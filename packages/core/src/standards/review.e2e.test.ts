/**
 * Regression tests for the 2026-09-25 implementation review (numbers match its findings).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../api/app.js";
import { env } from "../env.js";
import { withOrg, withSystem } from "../db/rls.js";
import { environments, members, principals, projectMembers, projects, receipts, repos } from "../db/schema.js";
import { registerSession } from "../api/session-context.js";
import { MemoryBlobStore, setBlobStore } from "../storage/blob.js";
import { saveNativeBrief } from "../adoption/native-documents.js";
import { createItem, getItem, previewVersion, publishVersion, saveDraft } from "./catalog.js";
import { storePackage } from "./packages.js";
import { applyChange, assignmentAdoption, previewChange } from "./rollouts.js";
import { enrollEnvironment, itemState, syncPayload } from "./environments.js";
import { whyThisApplies } from "./applicability.js";
import { checkDocument, listChecks } from "./checks.js";
import { decideException, requestException } from "./exceptions.js";
import { enc, one, setup, uid, type S } from "./test-fixtures.js";

const flag = env as unknown as { LOCKSTEP_STANDARDS: boolean; LOCKSTEP_CHECKS_ENABLED: boolean };
const prev = { ...flag };
before(() => {
  setBlobStore(new MemoryBlobStore());
  flag.LOCKSTEP_STANDARDS = true;
});
after(() => {
  setBlobStore(null);
  Object.assign(flag, prev);
});
const noExtract = async () => ({ rules: [], degraded: false });
const CAPS = { install: true, sessionAvailability: true, invocation: "unobservable" as const };
const hk = () => uid().toString(16).padStart(32, "0");

async function skill(s: S, body = "v1") {
  const pkg = await storePackage(s.orgId, [{ path: "SKILL.md", bytes: enc(`---\nname: x\n---\n${body}`) }], null);
  const { itemId } = await createItem(s.orgId, s.cto, { kind: "skill", name: `sk ${uid()}`, content: {} });
  const d = await saveDraft(s.orgId, s.cto, itemId, { content: {}, packageId: pkg.id });
  await publishVersion(s.orgId, s.cto, d.versionId);
  return { itemId, versionId: d.versionId };
}
async function secondProject(s: S) {
  return withSystem(async (tx) => {
    const p = one(await tx.insert(projects).values({ orgId: s.orgId, name: `b-${uid()}`, createdBy: s.cto }).returning());
    const r = one(await tx.insert(repos).values({ orgId: s.orgId, projectId: p.id, gitRemote: `github.com/acme/b-${uid()}` }).returning());
    await tx.insert(projectMembers).values({ orgId: s.orgId, projectId: p.id, memberId: s.eng, invitedGithubLogin: `eng-b-${uid()}`, role: "member", status: "active" });
    return { projectId: p.id, repoId: r.id, gitRemote: r.gitRemote };
  });
}
async function principalOf(memberId: string) {
  return withSystem(async (tx) => {
    const m = one(await tx.select().from(members).where(eq(members.id, memberId)));
    return one(await tx.select().from(principals).where(eq(principals.id, m.principalId!)));
  });
}

test("#1 an environment answers only to its own checkout, and revoked project access stops it", async (t) => {
  const s = await setup();
  const sk = await skill(s);
  await applyChange(s.orgId, s.cto, { kind: "create", versionIds: [sk.versionId], selectors: {}, level: "required" });
  const b = await secondProject(s);
  const p = await principalOf(s.eng);
  const repoA = await withSystem(async (tx) => one(await tx.select().from(repos).where(eq(repos.id, s.repoId))));
  const sessA = (await registerSession(p as never, { gitRemote: repoA.gitRemote, vendor: "claude" }))!;
  const sessB = (await registerSession(p as never, { gitRemote: b.gitRemote, vendor: "claude" }))!;
  const { environmentId } = await enrollEnvironment(sessA, { adapter: "claude", hostKey: hk(), capabilities: CAPS });

  const app = buildApp();
  t.after(() => app.close());
  const h = (sid: string) => ({ authorization: `Bearer ${s.engToken}`, "x-lockstep-session": sid });
  assert.equal((await app.inject({ method: "GET", url: `/environments/${environmentId}/sync`, headers: h(sessA.sessionId) })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/environments/${environmentId}/sync`, headers: h(sessB.sessionId) })).statusCode, 403, "another project's session can't use A's environment");

  // wall project A and revoke the member there: A's environment stops, from any session
  await withSystem(async (tx) => {
    await tx.update(projects).set({ settings: { visibility: "walled" } }).where(eq(projects.id, s.projectId));
    await tx.update(projectMembers).set({ status: "revoked" }).where(and(eq(projectMembers.projectId, s.projectId), eq(projectMembers.memberId, s.eng)));
  });
  await assert.rejects(syncPayload(s.orgId, environmentId, s.eng), /no longer have access/);
  const blocked = await app.inject({ method: "GET", url: `/environments/${environmentId}/sync`, headers: h(sessA.sessionId) });
  assert.equal(blocked.statusCode, 403);
});

test("#2 plain members can't read org-wide rollout metadata", async (t) => {
  const s = await setup();
  const sk = await skill(s);
  const { assignmentId } = await applyChange(s.orgId, s.cto, { kind: "create", versionIds: [sk.versionId], selectors: {}, level: "required" });
  const app = buildApp();
  t.after(() => app.close());
  const as = (tok: string, url: string) => app.inject({ method: "GET", url, headers: { authorization: `Bearer ${tok}` } });
  assert.equal((await as(s.engToken, `/orgs/${s.orgId}/assignments`)).statusCode, 403);
  assert.equal((await as(s.engToken, `/orgs/${s.orgId}/assignments/${assignmentId}/adoption`)).statusCode, 403);
  assert.equal((await as(s.ctoToken, `/orgs/${s.orgId}/assignments`)).statusCode, 200);
  assert.equal((await as(s.engToken, `/orgs/${s.orgId}/me/environments`)).statusCode, 200, "own status stays available");
});

test("#5 publishing approves exactly the reviewed content", async () => {
  const s = await setup();
  const { itemId, versionId } = await createItem(s.orgId, s.eng, { kind: "standard", name: `R ${uid()}`, content: { taskTypes: ["code"], requirements: [{ text: "Reviewed text", level: "required" }] } });
  const reviewed = (await previewVersion(s.orgId, versionId)).version.reviewHash;
  // the author edits after the admin looked
  await saveDraft(s.orgId, s.eng, itemId, { content: { taskTypes: ["code"], requirements: [{ text: "Sneaky new text", level: "required" }] } });
  await assert.rejects(publishVersion(s.orgId, s.cto, versionId, reviewed), /changed after you reviewed it/);
  const fresh = (await previewVersion(s.orgId, versionId)).version.reviewHash;
  await publishVersion(s.orgId, s.cto, versionId, fresh);
  const v = (await getItem(s.orgId, itemId)).versions[0]!;
  assert.equal((v.content as { requirements: Array<{ text: string }> }).requirements[0]!.text, "Sneaky new text");
  assert.equal(v.state, "published");
});

test("#11 apply is bound to the state the preview saw", async () => {
  const s = await setup();
  const a1 = await skill(s, "a");
  const a2 = await skill(s, "b");
  const { assignmentId } = await applyChange(s.orgId, s.cto, { kind: "create", versionIds: [a1.versionId], selectors: {}, level: "required" });
  const change = { kind: "revise" as const, assignmentId: assignmentId!, selectors: { repos: [s.repoId] } };
  const adminA = await previewChange(s.orgId, s.cto, change);
  const adminB = await previewChange(s.orgId, s.cto, { kind: "revise", assignmentId: assignmentId!, versionIds: [a2.versionId] });
  await applyChange(s.orgId, s.cto, { kind: "revise", assignmentId: assignmentId!, versionIds: [a2.versionId] }, adminB.basis);
  await assert.rejects(applyChange(s.orgId, s.cto, change, adminA.basis), /preview again/, "admin A's stale preview can't overwrite B's revision");
  const again = await previewChange(s.orgId, s.cto, change);
  await applyChange(s.orgId, s.cto, change, again.basis);
});

test("#9 PRD checks never evaluate exempt requirements; #10 staleness is judged in the artifact's context", async () => {
  const s = await setup();
  const std = await createItem(s.orgId, s.cto, { kind: "standard", name: `PRD ${uid()}`, content: { taskTypes: ["prd"], requirements: [{ text: "Has metrics", level: "required" }] } });
  await publishVersion(s.orgId, s.cto, std.versionId);
  const key = ((await getItem(s.orgId, std.itemId)).versions[0]!.content as { requirements: Array<{ key: string }> }).requirements[0]!.key;
  const ck = await createItem(s.orgId, s.cto, { kind: "check", name: `Sections ${uid()}`, content: { artifactType: "prd", method: "structural", requiredSections: ["Success metrics"], requirementKeys: [key] } });
  await publishVersion(s.orgId, s.cto, ck.versionId);
  const { assignmentId } = await applyChange(s.orgId, s.cto, { kind: "create", versionIds: [std.versionId, ck.versionId], selectors: { projects: [s.projectId] }, level: "required" });
  const doc = await saveNativeBrief(s.orgId, s.projectId, s.cto, { title: "No metrics", content: "## Scope\nx" }, noExtract);
  const before = (await checkDocument(s.orgId, s.projectId, s.eng, { documentId: doc.documentId })).results[0]!;
  assert.equal(before.findings[0]!.verdict, "possible_violation");

  const x = await requestException(s.orgId, s.eng, { target: "requirement", versionId: std.versionId, requirementKey: key, scope: { projectId: s.projectId }, reason: "research doc" });
  await decideException(s.orgId, s.cto, x.id, true);
  assert.match(String((await listChecks(s.orgId, s.projectId)).checks.find((c) => c.id === before.id)!.stale), /exceptions/, "an approved exception makes the old result stale");
  const after = (await checkDocument(s.orgId, s.projectId, s.eng, { documentId: doc.documentId })).results[0]!;
  assert.notEqual(after.id, before.id, "a different evaluated set is a different result");
  assert.equal(after.execution, "skipped");
  assert.deepEqual(after.findings.map((f) => f.verdict), ["exempt"], "exempt, reported distinctly — never a violation or a pass");

  // retire the only assignment for project A while the same versions stay assigned elsewhere
  const b = await secondProject(s);
  await applyChange(s.orgId, s.cto, { kind: "create", versionIds: [std.versionId, ck.versionId], selectors: { projects: [b.projectId] }, level: "required" });
  await applyChange(s.orgId, s.cto, { kind: "retire", assignmentId: assignmentId! });
  assert.match(String((await listChecks(s.orgId, s.projectId)).checks.find((c) => c.id === after.id)!.stale), /no longer applies/);
});

test("#12 coverage counts every environment, respects pilots and wrong-repo enrollment; standard-only shows guidance", async () => {
  const s = await setup();
  const sk = await skill(s);
  const b = await secondProject(s);
  // eng enrolls only project B's checkout; the rollout targets project A's repo
  const { assignmentId } = await applyChange(s.orgId, s.cto, { kind: "create", versionIds: [sk.versionId], selectors: { repos: [s.repoId] }, level: "required" });
  await enrollEnvironment({ orgId: s.orgId, projectId: b.projectId, repoId: b.repoId, memberId: s.eng } as never, { adapter: "claude", hostKey: hk(), capabilities: CAPS });
  let ad = await assignmentAdoption(s.orgId, assignmentId!);
  assert.equal(ad.coverage.enrolledEnvironments, 0);
  assert.equal(ad.coverage.membersNotEnrolled, 2, "enrolled elsewhere isn't covered here");

  // 600 environments of one person in scope: counts aren't the row cap
  await withOrg(s.orgId, (tx) =>
    tx.insert(environments).values(Array.from({ length: 600 }, () => ({ orgId: s.orgId, memberId: s.cto, adapter: "claude", hostKey: hk(), projectId: s.projectId, repoId: s.repoId, capabilities: CAPS }))),
  );
  ad = await assignmentAdoption(s.orgId, assignmentId!);
  assert.equal(ad.coverage.enrolledEnvironments, 600);
  assert.equal(ad.rows.length, 500);
  assert.equal(ad.truncated, true);
  assert.equal(ad.coverage.membersNotEnrolled, 1);

  // pilot narrows the reachable audience
  await applyChange(s.orgId, s.cto, { kind: "revise", assignmentId: assignmentId!, pilot: { audience: { kind: "members", ids: [s.cto] } } });
  ad = await assignmentAdoption(s.orgId, assignmentId!);
  assert.equal(ad.coverage.reachableMembers, 1);

  // a standard-only rollout still shows who receives it (as guidance)
  const std = await createItem(s.orgId, s.cto, { kind: "standard", name: `G ${uid()}`, content: { taskTypes: ["code"], requirements: [{ text: "g", level: "required" }] } });
  await publishVersion(s.orgId, s.cto, std.versionId);
  const g = await applyChange(s.orgId, s.cto, { kind: "create", versionIds: [std.versionId], selectors: { repos: [b.repoId] }, level: "required" });
  const ga = await assignmentAdoption(s.orgId, g.assignmentId!);
  assert.equal(ga.coverage.guidanceEnvironments, 1);
  assert.equal(ga.rows[0]!.guidance.length, 1);
});

test("#13 an old observation isn't presented as current", async () => {
  const old = new Date("2020-01-01T00:00:00Z");
  const st = itemState({ capabilities: CAPS, verifiedAt: old }, { itemId: "i", versionId: "v" }, [
    { kind: "installed", itemId: "i", versionId: "v", generation: "g", sessionId: null, receivedAt: old, detail: null } as never,
    { kind: "session_available", itemId: "i", versionId: "v", generation: "g", sessionId: null, receivedAt: old, detail: null } as never,
  ]);
  assert.equal(st.state, "installed", "kept as the last observed outcome");
  assert.equal(st.fresh, false);
  assert.equal(st.sessionAvailable, false, "an old session doesn't count");
  void receipts;
});

test("F4: fetching sync instructions doesn't make an old installation current; a completed sync does", async () => {
  const s = await setup();
  const sk = await skill(s);
  const { assignmentId } = await applyChange(s.orgId, s.cto, { kind: "create", versionIds: [sk.versionId], selectors: {}, level: "required" });
  const { environmentId } = await enrollEnvironment({ orgId: s.orgId, projectId: s.projectId, repoId: s.repoId, memberId: s.eng } as never, { adapter: "claude", hostKey: hk(), capabilities: CAPS });
  const { recordReceipts } = await import("./environments.js");
  const r = await syncPayload(s.orgId, environmentId, s.eng);
  await recordReceipts(s.orgId, environmentId, s.eng, { generation: r.generation, results: [{ kind: "installed", itemId: sk.itemId, versionId: sk.versionId }, { kind: "synced" }] });
  // a month passes with no completed sync …
  await withOrg(s.orgId, (tx) => tx.update(environments).set({ verifiedAt: new Date(Date.now() - 30 * 864e5) }).where(eq(environments.id, environmentId)));
  // … then the client fetches instructions and crashes before reporting
  await syncPayload(s.orgId, environmentId, s.eng);
  let row = (await assignmentAdoption(s.orgId, assignmentId!)).rows[0]!;
  assert.equal(row.skills[0]!.fresh, false, "contact alone verifies nothing");
  assert.equal((await assignmentAdoption(s.orgId, assignmentId!)).installation.installed, 0);
  await recordReceipts(s.orgId, environmentId, s.eng, { generation: r.generation, results: [{ kind: "synced" }] });
  row = (await assignmentAdoption(s.orgId, assignmentId!)).rows[0]!;
  assert.equal(row.skills[0]!.fresh, true, "a completed reconciliation does");
});

test("#16 a standard never applies outside the task types it was written for", async () => {
  const s = await setup();
  const std = await createItem(s.orgId, s.cto, { kind: "standard", name: `PRD-only ${uid()}`, content: { taskTypes: ["prd"], requirements: [{ text: "p", level: "required" }] } });
  await publishVersion(s.orgId, s.cto, std.versionId);
  await applyChange(s.orgId, s.cto, { kind: "create", versionIds: [std.versionId], selectors: {}, level: "required" }); // no task filter
  assert.equal((await whyThisApplies(s.orgId, s.projectId, s.eng, { taskType: "code" })).standards.length, 0);
  assert.equal((await whyThisApplies(s.orgId, s.projectId, s.eng, { taskType: "prd" })).standards.length, 1);
});

test("D2/D3 contracts: consumers stay with their producer; 'governed by' is binding rules only", async () => {
  const s = await setup();
  const { getConceptContracts } = await import("../concepts/read.js");
  const { conceptPlacements, concepts, decisionVersions, decisions, dependencyEdges, domains, surfaces } = await import("../db/schema.js");
  const route = `http:GET /files/${uid()}`;
  const ids = await withSystem(async (tx) => {
    const other = one(await tx.insert(repos).values({ orgId: s.orgId, projectId: s.projectId, gitRemote: `github.com/acme/other-${uid()}` }).returning());
    const consumers = await tx.insert(repos).values([1, 2, 3].map((i) => ({ orgId: s.orgId, projectId: s.projectId, gitRemote: `github.com/acme/c${i}-${uid()}` }))).returning();
    const d = one(await tx.insert(domains).values({ orgId: s.orgId, projectId: s.projectId, key: `d${uid()}`, label: "Files" }).returning());
    const c = one(await tx.insert(concepts).values({ orgId: s.orgId, projectId: s.projectId, key: `http:files${uid()}`, label: "files", domainId: d.id } as never).returning());
    const sa = one(await tx.insert(surfaces).values({ orgId: s.orgId, projectId: s.projectId, repoId: s.repoId, surface: route, kind: "http" }).returning());
    const sb = one(await tx.insert(surfaces).values({ orgId: s.orgId, projectId: s.projectId, repoId: other.id, surface: route, kind: "http" }).returning());
    for (const x of [sa, sb]) await tx.insert(conceptPlacements).values({ orgId: s.orgId, projectId: s.projectId, itemKind: "surface", itemId: x.id, location: "concept", conceptId: c.id, state: "confirmed" } as never);
    // repo A's route has 3 consumers, repo B's has 1
    for (const r of consumers) await tx.insert(dependencyEdges).values({ orgId: s.orgId, projectId: s.projectId, consumerRepoId: r.id, producedRepoId: s.repoId, producedSurface: route });
    await tx.insert(dependencyEdges).values({ orgId: s.orgId, projectId: s.projectId, consumerRepoId: consumers[0]!.id, producedRepoId: other.id, producedSurface: route });
    const mk = async (status: string, text: string) => {
      const dd = one(await tx.insert(decisions).values({ orgId: s.orgId, projectId: s.projectId, scopeKind: "surface", scopeRef: route, status, currentVersion: 1 }).returning());
      await tx.insert(decisionVersions).values({ orgId: s.orgId, decisionId: dd.id, version: 1, baseVersion: 0, ruleText: text, status } as never);
    };
    await mk("binding", "Paginate at 50");
    await mk("proposed", "Maybe cache for 60s");
    await mk("superseded", "Paginate at 20");
    return { conceptId: c.id, a: sa.id, b: sb.id };
  });
  const r = await getConceptContracts(s.orgId, s.projectId, ids.conceptId);
  const byId = new Map(r.contracts.map((x) => [x.id, x]));
  assert.equal(byId.get(ids.a)!.consumers.count, 3);
  assert.equal(byId.get(ids.b)!.consumers.count, 1, "same route in another repo keeps its own consumers");
  assert.deepEqual(byId.get(ids.a)!.governing.map((g) => g.ruleText), ["Paginate at 50"]);
  assert.deepEqual(byId.get(ids.a)!.related.map((g) => g.status).sort(), ["proposed", "superseded"]);
});
