import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeHooks, mergeMcp, upsertManagedBlock, type ManagedHook } from "./merge.js";

const HOOKS: ManagedHook[] = [
  { event: "SessionStart", matcher: "*", args: ["-y", "@lockstep/cli", "capture", "--event", "SessionStart"], timeout: 20 },
  { event: "PostToolUse", matcher: "Edit|Write", args: ["-y", "@lockstep/cli", "capture", "--event", "PostToolUse"], timeout: 30 },
];

test("mergeHooks is idempotent (run twice = byte-identical)", () => {
  const once = mergeHooks(null, HOOKS);
  const twice = mergeHooks(once, HOOKS);
  assert.equal(once, twice);
});

test("mergeHooks preserves foreign hooks and stays idempotent", () => {
  const existing = JSON.stringify({
    hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }] },
  });
  const merged = mergeHooks(existing, HOOKS);
  const obj = JSON.parse(merged) as { hooks: { PostToolUse: { hooks: { command: string; args?: string[] }[] }[] } };
  const cmds = obj.hooks.PostToolUse.map((e) => e.hooks[0]!.command);
  assert.ok(cmds.includes("my-linter"), "foreign hook preserved");
  assert.ok(
    obj.hooks.PostToolUse.some((e) => (e.hooks[0]!.args ?? []).join(" ").includes("@lockstep/cli")),
    "our hook added",
  );
  assert.equal(mergeHooks(merged, HOOKS), merged, "idempotent with foreign present");
});

test("mergeMcp upserts our key, preserves siblings, idempotent", () => {
  const existing = JSON.stringify({ mcpServers: { other: { command: "x", args: [] } } });
  const spec = { command: "npx", args: ["-y", "@lockstep/cli", "mcp"] };
  const m1 = mergeMcp(existing, "lockstep", spec);
  const obj = JSON.parse(m1) as { mcpServers: Record<string, unknown> };
  assert.ok(obj.mcpServers.other, "sibling preserved");
  assert.ok(obj.mcpServers.lockstep, "our server added");
  assert.equal(mergeMcp(m1, "lockstep", spec), m1, "idempotent");
});

test("upsertManagedBlock replaces only the managed region, idempotent", () => {
  const md = "# My project\n\nsome notes\n";
  const b1 = upsertManagedBlock(md, "LOCKSTEP RULES v1");
  assert.ok(b1.includes("My project") && b1.includes("LOCKSTEP RULES v1"));
  const b2 = upsertManagedBlock(b1, "LOCKSTEP RULES v2");
  assert.ok(b2.includes("v2") && !b2.includes("v1"), "managed block replaced, user content kept");
  assert.equal(upsertManagedBlock(b2, "LOCKSTEP RULES v2"), b2, "idempotent");
});
