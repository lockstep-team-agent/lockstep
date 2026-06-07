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
    JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }] } }, null, 2),
  );
  await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } }, null, 2));
  await writeFile(join(dir, "CLAUDE.md"), "# Project\n\nhand-written notes\n");

  const read = async () => ({
    settings: await readFile(join(dir, ".claude", "settings.json"), "utf8"),
    mcp: await readFile(join(dir, ".mcp.json"), "utf8"),
    claude: await readFile(join(dir, "CLAUDE.md"), "utf8"),
    skill: await readFile(join(dir, ".claude", "skills", "lockstep", "SKILL.md"), "utf8"),
  });

  await claudeAdapter.install(dir, "project", false);
  const after1 = await read();
  await claudeAdapter.install(dir, "project", false);
  const after2 = await read();

  assert.deepEqual(after1, after2, "second init is byte-identical (idempotent)");
  assert.ok(after1.settings.includes("my-linter"), "foreign hook preserved");
  assert.ok(after1.mcp.includes('"other"'), "foreign mcp server preserved");
  assert.ok(after1.claude.includes("hand-written notes"), "user CLAUDE.md content preserved");
  assert.ok(after1.settings.includes("@lockstep/cli"), "our hooks installed");
  assert.ok(after1.mcp.includes("@lockstep/cli"), "our mcp server installed");

  const v = await claudeAdapter.verify(dir, "project");
  assert.ok(v.ok, "verify passes after install");
});
