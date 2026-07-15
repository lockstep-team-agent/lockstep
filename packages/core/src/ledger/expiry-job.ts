import { and, eq, lt, isNotNull } from "drizzle-orm";
import { withSystem } from "../db/rls.js";
import { decisions, conflicts } from "../db/schema.js";
import { writeAudit } from "../audit/audit-service.js";

/**
 * Expiry job (FR-CORE-11). A dated product constraint (a launch gate with an `expiresAt`) should stop
 * governing once its window passes — otherwise C-4-style gates haunt briefings forever. This flips
 * Deliberately does NOT skip archived projects: expiring a past-due gate there is harmless state
 * hygiene, and the job is decision-driven, not project-driven (unlike sweeps/digests, which do skip).
 * `binding` → `expired` for every document constraint past its `expiresAt`, retires its open conflicts,
 * and writes a `decision.expired` audit. Cross-org (the worker calls it on a tick), idempotent (only
 * touches past-due rows; an already-`expired` row no longer matches).
 */
export async function expireConstraints(now = new Date()): Promise<{ expired: number; conflictsDismissed: number }> {
  return withSystem(async (tx) => {
    const due = await tx
      .select()
      .from(decisions)
      .where(
        and(
          eq(decisions.origin, "document"),
          eq(decisions.status, "binding"),
          isNotNull(decisions.expiresAt),
          lt(decisions.expiresAt, now),
        ),
      );
    let expired = 0;
    let conflictsDismissed = 0;
    for (const d of due) {
      await tx.update(decisions).set({ status: "expired" }).where(eq(decisions.id, d.id));
      expired++;
      await writeAudit(tx, {
        orgId: d.orgId,
        projectId: d.projectId,
        actorMemberId: null, // system job
        action: "decision.expired",
        entityKind: "decision",
        entityId: d.id,
        entityVersion: d.currentVersion,
        payload: { scopeRef: d.scopeRef, constraintKind: d.constraintKind, expiresAt: d.expiresAt },
      });
      // A retired constraint no longer contests anything — dismiss its open conflicts.
      const dismissed = await tx
        .update(conflicts)
        .set({ status: "dismissed", dismissReason: "constraint_expired", resolvedAt: now })
        .where(and(eq(conflicts.constraintDecisionId, d.id), eq(conflicts.status, "open")))
        .returning();
      conflictsDismissed += dismissed.length;
    }
    return { expired, conflictsDismissed };
  });
}
