/**
 * Release validation (PRD §2 examples, §10 failure scenarios) end to end against Postgres:
 *  - Example A: an engineering guideline with a linked skill and advisory check, applied to selected
 *    backend repos; relevant sessions receive it, unrelated projects get nothing (A4), a code check
 *    records the exact standard and release versions.
 *  - Example B: an imported skill piloted in two frontend repos, expanded, then rolled back — with
 *    an offline machine that stays outdated until its next sync (A10) and a session that keeps the
 *    version it started with (A11).
 *  - A5 (moving things in the Map changes nothing) and A8 (unenrolled users keep today's flow).
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { env } from "../env.js";
import { withOrg, withSystem } from "../db/rls.js";
import { conceptPlacements, concepts, domains, members, principals, projects, repos, surfaces } from "../db/schema.js";
import { registerSession } from "../api/session-context.js";
import { MemoryBlobStore, setBlobStore } from "../storage/blob.js";
import { continuity } from "../adoption/service.js";
import { runCheck } from "../adoption/checks.js";
import { createItem, publishVersion, saveDraft } from "./catalog.js";
import { storePackage } from "./packages.js";
import { importGithubSkill } from "./imports.js";
import { gitBlobSha } from "./github-import.js";
import { whyThisApplies } from "./applicability.js";
import { applyChange, assignmentAdoption, previewChange } from "./rollouts.js";
import { enrollEnvironment, recordReceipts, syncPayload } from "./environments.js";
import { enc, one, setup, uid, type S } from "./test-fixtures.js";

const flag = env as unknown as { LOCKSTEP_STANDARDS: boolean; LOCKSTEP_CHECKS_ENABLED: boolean };
const prev = { ...flag };
const realFetch = globalThis.fetch;
before(() => {
  setBlobStore(new MemoryBlobStore());
  flag.LOCKSTEP_STANDARDS = true;
  flag.LOCKSTEP_CHECKS_ENABLED = true;
});
after(() => {
  setBlobStore(null);
  Object.assign(flag, prev);
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const CAPS = { install: true, sessionAvailability: true, invocation: "unobservable" as const };
const hostKey = () => uid().toString(16).padStart(32, "0");

/** Extra repos in the fixture project, plus an unrelated second project with its own repo. */
async function more(s: S, names: string[]) {
  return withSystem(async (tx) => {
    const rs = await tx.insert(repos).values(names.map((n) => ({ orgId: s.orgId, projectId: s.projectId, gitRemote: `github.com/acme/${n}-${uid()}` }))).returning();
    const other = one(await tx.insert(projects).values({ orgId: s.orgId, name: "unrelated", createdBy: s.cto }).returning());
    const otherRepo = one(await tx.insert(repos).values({ orgId: s.orgId, projectId: other.id, gitRemote: `github.com/acme/other-${uid()}` }).returning());
    return { repos: rs, other, otherRepo };
  });
}
const envIn = async (s: S, projectId: string, repoId: string) =>
  (await enrollEnvironment({ orgId: s.orgId, projectId, repoId, memberId: s.eng, sessionId: "" } as never, { adapter: "claude", adapterVersion: "0.4.0", hostKey: hostKey(), capabilities: CAPS })).environmentId;
async function session(s: S, repoId: string) {
  const [p, repo] = await withSystem(async (tx) => {
    const m = one(await tx.select().from(members).where(eq(members.id, s.eng)));
    return [one(await tx.select().from(principals).where(eq(principals.id, m.principalId!))), one(await tx.select().from(repos).where(eq(repos.id, repoId)))] as const;
  });
  return (await registerSession(p as never, { gitRemote: repo.gitRemote, vendor: "claude" }))!;
}
/** What a real client does after a sync: report what it installed at that generation. */
async function syncAndReport(s: S, envId: string) {
  const r = await syncPayload(s.orgId, envId, s.eng);
  await recordReceipts(s.orgId, envId, s.eng, {
    generation: r.generation,
    results: [...r.desired.map((d) => ({ kind: "installed", itemId: d.itemId, versionId: d.versionId, packageHash: d.packageHash })), { kind: "synced" }],
  });
  return r;
}

test("Example A: engineering guideline → selected backend repos, sessions, checks, nothing elsewhere (A4)", async () => {
  const s = await setup();
  const { repos: [billing, web], other, otherRepo } = await more(s, ["billing-api", "web"]);
  // the linked skill and advisory check, then the standard that pins them
  const pkg = await storePackage(s.orgId, [{ path: "SKILL.md", bytes: enc("---\nname: api-change\n---\nCheck compatibility.") }], null);
  const sk = await createItem(s.orgId, s.cto, { kind: "skill", name: `api-change ${uid()}`, content: { whenToUse: "changing a public API" } });
  const skv = await saveDraft(s.orgId, s.cto, sk.itemId, { content: { whenToUse: "changing a public API" }, packageId: pkg.id });
  await publishVersion(s.orgId, s.cto, skv.versionId);
  const ck = await createItem(s.orgId, s.cto, { kind: "check", name: `API review ${uid()}`, content: { artifactType: "code_diff", method: "rubric", instructions: "Look for undocumented breaking changes." } });
  await publishVersion(s.orgId, s.cto, ck.versionId);
  const std = await createItem(s.orgId, s.cto, {
    kind: "standard",
    name: `Public API changes ${uid()}`,
    content: {
      taskTypes: ["code"],
      requirements: [{ text: "Public API changes must document compatibility", level: "required" }, { text: "Include appropriate tests", level: "required" }],
      skills: [{ itemId: sk.itemId, versionId: skv.versionId }],
      checks: [{ itemId: ck.itemId, versionId: ck.versionId }],
    },
  });
  await publishVersion(s.orgId, s.cto, std.versionId);

  const change = { kind: "create" as const, name: "API guideline", versionIds: [std.versionId], selectors: { repos: [s.repoId, billing!.id] }, level: "required" as const };
  const apiEnv = await envIn(s, s.projectId, s.repoId);
  const webEnv = await envIn(s, s.projectId, web!.id);
  const otherEnv = await envIn(s, other.id, otherRepo.id);
  const pv = await previewChange(s.orgId, s.cto, change);
  assert.equal(pv.environments.affected, 1, "only the backend checkout changes");
  assert.equal(pv.totals.install, 1);
  const { assignmentId } = await applyChange(s.orgId, s.cto, change);

  // installed where it applies, and nowhere else (A4)
  assert.deepEqual((await syncAndReport(s, apiEnv)).desired.map((d) => d.itemId), [sk.itemId]);
  assert.equal((await syncPayload(s.orgId, webEnv, s.eng)).desired.length, 0);
  assert.equal((await syncPayload(s.orgId, otherEnv, s.eng)).desired.length, 0);
  assert.equal((await whyThisApplies(s.orgId, other.id, s.eng, { repoId: otherRepo.id, taskType: "code" })).standards.length, 0);
  const why = await whyThisApplies(s.orgId, s.projectId, s.eng, { repoId: s.repoId, taskType: "code" });
  assert.deepEqual(why.standards[0]!.reasons.map((r) => r.matched), [["repository"]]);
  assert.deepEqual(why.checks.map((c) => c.versionId), [ck.versionId], "the linked check travels with the standard");

  // a relevant session is briefed with the exact version and a pointer to the skill
  const c = await session(s, s.repoId);
  const brief = (await continuity(c)).standards!;
  assert.deepEqual(brief.requirements.map((r) => [r.text, r.version]), [["Public API changes must document compatibility", 1], ["Include appropriate tests", 1]]);
  assert.equal(brief.skills[0]!.whenToUse, "changing a public API");
  const unrelated = (await continuity(await session(s, web!.id))).standards!;
  assert.equal(unrelated.requirements.length, 0);

  // an advisory code check links the result to the exact standard version and release
  const judge = async (_: unknown, qs: Record<string, unknown>) => Object.fromEntries(Object.keys(qs).map((k) => [k, { type: "noul" as const, noul: 0.1 }]));
  const r = await runCheck(c, { hunks: [{ file: "src/routes.ts", text: "@@ -1,1 +1,2 @@\n x\n+export const v2 = true;" }], surfaces: [] }, judge);
  assert.equal(r.standards![0]!.execution, "completed");
  assert.equal(r.standards![0]!.standardVersionId, std.versionId);
  assert.equal(r.standards![0]!.releaseIds.length, 1);
  assert.equal(r.standards![0]!.findings.length, 0, "no concern found — which is not recorded as 'satisfied'");
  const ad = await assignmentAdoption(s.orgId, assignmentId!);
  assert.equal(ad.installation.installed, 1);
  assert.equal(ad.invocation.startsWith("Not observable"), true, "A9: invocation is unobservable, never zero");
});

test("Example B: imported skill piloted in two repos, expanded, rolled back; offline machine converges later (A10, A11)", async () => {
  const s = await setup();
  const { repos: [fe1, fe2, fe3] } = await more(s, ["fe-web", "fe-admin", "fe-mobile"]);
  const commit = "e".repeat(40);
  let body = "---\nname: react-review\ndescription: Reviews React changes\n---\nv1";
  globalThis.fetch = (async (input: string | URL) => {
    const u = String(input);
    if (u.includes("/commits/")) return new Response(JSON.stringify({ sha: commit }));
    if (u.includes("/git/trees/"))
      return new Response(JSON.stringify({ truncated: false, tree: [{ path: "react/SKILL.md", type: "blob", mode: "100644", sha: gitBlobSha(enc(body)), size: body.length }, { path: "other/SKILL.md", type: "blob", mode: "100644", sha: "0".repeat(40), size: 1 }] }));
    if (u.includes("raw.githubusercontent.com")) return new Response(body);
    return new Response("?", { status: 500 });
  }) as typeof fetch;
  const imported = await importGithubSkill(s.orgId, s.cto, { url: "https://github.com/acme/skills/tree/main/react", commit, ref: "main", dir: "react" });
  await publishVersion(s.orgId, s.cto, imported.versionId);
  const frontends = [fe1!.id, fe2!.id, fe3!.id];
  const [e1, e2, e3] = [await envIn(s, s.projectId, fe1!.id), await envIn(s, s.projectId, fe2!.id), await envIn(s, s.projectId, fe3!.id)];

  // pilot: two of the three frontend repos
  const { assignmentId } = await applyChange(s.orgId, s.cto, { kind: "create", versionIds: [imported.versionId], selectors: { repos: frontends }, pilot: { repos: [fe1!.id, fe2!.id] }, level: "required" });
  assert.equal((await syncAndReport(s, e1)).desired.length, 1);
  assert.equal((await syncAndReport(s, e2)).desired.length, 1);
  assert.equal((await syncPayload(s.orgId, e3, s.eng)).desired.length, 0, "outside the pilot");
  let ad = await assignmentAdoption(s.orgId, assignmentId!);
  assert.equal(ad.installation.installed, 2);

  // expand: same release, pilot removed
  await applyChange(s.orgId, s.cto, { kind: "revise", assignmentId: assignmentId!, pilot: null });
  assert.equal((await syncAndReport(s, e3)).desired.length, 1);

  // v2 from upstream, rolled out; then rolled back while e2 is offline
  body = "---\nname: react-review\ndescription: Reviews React changes\n---\nv2";
  const { draftFromUpstream } = await import("./imports.js");
  const d2 = await draftFromUpstream(s.orgId, s.cto, imported.versionId, commit);
  await publishVersion(s.orgId, s.cto, d2.versionId);
  await applyChange(s.orgId, s.cto, { kind: "revise", assignmentId: assignmentId!, versionIds: [d2.versionId] });
  const e2v2 = await syncAndReport(s, e2); // e2 gets v2 …
  const sessionGen = e2v2.generation;
  await applyChange(s.orgId, s.cto, { kind: "rollback", assignmentId: assignmentId!, toRevision: 2 });
  // … then goes offline. Its running session keeps what it started with (A11): the receipt it
  // sends for that session names v2, and it is NOT counted as current.
  const late = await recordReceipts(s.orgId, e2, s.eng, { generation: sessionGen, results: [{ kind: "session_available", itemId: imported.itemId, versionId: d2.versionId }] });
  assert.equal(late.current, false);
  ad = await assignmentAdoption(s.orgId, assignmentId!);
  const row2 = ad.rows.find((r) => r.envId === e2)!;
  assert.equal(row2.skills[0]!.state, "outdated", "offline during rollback: pending, not claimed rolled back (A10)");
  assert.equal(row2.skills[0]!.sessionAvailable, false, "a session on v2 isn't availability of the v1 now assigned");
  // it reconnects and converges
  const back = await syncAndReport(s, e2);
  assert.equal(back.desired[0]!.versionId, imported.versionId);
  ad = await assignmentAdoption(s.orgId, assignmentId!);
  assert.equal(ad.rows.find((r) => r.envId === e2)!.skills[0]!.state, "installed");
  assert.deepEqual(ad.revisions.map((r) => r.reason), ["rollback", "expand", "expand", "pilot"], "full history kept");
});

test("A5: moving a decision or surface in the concept Map never changes what applies", async () => {
  const s = await setup();
  const std = await createItem(s.orgId, s.cto, { kind: "standard", name: `Map ${uid()}`, content: { taskTypes: ["code"], requirements: [{ text: "Stay put", level: "required" }] } });
  await publishVersion(s.orgId, s.cto, std.versionId);
  await applyChange(s.orgId, s.cto, { kind: "create", versionIds: [std.versionId], selectors: { repos: [s.repoId] }, level: "required" });
  const before = await whyThisApplies(s.orgId, s.projectId, s.eng, { repoId: s.repoId, taskType: "code" });
  await withOrg(s.orgId, async (tx) => {
    const d = one(await tx.insert(domains).values({ orgId: s.orgId, projectId: s.projectId, key: `d${uid()}`, label: "Somewhere" }).returning());
    const c = one(await tx.insert(concepts).values({ orgId: s.orgId, projectId: s.projectId, key: `http:x${uid()}`, label: "X", domainId: d.id } as never).returning());
    const surf = one(await tx.insert(surfaces).values({ orgId: s.orgId, projectId: s.projectId, repoId: s.repoId, surface: `http:GET /x${uid()}`, kind: "http" }).returning());
    await tx.insert(conceptPlacements).values({ orgId: s.orgId, projectId: s.projectId, itemKind: "surface", itemId: surf.id, location: "concept", conceptId: c.id, state: "confirmed" } as never);
  });
  const afterMove = await whyThisApplies(s.orgId, s.projectId, s.eng, { repoId: s.repoId, taskType: "code" });
  assert.deepEqual(afterMove.standards, before.standards);
});

test("A8: a user who never enrolls keeps today's briefing; rollouts show them as not enrolled", async () => {
  const s = await setup();
  const std = await createItem(s.orgId, s.cto, { kind: "standard", name: `A8 ${uid()}`, content: { taskTypes: ["code"], requirements: [{ text: "Be kind", level: "required" }] } });
  await publishVersion(s.orgId, s.cto, std.versionId);
  const { assignmentId } = await applyChange(s.orgId, s.cto, { kind: "create", versionIds: [std.versionId], selectors: {}, level: "required" });
  const c = await session(s, s.repoId);
  const cont = await continuity(c);
  assert.ok(Array.isArray(cont.decisions), "decision continuity unchanged");
  assert.equal(cont.standards!.requirements.length, 1, "guidance still arrives without enrollment");
  const ad = await assignmentAdoption(s.orgId, assignmentId!);
  assert.equal(ad.coverage.enrolledEnvironments, 0);
  assert.equal(ad.coverage.membersNotEnrolled, 2, "never counted as covered");

  flag.LOCKSTEP_STANDARDS = false;
  try {
    assert.equal((await continuity(c)).standards, null, "flag off: briefing exactly as before");
  } finally {
    flag.LOCKSTEP_STANDARDS = true;
  }
});
