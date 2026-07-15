import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAdapter } from "./claude.js";

test("init writes config, is idempotent on disk, and preserves foreign config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lockstep-init-"));
  await mkdir(join(dir, ".claude"), { recursive: true });
  await writeFile(
    join(dir, ".claude", "settings.json"),
    JSON.stringify(
      { hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }] } },
      null,
      2,
    ),
  );
  await writeFile(
    join(dir, ".mcp.json"),
    JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }, null, 2),
  );
  await writeFile(join(dir, "CLAUDE.md"), "# Project\n\nhand-written notes\n");

  const read = async () => ({
    settings: await readFile(join(dir, ".claude", "settings.json"), "utf8"),
    local: await readFile(join(dir, ".claude", "settings.local.json"), "utf8"),
    mcp: await readFile(join(dir, ".mcp.json"), "utf8"),
    claude: await readFile(join(dir, "CLAUDE.md"), "utf8"),
    skill: await readFile(join(dir, ".claude", "skills", "lockstep", "SKILL.md"), "utf8"),
  });

  await claudeAdapter.install(dir, "project", false);
  const after1 = await read();
  await claudeAdapter.install(dir, "project", false);
  const after2 = await read();

  assert.deepEqual(after1, after2, "second init is byte-identical (idempotent)");
  assert.ok(after1.settings.includes("my-linter"), "foreign hook preserved in the shared file");
  assert.ok(!after1.settings.includes("capture"), "our hooks stay OUT of the committed settings.json");
  assert.ok(after1.local.includes("capture"), "our hooks land in personal settings.local.json");
  assert.ok(after1.local.includes("statusLine"), "statusline lands in personal settings.local.json");
  assert.ok(after1.mcp.includes('"other"'), "foreign mcp server preserved");
  assert.ok(after1.claude.includes("hand-written notes"), "user CLAUDE.md content preserved");
  assert.ok(after1.mcp.includes('"lockstep"'), "our mcp server installed");

  const v = await claudeAdapter.verify(dir, "project");
  assert.ok(v.ok, "verify passes after install");
});

test("init heals a pre-existing shared settings.json: lockstep hooks/statusline move to local, foreign stays", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lockstep-init-heal-"));
  await mkdir(join(dir, ".claude"), { recursive: true });
  // A repo initialized BEFORE the personal-scope split: our hooks + statusline sit in the committed file.
  await writeFile(
    join(dir, ".claude", "settings.json"),
    JSON.stringify(
      {
        hooks: {
          PostToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] },
            { matcher: "Edit|Write", hooks: [{ type: "command", command: "lockstep", args: ["capture"] }] },
          ],
          Stop: [{ hooks: [{ type: "command", command: "lockstep", args: ["capture", "--event", "Stop"] }] }],
        },
        statusLine: { type: "command", command: "lockstep", args: ["statusline"] },
      },
      null,
      2,
    ),
  );

  await claudeAdapter.install(dir, "project", false);
  const shared = await readFile(join(dir, ".claude", "settings.json"), "utf8");
  const local = await readFile(join(dir, ".claude", "settings.local.json"), "utf8");

  assert.ok(shared.includes("my-linter"), "foreign hook survives the heal");
  assert.ok(!shared.includes("lockstep"), "every lockstep-managed entry is stripped from the shared file");
  const sharedObj = JSON.parse(shared) as { hooks?: Record<string, unknown[]>; statusLine?: unknown };
  assert.equal(sharedObj.hooks?.Stop, undefined, "an event left empty by the heal is dropped");
  assert.equal(sharedObj.statusLine, undefined, "lockstep statusline removed from the shared file");
  assert.ok(local.includes("capture") && local.includes("statusLine"), "personal file carries hooks + statusline");

  // A FOREIGN statusline is never touched (mergeStatusLine never overwrote it; the heal must not strip it).
  const dir2 = await mkdtemp(join(tmpdir(), "lockstep-init-heal2-"));
  await mkdir(join(dir2, ".claude"), { recursive: true });
  await writeFile(
    join(dir2, ".claude", "settings.json"),
    JSON.stringify({ statusLine: { type: "command", command: "my-status" } }, null, 2),
  );
  await claudeAdapter.install(dir2, "project", false);
  const shared2 = await readFile(join(dir2, ".claude", "settings.json"), "utf8");
  assert.ok(shared2.includes("my-status"), "foreign statusline untouched");
});

test("init never creates a shared settings.json just to heal it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lockstep-init-noshared-"));
  await claudeAdapter.install(dir, "project", false);
  await assert.rejects(readFile(join(dir, ".claude", "settings.json"), "utf8"), "shared file not minted");
  await readFile(join(dir, ".claude", "settings.local.json"), "utf8"); // personal file exists
});

test("init installs the lockstep-setup onboarding skill", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lockstep-setup-init-"));
  await mkdir(join(dir, ".claude"), { recursive: true });

  const results = await claudeAdapter.install(dir, "project", false);
  const setup = await readFile(join(dir, ".claude", "skills", "lockstep-setup", "SKILL.md"), "utf8");
  assert.ok(setup.includes("name: lockstep-setup"), "setup skill frontmatter written");
  assert.ok(setup.includes("lockstep scan"), "setup skill drives the scan command");
  assert.ok(
    results.some((r) => r.includes("lockstep-setup")),
    "install reports the setup-skill artifact",
  );

  const dry = await claudeAdapter.install(dir, "project", true);
  assert.ok(
    dry.some((r) => r.startsWith("unchanged") && r.includes("lockstep-setup")),
    "dry-run reports the setup skill unchanged after install",
  );
});
