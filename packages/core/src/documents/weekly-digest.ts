import { and, eq, lt, gt, ne, inArray } from "drizzle-orm";
import { withSystem } from "../db/rls.js";
import {
  projects,
  decisions,
  decisionVersions,
  decisionProvenances,
  conflicts,
  sourceDocuments,
  projectMembers,
  members,
  writebacks,
} from "../db/schema.js";
import { writeAudit } from "../audit/audit-service.js";
import { productLayerEnabled } from "./document-service.js";
import { projectArchived } from "../auth/permissions.js";

/** ISO-week bucket (e.g. "2026-W27") — the dedupe key so a digest fires at most once per project/week. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; // Mon=1..Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - day); // nearest Thursday
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Enqueue a weekly operator digest per project — delivered to each owner/pm with a Slack id.
 * Phase J sections (decisions due for review, proposals waiting past the staleness window) apply to
 * EVERY project; the product-layer sections (constraints expired this week, docs whose anchors need
 * reverify, open-conflict count) only to product-layer projects. Cross-org, worker-driven; the
 * week-bucketed `dedupeKey` + onConflictDoNothing makes it fire at most once per project per ISO
 * week even though the worker calls it every tick.
 */
export async function enqueueWeeklyDigests(now = new Date()): Promise<{ enqueued: number }> {
  const week = isoWeek(now);
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  return withSystem(async (tx) => {
    const projs = await tx.select().from(projects);
    let enqueued = 0;
    for (const p of projs) {
      if (projectArchived(p.settings)) continue; // archived = inert, no digests
      const productLayer = productLayerEnabled(p.settings);

      // Phase J: binding decisions past their review tripwire (query-time — nothing flips status).
      const reviewDueRows = await tx
        .select({ scopeRef: decisions.scopeRef, reviewAt: decisions.reviewAt })
        .from(decisions)
        .where(and(eq(decisions.projectId, p.id), eq(decisions.status, "binding"), lt(decisions.reviewAt, now)));
      const reviewDue = reviewDueRows.map((d) => ({ scopeRef: d.scopeRef }));

      // Phase J: proposals stuck in the review queue past the project's staleness window. Age is
      // anchored on the CURRENT version's createdAt — a re-proposed constraint gets a fresh clock.
      const staleDays = (p.settings as { staleProposalDays?: number } | null)?.staleProposalDays ?? 7;
      const staleCutoff = new Date(now.getTime() - staleDays * 86400000);
      const staleRows = await tx
        .select({ scopeRef: decisions.scopeRef, proposedAt: decisionVersions.createdAt })
        .from(decisions)
        .innerJoin(
          decisionVersions,
          and(eq(decisionVersions.decisionId, decisions.id), eq(decisionVersions.version, decisions.currentVersion)),
        )
        .where(
          and(eq(decisions.projectId, p.id), eq(decisions.status, "proposed"), lt(decisionVersions.createdAt, staleCutoff)),
        );
      const staleProposals = staleRows.map((r) => ({
        scopeRef: r.scopeRef,
        ageDays: Math.floor((now.getTime() - r.proposedAt.getTime()) / 86400000),
      }));

      // Product-layer sections.
      let expired: Array<{ scopeRef: string }> = [];
      let reverifyDocs: Array<{ title: string | null }> = [];
      let openConflicts = 0;
      if (productLayer) {
        // Constraints that expired this week (expiresAt is ~when the daily job flipped them).
        const expiredRows = await tx
          .select()
          .from(decisions)
          .where(
            and(
              eq(decisions.projectId, p.id),
              eq(decisions.origin, "document"),
              eq(decisions.status, "expired"),
              gt(decisions.expiresAt, weekAgo),
              lt(decisions.expiresAt, now),
            ),
          );
        expired = expiredRows.map((d) => ({ scopeRef: d.scopeRef }));

        // Docs (by external id) with at least one non-valid anchor.
        const shakyAnchors = await tx
          .select({ docId: sourceDocuments.id, title: sourceDocuments.title, anchorStatus: decisionProvenances.anchorStatus, source: decisionProvenances.source })
          .from(decisionProvenances)
          .innerJoin(decisions, eq(decisionProvenances.decisionId, decisions.id))
          .innerJoin(
            sourceDocuments,
            and(eq(sourceDocuments.projectId, p.id), eq(sourceDocuments.tool, decisionProvenances.source)),
          )
          .where(and(eq(decisions.projectId, p.id), eq(decisions.origin, "document"), ne(decisionProvenances.anchorStatus, "valid")));
        reverifyDocs = [...new Map(shakyAnchors.map((r) => [r.docId, r.title])).entries()].map(([, title]) => ({ title }));

        openConflicts = (
          await tx.select({ id: conflicts.id }).from(conflicts).where(and(eq(conflicts.projectId, p.id), eq(conflicts.status, "open")))
        ).length;
      }

      if (
        expired.length === 0 &&
        reverifyDocs.length === 0 &&
        openConflicts === 0 &&
        reviewDue.length === 0 &&
        staleProposals.length === 0
      )
        continue;

      // Recipients: active owners/PMs of the project with a linked Slack id.
      const pms = await tx
        .select({ memberId: projectMembers.memberId })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, p.id), eq(projectMembers.status, "active"), inArray(projectMembers.role, ["owner", "pm"])));
      const memberIds = pms.map((m) => m.memberId).filter((x): x is string => Boolean(x));
      if (memberIds.length === 0) continue;
      const recips = (await tx.select().from(members).where(inArray(members.id, memberIds))).filter((m) => m.slackUserId);

      const payload = {
        projectName: p.name,
        expired,
        reverifyDocs,
        openConflicts,
        reviewDue,
        staleProposals,
      };
      for (const m of recips) {
        const res = await tx
          .insert(writebacks)
          .values({
            orgId: p.orgId,
            projectId: p.id,
            connectionId: null,
            tool: "slack",
            kind: "weekly_digest",
            targetRef: m.slackUserId!,
            payload,
            dedupeKey: `weekly:${p.id}:${week}:${m.slackUserId}`,
          })
          .onConflictDoNothing()
          .returning();
        if (res.length > 0) {
          enqueued++;
          await writeAudit(tx, {
            orgId: p.orgId,
            projectId: p.id,
            action: "weekly_digest.enqueued",
            entityKind: "project",
            entityId: p.id,
            payload: { week, recipient: m.slackUserId },
          });
        }
      }
    }
    return { enqueued };
  });
}
