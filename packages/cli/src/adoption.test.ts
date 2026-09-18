import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { previewDocs, sectionize } from "./capture/markdown.js";
import { parseDiff, formatCheck } from "./check.js";
import { runOptionalSteps } from "./onboard.js";
import { claudeAdapter } from "./adapters/claude.js";
import { PINNED_COMMAND } from "./adapters/templates.js";

test("preview only reads tracked selected docs, strips managed blocks and exposes limits", () => {
  const cwd = mkdtempSync(join(tmpdir(), "lockstep-preview-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    mkdirSync(join(cwd, "docs/adr"), { recursive: true });
    writeFileSync(join(cwd, "CLAUDE.md"), "# Rules\nUse UTC timestamps for all persisted audit events. Preserve the offset at presentation time.\n<!-- lockstep:start -->\nNever import this generated rule.\n<!-- lockstep:end -->");
    writeFileSync(join(cwd, "README.md"), "# Large section\n" + "x".repeat(5000));
    writeFileSync(join(cwd, "docs/adr/draft.md"), "Status: proposed\nA proposed architecture should not be imported automatically.");
    writeFileSync(join(cwd, "docs/adr/large.md"), "x".repeat(200001));
    writeFileSync(join(cwd, "AGENTS.md"), "This untracked secret document should never appear in the preview.");
    execFileSync("git", ["add", "CLAUDE.md", "README.md", "docs"], { cwd });
    const p = previewDocs(cwd);
    assert.deepEqual(p.files.map((f) => f.path), ["CLAUDE.md", "README.md"]);
    assert.ok(!JSON.stringify(p.files).includes("generated rule")); assert.ok(p.files[0]!.sections[0]!.text.includes("Preserve the offset"));
    assert.equal(p.truncated.length, 1); assert.equal(p.skipped.length, 2);
    assert.ok(Buffer.byteLength(p.files[1]!.sections[0]!.text) <= 4000);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
test("sections retain examples and fenced headings; diffs exclude credentials and show partial scope", () => {
  const sections = sectionize("# Accepted\nUse the explicit namespace for handlers except private helpers.\n```sh\n# this is a code example, not a new section\nexport namespace=public\n```\n# Another\nUse integer cents for stored currency, never floating point values.");
  assert.equal(sections.length, 2); assert.ok(sections[0]!.text.includes("export namespace"));
  const d = parseDiff("diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n+SECRET=yes\ndiff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2 +2 @@\n-old\n+new");
  assert.equal(d.partial, true); assert.equal(d.hunks.length, 1); assert.ok(!JSON.stringify(d).includes("SECRET"));
});
test("failed extraction still runs pack and reports the incomplete step", async () => {
  const ran: string[] = [];
  await runOptionalSteps([{ name: "import", run: async () => { throw new Error("offline"); } }, { name: "pack", run: async () => { ran.push("pack"); } }], (m) => ran.push(m));
  assert.match(ran[0]!, /import incomplete/); assert.equal(ran[1], "pack");
});
test("Claude install is executable, pinned, preserves unrelated MCP/hooks and needs no global binary", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lockstep-fresh-"));
  try {
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "other" } } }));
    writeFileSync(join(cwd, ".claude/settings.local.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo foreign" }] }] } }));
    await claudeAdapter.install(cwd, "project", false);
    const settings = JSON.parse(readFileSync(join(cwd, ".claude/settings.local.json"), "utf8"));
    assert.equal(settings.hooks.Stop[0].hooks[0].command, "echo foreign");
    for (const event of ["SessionStart", "Stop"]) {
      const h = settings.hooks[event].flatMap((g: { hooks: unknown[] }) => g.hooks).find((h: { command: string }) => h.command.includes("lockstep"));
      assert.ok(h.command.startsWith(PINNED_COMMAND)); assert.equal(h.args, undefined);
    }
    const mcp = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
    assert.equal(mcp.mcpServers.other.command, "other"); assert.equal(mcp.mcpServers.lockstep.command, "npx");
    assert.ok(mcp.mcpServers.lockstep.args.some((s: string) => s.includes("lockstep-cli@")));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a scratch file in the repo does not make a complete check read as truncated", () => {
  const base = { status: "completed" as const, checked: 1, total: 1, findings: [] };
  const clean = formatCheck(base);
  assert.ok(!/truncated/.test(clean), "nothing truncated, nothing to warn about");
  assert.match(clean, /No possible contradictions found/);

  const withScratch = formatCheck({ ...base, untracked: 2 });
  assert.match(withScratch, /2 untracked files were not uploaded and not checked/);
  assert.ok(!/truncated/.test(withScratch), "untracked files are a note, not a degraded result");

  const truncated = formatCheck({ ...base, status: "partial", partial: true, untracked: 1 });
  assert.match(truncated, /This check was truncated/);
  assert.match(truncated, /1 untracked file was not uploaded/);
});
