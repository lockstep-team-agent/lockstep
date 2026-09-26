/**
 * Standards & Skills milestone 1 against Postgres: org authority (bootstrap, roles, teams),
 * catalog versioning (draft → propose → publish, immutability, diffs, preview), public GitHub
 * import, releases/assignments and "why this applies" — plus route-level flag and role gates.
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { buildApp } from "../api/app.js";
import { env } from "../env.js";
import { withOrg, withSystem } from "../db/rls.js";
import { itemVersions, members, orgRoles, principals, projectMembers, projects, repos } from "../db/schema.js";
import { issueTokenTx } from "../auth/tokens.js";
import { createOrg } from "../auth/auth-service.js";
import { MemoryBlobStore, setBlobStore } from "../storage/blob.js";
import { createTeam, setOrgRole, setTeamMember } from "./org-authority.js";
import { createItem, diffVersions, previewVersion, proposeVersion, publishVersion, saveDraft } from "./catalog.js";
import { createAssignment, createRelease, whyThisApplies } from "./applicability.js";
import { checkUpstream, importGithubSkill } from "./imports.js";
import { gitBlobSha } from "./github-import.js";
import { b64, enc, one, publishedSkill, publishedStandard, setup, uid, type S } from "./test-fixtures.js";

before(() => setBlobStore(new MemoryBlobStore()));
after(() => setBlobStore(null));
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});


test("org creator is the owner; the last owner can't be demoted; only owners manage roles", async () => {
  const s = await setup();
  const roles = await withOrg(s.orgId, (tx) => tx.select().from(orgRoles).where(eq(orgRoles.orgId, s.orgId)));
  assert.deepEqual(roles.map((r) => [r.memberId, r.role]), [[s.cto, "owner"]]);
  await assert.rejects(() => setOrgRole(s.orgId, s.cto, s.cto, "admin"), /at least one owner/);
  await assert.rejects(() => setOrgRole(s.orgId, s.eng, s.eng, "owner"), /requires org owner/);
  await setOrgRole(s.orgId, s.cto, s.eng, "admin");
  await assert.rejects(() => setOrgRole(s.orgId, s.eng, s.eng, "owner"), /requires org owner/, "admins can't make owners");
});

test("teams are admin-managed; members can't add themselves", async () => {
  const s = await setup();
  await assert.rejects(() => createTeam(s.orgId, s.eng, "Backend"), /requires org owner or admin/);
  const t = await createTeam(s.orgId, s.cto, "Backend");
  await assert.rejects(() => setTeamMember(s.orgId, s.eng, t.id, s.eng, true), /requires org owner or admin/);
  await setTeamMember(s.orgId, s.cto, t.id, s.eng, true);
});

test("catalog: members propose, admins publish; published versions are immutable; edits open v2", async () => {
  const s = await setup();
  const { itemId, versionId } = await createItem(s.orgId, s.eng, { kind: "standard", name: "PRD quality", content: { taskTypes: ["prd"] } });
  await proposeVersion(s.orgId, s.eng, versionId);
  await assert.rejects(() => publishVersion(s.orgId, s.eng, versionId), /requires org owner or admin/);
  await assert.rejects(() => publishVersion(s.orgId, s.cto, versionId), /at least one requirement/, "empty requirements block publishing");
  const v1 = await saveDraft(s.orgId, s.eng, itemId, { content: { taskTypes: ["prd"], requirements: [{ text: "Has success metrics", level: "required" }] } });
  assert.equal(v1.version, 1, "the working draft is edited in place");
  await publishVersion(s.orgId, s.cto, v1.versionId);
  await assert.rejects(
    () => withOrg(s.orgId, (tx) => tx.update(itemVersions).set({ contentHash: "x" }).where(eq(itemVersions.id, v1.versionId))),
    (e: Error & { cause?: Error }) => /immutable/.test(`${e.message} ${e.cause?.message ?? ""}`),
    "the database refuses to change a published version",
  );
  const published = one(await withOrg(s.orgId, (tx) => tx.select().from(itemVersions).where(eq(itemVersions.id, v1.versionId))));
  const reqKey = (published.content as { requirements: Array<{ key: string }> }).requirements[0]!.key;
  const v2 = await saveDraft(s.orgId, s.eng, itemId, {
    content: { taskTypes: ["prd"], requirements: [{ key: reqKey, text: "Has measurable success metrics", level: "required" }, { text: "Lists non-goals", level: "recommended" }] },
  });
  assert.equal(v2.version, 2);
  const d = await diffVersions(s.orgId, v1.versionId, v2.versionId);
  assert.deepEqual(d.requirements.map((r) => r.change).sort(), ["added", "changed"]);
  assert.equal(d.requirements.find((r) => r.change === "changed")!.key, reqKey, "requirement identity is stable across versions");
});

test("skill preview shows the whole package and flags scripts; standards say when they're unverified", async () => {
  const s = await setup();
  const { itemId } = await createItem(s.orgId, s.cto, { kind: "skill", name: "Writer" });
  const { storePackage } = await import("./packages.js");
  const pkg = await storePackage(s.orgId, [{ path: "SKILL.md", bytes: enc("---\nname: writer\ndescription: Write PRDs\n---\nWrite.") }, { path: "fmt.sh", bytes: enc("echo") }], null);
  const d = await saveDraft(s.orgId, s.cto, itemId, { content: {}, packageId: pkg.id });
  const p = await previewVersion(s.orgId, d.versionId);
  assert.equal(p.frontmatter.name, "writer");
  assert.deepEqual(p.package!.files.map((f) => [f.path, f.isScript]), [
    ["SKILL.md", false],
    ["fmt.sh", true],
  ]);
  const st = await publishedStandard(s);
  const sp = await previewVersion(s.orgId, st.versionId);
  assert.match(sp.brief!, /\[required\] Public API changes document compatibility/);
  assert.match(sp.brief!, /Unverified guidance/);
});

test("releases hold published versions only; publishing a new version never changes an assignment (A1)", async () => {
  const s = await setup();
  const st = await publishedStandard(s);
  const draft = await createItem(s.orgId, s.cto, { kind: "standard", name: "Draft only", content: { taskTypes: ["code"] } });
  await assert.rejects(() => createRelease(s.orgId, s.cto, "r", [draft.versionId]), /only published/);
  const rel = await createRelease(s.orgId, s.cto, "API v1", [st.versionId]);
  await createAssignment(s.orgId, s.cto, { name: "Backend API", releaseId: rel.id, selectors: { repos: [s.repoId], taskTypes: ["code"] }, level: "required" });
  const v2 = await saveDraft(s.orgId, s.cto, st.itemId, { content: { taskTypes: ["code"], requirements: [{ text: "Changed rule", level: "required" }] } });
  await publishVersion(s.orgId, s.cto, v2.versionId);
  const why = await whyThisApplies(s.orgId, s.projectId, s.eng, { repoId: s.repoId, taskType: "code" });
  assert.equal(why.standards.length, 1);
  assert.equal(why.standards[0]!.versionId, st.versionId, "still the released v1");
});

test("why this applies: baseline + repo + team audience, unknown context, blocked versions (A4, A6)", async () => {
  const s = await setup();
  const st = await publishedStandard(s);
  const sk = await publishedSkill(s);
  const team = await createTeam(s.orgId, s.cto, `Backend ${uid()}`);
  await setTeamMember(s.orgId, s.cto, team.id, s.eng, true);
  const base = await createRelease(s.orgId, s.cto, "baseline", [sk.versionId]);
  const scoped = await createRelease(s.orgId, s.cto, "api", [st.versionId]);
  await createAssignment(s.orgId, s.cto, { name: "Org baseline", releaseId: base.id, selectors: {}, level: "recommended" });
  await createAssignment(s.orgId, s.cto, { name: "Backend team", releaseId: scoped.id, selectors: { repos: [s.repoId], taskTypes: ["code"], audience: { kind: "teams", ids: [team.id] } }, level: "required" });

  const w = await whyThisApplies(s.orgId, s.projectId, s.eng, { repoId: s.repoId, taskType: "code" });
  assert.deepEqual(w.skills.map((x) => [x.level, x.reasons[0]!.matched]), [["recommended", ["organization baseline"]]]);
  assert.deepEqual(w.standards[0]!.reasons[0]!.matched, ["repository", "team", "task type"]);

  const unknown = await whyThisApplies(s.orgId, s.projectId, s.eng, { repoId: s.repoId });
  assert.equal(unknown.standards.length, 0);
  assert.deepEqual(unknown.unknown.map((u) => u.missing), [["task type"]]);
  assert.equal(unknown.limitations.length, 2);

  const notInTeam = await whyThisApplies(s.orgId, s.projectId, s.cto, { repoId: s.repoId, taskType: "code" });
  assert.equal(notInTeam.standards.length, 0, "team audience doesn't reach non-members");

  const v2 = await saveDraft(s.orgId, s.cto, sk.itemId, { content: { purpose: "v2" } });
  await publishVersion(s.orgId, s.cto, v2.versionId);
  const rel2 = await createRelease(s.orgId, s.cto, "baseline v2", [v2.versionId]);
  await createAssignment(s.orgId, s.cto, { name: "Pilot v2", releaseId: rel2.id, selectors: { repos: [s.repoId] }, level: "required" });
  const conflict = await whyThisApplies(s.orgId, s.projectId, s.eng, { repoId: s.repoId, taskType: "code" });
  assert.equal(conflict.skills.length, 0);
  assert.equal(conflict.blocked[0]!.versions.length, 2, "never last-write-wins");
});

test("GitHub import captures a draft with provenance; a vanished upstream never breaks it (A2, A3)", async () => {
  const s = await setup();
  const commit = "d".repeat(40);
  const skillMd = "---\nname: pr-writer\ndescription: Writes PRDs\n---\nWrite.";
  let upstreamGone = false;
  globalThis.fetch = (async (input: string | URL) => {
    const u = String(input);
    if (upstreamGone && u.includes("api.github.com")) return new Response("{}", { status: 404 });
    if (u.includes("/commits/")) return new Response(JSON.stringify({ sha: commit }));
    if (u.includes("/git/trees/"))
      return new Response(JSON.stringify({ truncated: false, tree: [{ path: "prd/SKILL.md", type: "blob", mode: "100644", sha: gitBlobSha(enc(skillMd)), size: skillMd.length }] }));
    if (u.includes("raw.githubusercontent.com")) return new Response(skillMd);
    return new Response("?", { status: 500 });
  }) as typeof fetch;
  const r = await importGithubSkill(s.orgId, s.eng, { url: "https://github.com/acme/skills/tree/main/prd", commit, ref: "main", dir: "prd" });
  const v = one(await withOrg(s.orgId, (tx) => tx.select().from(itemVersions).where(eq(itemVersions.id, r.versionId))));
  assert.equal(v.state, "draft", "import never publishes");
  assert.deepEqual((v.provenance as { commit: string; path: string }).commit, commit);
  assert.equal((await checkUpstream(s.orgId, r.versionId)).status, "up_to_date");
  upstreamGone = true;
  const u = await checkUpstream(s.orgId, r.versionId);
  assert.equal(u.status, "unavailable");
  const p = await previewVersion(s.orgId, r.versionId);
  assert.equal(p.package!.files[0]!.path, "SKILL.md", "the captured snapshot is intact");
});

test("routes: 404 while the flag is off; server-side role and org gates when on (A16)", async (t) => {
  const s = await setup();
  const other = await setup();
  const app = buildApp();
  t.after(() => app.close());
  const auth = (tok: string) => ({ authorization: `Bearer ${tok}` });
  const flag = env as unknown as { LOCKSTEP_STANDARDS: boolean };
  const prev = flag.LOCKSTEP_STANDARDS;
  t.after(() => {
    flag.LOCKSTEP_STANDARDS = prev;
  });

  flag.LOCKSTEP_STANDARDS = false;
  assert.equal((await app.inject({ method: "GET", url: `/orgs/${s.orgId}/catalog`, headers: auth(s.ctoToken) })).statusCode, 404);
  assert.deepEqual((await app.inject({ method: "GET", url: "/standards/capabilities" })).json(), { standards: false });

  flag.LOCKSTEP_STANDARDS = true;
  const created = await app.inject({
    method: "POST",
    url: `/orgs/${s.orgId}/catalog`,
    headers: auth(s.engToken),
    payload: { kind: "skill", name: "Member draft", files: [{ path: "SKILL.md", contentBase64: b64("---\nname: m\n---\nx") }] },
  });
  assert.equal(created.statusCode, 200, created.body);
  const { versionId } = created.json() as { versionId: string };
  const reviewed = (await app.inject({ method: "GET", url: `/orgs/${s.orgId}/catalog/versions/${versionId}/preview`, headers: auth(s.ctoToken) })).json() as { version: { reviewHash: string } };
  const hash = { expectedHash: reviewed.version.reviewHash };
  assert.equal((await app.inject({ method: "POST", url: `/orgs/${s.orgId}/catalog/versions/${versionId}/publish`, headers: auth(s.ctoToken) })).statusCode, 400, "publishing requires the reviewed hash");
  const stale = await app.inject({ method: "POST", url: `/orgs/${s.orgId}/catalog/versions/${versionId}/publish`, headers: auth(s.ctoToken), payload: { expectedHash: "0".repeat(64) } });
  assert.equal(stale.statusCode, 409, "content that differs from what was reviewed is never published");
  const denied = await app.inject({ method: "POST", url: `/orgs/${s.orgId}/catalog/versions/${versionId}/publish`, headers: auth(s.engToken), payload: hash });
  assert.equal(denied.statusCode, 403, "members can't publish");
  const ok = await app.inject({ method: "POST", url: `/orgs/${s.orgId}/catalog/versions/${versionId}/publish`, headers: auth(s.ctoToken), payload: hash });
  assert.equal(ok.statusCode, 200, ok.body);
  const crossOrg = await app.inject({ method: "GET", url: `/orgs/${s.orgId}/catalog/versions/${versionId}/preview`, headers: auth(other.ctoToken) });
  assert.equal(crossOrg.statusCode, 403, "a non-member can't read another org's packages");
  const viaOwnOrg = await app.inject({ method: "GET", url: `/orgs/${other.orgId}/catalog/versions/${versionId}/preview`, headers: auth(other.ctoToken) });
  assert.equal(viaOwnOrg.statusCode, 404, "RLS hides other orgs' versions");
});
