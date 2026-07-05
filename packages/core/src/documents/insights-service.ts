import { and, eq, inArray } from "drizzle-orm";
import { withOrg } from "../db/rls.js";
import { decisions, decisionVersions, conflicts, decisionProvenances } from "../db/schema.js";

/**
 * Read-only Insights: low-confidence / dismiss-reason tuning signals, computed straight from the
 * entity tables (no audit scan, no index). Every rate guards divide-by-zero (empty denominator → 0).
 */
export interface ProjectInsights {
  /** origin=document decisions: ratified (binding) vs rejected — the PM's accept/reject signal. */
  ratification: { ratified: number; rejected: number; rate: number };
  /** conflicts: how often a co-location conflict is dismissed rather than actioned, + why. */
  conflicts: {
    dismissed: number;
    resolved: number;
    rate: number;
    dismissReasons: Array<{ reason: string; count: number }>;
  };
  /** low-confidence extractions: how often a flagged constraint is nonetheless accepted (binding). */
  lowConfidence: { accepted: number; total: number; rate: number };
  /** document-constraint anchors still pointing at a valid source location. */
  anchors: { valid: number; total: number; rate: number };
}

const rate = (num: number, denom: number): number => (denom > 0 ? num / denom : 0);

export async function projectInsights(orgId: string, projectId: string): Promise<ProjectInsights> {
  return withOrg(orgId, async (tx) => {
    // ── ratification approval rate: over origin=document decisions ──
    const docDecisions = await tx
      .select()
      .from(decisions)
      .where(and(eq(decisions.projectId, projectId), eq(decisions.origin, "document")));
    const ratified = docDecisions.filter((d) => d.status === "binding").length;
    const rejected = docDecisions.filter((d) => d.status === "rejected").length;

    // ── conflict dismiss rate + dismiss-reason histogram ──
    const cs = await tx.select().from(conflicts).where(eq(conflicts.projectId, projectId));
    const dismissed = cs.filter((c) => c.status === "dismissed").length;
    const resolved = cs.filter(
      (c) =>
        c.status === "dismissed" || c.status === "resolved_eng_revised" || c.status === "resolved_prd_amended",
    ).length;
    const reasonCounts = new Map<string, number>();
    for (const c of cs) {
      if (c.status !== "dismissed") continue;
      const reason = c.dismissReason ?? "unspecified";
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
    const dismissReasons = [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);

    // ── low-confidence acceptance: origin=document decisions whose CURRENT version provenance is
    // flagged lowConfidence (stored on decision_versions.provenance jsonb by the extraction path) ──
    let lcAccepted = 0;
    let lcTotal = 0;
    for (const d of docDecisions) {
      const v = (
        await tx
          .select({ provenance: decisionVersions.provenance })
          .from(decisionVersions)
          .where(and(eq(decisionVersions.decisionId, d.id), eq(decisionVersions.version, d.currentVersion)))
          .limit(1)
      )[0];
      const prov = (v?.provenance ?? {}) as { lowConfidence?: boolean };
      if (prov.lowConfidence !== true) continue;
      lcTotal++;
      if (d.status === "binding") lcAccepted++;
    }

    // ── anchor validity: over the provenance rows of this project's document decisions ──
    const docDecisionIds = docDecisions.map((d) => d.id);
    const provRows = docDecisionIds.length
      ? await tx
          .select({ anchorStatus: decisionProvenances.anchorStatus })
          .from(decisionProvenances)
          .where(inArray(decisionProvenances.decisionId, docDecisionIds))
      : [];
    const anchorValid = provRows.filter((p) => p.anchorStatus === "valid").length;
    const anchorTotal = provRows.length;

    return {
      ratification: { ratified, rejected, rate: rate(ratified, ratified + rejected) },
      conflicts: { dismissed, resolved, rate: rate(dismissed, resolved), dismissReasons },
      lowConfidence: { accepted: lcAccepted, total: lcTotal, rate: rate(lcAccepted, lcTotal) },
      anchors: { valid: anchorValid, total: anchorTotal, rate: rate(anchorValid, anchorTotal) },
    };
  });
}
