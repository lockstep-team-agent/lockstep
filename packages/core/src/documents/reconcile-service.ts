import { and, eq } from "drizzle-orm";
import { withOrg, type Tx } from "../db/rls.js";
import { conflicts, decisions, decisionVersions, writebacks } from "../db/schema.js";
import { writeAudit } from "../audit/audit-service.js";
import { capabilitySurfacesTx } from "../ledger/ledger-service.js";

/**
 * v3 conflict detection is co-location, by design: two things governing the same surface — a human
 * should look. No semantic contradiction claims, ever; every rendering says "may conflict / review
 * both". Pre-approval reconciliation runs when a PRD candidate is filed; the conflict is commented
 * back into the source document (via the write-back queue) so the PM sees it while the PRD is still
 * editable.
 */

export interface DocForReconcile {
  id: string;
  projectId: string;
  connectionId: string | null;
  externalId: string;
  url: string | null;
  title: string | null;
}

/** The comment posted into the source doc. Pure so tests pin the language discipline. */
export function composeConflictComment(input: {
  constraintText: string;
  engRuleText: string;
  surface: string;
  engDecisionCreatedAt?: Date | null;
}): string {
  const when = input.engDecisionCreatedAt
    ? ` (${input.engDecisionCreatedAt.toLocaleString("en-US", { month: "short", year: "numeric" })})`
    : "";
  return (
    `⚠ Lockstep: "${input.constraintText}" may conflict with an existing binding engineering decision` +
    `${when} on \`${input.surface}\`: "${input.engRuleText}". Please review both before approval. (via Lockstep)`
  );
}

/**
 * Surface set of a decision for co-location: a surface-scoped decision is its own surface; a
 * capability-scoped constraint maps through CONFIRMED governs edges (usually empty at first filing).
 */
async function surfacesForTx(tx: Tx, projectId: string, scopeKind: string, scopeRef: string): Promise<string[]> {
  if (scopeKind === "surface") return [scopeRef];
  if (scopeKind === "capability") return capabilitySurfacesTx(tx, projectId, scopeRef);
  return [];
}

/**
 * Pre-approval reconciliation for one just-filed document constraint: find binding decisions sharing
 * any surface, open a `pre_approval` conflict per hit (idempotent on the (constraint, eng, kind)
 * unique key — re-detections never duplicate or re-notify), and queue the source-doc comment.
 */
export async function reconcileCandidateTx(
  tx: Tx,
  orgId: string,
  input: {
    doc: DocForReconcile;
    decisionId: string;
    scopeKind: string;
    scopeRef: string;
    ruleText: string;
    anchorBlockId?: string | null;
  },
): Promise<Array<{ conflictId: string; engDecisionId: string; surface: string }>> {
  const opened: Array<{ conflictId: string; engDecisionId: string; surface: string }> = [];
  const surfaces = await surfacesForTx(tx, input.doc.projectId, input.scopeKind, input.scopeRef);
  for (const surface of surfaces) {
    const mates = await tx
      .select()
      .from(decisions)
      .where(
        and(
          eq(decisions.projectId, input.doc.projectId),
          eq(decisions.scopeRef, surface),
          eq(decisions.status, "binding"),
        ),
      );
    for (const m of mates) {
      if (m.id === input.decisionId) continue;
      if (m.origin === "document") continue; // constraint-vs-constraint is not drift, it's fusion territory
      const inserted = (
        await tx
          .insert(conflicts)
          .values({
            orgId,
            projectId: input.doc.projectId,
            constraintDecisionId: input.decisionId,
            engDecisionId: m.id,
            surface,
            kind: "pre_approval",
            status: "open",
          })
          .onConflictDoNothing()
          .returning()
      )[0];
      if (!inserted) continue; // already open — never re-notify
      const v = (
        await tx
          .select()
          .from(decisionVersions)
          .where(and(eq(decisionVersions.decisionId, m.id), eq(decisionVersions.version, m.currentVersion)))
          .limit(1)
      )[0];
      await writeAudit(tx, {
        orgId,
        projectId: input.doc.projectId,
        action: "conflict.opened",
        entityKind: "conflict",
        entityId: inserted.id,
        payload: { kind: "pre_approval", surface, constraintDecisionId: input.decisionId, engDecisionId: m.id },
      });
      await tx
        .insert(writebacks)
        .values({
          orgId,
          projectId: input.doc.projectId,
          connectionId: input.doc.connectionId,
          tool: "notion",
          kind: "conflict_comment",
          targetRef: input.doc.externalId,
          payload: {
            conflictId: inserted.id,
            anchorBlockId: input.anchorBlockId ?? null,
            body: composeConflictComment({
              constraintText: input.ruleText,
              engRuleText: v?.ruleText ?? "",
              surface,
              engDecisionCreatedAt: m.createdAt,
            }),
          },
          dedupeKey: `preapproval:${inserted.id}`,
        })
        .onConflictDoNothing();
      opened.push({ conflictId: inserted.id, engDecisionId: m.id, surface });
    }
  }
  return opened;
}

export async function listConflicts(
  orgId: string,
  projectId: string,
  status?: string,
): Promise<
  Array<{
    id: string;
    kind: string;
    status: string;
    surface: string;
    constraintDecisionId: string;
    engDecisionId: string | null;
    dismissReason: string | null;
    openedAt: Date;
  }>
> {
  return withOrg(orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(conflicts)
      .where(
        status
          ? and(eq(conflicts.projectId, projectId), eq(conflicts.status, status))
          : eq(conflicts.projectId, projectId),
      );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      surface: r.surface,
      constraintDecisionId: r.constraintDecisionId,
      engDecisionId: r.engDecisionId,
      dismissReason: r.dismissReason,
      openedAt: r.openedAt,
    }));
  });
}

/** Dismiss a conflict as a false positive — the reason feeds extraction/scoping tuning. */
export async function dismissConflict(
  orgId: string,
  conflictId: string,
  memberId: string,
  reason?: string,
): Promise<{ status: string }> {
  return withOrg(orgId, async (tx) => {
    const c = (await tx.select().from(conflicts).where(eq(conflicts.id, conflictId)).limit(1))[0];
    if (!c) throw Object.assign(new Error("conflict not found"), { statusCode: 404 });
    if (c.status !== "open") throw Object.assign(new Error(`conflict is ${c.status}, not open`), { statusCode: 409 });
    await tx
      .update(conflicts)
      .set({ status: "dismissed", dismissReason: reason ?? null, resolvedAt: new Date(), resolvedBy: memberId })
      .where(eq(conflicts.id, conflictId));
    await writeAudit(tx, {
      orgId,
      projectId: c.projectId,
      actorMemberId: memberId,
      action: "conflict.resolved",
      entityKind: "conflict",
      entityId: conflictId,
      payload: { resolution: "dismissed", reason },
    });
    return { status: "dismissed" };
  });
}
