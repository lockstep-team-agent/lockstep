import { join } from "node:path";
import { homedir } from "node:os";
import { unlink } from "node:fs/promises";
import { applyFile, readIfExists } from "./adapters/fsutil.js";
import { removeManagedBlock, removeManagedHooks, removeManagedStatusLine } from "./adapters/merge.js";
import { SKILL_MD, SETUP_SKILL_MD } from "./adapters/templates.js";
import { saveLocalState } from "./local-state.js";

export async function runUninstall(opts: { dryRun?: boolean; scope?: "project" | "user" }) {
  const user = opts.scope === "user";
  const root = user ? homedir() : process.cwd();
  const claude = join(root, ".claude");
  for (const path of [join(claude, "settings.json"), ...(!user ? [join(claude, "settings.local.json")] : [])]) {
    if (await readIfExists(path) !== null) console.log(await applyFile(path, (cur) => removeManagedStatusLine(removeManagedHooks(cur!)), opts.dryRun ?? false));
  }
  const mcp = join(root, user ? ".claude.json" : ".mcp.json");
  if (await readIfExists(mcp) !== null) console.log(await applyFile(mcp, (cur) => {
    const data = JSON.parse(cur!) as { mcpServers?: Record<string, unknown> };
    if (JSON.stringify(data.mcpServers?.lockstep ?? null).includes("lockstep")) delete data.mcpServers?.lockstep;
    return JSON.stringify(data, null, 2) + "\n";
  }, opts.dryRun ?? false));
  const instructions = join(user ? claude : root, "CLAUDE.md");
  if (await readIfExists(instructions) !== null) console.log(await applyFile(instructions, (cur) => removeManagedBlock(cur!), opts.dryRun ?? false));
  for (const [name, expected] of [["lockstep", SKILL_MD], ["lockstep-setup", SETUP_SKILL_MD]]) {
    const path = join(claude, "skills", name!, "SKILL.md");
    if (await readIfExists(path) === expected) { console.log(`${opts.dryRun ? "would remove" : "removing"} ${path}`); if (!opts.dryRun) await unlink(path); }
  }
  if (!opts.dryRun) saveLocalState({ automaticChecks: false, configured: false, verifiedAt: undefined, verifiedSession: undefined });
  console.log("Shared decisions and project history remain in Lockstep. Modified skills are preserved.");
}
