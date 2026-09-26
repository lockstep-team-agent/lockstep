/**
 * Rollouts: preview → apply for every change to what environments hold, plus adoption reporting.
 *
 * Every change (create, revise/expand/pilot, rollback, retire, withdraw) is previewed through the
 * SAME resolution the sync endpoint uses (`loadActiveAssignmentsTx` with a rewrite), so the
 * preview can't disagree with what environments will actually receive. Applying writes an
 * immutable revision (or retirement / withdrawal); environments pick it up at their next sync.
 *
 * ponytail: preview and adoption resolve every enrolled environment in memory — fine into the low
 * thousands; page by project/repo with SQL pre-filters when orgs grow past that.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { withOrg, type Tx } from "../db/rls.js";
import {
  assignmentRevisions,
  assignments,
  environments,
  members,
  projectMembers,
  releases,
  releaseWithdrawals,
  repos,
  teamMembers,
  type Selectors,
} from "../db/schema.js";
import { writeAudit } from "../audit/audit-service.js";
import { OrgError } from "./org-authority.js";
import {
  approvedExceptionsTx,
  cleanSelectors,
  insertReleaseTx,
  loadActiveAssignmentsTx,
  releaseItemsTx,
  requireAdminTx,
  type AssignmentRow,
} from "./applicability.js";
import { FRESH_MS, itemState, latestReceiptsTx, resolveEnv, type EnvItemState, type EnvResolution } from "./environments.js";
import { artifactChecks, catalogItems, exceptions, skillPackages } from "../db/schema.js";
import { contentPresence } from "./exceptions.js";

export type Change =
  | {
      kind: "create";
      name?: string;
      /** An existing release, or versions to release as part of this rollout. */
      releaseId?: string;
      versionIds?: string[];
      selectors: Selectors;
      level: "required" | "recommended";
      pilot?: Selectors | null;
    }
  | {
      kind: "revise";
      assignmentId: string;
      releaseId?: string;
      /** New versions to release as part of this revision (instead of an existing releaseId). */
      versionIds?: string[];
      selectors?: Selectors;
      level?: "required" | "recommended";
      pilot?: Selectors | null;
    }
  | { kind: "rollback"; assignmentId: string; toRevision: number }
  | { kind: "retire"; assignmentId: string }
  | { kind: "withdraw"; releaseId: string; replacementReleaseId?: string | null; reason?: string };

const NEW = "__new__";
const NEW_RELEASE = "00000000-0000-0000-0000-000000000000";

async function assignmentTx(tx: Tx, orgId: string, id: string) {
  const a = (
    await tx
      .select()
      .from(assignments)
      .where(and(eq(assignments.id, id), eq(assignments.orgId, orgId)))
      .limit(1)
  )[0];
  if (!a) throw new OrgError(404, "assignment not found");
  return a;
}

async function releaseTx(tx: Tx, orgId: string, id: string) {
  const r = (
    await tx
      .select()
      .from(releases)
      .where(and(eq(releases.id, id), eq(releases.orgId, orgId)))
      .limit(1)
  )[0];
  if (!r) throw new OrgError(404, "release not found");
  return r;
}

/** Turn a change into (a) the rewrite for preview and (b) the target assignment id, validating it. */
async function planTx(tx: Tx, orgId: string, c: Change) {
  switch (c.kind) {
    case "create": {
      const draft =
        c.releaseId === undefined ? { id: NEW_RELEASE, items: await releaseItemsTx(tx, orgId, c.versionIds ?? []) } : undefined;
      const relName = draft ? "" : (await releaseTx(tx, orgId, c.releaseId!)).name;
      const row: AssignmentRow = {
        assignmentId: NEW,
        name: c.name?.trim() || relName || "Rollout",
        revision: 1,
        releaseId: draft?.id ?? c.releaseId!,
        selectors: cleanSelectors(c.selectors ?? {}),
        level: c.level === "recommended" ? "recommended" : "required",
        pilot: c.pilot ? cleanSelectors(c.pilot) : null,
      };
      return { target: NEW, rewrite: (rows: AssignmentRow[]) => [...rows, row], next: row, draftRelease: draft };
    }
    case "revise":
    case "rollback": {
      const a = await assignmentTx(tx, orgId, c.assignmentId);
      if (a.state === "retired") throw new OrgError(409, "assignment is retired");
      const revs = await tx.select().from(assignmentRevisions).where(eq(assignmentRevisions.assignmentId, a.id));
      const cur = revs.find((r) => r.revision === a.currentRevision);
      if (!cur) throw new OrgError(409, "assignment has no current revision");
      const draft =
        c.kind === "revise" && c.versionIds?.length ? { id: NEW_RELEASE, items: await releaseItemsTx(tx, orgId, c.versionIds) } : undefined;
      const src =
        c.kind === "rollback"
          ? revs.find((r) => r.revision === c.toRevision)
          : { ...cur, ...(draft ? { releaseId: draft.id } : c.releaseId ? { releaseId: c.releaseId } : {}) };
      if (!src) throw new OrgError(404, "revision not found");
      if (c.kind === "rollback" && c.toRevision === a.currentRevision) throw new OrgError(409, "that revision is already current");
      if (!draft) await releaseTx(tx, orgId, src.releaseId);
      const row: AssignmentRow = {
        assignmentId: a.id,
        name: a.name,
        revision: a.currentRevision + 1,
        releaseId: src.releaseId,
        selectors: cleanSelectors(c.kind === "revise" && c.selectors ? c.selectors : src.selectors),
        level: ((c.kind === "revise" && c.level) || src.level) as "required" | "recommended",
        pilot:
          c.kind === "revise" && c.pilot !== undefined ? (c.pilot ? cleanSelectors(c.pilot) : null) : (src.pilot ?? null),
      };
      return {
        target: a.id,
        rewrite: (rows: AssignmentRow[]) => rows.map((r) => (r.assignmentId === a.id ? row : r)),
        next: row,
        draftRelease: draft,
      };
    }
    case "retire": {
      const a = await assignmentTx(tx, orgId, c.assignmentId);
      if (a.state === "retired") throw new OrgError(409, "assignment is already retired");
      return { target: a.id, rewrite: (rows: AssignmentRow[]) => rows.filter((r) => r.assignmentId !== a.id), next: null };
    }
    case "withdraw": {
      await releaseTx(tx, orgId, c.releaseId);
      if (c.replacementReleaseId) {
        if (c.replacementReleaseId === c.releaseId) throw new OrgError(400, "a release can't replace itself");
        await releaseTx(tx, orgId, c.replacementReleaseId);
      }
      const done = await tx.select().from(releaseWithdrawals).where(eq(releaseWithdrawals.releaseId, c.releaseId)).limit(1);
      if (done.length) throw new OrgError(409, "release is already withdrawn");
      return {
        target: null,
        rewrite: undefined,
        withdrawal: { releaseId: c.releaseId, replacementReleaseId: c.replacementReleaseId ?? null },
        next: null,
      };
    }
  }
}

/**
 * Fingerprint of the rollout state a preview was computed against: every assignment's revision and
 * state, and every withdrawal. Apply must present the preview's basis, so an admin never applies a
 * change whose impact was computed against state that has since moved (another admin's revision).
 */
async function basisTx(tx: Tx, orgId: string): Promise<string> {
  const as = await tx.select({ id: assignments.id, r: assignments.currentRevision, st: assignments.state }).from(assignments).where(eq(assignments.orgId, orgId));
  const wd = await tx.select({ id: releaseWithdrawals.releaseId }).from(releaseWithdrawals).where(eq(releaseWithdrawals.orgId, orgId));
  const lines = [...as.map((a) => `${a.id}@${a.r}:${a.st}`), ...wd.map((w) => `w:${w.id}`)].sort();
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 32);
}

/** Does this assignment deliver anything (skills or guidance) to this environment? */
const appliesIn = (r: EnvResolution, assignmentId: string) =>
  [...r.desired, ...r.guidance].some((d) => d.reasons.some((x) => x.assignmentId === assignmentId));

/**
 * One lock per org for everything that reads or writes rollout state as a whole: every writer and
 * every preview take it, so a preview's impact and its basis come from the same state (no rollout
 * change can commit mid-preview), and apply compares against exactly that.
 */
export async function lockRolloutsTx(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`rollouts:${orgId}`}, 0))`);
}

/** Members an assignment reaches, narrowed by its pilot when it has one. */
async function audienceTx(tx: Tx, orgId: string, s: Selectors, pilot: Selectors | null): Promise<Set<string>> {
  const all = await reachableMembersTx(tx, orgId, s);
  if (!pilot) return all;
  const p = await reachableMembersTx(tx, orgId, pilot);
  return new Set([...all].filter((m) => p.has(m)));
}

/** Members an assignment's selectors can reach (for "not yet enrolled" coverage). */
async function reachableMembersTx(tx: Tx, orgId: string, s: Selectors): Promise<Set<string>> {
  const aud = s.audience ?? { kind: "all" as const };
  let ids: string[];
  if (aud.kind === "members") ids = aud.ids;
  else if (aud.kind === "teams")
    ids = aud.ids.length
      ? (await tx.select({ m: teamMembers.memberId }).from(teamMembers).where(inArray(teamMembers.teamId, aud.ids))).map((r) => r.m)
      : [];
  else ids = (await tx.select({ id: members.id }).from(members).where(eq(members.orgId, orgId))).map((r) => r.id);
  const projectIds = new Set(s.projects ?? []);
  if (s.repos?.length)
    for (const r of await tx.select({ p: repos.projectId }).from(repos).where(inArray(repos.id, s.repos))) projectIds.add(r.p);
  if (projectIds.size) {
    const inProjects = new Set(
      (
        await tx
          .select({ m: projectMembers.memberId })
          .from(projectMembers)
          .where(and(inArray(projectMembers.projectId, [...projectIds]), eq(projectMembers.status, "active")))
      ).map((r) => r.m),
    );
    ids = ids.filter((id) => inProjects.has(id));
  }
  return new Set(ids);
}

async function envContextTx(tx: Tx, orgId: string) {
  const envs = await tx
    .select()
    .from(environments)
    .where(and(eq(environments.orgId, orgId), isNull(environments.unenrolledAt)));
  const tm = await tx.select().from(teamMembers).where(eq(teamMembers.orgId, orgId));
  const teamsOf = (m: string) => tm.filter((t) => t.memberId === m).map((t) => t.teamId);
  const exceptions = await approvedExceptionsTx(tx, orgId);
  const logins = new Map(
    (await tx.select({ id: members.id, login: members.githubLogin }).from(members).where(eq(members.orgId, orgId))).map((m) => [
      m.id,
      m.login,
    ]),
  );
  const repoNames = new Map(
    (await tx.select({ id: repos.id, r: repos.gitRemote }).from(repos).where(eq(repos.orgId, orgId))).map((r) => [r.id, r.r]),
  );
  return { envs, teamsOf, exceptions, logins, repoNames };
}

async function packagesFor(tx: Tx, as: Awaited<ReturnType<typeof loadActiveAssignmentsTx>>[]) {
  const ids = [...new Set(as.flat().flatMap((a) => a.items.map((i) => i.packageId)).filter((x): x is string => Boolean(x)))];
  const rows = ids.length ? await tx.select().from(skillPackages).where(inArray(skillPackages.id, ids)) : [];
  return new Map(rows.map((p) => [p.id, p]));
}

type EnvChange = { itemId: string; name: string; action: "install" | "update" | "remove"; from?: number; to?: number };

function diffEnv(before: EnvResolution, after: EnvResolution): EnvChange[] {
  const b = new Map(before.desired.map((d) => [d.itemId, d]));
  const a = new Map(after.desired.map((d) => [d.itemId, d]));
  const out: EnvChange[] = [];
  for (const [id, d] of a) {
    const was = b.get(id);
    if (!was) out.push({ itemId: id, name: d.name, action: "install", to: d.version });
    else if (was.versionId !== d.versionId) out.push({ itemId: id, name: d.name, action: "update", from: was.version, to: d.version });
  }
  for (const [id, d] of b) if (!a.has(id)) out.push({ itemId: id, name: d.name, action: "remove", from: d.version });
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

/** Impact of a change, computed without writing anything. */
export async function previewChange(orgId: string, actor: string, c: Change) {
  return withOrg(orgId, async (tx) => {
    await requireAdminTx(tx, orgId, actor);
    await lockRolloutsTx(tx, orgId);
    const basis = await basisTx(tx, orgId);
    const plan = await planTx(tx, orgId, c);
    const before = await loadActiveAssignmentsTx(tx, orgId);
    const after = await loadActiveAssignmentsTx(tx, orgId, {
      rewrite: plan.rewrite,
      withdrawal: "withdrawal" in plan ? plan.withdrawal : undefined,
      draftRelease: "draftRelease" in plan ? plan.draftRelease : undefined,
    });
    const pkgs = await packagesFor(tx, [before, after]);
    const ctx = await envContextTx(tx, orgId);
    const rows: Array<{
      envId: string;
      login: string;
      repo: string | null;
      adapter: string;
      supported: boolean;
      lastContactAt: Date;
      changes: EnvChange[];
      blocked: string[];
    }> = [];
    const reached = new Set<string>();
    let affected = 0;
    let unsupported = 0;
    const totals = { install: 0, update: 0, remove: 0 };
    const blocked = new Map<string, { name: string; versions: number[] }>();
    for (const e of ctx.envs) {
      const teams = ctx.teamsOf(e.memberId);
      const b = resolveEnv(e, teams, before, ctx.exceptions, pkgs);
      const a = resolveEnv(e, teams, after, ctx.exceptions, pkgs);
      if (plan.target && appliesIn(a, plan.target)) reached.add(e.memberId);
      const changes = diffEnv(b, a);
      const newBlocked = a.blocked.filter((x) => !b.blocked.some((y) => y.itemId === x.itemId));
      for (const x of newBlocked) blocked.set(x.itemId, { name: x.name, versions: x.versions });
      if (!changes.length && !newBlocked.length) continue;
      affected++;
      if (!e.capabilities.install) unsupported++;
      for (const ch of changes) totals[ch.action]++;
      if (rows.length < 200)
        rows.push({
          envId: e.id,
          login: ctx.logins.get(e.memberId) ?? "unknown",
          repo: e.repoId ? (ctx.repoNames.get(e.repoId) ?? null) : null,
          adapter: `${e.adapter}${e.adapterVersion ? ` ${e.adapterVersion}` : ""}`,
          supported: Boolean(e.capabilities.install),
          lastContactAt: e.lastContactAt,
          changes,
          blocked: newBlocked.map((x) => x.name),
        });
    }
    // People the assignment reaches with no enrolled checkout WHERE IT APPLIES (never counted as
    // covered just because they enrolled some other repository).
    let notEnrolled = 0;
    if (plan.next) {
      const want = await audienceTx(tx, orgId, plan.next.selectors, plan.next.pilot);
      notEnrolled = [...want].filter((m) => !reached.has(m)).length;
    }
    // Approved exceptions whose covered content this change replaces: they need review (§7.6).
    const pb = contentPresence(before);
    const pa = contentPresence(after);
    const approved = await tx.select().from(exceptions).where(and(eq(exceptions.orgId, orgId), eq(exceptions.state, "approved")));
    const itemNames = new Map((await tx.select({ id: catalogItems.id, n: catalogItems.name }).from(catalogItems).where(eq(catalogItems.orgId, orgId))).map((x) => [x.id, x.n]));
    const exceptionsNeedingReview = approved
      .filter((x) => pb.has(x) && !pa.has(x) && pa.items.has(x.itemId))
      .map((x) => ({ id: x.id, item: itemNames.get(x.itemId) ?? "item", requirementKey: x.requirementKey, reason: x.reason }));
    return {
      change: c.kind,
      basis,
      exceptionsNeedingReview,
      environments: { total: ctx.envs.length, affected, unsupported, notEnrolledMembers: notEnrolled },
      totals,
      blocked: [...blocked.values()],
      rows,
      truncated: affected > rows.length,
      timing: "Changes reach each environment at its next sync (session start, `lockstep skills sync`, or the sync_skills tool). Sessions already running keep what they started with.",
    };
  });
}

/** Apply a previewed change. Writes one immutable revision / retirement / withdrawal + audit. */
export async function applyChange(
  orgId: string,
  actor: string,
  c: Change,
  expectedBasis?: string,
): Promise<{ assignmentId?: string; revision?: number }> {
  return withOrg(orgId, async (tx) => {
    await requireAdminTx(tx, orgId, actor);
    await lockRolloutsTx(tx, orgId); // every writer serializes here
    if (expectedBasis !== undefined && (await basisTx(tx, orgId)) !== expectedBasis)
      throw new OrgError(409, "rollouts changed since your preview — preview again before applying");
    const plan = await planTx(tx, orgId, c);
    if (c.kind === "create") {
      const n = plan.next!;
      if ("draftRelease" in plan && plan.draftRelease) n.releaseId = await insertReleaseTx(tx, orgId, actor, n.name, plan.draftRelease.items);
      const [a] = await tx
        .insert(assignments)
        .values({ orgId, name: n.name.slice(0, 120), ownerMemberId: actor, currentRevision: 1 })
        .returning();
      await tx.insert(assignmentRevisions).values({
        orgId,
        assignmentId: a!.id,
        revision: 1,
        releaseId: n.releaseId,
        selectors: n.selectors,
        level: n.level,
        pilot: n.pilot,
        reason: n.pilot ? "pilot" : "create",
        createdBy: actor,
      });
      await writeAudit(tx, { orgId, actorMemberId: actor, action: "assignment.created", entityKind: "assignment", entityId: a!.id, payload: { releaseId: n.releaseId, revision: 1 } });
      return { assignmentId: a!.id, revision: 1 };
    }
    if (c.kind === "revise" || c.kind === "rollback") {
      const n = plan.next!;
      if ("draftRelease" in plan && plan.draftRelease) n.releaseId = await insertReleaseTx(tx, orgId, actor, n.name, plan.draftRelease.items);
      const reason = c.kind === "rollback" ? "rollback" : n.pilot ? "pilot" : "expand";
      await tx.insert(assignmentRevisions).values({
        orgId,
        assignmentId: n.assignmentId,
        revision: n.revision,
        releaseId: n.releaseId,
        selectors: n.selectors,
        level: n.level,
        pilot: n.pilot,
        reason,
        createdBy: actor,
      });
      // conditional on the revision we planned against: a concurrent revise loses instead of clobbering
      const upd = await tx
        .update(assignments)
        .set({ currentRevision: n.revision })
        .where(and(eq(assignments.id, n.assignmentId), eq(assignments.currentRevision, n.revision - 1)))
        .returning({ id: assignments.id });
      if (!upd.length) throw new OrgError(409, "assignment changed meanwhile — preview again");
      await writeAudit(tx, {
        orgId,
        actorMemberId: actor,
        action: c.kind === "rollback" ? "assignment.rolled_back" : "assignment.revised",
        entityKind: "assignment",
        entityId: n.assignmentId,
        payload: { revision: n.revision, releaseId: n.releaseId, ...(c.kind === "rollback" ? { toRevision: c.toRevision } : {}) },
      });
      return { assignmentId: n.assignmentId, revision: n.revision };
    }
    if (c.kind === "retire") {
      await tx.update(assignments).set({ state: "retired" }).where(eq(assignments.id, c.assignmentId));
      await writeAudit(tx, { orgId, actorMemberId: actor, action: "assignment.retired", entityKind: "assignment", entityId: c.assignmentId });
      return { assignmentId: c.assignmentId };
    }
    await tx.insert(releaseWithdrawals).values({
      orgId,
      releaseId: c.releaseId,
      reason: c.reason?.trim().slice(0, 500) || "withdrawn",
      replacementReleaseId: c.replacementReleaseId ?? null,
      withdrawnBy: actor,
    });
    await writeAudit(tx, {
      orgId,
      actorMemberId: actor,
      action: "release.withdrawn",
      entityKind: "release",
      entityId: c.releaseId,
      payload: { replacementReleaseId: c.replacementReleaseId ?? null, reason: c.reason ?? null },
    });
    return {};
  });
}

/* ── reads ── */

export async function listAssignments(orgId: string) {
  return withOrg(orgId, async (tx) => {
    const as = await tx.select().from(assignments).where(eq(assignments.orgId, orgId));
    const revs = as.length
      ? await tx.select().from(assignmentRevisions).where(inArray(assignmentRevisions.assignmentId, as.map((a) => a.id)))
      : [];
    const rels = await tx.select().from(releases).where(eq(releases.orgId, orgId));
    const wd = await tx.select().from(releaseWithdrawals).where(eq(releaseWithdrawals.orgId, orgId));
    return {
      assignments: as
        .map((a) => {
          const cur = revs.find((r) => r.assignmentId === a.id && r.revision === a.currentRevision);
          const rel = rels.find((r) => r.id === cur?.releaseId);
          return {
            id: a.id,
            name: a.name,
            state: a.state,
            revision: a.currentRevision,
            level: cur?.level ?? null,
            selectors: cur?.selectors ?? null,
            pilot: cur?.pilot ?? null,
            release: rel ? { id: rel.id, name: rel.name, items: rel.items, withdrawn: wd.some((w) => w.releaseId === rel.id) } : null,
            createdAt: a.createdAt,
          };
        })
        .sort((x, y) => Number(x.state === "retired") - Number(y.state === "retired") || +y.createdAt - +x.createdAt),
      releases: rels
        .map((r) => ({ id: r.id, name: r.name, items: r.items, createdAt: r.createdAt, withdrawn: wd.find((w) => w.releaseId === r.id) ?? null }))
        .sort((x, y) => +y.createdAt - +x.createdAt),
    };
  });
}

/** One assignment: revision history + the PRD's adoption columns, per environment. */
export async function assignmentAdoption(orgId: string, assignmentId: string) {
  return withOrg(orgId, async (tx) => {
    const a = await assignmentTx(tx, orgId, assignmentId);
    const revs = (await tx.select().from(assignmentRevisions).where(eq(assignmentRevisions.assignmentId, a.id))).sort((x, y) => y.revision - x.revision);
    const relIds = [...new Set(revs.map((r) => r.releaseId))];
    const rels = relIds.length ? await tx.select().from(releases).where(inArray(releases.id, relIds)) : [];
    const wd = relIds.length ? await tx.select().from(releaseWithdrawals).where(inArray(releaseWithdrawals.releaseId, relIds)) : [];
    const active = await loadActiveAssignmentsTx(tx, orgId);
    const mine = active.find((x) => x.assignmentId === a.id);
    const pkgs = await packagesFor(tx, [active]);
    const ctx = await envContextTx(tx, orgId);
    const latest = await latestReceiptsTx(tx, ctx.envs.map((e) => e.id));
    const counts: Record<EnvItemState | "stale", number> = {
      pending_sync: 0,
      installed: 0,
      outdated: 0,
      failed: 0,
      user_action_required: 0,
      declined: 0,
      exempt: 0,
      unsupported: 0,
      blocked: 0,
      stale: 0,
    };
    const failures = new Map<string, number>();
    let sessionAvailable = 0;
    let guidanceEnvs = 0;
    const ROW_CAP = 500;
    const rows = [];
    const coveredMembers = new Set<string>();
    let coveredEnvs = 0;
    const skillIds = new Set((mine?.items ?? []).filter((i) => i.kind === "skill").map((i) => i.itemId));
    for (const e of mine ? ctx.envs : []) {
      const r = resolveEnv(e, ctx.teamsOf(e.memberId), active, ctx.exceptions, pkgs);
      const desired = r.desired.filter((d) => d.reasons.some((x) => x.assignmentId === a.id));
      const guidance = r.guidance.filter((g) => g.reasons.some((x) => x.assignmentId === a.id));
      const declined = r.declined.filter((d) => skillIds.has(d.itemId));
      const exempt = r.exempt.filter((d) => skillIds.has(d.itemId));
      const blocked = r.blocked.filter((d) => skillIds.has(d.itemId));
      const offered = r.offered.filter((d) => skillIds.has(d.itemId));
      if (!desired.length && !guidance.length && !declined.length && !exempt.length && !blocked.length && !offered.length) continue;
      // Coverage is counted over every environment, independently of how many rows are shown.
      coveredEnvs++;
      coveredMembers.add(e.memberId);
      if (guidance.length) guidanceEnvs++;
      const skills = [
        ...desired.map((d) => {
          const st = itemState(e, d, latest.get(e.id) ?? []);
          if (st.state === "installed" && !st.fresh) counts.stale++;
          else counts[st.state]++;
          if (st.sessionAvailable) sessionAvailable++;
          if (st.state === "failed" || st.state === "user_action_required") {
            const code = (latest.get(e.id) ?? []).find((x) => x.itemId === d.itemId && (x.kind === "failed" || x.kind === "conflict"))?.detail?.code ?? st.state;
            failures.set(String(code), (failures.get(String(code)) ?? 0) + 1);
          }
          return { itemId: d.itemId, name: d.name, version: d.version, state: st.state, fresh: st.fresh, sessionAvailable: st.sessionAvailable, at: st.at };
        }),
        ...declined.map((d) => (counts.declined++, { itemId: d.itemId, name: d.name, version: null, state: "declined" as const, fresh: true, sessionAvailable: false, at: null })),
        ...exempt.map((d) => (counts.exempt++, { itemId: d.itemId, name: d.name, version: null, state: "exempt" as const, fresh: true, sessionAvailable: false, at: null })),
        ...blocked.map((d) => (counts.blocked++, { itemId: d.itemId, name: d.name, version: null, state: "blocked" as const, fresh: true, sessionAvailable: false, at: null })),
        ...offered.map((d) => ({ itemId: d.itemId, name: d.name, version: d.version, state: "offered" as const, fresh: true, sessionAvailable: false, at: null })),
      ];
      if (rows.length < ROW_CAP)
        rows.push({
          envId: e.id,
          login: ctx.logins.get(e.memberId) ?? "unknown",
          repo: e.repoId ? (ctx.repoNames.get(e.repoId) ?? null) : null,
          adapter: `${e.adapter}${e.adapterVersion ? ` ${e.adapterVersion}` : ""}`,
          invocation: e.capabilities.invocation ?? "unobservable",
          lastContactAt: e.lastContactAt,
          verifiedAt: e.verifiedAt,
          fresh: e.verifiedAt != null && Date.now() - +e.verifiedAt <= FRESH_MS,
          skills,
          guidance: guidance.map((g) => ({ name: g.name, version: g.version })),
        });
    }
    const cur = revs.find((r) => r.revision === a.currentRevision);
    const reach = cur && a.state !== "retired" ? await audienceTx(tx, orgId, cur.selectors, cur.pilot ?? null) : new Set<string>();
    // Outcomes: check results produced under this assignment's current release.
    const relId = mine?.releaseId;
    const outcomeRows = relId
      ? await tx
          .select({ execution: artifactChecks.execution, findings: artifactChecks.findings })
          .from(artifactChecks)
          .where(and(eq(artifactChecks.orgId, orgId), sql`${artifactChecks.releaseIds} @> ${JSON.stringify([relId])}::jsonb`))
      : [];
    const outcomes = {
      results: outcomeRows.length,
      completed: outcomeRows.filter((o) => o.execution === "completed").length,
      notEvaluated: outcomeRows.filter((o) => o.execution !== "completed" && o.execution !== "partial").length,
      possibleIssues: outcomeRows.reduce((n, o) => n + o.findings.filter((f) => f.verdict === "possible_violation").length, 0),
      exempt: outcomeRows.reduce((n, o) => n + o.findings.filter((f) => f.verdict === "exempt").length, 0),
    };
    return {
      assignment: { id: a.id, name: a.name, state: a.state, revision: a.currentRevision },
      revisions: revs.map((r) => {
        const rel = rels.find((x) => x.id === r.releaseId);
        return {
          revision: r.revision,
          reason: r.reason,
          level: r.level,
          selectors: r.selectors,
          pilot: r.pilot,
          release: rel ? { id: rel.id, name: rel.name, items: rel.items, withdrawn: wd.some((w) => w.releaseId === rel.id) } : null,
          createdAt: r.createdAt,
        };
      }),
      coverage: {
        reachableMembers: reach.size,
        enrolledEnvironments: coveredEnvs,
        coveredMembers: coveredMembers.size,
        membersNotEnrolled: [...reach].filter((m) => !coveredMembers.has(m)).length,
        guidanceEnvironments: guidanceEnvs,
      },
      installation: counts,
      sessionAvailability: { available: sessionAvailable, installed: counts.installed },
      invocation: "Not observable on Claude Code yet — shown as unobservable, never as zero.",
      outcomes,
      troubleshooting: [...failures.entries()].map(([code, n]) => ({ code, environments: n })).sort((x, y) => y.environments - x.environments),
      rows,
      truncated: coveredEnvs > rows.length,
    };
  });
}
