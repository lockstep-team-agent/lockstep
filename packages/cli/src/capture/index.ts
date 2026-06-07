import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { registerSession } from "../mcp/session.js";
import { call } from "../mcp/api.js";
import { changedFiles } from "./diff.js";
import { isContractSurface, riskTierFor } from "./classify.js";

interface InboxResp {
  unread?: number;
  changes?: Array<{ summary: string; surface: string | null }>;
}
interface DecisionsResp {
  decisions?: Array<{ scopeRef: string; status: string; ruleText: string }>;
}

function formatReplay(inbox: InboxResp | null, decisions: DecisionsResp | null): string {
  const lines: string[] = [];
  const changes = inbox?.changes ?? [];
  if (changes.length) {
    lines.push(`📥 ${changes.length} change(s) since you were last here:`);
    for (const c of changes.slice(0, 8)) lines.push(`  • ${c.summary}${c.surface ? ` (${c.surface})` : ""}`);
  }
  const binding = (decisions?.decisions ?? []).filter((d) => d.status === "binding");
  if (binding.length) {
    lines.push(`📌 ${binding.length} binding decision(s) in effect:`);
    for (const d of binding.slice(0, 8)) lines.push(`  • [${d.scopeRef}] ${d.ruleText}`);
  }
  return lines.length ? `Lockstep:\n${lines.join("\n")}` : "Lockstep: nothing new.";
}

/**
 * Hook entrypoint. Resilient by design — never break the agent: on any error it exits 0.
 *  SessionStart → replay inbox + binding decisions as additionalContext.
 *  PostToolUse/Stop → diff → classify surface → risk-tiered publish via notify.
 */
export async function runCapture(event: string): Promise<void> {
  const vendor = process.env.LOCKSTEP_VENDOR ?? "unknown";
  const cwd = process.cwd();

  let session;
  try {
    session = await registerSession(vendor);
  } catch {
    process.exit(0); // not a connected repo / not logged in → silent no-op
  }

  try {
    if (event === "SessionStart") {
      const inbox = await call<InboxResp>("GET", "/inbox", session.sessionId).catch(() => null);
      const decisions = await call<DecisionsResp>("GET", "/decisions", session.sessionId).catch(() => null);
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: formatReplay(inbox, decisions) },
        }),
      );
      return;
    }

    // PostToolUse / Stop — capture the change
    const files = changedFiles(cwd);
    if (files.length === 0) return;

    const surfaces: string[] = [];
    let anyContractSurface = false;
    for (const f of files) {
      let content = "";
      try {
        content = readFileSync(join(cwd, f), "utf8");
      } catch {
        /* deleted/binary — skip content */
      }
      if (isContractSurface(f, content)) {
        anyContractSurface = true;
        surfaces.push(f);
      }
    }

    // v1: contract surface ⇒ shared (the safety-critical bias). Ownership-based refinement later.
    const riskTier = riskTierFor({ anyContractSurface, allOwnedByMe: true });
    const summary = `${event}: changed ${files.length} file(s): ${files.slice(0, 5).join(", ")}${files.length > 5 ? "…" : ""}`;
    const diffHash = createHash("sha256").update(files.sort().join("|")).digest("hex").slice(0, 16);

    await call("POST", "/changes", session.sessionId, {
      summary,
      surface: surfaces[0],
      riskTier,
      verified: true, // mechanical delta is derived from real local code
      verifiedAgainst: "git-diff",
      diffHash,
    }).catch(() => {});
    process.stderr.write(`[lockstep] published change (${riskTier})\n`);
  } catch {
    process.exit(0);
  }
}
