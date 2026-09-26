/**
 * Exceptions (PRD §7.6): a member requests, an owner/admin approves or rejects; every transition is
 * attributed and audited. An exception binds to the exact published version it was granted for:
 * when an assignment moves to a new version, the exception stops applying and shows as needing
 * review (A12) — it is never silently carried forward. The covered content's hash is recorded for
 * the reviewer's diff. Expiry restores applicability at the next resolution and reminds the
 * requester. "Exempt" is never a pass.
 */
import { and, desc, eq, lte } from "drizzle-orm";
import { withOrg, withSystem } from "../db/rls.js";
import { catalogItems, exceptions, itemVersions, members, projects, skillPackages } from "../db/schema.js";
import { writeAudit } from "../audit/audit-service.js";
import { OrgError } from "./org-authority.js";
import { loadActiveAssignmentsTx, requireAdminTx } from "./applicability.js";
import { requirementHash } from "./resolve.js";
import type { StandardContent } from "./catalog.js";

type Scope = { projectId?: string; repoId?: string; taskType?: string; memberId?: string };

export interface ExceptionRequest {
  target: "requirement" | "skill_assignment";
  versionId: string;
  requirementKey?: string | null;
  scope: Scope;
  reason: string;
  expiresAt?: string | null;
  sourceCheckId?: string | null;
}

export async function requestException(orgId: string, actor: string, input: ExceptionRequest): Promise<{ id: string }> {
  const reason = input.reason?.trim();
  if (!reason) throw new OrgError(400, "a reason is required");
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && (Number.isNaN(+expiresAt) || +expiresAt <= Date.now())) throw new OrgError(400, "expiry must be in the future");
  return withOrg(orgId, async (tx) => {
    const v = (
      await tx
        .select({ id: itemVersions.id, itemId: itemVersions.itemId, state: itemVersions.state, content: itemVersions.content, packageId: itemVersions.packageId, kind: catalogItems.kind })
        .from(itemVersions)
        .innerJoin(catalogItems, eq(catalogItems.id, itemVersions.itemId))
        .where(and(eq(itemVersions.id, input.versionId), eq(itemVersions.orgId, orgId)))
        .limit(1)
    )[0];
    if (!v || v.state !== "published") throw new OrgError(404, "published version not found");
    let contentHash: string;
    if (input.target === "requirement") {
      if (v.kind !== "standard") throw new OrgError(400, "requirement exceptions apply to standards");
      const r = (v.content as StandardContent).requirements.find((x) => x.key === input.requirementKey);
      if (!r) throw new OrgError(404, "requirement not found in that version");
      contentHash = requirementHash(r);
    } else {
      if (v.kind !== "skill" || !v.packageId) throw new OrgError(400, "skill exceptions apply to skills");
      contentHash = (await tx.select().from(skillPackages).where(eq(skillPackages.id, v.packageId)).limit(1))[0]!.packageHash;
    }
    const scope: Scope = {};
    if (input.scope?.projectId) {
      const p = (await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.id, input.scope.projectId), eq(projects.orgId, orgId))).limit(1))[0];
      if (!p) throw new OrgError(404, "project not found");
      scope.projectId = p.id;
    }
    if (input.scope?.repoId) scope.repoId = input.scope.repoId;
    if (input.scope?.taskType === "code" || input.scope?.taskType === "prd") scope.taskType = input.scope.taskType;
    if (input.scope?.memberId) scope.memberId = input.scope.memberId;
    const [row] = await tx
      .insert(exceptions)
      .values({
        orgId,
        target: input.target,
        itemId: v.itemId,
        versionId: v.id,
        requirementKey: input.target === "requirement" ? (input.requirementKey ?? null) : null,
        scope,
        reason: reason.slice(0, 2000),
        expiresAt,
        requestedBy: actor,
        contentHash,
        sourceCheckId: input.sourceCheckId ?? null,
      })
      .returning({ id: exceptions.id });
    await writeAudit(tx, {
      orgId,
      projectId: scope.projectId ?? null,
      actorMemberId: actor,
      action: "exception.requested",
      entityKind: "exception",
      entityId: row!.id,
      payload: { target: input.target, versionId: v.id, requirementKey: input.requirementKey ?? null, scope },
    });
    return { id: row!.id };
  });
}

export async function decideException(orgId: string, actor: string, id: string, approve: boolean, note?: string): Promise<void> {
  await withOrg(orgId, async (tx) => {
    await requireAdminTx(tx, orgId, actor);
    const x = (await tx.select().from(exceptions).where(and(eq(exceptions.id, id), eq(exceptions.orgId, orgId))).limit(1))[0];
    if (!x) throw new OrgError(404, "exception not found");
    if (x.state !== "requested") throw new OrgError(409, `exception is already ${x.state}`);
    if (approve && x.expiresAt && +x.expiresAt <= Date.now()) throw new OrgError(409, "the requested expiry has passed");
    const state = approve ? "approved" : "rejected";
    const upd = await tx
      .update(exceptions)
      .set({ state, decidedBy: actor, decidedAt: new Date(), decisionNote: note?.trim().slice(0, 2000) || null })
      .where(and(eq(exceptions.id, id), eq(exceptions.state, "requested")))
      .returning({ id: exceptions.id });
    if (!upd.length) throw new OrgError(409, "exception changed meanwhile");
    await writeAudit(tx, {
      orgId,
      projectId: x.scope.projectId ?? null,
      actorMemberId: actor,
      action: `exception.${state}`,
      entityKind: "exception",
      entityId: id,
      payload: { note: note ?? null },
    });
  });
}

/** Hourly job: approved exceptions past expiry → expired (audited; the requester sees a reminder). */
export async function expireExceptions(now = new Date()): Promise<{ expired: number }> {
  return withSystem(async (tx) => {
    const due = await tx
      .update(exceptions)
      .set({ state: "expired" })
      .where(and(eq(exceptions.state, "approved"), lte(exceptions.expiresAt, now)))
      .returning();
    for (const x of due)
      await writeAudit(tx, {
        orgId: x.orgId,
        projectId: x.scope.projectId ?? null,
        action: "exception.expired",
        entityKind: "exception",
        entityId: x.id,
        payload: { requestedBy: x.requestedBy },
      });
    return { expired: due.length };
  });
}

/**
 * Exceptions with a computed review status. `needsReview`: approved, but no currently assigned
 * version still has the content it covers while the item itself is still assigned.
 */
export async function listExceptions(orgId: string, opts: { projectId?: string } = {}) {
  return withOrg(orgId, async (tx) => {
    const rows = (await tx.select().from(exceptions).where(eq(exceptions.orgId, orgId)).orderBy(desc(exceptions.createdAt)).limit(500)).filter(
      (x) => !opts.projectId || !x.scope.projectId || x.scope.projectId === opts.projectId,
    );
    const active = await loadActiveAssignmentsTx(tx, orgId);
    const present = contentPresence(active);
    const logins = new Map((await tx.select({ id: members.id, l: members.githubLogin }).from(members).where(eq(members.orgId, orgId))).map((m) => [m.id, m.l]));
    const names = new Map((await tx.select({ id: catalogItems.id, n: catalogItems.name }).from(catalogItems).where(eq(catalogItems.orgId, orgId))).map((c) => [c.id, c.n]));
    const vs = rows.length
      ? await tx.select({ id: itemVersions.id, version: itemVersions.version, content: itemVersions.content }).from(itemVersions).where(eq(itemVersions.orgId, orgId))
      : [];
    const vById = new Map(vs.map((v) => [v.id, v]));
    return rows.map((x) => {
      const v = vById.get(x.versionId);
      const req = x.requirementKey ? (v?.content as StandardContent | undefined)?.requirements?.find((r) => r.key === x.requirementKey) : undefined;
      const expired = x.state === "expired" || (x.state === "approved" && x.expiresAt != null && +x.expiresAt <= Date.now());
      const needsReview = x.state === "approved" && !expired && present.items.has(x.itemId) && !present.has(x);
      return {
        id: x.id,
        target: x.target,
        itemId: x.itemId,
        itemName: names.get(x.itemId) ?? "Removed item",
        versionId: x.versionId,
        version: v?.version ?? null,
        requirementKey: x.requirementKey,
        requirementText: req?.text ?? null,
        scope: x.scope,
        reason: x.reason,
        expiresAt: x.expiresAt,
        state: expired ? "expired" : needsReview ? "needs_review" : x.state,
        requestedBy: x.requestedBy ? (logins.get(x.requestedBy) ?? null) : null,
        requestedById: x.requestedBy,
        decidedBy: x.decidedBy ? (logins.get(x.decidedBy) ?? null) : null,
        decidedAt: x.decidedAt,
        decisionNote: x.decisionNote,
        sourceCheckId: x.sourceCheckId,
        createdAt: x.createdAt,
      };
    });
  });
}

/** Which exact versions the given assignments currently deliver — for review/preview. */
export function contentPresence(active: Awaited<ReturnType<typeof loadActiveAssignmentsTx>>) {
  const versions = new Set<string>();
  const items = new Set<string>();
  for (const a of active)
    for (const e of a.items) {
      items.add(e.itemId);
      versions.add(e.versionId);
    }
  return { items, has: (x: { versionId: string }) => versions.has(x.versionId) };
}
