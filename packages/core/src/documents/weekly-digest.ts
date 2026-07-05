import { and, eq, lt, gt, ne, inArray } from "drizzle-orm";
import { withSystem } from "../db/rls.js";
import {
  projects,
  decisions,
  decisionProvenances,
  conflicts,
  sourceDocuments,
  projectMembers,
  members,
  writebacks,
} from "../db/schema.js";
import { writeAudit } from "../audit/audit-service.js";
import { productLayerEnabled } from "./document-service.js";

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
 * Enqueue a weekly operator digest per product-layer project: constraints that expired this week, docs
 * whose anchors need reverify, and the open-conflict count — delivered to each owner/pm with a Slack id.
 * Cross-org, worker-driven; the week-bucketed `dedupeKey` + onConflictDoNothing makes it fire at most
 * once per project per ISO week even though the worker calls it every tick.
 */
export async function enqueueWeeklyDigests(now = new Date()): Promise<{ enqueued: number }> {
  const week = isoWeek(now);
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  return withSystem(async (tx) => {
    const projs = await tx.select().from(projects);
    let enqueued = 0;
    for (const p of projs) {
      if (!productLayerEnabled(p.settings)) continue;

      // Constraints that expired this week (expiresAt is ~when the daily job flipped them).
      const expired = await tx
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
      const reverifyDocs = [...new Map(shakyAnchors.map((r) => [r.docId, r.title])).entries()].map(([, title]) => ({ title }));

      const openConflicts = (
        await tx.select({ id: conflicts.id }).from(conflicts).where(and(eq(conflicts.projectId, p.id), eq(conflicts.status, "open")))
      ).length;

      if (expired.length === 0 && reverifyDocs.length === 0 && openConflicts === 0) continue;

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
        expired: expired.map((d) => ({ scopeRef: d.scopeRef })),
        reverifyDocs,
        openConflicts,
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
