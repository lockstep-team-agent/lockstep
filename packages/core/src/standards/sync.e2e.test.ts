/**
 * Standards milestone 2 against Postgres: enrollment, desired state, receipts (generation-checked),
 * rollouts (preview writes nothing; revise/rollback/retire/withdraw), recommended opt-in, blocked
 * versions, per-member environment isolation, and the flag-gated CLI routes.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { buildApp } from "../api/app.js";
import { env } from "../env.js";
import { withOrg, withSystem } from "../db/rls.js";
import { assignmentRevisions, members, principals, receipts, releases, repos } from "../db/schema.js";
import { registerSession } from "../api/session-context.js";
import { MemoryBlobStore, setBlobStore } from "../storage/blob.js";
import { createItem, publishVersion, saveDraft } from "./catalog.js";
import { storePackage } from "./packages.js";
import { createRelease } from "./applicability.js";
import { applyChange, assignmentAdoption, previewChange } from "./rollouts.js";
import {
  blobForEnv,
  enrollEnvironment,
  recordReceipts,
  setSkillPreference,
  syncPayload,
  unenrollEnvironment,
} from "./environments.js";
import { enc, one, setup, uid, type S } from "./test-fixtures.js";

before(() => setBlobStore(new MemoryBlobStore()));
after(() => setBlobStore(null));

const CAPS = { install: true, sessionAvailability: true, invocation: "unobservable" as const };
const hostKey = () => uid().toString(16).padStart(32, "0");

async function sessionFor(s: S, who: "cto" | "eng") {
  const memberId = who === "cto" ? s.cto : s.eng;
  const [p, repo] = await withSystem(async (tx) => {
    const m = one(await tx.select().from(members).where(eq(members.id, memberId)));
    return [
      one(await tx.select().from(principals).where(eq(principals.id, m.principalId!))),
      one(await tx.select().from(repos).where(eq(repos.id, s.repoId))),
    ] as const;
  });
  const ctx = await registerSession(p as never, { gitRemote: repo.gitRemote, vendor: "claude" });
  assert.ok(ctx, "session registers for a connected repo");
  return ctx!;
}

async function skillVersion(s: S, itemId: string | null, body: string) {
  const pkg = await storePackage(s.orgId, [{ path: "SKILL.md", bytes: enc(`---\nname: api-review\n---\n${body}`) }], null);
  const id = itemId ?? (await createItem(s.orgId, s.cto, { kind: "skill", name: `api-review ${uid()}`, content: { purpose: "Review" } })).itemId;
  const d = await saveDraft(s.orgId, s.cto, id, { content: { purpose: "Review" }, packageId: pkg.id });
  await publishVersion(s.orgId, s.cto, d.versionId);
  return { itemId: id, versionId: d.versionId };
}

async function assign(s: S, versionIds: string[], level: "required" | "recommended" = "required", selectors = {}) {
  const rel = await createRelease(s.orgId, s.cto, `rel ${uid()}`, versionIds);
  const r = await applyChange(s.orgId, s.cto, { kind: "create", releaseId: rel.id, selectors, level });
  return { releaseId: rel.id, assignmentId: r.assignmentId! };
}

async function enrolled(s: S, who: "cto" | "eng" = "eng") {
  const ctx = await sessionFor(s, who);
  const { environmentId } = await enrollEnvironment(ctx, { adapter: "claude", adapterVersion: "0.4.0", hostKey: hostKey(), capabilities: CAPS });
  return { ctx, envId: environmentId };
}

test("enrolled environment gets required skills; recommended ones are offered until accepted", async () => {
  const s = await setup();
  const req = await skillVersion(s, null, "v1");
  const rec = await skillVersion(s, null, "rec");
  await assign(s, [req.versionId]);
  await assign(s, [rec.versionId], "recommended");
  const { envId } = await enrolled(s);

  const r1 = await syncPayload(s.orgId, envId, s.eng);
  assert.deepEqual(r1.desired.map((d) => d.itemId), [req.itemId]);
  assert.deepEqual(r1.offered.map((o) => o.itemId), [rec.itemId]);
  assert.match(r1.generation, /^[0-9a-f]{32}$/);
  assert.equal(r1.desired[0]!.files[0]!.path, "SKILL.md");

  await setSkillPreference(s.orgId, envId, s.eng, rec.itemId, "accept");
  const r2 = await syncPayload(s.orgId, envId, s.eng);
  assert.deepEqual(new Set(r2.desired.map((d) => d.itemId)), new Set([req.itemId, rec.itemId]));
  assert.notEqual(r2.generation, r1.generation, "a different desired set is a different generation");

  // review #7: a required skill can't be declined; a recommendation declined earlier that later
  // becomes required is installed anyway.
  await assert.rejects(setSkillPreference(s.orgId, envId, s.eng, req.itemId, "decline"), /can't be declined/);
  await setSkillPreference(s.orgId, envId, s.eng, rec.itemId, "decline");
  const r3 = await syncPayload(s.orgId, envId, s.eng);
  assert.deepEqual(r3.declined.map((d) => d.itemId), [rec.itemId]);
  assert.deepEqual(r3.desired.map((d) => d.itemId), [req.itemId]);
  await assign(s, [rec.versionId], "required");
  const r4 = await syncPayload(s.orgId, envId, s.eng);
  assert.deepEqual(new Set(r4.desired.map((d) => d.itemId)), new Set([req.itemId, rec.itemId]), "now required: the old opt-out no longer applies");
});

test("blobs are served only for this environment's desired files and only to its member", async () => {
  const s = await setup();
  const sk = await skillVersion(s, null, "hello");
  await assign(s, [sk.versionId]);
  const { envId } = await enrolled(s);
  const want = (await syncPayload(s.orgId, envId, s.eng)).desired[0]!.files[0]!;
  const bytes = await blobForEnv(s.orgId, envId, s.eng, want.sha256);
  assert.match(new TextDecoder().decode(bytes), /hello/);
  await assert.rejects(blobForEnv(s.orgId, envId, s.eng, "0".repeat(64)), /not part of/);
  await assert.rejects(blobForEnv(s.orgId, envId, s.cto, want.sha256), /environment not found/, "another member can't read this env");
  await unenrollEnvironment(s.orgId, envId, s.eng);
  await assert.rejects(syncPayload(s.orgId, envId, s.eng), /no longer enrolled/);
});

test("receipts: a sync against an older generation never counts as current (A19); adoption shows outdated", async () => {
  const s = await setup();
  const v1 = await skillVersion(s, null, "one");
  const { assignmentId } = await assign(s, [v1.versionId]);
  const { envId } = await enrolled(s);
  const g1 = (await syncPayload(s.orgId, envId, s.eng)).generation;

  const ok = await recordReceipts(s.orgId, envId, s.eng, {
    generation: g1,
    results: [{ kind: "installed", itemId: v1.itemId, versionId: v1.versionId }, { kind: "synced" }],
  });
  assert.equal(ok.current, true);
  let ad = await assignmentAdoption(s.orgId, assignmentId);
  assert.equal(ad.installation.installed, 1);

  // v2 is published and rolled out while the machine is still acknowledging v1
  const v2 = await skillVersion(s, v1.itemId, "two");
  const rel2 = await createRelease(s.orgId, s.cto, "v2", [v2.versionId]);
  await applyChange(s.orgId, s.cto, { kind: "revise", assignmentId, releaseId: rel2.id });
  const stale = await recordReceipts(s.orgId, envId, s.eng, { generation: g1, results: [{ kind: "synced" }] });
  assert.equal(stale.current, false, "stale acknowledgement is recorded but not current");
  assert.notEqual(stale.generation, g1);
  ad = await assignmentAdoption(s.orgId, assignmentId);
  assert.equal(ad.installation.outdated, 1);
  assert.equal(ad.installation.installed, 0);
  assert.deepEqual(ad.revisions.map((r) => r.revision), [2, 1]);

  await assert.rejects(recordReceipts(s.orgId, envId, s.eng, { generation: "nope", results: [] }), /generation/);
  await assert.rejects(
    recordReceipts(s.orgId, envId, s.eng, { generation: g1, results: [{ kind: "exploded" }] }),
    /unknown receipt kind/,
  );
  // receipts are append-only
  await assert.rejects(withOrg(s.orgId, (tx) => tx.delete(receipts).where(eq(receipts.envId, envId))));
});

test("preview writes nothing and reports install/update/remove; rollback and retire then apply", async () => {
  const s = await setup();
  const v1 = await skillVersion(s, null, "one");
  const v2 = await skillVersion(s, v1.itemId, "two");
  await enrolled(s);
  const rel1 = await createRelease(s.orgId, s.cto, "r1", [v1.versionId]);

  const p = await previewChange(s.orgId, s.cto, { kind: "create", releaseId: rel1.id, selectors: {}, level: "required" });
  assert.equal(p.environments.affected, 1);
  assert.equal(p.totals.install, 1);
  assert.equal(p.environments.notEnrolledMembers, 1, "the owner is reachable but has no environment");
  const count = async () => (await withOrg(s.orgId, (tx) => tx.select().from(assignmentRevisions))).length;
  const before = await count();
  await previewChange(s.orgId, s.cto, { kind: "create", releaseId: rel1.id, selectors: {}, level: "required" });
  assert.equal(await count(), before, "preview is read-only");

  // versions can be rolled out directly: preview needs no release, apply creates one
  const rels = async () => (await withOrg(s.orgId, (tx) => tx.select().from(releases))).length;
  const r0 = await rels();
  const pv = await previewChange(s.orgId, s.cto, { kind: "create", versionIds: [v1.versionId], selectors: {}, level: "required" });
  assert.equal(pv.totals.install, 1);
  assert.equal(await rels(), r0, "previewing versions writes no release");
  await assert.rejects(previewChange(s.orgId, s.cto, { kind: "create", versionIds: [], selectors: {}, level: "required" }), /at least one/);

  const { assignmentId } = await applyChange(s.orgId, s.cto, { kind: "create", releaseId: rel1.id, selectors: {}, level: "required" });
  const up = await previewChange(s.orgId, s.cto, { kind: "revise", assignmentId: assignmentId!, versionIds: [v2.versionId] });
  assert.deepEqual(up.rows[0]!.changes.map((c) => [c.action, c.from, c.to]), [["update", 1, 2]]);
  await applyChange(s.orgId, s.cto, { kind: "revise", assignmentId: assignmentId!, versionIds: [v2.versionId] });

  const back = await previewChange(s.orgId, s.cto, { kind: "rollback", assignmentId: assignmentId!, toRevision: 1 });
  assert.deepEqual(back.rows[0]!.changes.map((c) => [c.action, c.from, c.to]), [["update", 2, 1]]);
  const rb = await applyChange(s.orgId, s.cto, { kind: "rollback", assignmentId: assignmentId!, toRevision: 1 });
  assert.equal(rb.revision, 3, "rollback is a new revision; history is kept");

  const ret = await previewChange(s.orgId, s.cto, { kind: "retire", assignmentId: assignmentId! });
  assert.equal(ret.totals.remove, 1);
  await applyChange(s.orgId, s.cto, { kind: "retire", assignmentId: assignmentId! });
  await assert.rejects(applyChange(s.orgId, s.cto, { kind: "retire", assignmentId: assignmentId! }), /already retired/);
  await assert.rejects(previewChange(s.orgId, s.eng, { kind: "retire", assignmentId: assignmentId! }), /owner or admin/);
});

test("retiring one assignment keeps a skill another still needs (A18); two versions are blocked (A6)", async () => {
  const s = await setup();
  const v1 = await skillVersion(s, null, "one");
  const a = await assign(s, [v1.versionId]);
  const b = await assign(s, [v1.versionId], "required", { repos: [s.repoId] });
  const { envId } = await enrolled(s);
  await applyChange(s.orgId, s.cto, { kind: "retire", assignmentId: a.assignmentId });
  assert.deepEqual((await syncPayload(s.orgId, envId, s.eng)).desired.map((d) => d.itemId), [v1.itemId]);
  await applyChange(s.orgId, s.cto, { kind: "retire", assignmentId: b.assignmentId });
  assert.equal((await syncPayload(s.orgId, envId, s.eng)).desired.length, 0);

  const v2 = await skillVersion(s, v1.itemId, "two");
  await assign(s, [v1.versionId]);
  await assign(s, [v2.versionId], "required", { pathGlobs: ["src/**"] }); // path scope still installs checkout-wide
  const r = await syncPayload(s.orgId, envId, s.eng);
  assert.equal(r.desired.length, 0, "never last-write-wins");
  assert.deepEqual(r.blocked.map((x) => x.versions), [[1, 2]]);
});

test("withdrawn release: replacement takes over, or the skill is removed (A10)", async () => {
  const s = await setup();
  const v1 = await skillVersion(s, null, "one");
  const v2 = await skillVersion(s, v1.itemId, "two");
  const { releaseId } = await assign(s, [v1.versionId]);
  const { envId } = await enrolled(s);
  const rel2 = await createRelease(s.orgId, s.cto, "fix", [v2.versionId]);
  await applyChange(s.orgId, s.cto, { kind: "withdraw", releaseId, replacementReleaseId: rel2.id, reason: "bad advice" });
  assert.deepEqual((await syncPayload(s.orgId, envId, s.eng)).desired.map((d) => d.versionId), [v2.versionId]);
  await assert.rejects(applyChange(s.orgId, s.cto, { kind: "withdraw", releaseId }), /already withdrawn/);
  const pv = await previewChange(s.orgId, s.cto, { kind: "withdraw", releaseId: rel2.id });
  assert.equal(pv.totals.remove, 1, "preview follows the replacement chain");
  await applyChange(s.orgId, s.cto, { kind: "withdraw", releaseId: rel2.id });
  assert.equal((await syncPayload(s.orgId, envId, s.eng)).desired.length, 0);
});

test("routes: environment endpoints are flag-gated and session-authenticated", async (t) => {
  const s = await setup();
  const sk = await skillVersion(s, null, "route");
  await assign(s, [sk.versionId]);
  const ctx = await sessionFor(s, "eng");
  const app = buildApp();
  t.after(() => app.close());
  const flag = env as unknown as { LOCKSTEP_STANDARDS: boolean };
  const prev = flag.LOCKSTEP_STANDARDS;
  t.after(() => {
    flag.LOCKSTEP_STANDARDS = prev;
  });
  const h = { authorization: `Bearer ${s.engToken}`, "x-lockstep-session": ctx.sessionId };
  const body = { adapter: "claude", adapterVersion: "0.4.0", hostKey: hostKey(), capabilities: CAPS };

  flag.LOCKSTEP_STANDARDS = false;
  assert.equal((await app.inject({ method: "POST", url: "/environments/enroll", headers: h, payload: body })).statusCode, 404);
  flag.LOCKSTEP_STANDARDS = true;
  assert.equal((await app.inject({ method: "POST", url: "/environments/enroll", headers: { authorization: h.authorization }, payload: body })).statusCode, 400);
  const en = await app.inject({ method: "POST", url: "/environments/enroll", headers: h, payload: body });
  assert.equal(en.statusCode, 200, en.body);
  const { environmentId } = en.json() as { environmentId: string };
  const sync = await app.inject({ method: "GET", url: `/environments/${environmentId}/sync`, headers: h });
  assert.equal(sync.statusCode, 200, sync.body);
  const file = (sync.json() as { desired: Array<{ files: Array<{ sha256: string }> }> }).desired[0]!.files[0]!;
  const blob = await app.inject({ method: "GET", url: `/environments/${environmentId}/blobs/${file.sha256}`, headers: h });
  assert.equal(blob.statusCode, 200);
  assert.match(blob.body, /route/);
  const rc = await app.inject({
    method: "POST",
    url: `/environments/${environmentId}/receipts`,
    headers: h,
    payload: { generation: (sync.json() as { generation: string }).generation, results: [{ kind: "synced" }] },
  });
  assert.deepEqual((rc.json() as { current: boolean }).current, true);
  const other = await app.inject({ method: "GET", url: `/environments/${environmentId}/sync`, headers: { authorization: `Bearer ${s.ctoToken}`, "x-lockstep-session": ctx.sessionId } });
  assert.equal(other.statusCode, 403, "someone else's token can't use this session");
  const mine = await app.inject({ method: "GET", url: `/orgs/${s.orgId}/me/environments`, headers: { authorization: h.authorization } });
  assert.equal((mine.json() as { environments: unknown[] }).environments.length, 1);
});
