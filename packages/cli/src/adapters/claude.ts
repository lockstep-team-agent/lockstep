import { homedir } from "node:os";
import { join } from "node:path";
import { access } from "node:fs/promises";
import { applyFile, readIfExists } from "./fsutil.js";
import {
  mergeHooks,
  mergeMcp,
  mergeStatusLine,
  removeManagedHooks,
  removeManagedStatusLine,
  upsertManagedBlock,
} from "./merge.js";
import { captureHooks, mcpSpec, SKILL_MD, SETUP_SKILL_MD, CLAUDE_BLOCK } from "./templates.js";
import type { Scope, VendorAdapter } from "./types.js";

function paths(cwd: string, scope: Scope) {
  if (scope === "user") {
    const h = homedir();
    const hooks = join(h, ".claude", "settings.json");
    return {
      mcp: join(h, ".mcp.json"),
      hooks,
      // ~/.claude is already personal — hooks live in the same file (no shared/local split).
      hooksLocal: hooks,
      skill: join(h, ".claude", "skills", "lockstep", "SKILL.md"),
      setupSkill: join(h, ".claude", "skills", "lockstep-setup", "SKILL.md"),
      instructions: join(h, ".claude", "CLAUDE.md"),
    };
  }
  return {
    mcp: join(cwd, ".mcp.json"),
    hooks: join(cwd, ".claude", "settings.json"),
    // Hooks + statusline invoke the locally-installed `lockstep` bin — personal/machine state, so
    // they go in settings.local.json (Claude Code's personal scope, auto-gitignored), never in the
    // committed settings.json where they'd leak to teammates on git pull (IMPROVEMENTS #2).
    hooksLocal: join(cwd, ".claude", "settings.local.json"),
    skill: join(cwd, ".claude", "skills", "lockstep", "SKILL.md"),
    setupSkill: join(cwd, ".claude", "skills", "lockstep-setup", "SKILL.md"),
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
    const results = [
      await applyFile(p.mcp, (cur) => mergeMcp(cur, "lockstep", mcpSpec("claude")), dryRun),
      await applyFile(
        p.hooksLocal,
        (cur) => {
          const withHooks = mergeHooks(cur, captureHooks, "lockstep");
          return mergeStatusLine(withHooks, "lockstep", ["statusline"]);
        },
        dryRun,
      ),
      await applyFile(p.skill, () => SKILL_MD, dryRun),
      await applyFile(p.setupSkill, () => SETUP_SKILL_MD, dryRun),
      await applyFile(p.instructions, (cur) => upsertManagedBlock(cur, CLAUDE_BLOCK), dryRun),
    ];
    // Self-heal pre-existing installs: strip our hooks/statusline from the SHARED settings.json
    // (foreign entries preserved; the file is never created if absent).
    if (p.hooksLocal !== p.hooks && (await readIfExists(p.hooks)) !== null) {
      results.push(
        await applyFile(p.hooks, (cur) => removeManagedStatusLine(removeManagedHooks(cur ?? "{}")), dryRun),
      );
    }
    return results;
  },

  async verify(cwd, scope) {
    const p = paths(cwd, scope);
    const mcp = await readIfExists(p.mcp);
    const hooks = await readIfExists(p.hooksLocal);
    const mcpOk = !!mcp && mcp.includes('"lockstep"');
    const hooksOk = !!hooks && hooks.includes("lockstep");
    return {
      ok: mcpOk && hooksOk,
      details: [`${mcpOk ? "✓" : "✗"} mcp server  (${p.mcp})`, `${hooksOk ? "✓" : "✗"} hooks       (${p.hooksLocal})`],
    };
  },
};
