import { homedir } from "node:os";
import { join } from "node:path";
import { access } from "node:fs/promises";
import { applyFile, readIfExists } from "./fsutil.js";
import { mergeHooks, mergeMcp, upsertManagedBlock } from "./merge.js";
import { captureHooks, mcpSpec, SKILL_MD, CLAUDE_BLOCK } from "./templates.js";
import type { Scope, VendorAdapter } from "./types.js";

function paths(cwd: string, scope: Scope) {
  if (scope === "user") {
    const h = homedir();
    return {
      mcp: join(h, ".mcp.json"),
      hooks: join(h, ".claude", "settings.json"),
      skill: join(h, ".claude", "skills", "lockstep", "SKILL.md"),
      instructions: join(h, ".claude", "CLAUDE.md"),
    };
  }
  return {
    mcp: join(cwd, ".mcp.json"),
    hooks: join(cwd, ".claude", "settings.json"),
    skill: join(cwd, ".claude", "skills", "lockstep", "SKILL.md"),
    instructions: join(cwd, "CLAUDE.md"),
  };
}

export const claudeAdapter: VendorAdapter = {
  id: "claude",

  async detect() {
    try {
      await access(join(homedir(), ".claude"));
      return true;
    } catch {
      return false;
    }
  },

  async install(cwd, scope, dryRun) {
    const p = paths(cwd, scope);
    return [
      await applyFile(p.mcp, (cur) => mergeMcp(cur, "lockstep", mcpSpec("claude")), dryRun),
      await applyFile(p.hooks, (cur) => mergeHooks(cur, captureHooks, "lockstep"), dryRun),
      await applyFile(p.skill, () => SKILL_MD, dryRun),
      await applyFile(p.instructions, (cur) => upsertManagedBlock(cur, CLAUDE_BLOCK), dryRun),
    ];
  },

  async verify(cwd, scope) {
    const p = paths(cwd, scope);
    const mcp = await readIfExists(p.mcp);
    const hooks = await readIfExists(p.hooks);
    const mcpOk = !!mcp && mcp.includes('"lockstep"');
    const hooksOk = !!hooks && hooks.includes("lockstep");
    return {
      ok: mcpOk && hooksOk,
      details: [`${mcpOk ? "✓" : "✗"} mcp server  (${p.mcp})`, `${hooksOk ? "✓" : "✗"} hooks       (${p.hooks})`],
    };
  },
};
