import { and, eq } from "drizzle-orm";
import { withOrg, type Tx } from "../db/rls.js";
import { conflicts, decisions, decisionVersions, sourceDocuments, writebacks } from "../db/schema.js";
import { writeAudit } from "../audit/audit-service.js";
import { capabilitySurfacesTx } from "../ledger/ledger-service.js";
import { getProjectRoleTx } from "../auth/permissions.js";
import { notifyConflictTx } from "../routing/routing-engine.js";

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

export interface ConflictView {
  id: string;
  kind: string;
  status: string;
  surface: string;
  constraintDecisionId: string;
  engDecisionId: string | null;
  constraintRuleText: string;
  engRuleText: string | null;
  docId: string | null;
  docTitle: string | null;
  docUrl: string | null;
  dismissReason: string | null;
  openedAt: Date;
  resolvedAt: Date | null;
}

async function ruleTextTx(tx: Tx, id: string | null): Promise<string | null> {
  if (!id) return null;
  const d = (await tx.select().from(decisions).where(eq(decisions.id, id)).limit(1))[0];
  if (!d) return null;
  const v = (
    await tx.select().from(decisionVersions).where(and(eq(decisionVersions.decisionId, id), eq(decisionVersions.version, d.currentVersion))).limit(1)
  )[0];
  return v?.ruleText ?? "";
}

/** Conflicts for the dashboard tab — enriched with both rule texts + the constraint's source doc. */
export async function listConflicts(orgId: string, projectId: string, status?: string): Promise<ConflictView[]> {
  return withOrg(orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(conflicts)
      .where(status ? and(eq(conflicts.projectId, projectId), eq(conflicts.status, status)) : eq(conflicts.projectId, projectId));
    const out: ConflictView[] = [];
    for (const r of rows) {
      // Resolve the constraint's source doc via its current version provenance.
      const cd = (await tx.select().from(decisions).where(eq(decisions.id, r.constraintDecisionId)).limit(1))[0];
      const cv = cd
        ? (await tx.select().from(decisionVersions).where(and(eq(decisionVersions.decisionId, cd.id), eq(decisionVersions.version, cd.currentVersion))).limit(1))[0]
        : undefined;
      const docId = (cv?.provenance as { documentId?: string } | null)?.documentId ?? null;
      const doc = docId ? (await tx.select().from(sourceDocuments).where(eq(sourceDocuments.id, docId)).limit(1))[0] : undefined;
      out.push({
        id: r.id,
        kind: r.kind,
        status: r.status,
        surface: r.surface,
        constraintDecisionId: r.constraintDecisionId,
        engDecisionId: r.engDecisionId,
        constraintRuleText: cv?.ruleText ?? "",
        engRuleText: await ruleTextTx(tx, r.engDecisionId),
        docId: doc?.id ?? null,
        docTitle: doc?.title ?? null,
        docUrl: doc?.url ?? null,
        dismissReason: r.dismissReason,
        openedAt: r.openedAt,
        resolvedAt: r.resolvedAt,
      });
    }
    out.sort((a, b) => b.openedAt.getTime() - a.openedAt.getTime());
    return out;
  });
}

/** May resolve a conflict: the constraint's doc owner, or a project owner/pm. */
async function canResolveConflictTx(tx: Tx, projectId: string, memberId: string, constraintDecisionId: string): Promise<boolean> {
  const role = await getProjectRoleTx(tx, projectId, memberId);
  if (role === "owner" || role === "pm") return true;
  const cd = (await tx.select().from(decisions).where(eq(decisions.id, constraintDecisionId)).limit(1))[0];
  const cv = cd
    ? (await tx.select().from(decisionVersions).where(and(eq(decisionVersions.decisionId, cd.id), eq(decisionVersions.version, cd.currentVersion))).limit(1))[0]
    : undefined;
  const docId = (cv?.provenance as { documentId?: string } | null)?.documentId;
  if (!docId) return false;
  const doc = (await tx.select().from(sourceDocuments).where(eq(sourceDocuments.id, docId)).limit(1))[0];
  return Boolean(doc && (doc.ownerMemberId === memberId || doc.registeredBy === memberId));
}

/**
 * Resolve an open conflict. `holds` — the constraint wins; the eng decision is expected to be revised
 * (its author is re-notified). `dismiss` — a false positive (reason feeds tuning). The **concede**
 * path is not here: the PM edits the PRD in Notion → re-extraction re-ratifies → auto-resolve.
 */
export async function resolveConflict(
  orgId: string,
  conflictId: string,
  memberId: string,
  input: { resolution: "holds" | "dismiss"; reason?: string },
): Promise<{ status: string }> {
  return withOrg(orgId, async (tx) => {
    const c = (await tx.select().from(conflicts).where(eq(conflicts.id, conflictId)).limit(1))[0];
    if (!c) throw Object.assign(new Error("conflict not found"), { statusCode: 404 });
    if (c.status !== "open") throw Object.assign(new Error(`conflict is ${c.status}, not open`), { statusCode: 409 });
    if (!(await canResolveConflictTx(tx, c.projectId, memberId, c.constraintDecisionId)))
      throw Object.assign(new Error("resolving a conflict requires owner/pm role or document ownership"), { statusCode: 403 });
    const status = input.resolution === "holds" ? "resolved_eng_revised" : "dismissed";
    await tx
      .update(conflicts)
      .set({ status, dismissReason: input.resolution === "dismiss" ? (input.reason ?? null) : null, resolvedAt: new Date(), resolvedBy: memberId })
      .where(eq(conflicts.id, conflictId));
    await writeAudit(tx, {
      orgId,
      projectId: c.projectId,
      actorMemberId: memberId,
      action: "conflict.resolved",
      entityKind: "conflict",
      entityId: conflictId,
      payload: { resolution: input.resolution, reason: input.reason },
    });
    // Hold: the constraint stands — tell the eng author to revise/supersede their decision.
    if (input.resolution === "holds" && c.engDecisionId) {
      const ed = (await tx.select().from(decisions).where(eq(decisions.id, c.engDecisionId)).limit(1))[0];
      const ev = ed
        ? (await tx.select().from(decisionVersions).where(and(eq(decisionVersions.decisionId, ed.id), eq(decisionVersions.version, ed.currentVersion))).limit(1))[0]
        : undefined;
      const author = (ev?.proposedBy as string | null) ?? null;
      if (author) await notifyConflictTx(tx, orgId, { projectId: c.projectId, memberId: author, conflictId });
    }
    return { status };
  });
}

/** Back-compat thin wrapper — dismiss is a resolution. */
export async function dismissConflict(orgId: string, conflictId: string, memberId: string, reason?: string): Promise<{ status: string }> {
  return resolveConflict(orgId, conflictId, memberId, { resolution: "dismiss", reason });
}

/** Auto-resolve open drift on a constraint when a PRD amendment re-ratifies it (concede path). */
export async function autoResolveDriftForConstraintTx(tx: Tx, orgId: string, projectId: string, constraintDecisionId: string, resolution: "resolved_prd_amended" | "dismissed", reason?: string): Promise<void> {
  const open = await tx
    .select()
    .from(conflicts)
    .where(and(eq(conflicts.constraintDecisionId, constraintDecisionId), eq(conflicts.kind, "drift"), eq(conflicts.status, "open")));
  for (const c of open) {
    await tx
      .update(conflicts)
      .set({ status: resolution, dismissReason: reason ?? null, resolvedAt: new Date() })
      .where(eq(conflicts.id, c.id));
    await writeAudit(tx, {
      orgId,
      projectId,
      action: "conflict.resolved",
      entityKind: "conflict",
      entityId: c.id,
      payload: { resolution, auto: true },
    });
  }
}
