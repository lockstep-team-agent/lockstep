/**
 * Releases, assignments and "why this applies". Milestone 1 records assignments as data and
 * resolves them for a work context; rollout mechanics (preview, fan-out, sync) arrive in M2.
 * Resolution reads assignments only — concept placement on the Map never feeds into it.
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import { withOrg, type Tx } from "../db/rls.js";
import {
  assignmentRevisions,
  assignments,
  catalogItems,
  exceptions,
  itemVersions,
  releases,
  releaseWithdrawals,
  skillPackages,
  repos,
  type ReleaseItem,
  type Selectors,
} from "../db/schema.js";
import { writeAudit } from "../audit/audit-service.js";
import { sha256Hex } from "../storage/blob.js";
import { getOrgRoleTx, OrgError, teamIdsForMemberTx } from "./org-authority.js";
import type { StandardContent } from "./catalog.js";
import { resolveApplicability, type ActiveAssignment, type ExceptionRow, type WorkContext } from "./resolve.js";

export async function requireAdminTx(tx: Tx, orgId: string, actor: string) {
  const r = await getOrgRoleTx(tx, orgId, actor);
  if (r !== "owner" && r !== "admin") throw new OrgError(403, "requires org owner or admin");
}

/** Validate a would-be release: existing, PUBLISHED versions, one per item. Sorted, hashable. */
export async function releaseItemsTx(tx: Tx, orgId: string, versionIds: string[]): Promise<ReleaseItem[]> {
  if (versionIds.length === 0) throw new OrgError(400, "a release needs at least one version");
  const load = (ids: string[]) =>
    tx
      .select({ id: itemVersions.id, itemId: itemVersions.itemId, state: itemVersions.state, kind: catalogItems.kind, content: itemVersions.content })
      .from(itemVersions)
      .innerJoin(catalogItems, eq(catalogItems.id, itemVersions.itemId))
      .where(and(eq(itemVersions.orgId, orgId), inArray(itemVersions.id, ids)));
  const rows = await load([...new Set(versionIds)]);
  if (rows.length !== new Set(versionIds).size) throw new OrgError(404, "some versions don't exist in this org");
  // A standard travels with the exact skill/check versions it pins (PRD Example A).
  const pinned = rows
    .filter((r) => r.kind === "standard")
    .flatMap((r) => [...((r.content as StandardContent).skills ?? []), ...((r.content as StandardContent).checks ?? [])].map((p) => p.versionId))
    .filter((id) => !rows.some((r) => r.id === id));
  if (pinned.length) rows.push(...(await load([...new Set(pinned)])));
  if (rows.some((r) => r.state !== "published")) throw new OrgError(409, "only published versions can be released (including linked skills and checks)");
  if (new Set(rows.map((r) => r.itemId)).size !== rows.length)
    throw new OrgError(409, "a release can hold one version per item — a linked skill or check is also selected at another version");
  return rows.map((r) => ({ itemId: r.itemId, versionId: r.id, kind: r.kind })).sort((a, b) => (a.itemId < b.itemId ? -1 : 1));
}

export async function insertReleaseTx(tx: Tx, orgId: string, actor: string, name: string, items: ReleaseItem[]): Promise<string> {
  const [rel] = await tx
    .insert(releases)
    .values({ orgId, name: name.trim().slice(0, 120) || "Release", items, releaseHash: sha256Hex(JSON.stringify(items)), createdBy: actor })
    .returning({ id: releases.id });
  await writeAudit(tx, { orgId, actorMemberId: actor, action: "release.created", entityKind: "release", entityId: rel!.id, payload: { items } });
  return rel!.id;
}

/** A release is an immutable selection of PUBLISHED versions (one skill alone is valid). */
export async function createRelease(orgId: string, actor: string, name: string, versionIds: string[]): Promise<{ id: string }> {
  if (versionIds.length === 0) throw new OrgError(400, "a release needs at least one version");
  return withOrg(orgId, async (tx) => {
    await requireAdminTx(tx, orgId, actor);
    return { id: await insertReleaseTx(tx, orgId, actor, name, await releaseItemsTx(tx, orgId, versionIds)) };
  });
}

export function cleanSelectors(s: Selectors): Selectors {
  const uniq = (xs?: string[]) =>
    xs?.length ? [...new Set(xs.map((x) => x.trim()).filter(Boolean))].slice(0, 500) : undefined;
  const aud = s.audience;
  return {
    projects: uniq(s.projects),
    repos: uniq(s.repos),
    pathGlobs: uniq(s.pathGlobs),
    taskTypes: uniq(s.taskTypes)?.filter((t) => t === "code" || t === "prd"),
    audience: aud && aud.kind !== "all" ? { kind: aud.kind, ids: uniq(aud.ids) ?? [] } : { kind: "all" },
  };
}

/** Record an assignment (revision 1). Publishing never creates or changes one on its own. */
export async function createAssignment(
  orgId: string,
  actor: string,
  input: {
    name: string;
    releaseId: string;
    selectors: Selectors;
    level: "required" | "recommended";
    pilot?: Selectors | null;
  },
): Promise<{ id: string; revision: number }> {
  return withOrg(orgId, async (tx) => {
    await requireAdminTx(tx, orgId, actor);
    const { lockRolloutsTx } = await import("./rollouts.js");
    await lockRolloutsTx(tx, orgId); // same rollout protocol as applyChange
    const rel = (
      await tx
        .select()
        .from(releases)
        .where(and(eq(releases.id, input.releaseId), eq(releases.orgId, orgId)))
        .limit(1)
    )[0];
    if (!rel) throw new OrgError(404, "release not found");
    const [a] = await tx
      .insert(assignments)
      .values({ orgId, name: input.name.trim().slice(0, 120) || rel.name, ownerMemberId: actor, currentRevision: 1 })
      .returning();
    await tx.insert(assignmentRevisions).values({
      orgId,
      assignmentId: a!.id,
      revision: 1,
      releaseId: rel.id,
      selectors: cleanSelectors(input.selectors),
      level: input.level,
      pilot: input.pilot ? cleanSelectors(input.pilot) : null,
      reason: input.pilot ? "pilot" : "create",
      createdBy: actor,
    });
    await writeAudit(tx, {
      orgId,
      actorMemberId: actor,
      action: "assignment.created",
      entityKind: "assignment",
      entityId: a!.id,
      entityVersion: 1,
      payload: { releaseId: rel.id },
    });
    return { id: a!.id, revision: 1 };
  });
}

/** Every non-retired assignment at its current revision, with release contents expanded. */
/** One assignment's effective revision, before its release is expanded. */
export interface AssignmentRow {
  assignmentId: string;
  name: string;
  revision: number;
  releaseId: string;
  selectors: Selectors;
  level: "required" | "recommended";
  pilot: Selectors | null;
}

/**
 * Active (non-retired) assignments at their current revision, expanded to exact versions.
 * `rewrite` lets a rollout preview resolve a hypothetical change through this same path.
 */
export interface Hypothetical {
  rewrite?: (rows: AssignmentRow[]) => AssignmentRow[];
  /** A withdrawal that hasn't been applied yet. */
  withdrawal?: { releaseId: string; replacementReleaseId: string | null };
  /** A release that hasn't been created yet (id is a placeholder). */
  draftRelease?: { id: string; items: ReleaseItem[] };
}

export async function loadActiveAssignmentsTx(tx: Tx, orgId: string, h: Hypothetical = {}): Promise<ActiveAssignment[]> {
  const { rewrite, withdrawal: extraWithdrawal, draftRelease } = h;
  const as = await tx
    .select()
    .from(assignments)
    .where(and(eq(assignments.orgId, orgId), ne(assignments.state, "retired")));
  const revs = as.length
    ? await tx
        .select()
        .from(assignmentRevisions)
        .where(
          and(
            eq(assignmentRevisions.orgId, orgId),
            inArray(
              assignmentRevisions.assignmentId,
              as.map((a) => a.id),
            ),
          ),
        )
    : [];
  let rows: AssignmentRow[] = as.flatMap((a) => {
    const r = revs.find((x) => x.assignmentId === a.id && x.revision === a.currentRevision);
    return r
      ? [
          {
            assignmentId: a.id,
            name: a.name,
            revision: r.revision,
            releaseId: r.releaseId,
            selectors: r.selectors,
            level: r.level as "required" | "recommended",
            pilot: r.pilot ?? null,
          },
        ]
      : [];
  });
  if (rewrite) rows = rewrite(rows);
  if (rows.length === 0) return [];
  const current = rows.map((r) => ({ r }));
  // A withdrawn release is never resolved again: its replacement stands in (following the chain,
  // since a replacement can itself be withdrawn), or it drops out (A10).
  const withdrawn = new Map(
    (await tx.select().from(releaseWithdrawals).where(eq(releaseWithdrawals.orgId, orgId))).map((w) => [
      w.releaseId,
      w.replacementReleaseId,
    ]),
  );
  if (extraWithdrawal) withdrawn.set(extraWithdrawal.releaseId, extraWithdrawal.replacementReleaseId);
  const effective = (id: string): string | null => {
    let cur: string | null = id;
    for (let hops = 0; cur && hops < 20; hops++) {
      if (!withdrawn.has(cur)) return cur;
      cur = withdrawn.get(cur) ?? null;
    }
    return null; // a cycle or an absurd chain resolves to nothing, never to a withdrawn release
  };
  const relIds = [...new Set(current.map((x) => effective(x.r.releaseId)).filter((x): x is string => Boolean(x)))];
  const stored = relIds.filter((id) => id !== draftRelease?.id);
  const rels: Array<{ id: string; items: ReleaseItem[] }> = [
    ...(stored.length ? await tx.select().from(releases).where(inArray(releases.id, stored)) : []),
    ...(draftRelease && relIds.includes(draftRelease.id) ? [draftRelease] : []),
  ];
  const versionIds = [...new Set(rels.flatMap((r) => r.items.map((i) => i.versionId)))];
  const vs = versionIds.length
    ? await tx
        .select({
          id: itemVersions.id,
          itemId: itemVersions.itemId,
          version: itemVersions.version,
          content: itemVersions.content,
          packageId: itemVersions.packageId,
          packageHash: skillPackages.packageHash,
          slug: catalogItems.slug,
          name: catalogItems.name,
          kind: catalogItems.kind,
        })
        .from(itemVersions)
        .innerJoin(catalogItems, eq(catalogItems.id, itemVersions.itemId))
        .leftJoin(skillPackages, eq(skillPackages.id, itemVersions.packageId))
        .where(inArray(itemVersions.id, versionIds))
    : [];
  const vById = new Map(vs.map((v) => [v.id, v]));
  return current.map(({ r }) => ({
    assignmentId: r.assignmentId,
    name: r.name,
    revision: r.revision,
    level: r.level,
    selectors: r.selectors,
    pilot: r.pilot,
    releaseId: effective(r.releaseId) ?? undefined,
    items: (rels.find((x) => x.id === effective(r.releaseId))?.items ?? []).flatMap((i) => {
      const v = vById.get(i.versionId);
      if (!v) return [];
      const sc = v.kind === "standard" ? (v.content as StandardContent) : null;
      const reqs = sc ? sc.requirements.map((q) => ({ key: q.key!, text: q.text, level: q.level })) : undefined;
      return [
        {
          itemId: v.itemId,
          versionId: v.id,
          kind: v.kind as "standard" | "skill" | "check",
          name: v.name,
          slug: v.slug,
          packageId: v.packageId,
          packageHash: v.packageHash,
          version: v.version,
          requirements: reqs,
          ...(sc ? { taskTypes: sc.taskTypes ?? [], pinnedChecks: (sc.checks ?? []).map((p) => p.versionId) } : {}),
          ...(v.kind === "skill" ? { whenToUse: String((v.content as { whenToUse?: string }).whenToUse ?? "") } : {}),
          ...(v.kind === "check"
            ? {
                check: (({ artifactType, method, requirementKeys, requiredSections, instructions }) => ({
                  artifactType: String(artifactType ?? "prd"),
                  method: String(method ?? "structural"),
                  requirementKeys: (requirementKeys as string[] | undefined) ?? [],
                  requiredSections: (requiredSections as string[] | undefined) ?? [],
                  instructions: String(instructions ?? ""),
                }))(v.content as Record<string, unknown>),
              }
            : {}),
        },
      ];
    }),
  }));
}

export async function approvedExceptionsTx(tx: Tx, orgId: string): Promise<ExceptionRow[]> {
  const rows = await tx
    .select()
    .from(exceptions)
    .where(and(eq(exceptions.orgId, orgId), eq(exceptions.state, "approved")));
  return rows.map((e) => ({
    id: e.id,
    target: e.target as ExceptionRow["target"],
    itemId: e.itemId,
    versionId: e.versionId,
    requirementKey: e.requirementKey,
    scope: e.scope,
    expiresAt: e.expiresAt,
    contentHash: e.contentHash,
  }));
}

/** "Why this applies" for a member's work context in a project. */
export async function whyThisApplies(
  orgId: string,
  projectId: string,
  memberId: string,
  q: { repoId?: string | null; paths?: string[] | null; taskType?: "code" | "prd" | null },
) {
  return withOrg(orgId, async (tx) => {
    if (q.repoId) {
      const r = (
        await tx
          .select({ id: repos.id })
          .from(repos)
          .where(and(eq(repos.id, q.repoId), eq(repos.projectId, projectId)))
          .limit(1)
      )[0];
      if (!r) throw new OrgError(404, "repository not found in this project");
    }
    const ctx: WorkContext = {
      projectId,
      repoId: q.repoId ?? null,
      paths: q.paths ?? null,
      taskType: q.taskType ?? null,
      memberId,
      teamIds: await teamIdsForMemberTx(tx, memberId),
    };
    const res = resolveApplicability(
      ctx,
      await loadActiveAssignmentsTx(tx, orgId),
      await approvedExceptionsTx(tx, orgId),
    );
    const limitations = [
      ...(ctx.taskType === null
        ? ["No task type was given, so task-scoped assignments are listed as “may apply”."]
        : []),
      ...(ctx.paths === null
        ? ["No file paths were given, so path-scoped assignments are listed as “may apply”."]
        : []),
    ];
    return { context: ctx, ...res, limitations };
  });
}

/**
 * Project Standards tab: assignments that can apply somewhere in this project (org baseline, the
 * project itself, or one of its repositories), with their contents and approved exceptions.
 */
export async function projectStandards(orgId: string, projectId: string) {
  return withOrg(orgId, async (tx) => {
    const projectRepos = await tx.select({ id: repos.id, gitRemote: repos.gitRemote }).from(repos).where(eq(repos.projectId, projectId));
    const repoIds = new Set(projectRepos.map((r) => r.id));
    const active = await loadActiveAssignmentsTx(tx, orgId);
    const relevant = active.filter((a) => {
      const s = a.selectors;
      if (s.projects?.length && !s.projects.includes(projectId)) return false;
      if (s.repos?.length && !s.repos.some((r) => repoIds.has(r))) return false;
      return true;
    });
    const ex = await approvedExceptionsTx(tx, orgId);
    return {
      repos: projectRepos,
      assignments: relevant.map((a) => ({
        assignmentId: a.assignmentId,
        name: a.name,
        revision: a.revision,
        level: a.level,
        scope: {
          baseline: !a.selectors.projects?.length && !a.selectors.repos?.length,
          repos: (a.selectors.repos ?? []).filter((r) => repoIds.has(r)),
          pathGlobs: a.selectors.pathGlobs ?? [],
          taskTypes: a.selectors.taskTypes ?? [],
          audience: a.selectors.audience ?? { kind: "all" },
          pilot: Boolean(a.pilot),
        },
        items: a.items,
        exceptions: ex.filter((e) => a.items.some((i) => i.versionId === e.versionId) && (!e.scope.projectId || e.scope.projectId === projectId)),
      })),
    };
  });
}
