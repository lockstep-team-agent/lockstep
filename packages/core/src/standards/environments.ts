/**
 * Enrolled environments (a checkout on a developer machine, per adapter) and what they should hold.
 *
 * Desired state is resolved on request from the org's current assignments — nothing is
 * materialized, so it can't drift from them. `generation` is a hash of the resolved skill set; a
 * receipt carries the generation it synced, which is how a stale acknowledgement is told apart
 * from a current one (A19).
 *
 * Install scope: a skill lands in the whole checkout, so task-type and path selectors don't gate
 * installation (they narrow the briefing instead). Two versions of one skill anywhere in the
 * checkout are therefore blocked, never picked (A6).
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { withOrg, type Tx } from "../db/rls.js";
import {
  environments,
  receipts,
  skillPackages,
  type EnvCapabilities,
  type PackageFile,
} from "../db/schema.js";
import { writeAudit } from "../audit/audit-service.js";
import { blobStore, sha256Hex } from "../storage/blob.js";
import { OrgError, teamIdsForMemberTx } from "./org-authority.js";
import { approvedExceptionsTx, loadActiveAssignmentsTx } from "./applicability.js";
import { resolveApplicability, type ActiveAssignment, type ExceptionRow, type Reason } from "./resolve.js";

type Env = typeof environments.$inferSelect;
type Pkg = typeof skillPackages.$inferSelect;

export interface DesiredSkill {
  slug: string;
  itemId: string;
  versionId: string;
  name: string;
  version: number;
  level: "required" | "recommended";
  packageHash: string;
  files: PackageFile[];
  declared: unknown;
  reasons: Reason[];
}
export interface EnvResolution {
  generation: string;
  desired: DesiredSkill[];
  /** Recommended skills this environment hasn't opted into. */
  offered: Array<{ slug: string; itemId: string; versionId: string; name: string; version: number }>;
  declined: Array<{ slug: string; itemId: string; versionId: string; name: string; level: string }>;
  exempt: Array<{ itemId: string; name: string }>;
  blocked: Array<{ itemId: string; name: string; versions: number[] }>;
  /** Assigned skills whose package is missing (should never happen for published versions). */
  unavailable: Array<{ itemId: string; name: string }>;
  /** Standards that reach this checkout (guidance, delivered via the briefing — not installed). */
  guidance: Array<{ itemId: string; versionId: string; name: string; version: number; reasons: Reason[] }>;
}

const RECEIPT_KINDS = new Set([
  "synced",
  "installed",
  "removed",
  "failed",
  "conflict",
  "declined",
  "readiness_gap",
  "session_available",
  "invoked",
]);

/** Task-type and path selectors narrow guidance, not installation. */
export function installScope(a: ActiveAssignment): ActiveAssignment {
  const strip = (s: ActiveAssignment["selectors"]) => ({ ...s, taskTypes: [], pathGlobs: [] });
  return { ...a, selectors: strip(a.selectors), pilot: a.pilot ? strip(a.pilot) : null };
}

export function generationOf(desired: Array<{ itemId: string; versionId: string; packageHash: string }>): string {
  const lines = desired.map((d) => `${d.itemId}:${d.versionId}:${d.packageHash}`).sort();
  return sha256Hex(lines.join("\n")).slice(0, 32);
}

/** Pure: what one environment should hold, given the org's assignments. */
export function resolveEnv(
  env: Pick<Env, "projectId" | "repoId" | "memberId" | "accepted" | "declined">,
  teamIds: string[],
  assignments: ActiveAssignment[],
  exceptions: ExceptionRow[],
  packages: Map<string, Pkg>,
  now = new Date(),
): EnvResolution {
  const res = resolveApplicability(
    { projectId: env.projectId, repoId: env.repoId, paths: null, taskType: null, memberId: env.memberId, teamIds },
    assignments.map(installScope),
    exceptions,
    now,
  );
  const entries = new Map(assignments.flatMap((a) => a.items).map((i) => [i.versionId, i]));
  const out: EnvResolution = {
    generation: "",
    desired: [],
    offered: [],
    declined: [],
    exempt: [],
    blocked: [],
    unavailable: [],
    guidance: res.standards.map((s) => ({ itemId: s.itemId, versionId: s.versionId, name: s.name, version: s.version, reasons: s.reasons })),
  };
  for (const s of res.skills) {
    const e = entries.get(s.versionId);
    const pkg = e?.packageId ? packages.get(e.packageId) : undefined;
    const slug = e?.slug ?? s.itemId;
    if (s.exempt) out.exempt.push({ itemId: s.itemId, name: s.name });
    // A personal opt-out only ever applies to a recommendation: a required skill stays desired
    // (only an approved exception removes it), even if it was declined while it was recommended.
    else if (s.level === "recommended" && env.declined.includes(s.itemId))
      out.declined.push({ slug, itemId: s.itemId, versionId: s.versionId, name: s.name, level: s.level });
    else if (s.level === "recommended" && !env.accepted.includes(s.itemId))
      out.offered.push({ slug, itemId: s.itemId, versionId: s.versionId, name: s.name, version: s.version });
    else if (!pkg) out.unavailable.push({ itemId: s.itemId, name: s.name });
    else
      out.desired.push({
        slug,
        itemId: s.itemId,
        versionId: s.versionId,
        name: s.name,
        version: s.version,
        level: s.level,
        packageHash: pkg.packageHash,
        files: pkg.manifest,
        declared: pkg.declared,
        reasons: s.reasons,
      });
  }
  out.blocked = res.blocked
    .filter((b) => entries.get(b.versions[0]!.versionId)?.kind === "skill")
    .map((b) => ({ itemId: b.itemId, name: b.name, versions: b.versions.map((v) => v.version) }));
  out.generation = generationOf(out.desired);
  return out;
}

/** Everything needed to resolve many environments at once (one load per org, not per env). */
export async function resolutionInputsTx(tx: Tx, orgId: string) {
  const assignments = await loadActiveAssignmentsTx(tx, orgId);
  const exceptions = await approvedExceptionsTx(tx, orgId);
  const pkgIds = [
    ...new Set(assignments.flatMap((a) => a.items.map((i) => i.packageId)).filter((x): x is string => Boolean(x))),
  ];
  const pkgs = pkgIds.length ? await tx.select().from(skillPackages).where(inArray(skillPackages.id, pkgIds)) : [];
  return { assignments, exceptions, packages: new Map(pkgs.map((p) => [p.id, p])) };
}

/**
 * Who is asking about an environment. From a route this is always the agent session's member AND
 * repository: an environment answers only to sessions from the checkout it was enrolled in.
 * (A bare member id is for internal callers: reports, tests.)
 */
export type Caller = string | { memberId: string; repoId: string };
const memberOf = (c: Caller) => (typeof c === "string" ? c : c.memberId);

async function envTx(tx: Tx, orgId: string, envId: string, caller: Caller): Promise<Env> {
  const memberId = memberOf(caller);
  const e = (
    await tx
      .select()
      .from(environments)
      .where(and(eq(environments.id, envId), eq(environments.orgId, orgId)))
      .limit(1)
  )[0];
  // Only the enrolling member's own sessions can read or report for an environment.
  if (!e || e.memberId !== memberId) throw new OrgError(404, "environment not found");
  if (typeof caller !== "string" && e.repoId && e.repoId !== caller.repoId)
    throw new OrgError(403, "this environment belongs to a different checkout");
  if (e.unenrolledAt) throw new OrgError(410, "environment is no longer enrolled — run `lockstep enroll`");
  // Re-authorize the environment's OWN project on every call: revoked access stops sync/downloads.
  if (e.projectId) {
    const { projects, repos } = await import("../db/schema.js");
    const { getProjectRoleTx, projectVisibility, projectArchived } = await import("../auth/permissions.js");
    const p = (await tx.select().from(projects).where(eq(projects.id, e.projectId)).limit(1))[0];
    const visible = p && !projectArchived(p.settings) && (projectVisibility(p.settings) === "shared" || (await getProjectRoleTx(tx, p.id, memberId)) !== null);
    if (!visible) throw new OrgError(403, "you no longer have access to this environment's project");
    if (e.repoId) {
      const r = (await tx.select({ projectId: repos.projectId }).from(repos).where(eq(repos.id, e.repoId)).limit(1))[0];
      if (!r || r.projectId !== e.projectId) throw new OrgError(403, "this environment's repository is no longer connected to its project");
    }
  }
  return e;
}

export interface SessionCtx {
  orgId: string;
  projectId: string;
  repoId: string;
  memberId: string;
}

export async function enrollEnvironment(
  c: SessionCtx,
  input: { adapter: string; adapterVersion?: string; hostKey: string; capabilities?: EnvCapabilities },
): Promise<{ environmentId: string }> {
  if (input.adapter !== "claude" && input.adapter !== "codex") throw new OrgError(400, "unsupported adapter");
  if (!/^[0-9a-f]{32,64}$/.test(input.hostKey)) throw new OrgError(400, "hostKey must be a hex digest");
  return withOrg(c.orgId, async (tx) => {
    const caps: EnvCapabilities = {
      install: Boolean(input.capabilities?.install),
      sessionAvailability: Boolean(input.capabilities?.sessionAvailability),
      invocation: input.capabilities?.invocation ?? "unobservable",
      checks: Boolean(input.capabilities?.checks),
    };
    const [row] = await tx
      .insert(environments)
      .values({
        orgId: c.orgId,
        memberId: c.memberId,
        adapter: input.adapter,
        adapterVersion: input.adapterVersion?.slice(0, 40) ?? null,
        hostKey: input.hostKey,
        projectId: c.projectId,
        repoId: c.repoId,
        capabilities: caps,
      })
      .onConflictDoUpdate({
        target: [environments.orgId, environments.memberId, environments.adapter, environments.hostKey],
        set: {
          adapterVersion: input.adapterVersion?.slice(0, 40) ?? null,
          projectId: c.projectId,
          repoId: c.repoId,
          capabilities: caps,
          unenrolledAt: null,
          lastContactAt: new Date(),
        },
      })
      .returning();
    await writeAudit(tx, {
      orgId: c.orgId,
      projectId: c.projectId,
      actorMemberId: c.memberId,
      action: "environment.enrolled",
      entityKind: "environment",
      entityId: row!.id,
      payload: { adapter: input.adapter, adapterVersion: input.adapterVersion ?? null },
    });
    return { environmentId: row!.id };
  });
}

export async function unenrollEnvironment(orgId: string, envId: string, caller: Caller): Promise<void> {
  const memberId = memberOf(caller);
  await withOrg(orgId, async (tx) => {
    await envTx(tx, orgId, envId, caller);
    await tx.update(environments).set({ unenrolledAt: new Date() }).where(eq(environments.id, envId));
    await writeAudit(tx, { orgId, actorMemberId: memberId, action: "environment.unenrolled", entityKind: "environment", entityId: envId });
  });
}

/** GET sync: the desired set for this environment right now. Touches last contact. */
export async function syncPayload(orgId: string, envId: string, caller: Caller): Promise<EnvResolution> {
  const memberId = memberOf(caller);
  return withOrg(orgId, async (tx) => {
    const env = await envTx(tx, orgId, envId, caller);
    await tx.update(environments).set({ lastContactAt: new Date() }).where(eq(environments.id, envId));
    const inp = await resolutionInputsTx(tx, orgId);
    return resolveEnv(env, await teamIdsForMemberTx(tx, memberId), inp.assignments, inp.exceptions, inp.packages);
  });
}

/**
 * One package file for an environment. Served through core (not a presigned URL) so every read is
 * authorized against the current desired set: revoking membership or an assignment stops downloads.
 */
export async function blobForEnv(orgId: string, envId: string, caller: Caller, sha: string): Promise<Uint8Array> {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new OrgError(400, "invalid blob id");
  const r = await syncPayload(orgId, envId, caller);
  if (!r.desired.some((d) => d.files.some((f) => f.sha256 === sha))) throw new OrgError(404, "not part of this environment's skills");
  return blobStore().get(orgId, sha);
}

export interface ReceiptInput {
  kind: string;
  itemId?: string | null;
  versionId?: string | null;
  packageHash?: string | null;
  detail?: Record<string, unknown> | null;
  observedAt?: string;
}

const UUID = /^[0-9a-f-]{36}$/;

/**
 * Receipts are appended as reported. Whether they describe the CURRENT desired state is decided
 * here and returned, never assumed: a sync against an older generation leaves the env outdated.
 */
export async function recordReceipts(
  orgId: string,
  envId: string,
  caller: Caller,
  input: { generation: string; sessionId?: string | null; results: ReceiptInput[] },
): Promise<{ recorded: number; current: boolean; generation: string }> {
  const memberId = memberOf(caller);
  if (typeof input.generation !== "string" || !/^[0-9a-f]{32}$/.test(input.generation))
    throw new OrgError(400, "generation required");
  if (!Array.isArray(input.results) || input.results.length > 500) throw new OrgError(400, "results must be an array (≤500)");
  const now = Date.now();
  const rows = input.results.map((r) => {
    if (!RECEIPT_KINDS.has(r.kind)) throw new OrgError(400, `unknown receipt kind: ${r.kind}`);
    if ((r.itemId && !UUID.test(r.itemId)) || (r.versionId && !UUID.test(r.versionId))) throw new OrgError(400, "invalid ids");
    const t = r.observedAt ? Date.parse(r.observedAt) : now;
    // clock skew guard: an observation can't be from the future or older than a week
    const observedAt = new Date(Number.isFinite(t) ? Math.min(Math.max(t, now - 7 * 864e5), now) : now);
    const detail = r.detail && JSON.stringify(r.detail).length <= 2000 ? r.detail : r.detail ? { truncated: true } : null;
    return {
      orgId,
      envId,
      kind: r.kind,
      itemId: r.itemId ?? null,
      versionId: r.versionId ?? null,
      packageHash: r.packageHash?.slice(0, 64) ?? null,
      sessionId: input.sessionId && UUID.test(input.sessionId) ? input.sessionId : null,
      generation: input.generation,
      detail,
      observedAt,
    };
  });
  return withOrg(orgId, async (tx) => {
    const env = await envTx(tx, orgId, envId, caller);
    if (rows.length) await tx.insert(receipts).values(rows);
    // Only a completed reconciliation verifies what's on disk; contact alone doesn't (verification F4).
    const completed = rows.some((r) => r.kind === "synced");
    await tx.update(environments).set({ lastContactAt: new Date(), ...(completed ? { verifiedAt: new Date() } : {}) }).where(eq(environments.id, envId));
    const inp = await resolutionInputsTx(tx, orgId);
    const cur = resolveEnv(env, await teamIdsForMemberTx(tx, memberId), inp.assignments, inp.exceptions, inp.packages);
    return { recorded: rows.length, current: cur.generation === input.generation, generation: cur.generation };
  });
}

/** Opt into / decline a skill for this environment (recommended opt-in; "keep my personal copy"). */
export async function setSkillPreference(
  orgId: string,
  envId: string,
  caller: Caller,
  itemId: string,
  choice: "accept" | "decline" | "reset",
): Promise<void> {
  const memberId = memberOf(caller);
  if (!UUID.test(itemId)) throw new OrgError(400, "invalid item id");
  await withOrg(orgId, async (tx) => {
    const env = await envTx(tx, orgId, envId, caller);
    if (choice === "decline") {
      const inp = await resolutionInputsTx(tx, orgId);
      const r = resolveEnv(env, await teamIdsForMemberTx(tx, memberId), inp.assignments, inp.exceptions, inp.packages);
      if (r.desired.some((d) => d.itemId === itemId && d.level === "required"))
        throw new OrgError(409, "required skills can't be declined — ask an org admin for an exception instead");
    }
    const without = (xs: string[]) => xs.filter((x) => x !== itemId);
    await tx
      .update(environments)
      .set({
        accepted: choice === "accept" ? [...without(env.accepted), itemId] : without(env.accepted),
        declined: choice === "decline" ? [...without(env.declined), itemId] : without(env.declined),
      })
      .where(eq(environments.id, envId));
    await writeAudit(tx, {
      orgId,
      actorMemberId: memberId,
      action: `environment.skill_${choice}`,
      entityKind: "environment",
      entityId: envId,
      payload: { itemId },
    });
  });
}

/* ── status (for adoption reporting and "my environments") ── */

export type EnvItemState =
  | "pending_sync"
  | "installed"
  | "outdated"
  | "failed"
  | "user_action_required"
  | "declined"
  | "exempt"
  | "unsupported"
  | "blocked";

export interface ReceiptRow {
  kind: string;
  itemId: string | null;
  versionId: string | null;
  generation: string;
  sessionId: string | null;
  receivedAt: Date;
  detail: Record<string, unknown> | null;
}

/** Latest receipts per (env, item), newest first — bounded so a noisy env can't blow up a report. */
export async function latestReceiptsTx(tx: Tx, envIds: string[]): Promise<Map<string, ReceiptRow[]>> {
  if (envIds.length === 0) return new Map();
  // ponytail: DISTINCT ON scan per (env, item, kind); add a latest-receipt table past ~10M receipts
  const rows = await tx
    .selectDistinctOn([receipts.envId, receipts.itemId, receipts.kind])
    .from(receipts)
    .where(inArray(receipts.envId, envIds))
    .orderBy(receipts.envId, receipts.itemId, receipts.kind, desc(receipts.receivedAt));
  const out = new Map<string, ReceiptRow[]>();
  for (const r of rows) {
    const list = out.get(r.envId) ?? out.set(r.envId, []).get(r.envId)!;
    list.push(r);
  }
  return out;
}

/** Observations older than this are shown as "last seen", never as the current state (review #13). */
export const FRESH_MS = 7 * 86_400_000;

/**
 * State of one desired skill in one environment, from its latest receipts. `state` is the last
 * OBSERVED outcome; `fresh` says whether that observation is recent enough to stand for now.
 */
export function itemState(
  env: Pick<Env, "capabilities" | "verifiedAt">,
  want: { itemId: string; versionId: string },
  latest: ReceiptRow[],
  now = Date.now(),
): { state: EnvItemState; installedVersionId: string | null; sessionAvailable: boolean; at: Date | null; fresh: boolean } {
  // Fresh = the environment completed a reconciliation recently. Fetching instructions or a
  // download doesn't count: a client that then crashed verified nothing.
  const contactFresh = env.verifiedAt != null && now - +env.verifiedAt <= FRESH_MS;
  if (!env.capabilities.install) return { state: "unsupported", installedVersionId: null, sessionAvailable: false, at: null, fresh: contactFresh };
  const mine = latest.filter((r) => r.itemId === want.itemId).sort((a, b) => +b.receivedAt - +a.receivedAt);
  const outcome = mine.find((r) => r.kind === "installed" || r.kind === "failed" || r.kind === "conflict" || r.kind === "removed");
  // A session only counts if it started recently, on the version assigned now.
  const avail = mine.find((r) => r.kind === "session_available" && r.versionId === want.versionId && now - +r.receivedAt <= FRESH_MS);
  // Every completed sync re-verifies the files on disk (drift is reported as a conflict), so a recent
  // verification is what makes the last observed outcome current; without one it's history.
  const base = { sessionAvailable: Boolean(avail), at: outcome?.receivedAt ?? null, fresh: contactFresh };
  if (!outcome || outcome.kind === "removed") return { ...base, state: "pending_sync", installedVersionId: null };
  if (outcome.kind === "conflict") return { ...base, state: "user_action_required", installedVersionId: outcome.versionId };
  if (outcome.kind === "failed") return { ...base, state: "failed", installedVersionId: null };
  return {
    ...base,
    state: outcome.versionId === want.versionId ? "installed" : "outdated",
    installedVersionId: outcome.versionId,
  };
}

/** The signed-in member's own environments with per-skill state ("my status"). */
export async function myEnvironments(orgId: string, memberId: string) {
  return withOrg(orgId, async (tx) => {
    const envs = await tx
      .select()
      .from(environments)
      .where(and(eq(environments.orgId, orgId), eq(environments.memberId, memberId), isNull(environments.unenrolledAt)))
      .orderBy(desc(environments.lastContactAt));
    const inp = await resolutionInputsTx(tx, orgId);
    const teams = await teamIdsForMemberTx(tx, memberId);
    const latest = await latestReceiptsTx(tx, envs.map((e) => e.id));
    return envs.map((e) => {
      const r = resolveEnv(e, teams, inp.assignments, inp.exceptions, inp.packages);
      return {
        id: e.id,
        adapter: e.adapter,
        adapterVersion: e.adapterVersion,
        projectId: e.projectId,
        repoId: e.repoId,
        lastContactAt: e.lastContactAt,
        capabilities: e.capabilities,
        skills: r.desired.map((d) => ({ itemId: d.itemId, name: d.name, version: d.version, level: d.level, ...itemState(e, d, latest.get(e.id) ?? []) })),
        offered: r.offered,
        declined: r.declined,
        blocked: r.blocked,
      };
    });
  });
}

/** Project Settings: enrolled environments in this project and their skill status (metadata only). */
export async function projectEnvironments(orgId: string, projectId: string) {
  return withOrg(orgId, async (tx) => {
    const envs = await tx
      .select()
      .from(environments)
      .where(and(eq(environments.orgId, orgId), eq(environments.projectId, projectId), isNull(environments.unenrolledAt)))
      .orderBy(desc(environments.lastContactAt))
      .limit(500);
    const inp = await resolutionInputsTx(tx, orgId);
    const latest = await latestReceiptsTx(tx, envs.map((e) => e.id));
    const { members, repos } = await import("../db/schema.js");
    const logins = new Map((await tx.select({ id: members.id, l: members.githubLogin }).from(members).where(eq(members.orgId, orgId))).map((m) => [m.id, m.l]));
    const repoNames = new Map((await tx.select({ id: repos.id, r: repos.gitRemote }).from(repos).where(eq(repos.projectId, projectId))).map((r) => [r.id, r.r]));
    const out = [];
    for (const e of envs) {
      const r = resolveEnv(e, await teamIdsForMemberTx(tx, e.memberId), inp.assignments, inp.exceptions, inp.packages);
      const states = r.desired.map((d) => itemState(e, d, latest.get(e.id) ?? []).state);
      out.push({
        id: e.id,
        login: logins.get(e.memberId) ?? "unknown",
        repo: e.repoId ? (repoNames.get(e.repoId) ?? null) : null,
        adapter: `${e.adapter}${e.adapterVersion ? ` ${e.adapterVersion}` : ""}`,
        lastContactAt: e.lastContactAt,
        skills: states.length,
        installed: states.filter((s) => s === "installed").length,
        attention: states.filter((s) => s === "failed" || s === "user_action_required" || s === "outdated").length,
        blocked: r.blocked.length,
      });
    }
    return { environments: out };
  });
}
