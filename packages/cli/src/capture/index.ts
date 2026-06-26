import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { registerSession } from "../mcp/session.js";
import { call } from "../mcp/api.js";
import { changedFiles } from "./diff.js";
import { isContractSurface, riskTierFor } from "./classify.js";
import { extractSurfaces } from "./surface.js";
import { readManifest } from "./manifest.js";

/** Sync this repo's declared dependencies (lockstep.yaml `consumes:`) into the usage graph. Idempotent. */
async function syncManifestDeps(cwd: string, sessionId: string): Promise<void> {
  const { consumes } = readManifest(cwd);
  for (const producedSurface of consumes) {
    await call("POST", "/dependencies", sessionId, { producedSurface, source: "manifest" }).catch(() => {});
  }
}

interface InboxResp {
  unread?: number;
  changes?: Array<{ summary: string; surface: string | null; impact?: number }>;
  questions?: Array<{ id: string; body: string; scopeRef: string | null; urgent: boolean; status: string }>;
  tasks?: Array<{ id: string; title: string; runState: string; status: string }>;
  decisions?: Array<{ id: string; scopeRef: string; ruleText: string; status: string; impact?: number }>;
}
interface DecisionsResp {
  decisions?: Array<{ scopeRef: string; status: string; ruleText: string; impact?: number }>;
}

/** Highest-blast-radius first, so the session-start briefing leads with what matters most. */
const byImpact = <T extends { impact?: number }>(a: T, b: T): number => (b.impact ?? 0) - (a.impact ?? 0);
const tag = (impact?: number): string => ((impact ?? 0) > 0 ? `[impact ${impact}] ` : "");

function formatReplay(inbox: InboxResp | null, decisions: DecisionsResp | null): string {
  const lines: string[] = [];
  const changes = [...(inbox?.changes ?? [])].sort(byImpact);
  if (changes.length) {
    lines.push(`📥 ${changes.length} change(s) since you were last here:`);
    for (const c of changes.slice(0, 8))
      lines.push(`  • ${tag(c.impact)}${c.summary}${c.surface ? ` (${c.surface})` : ""}`);
  }
  const qs = (inbox?.questions ?? []).filter((q) => q.status === "open");
  if (qs.length) {
    lines.push(`❓ ${qs.length} open question(s) for you:`);
    for (const q of qs.slice(0, 8)) lines.push(`  • ${q.urgent ? "[URGENT] " : ""}${q.body}`);
  }
  const ts = (inbox?.tasks ?? []).filter((t) => t.status === "open");
  if (ts.length) {
    lines.push(`📋 ${ts.length} task(s) assigned to you:`);
    for (const t of ts.slice(0, 8)) lines.push(`  • ${t.title}`);
  }
  const pendingDecisions = (inbox?.decisions ?? []).filter((d) => d.status === "open");
  if (pendingDecisions.length) {
    lines.push(`⚖️ ${pendingDecisions.length} decision(s) pending your acknowledgment:`);
    for (const d of pendingDecisions.slice(0, 8)) lines.push(`  • [${d.scopeRef}] ${d.ruleText}`);
  }
  const binding = (decisions?.decisions ?? []).filter((d) => d.status === "binding").sort(byImpact);
  if (binding.length) {
    lines.push(`📌 ${binding.length} binding decision(s) in effect:`);
    for (const d of binding.slice(0, 8)) lines.push(`  • ${tag(d.impact)}[${d.scopeRef}] ${d.ruleText}`);
  }
  return lines.length ? `Lockstep:\n${lines.join("\n")}` : "Lockstep: nothing new.";
}

interface PeekResp {
  unread?: number;
  questions?: number;
  tasks?: number;
  changes?: number;
  decisions?: number;
}

/** Format a short badge from inbox peek counts. Returns null if nothing new. */
function formatPeek(peek: PeekResp | null): string | null {
  if (!peek || !peek.unread) return null;
  const parts: string[] = [];
  if (peek.questions) parts.push(`${peek.questions} question${peek.questions > 1 ? "s" : ""}`);
  if (peek.tasks) parts.push(`${peek.tasks} task${peek.tasks > 1 ? "s" : ""}`);
  if (peek.decisions) parts.push(`${peek.decisions} decision${peek.decisions > 1 ? "s" : ""} to review`);
  if (peek.changes) parts.push(`${peek.changes} change${peek.changes > 1 ? "s" : ""}`);
  if (parts.length === 0) return null;
  return `[Lockstep] ${peek.unread} new message${peek.unread > 1 ? "s" : ""} (${parts.join(", ")}). Check your inbox.`;
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
      await syncManifestDeps(cwd, session.sessionId); // keep the usage graph current from lockstep.yaml
      const inbox = await call<InboxResp>("GET", "/inbox", session.sessionId).catch(() => null);
      const decisions = await call<DecisionsResp>("GET", "/decisions", session.sessionId).catch(() => null);
      const replay = formatReplay(inbox, decisions);
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: replay },
        }),
      );
      // Also write to stderr so it's visible in the terminal
      if ((inbox?.unread ?? 0) > 0) {
        process.stderr.write(`\n${replay}\n\n`);
      }
      return;
    }

    // PostToolUse / Stop — capture the change
    const files = changedFiles(cwd);
    if (files.length === 0) return;

    // Extract CANONICAL surface IDs (e.g. "http:POST /auth/session") — the shared vocabulary that
    // lets a consumer's declared dependency match a producer's change. File paths never matched.
    const surfaceIds = new Set<string>();
    let anyContractSurface = false;
    for (const f of files) {
      let content = "";
      try {
        content = readFileSync(join(cwd, f), "utf8");
      } catch {
        /* deleted/binary — skip content */
      }
      const ids = extractSurfaces(f, content);
      if (ids.length > 0) {
        anyContractSurface = true;
        ids.forEach((s) => surfaceIds.add(s));
      } else if (isContractSurface(f, content)) {
        anyContractSurface = true; // contract-ish file we couldn't parse into an exact surface
      }
    }

    // v1: contract surface ⇒ shared (the safety-critical bias). Ownership-based refinement later.
    const riskTier = riskTierFor({ anyContractSurface, allOwnedByMe: true });
    const summary = `${event}: changed ${files.length} file(s): ${files.slice(0, 5).join(", ")}${files.length > 5 ? "…" : ""}`;
    const baseHash = createHash("sha256").update(files.sort().join("|")).digest("hex").slice(0, 16);

    const ids = [...surfaceIds].slice(0, 10);
    if (ids.length === 0) {
      // No contract surface touched — record a single owned activity entry (routes to no one).
      await call("POST", "/changes", session.sessionId, {
        summary,
        riskTier,
        verified: true,
        verifiedAgainst: "git-diff",
        diffHash: baseHash,
      }).catch(() => {});
    } else {
      // One change per changed surface, so each routes to that surface's consumers.
      for (const surface of ids) {
        await call("POST", "/changes", session.sessionId, {
          summary,
          surface,
          riskTier,
          verified: true, // mechanical delta is derived from real local code
          verifiedAgainst: "git-diff",
          diffHash: `${baseHash}:${surface}`,
        }).catch(() => {});
      }
    }
    process.stderr.write(`[lockstep] published change (${riskTier}, ${ids.length} surface(s))\n`);

    // NOTE: capture publishes a CHANGE event only. A change is NOT a decision — decisions are
    // durable rules/architectural choices, logged deliberately by the agent via propose_decision
    // (see the lockstep skill). Auto-minting a decision per save was a category error that flooded
    // the ledger; routing/impact for changes is handled by recordChange on the server.

    // Peek at inbox (without marking as read) — notify the agent if there are unread items
    const peek = await call<PeekResp>("GET", "/inbox/peek", session.sessionId).catch(() => null);
    const badge = formatPeek(peek);
    if (badge) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: badge },
        }),
      );
    }
  } catch {
    process.exit(0);
  }
}
