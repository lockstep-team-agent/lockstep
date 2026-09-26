/**
 * Standards milestone 3 against Postgres: PRD structural + rubric checks (execution separate from
 * findings, verbatim evidence, dedupe, staleness), code-diff checks against standards through the
 * existing consented path, finding actions, content-bound exceptions (approve / needs review /
 * expiry), the versioned session briefing, the repo-free brief export, and Inbox items.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { env } from "../env.js";
import { withOrg, withSystem } from "../db/rls.js";
import { exceptions, members, principals, receipts, repos, usageEvents } from "../db/schema.js";
import { registerSession } from "../api/session-context.js";
import { MemoryBlobStore, setBlobStore } from "../storage/blob.js";
import { saveNativeBrief } from "../adoption/native-documents.js";
import { buildBrief } from "../adoption/sharing.js";
import { runCheck } from "../adoption/checks.js";
import { continuity } from "../adoption/service.js";
import { createItem, publishVersion, saveDraft } from "./catalog.js";
import { storePackage } from "./packages.js";
import { applyChange } from "./rollouts.js";
import { actOnFinding, checkDocument, listChecks, structuralFindings, type RubricJudge } from "./checks.js";
import { decideException, expireExceptions, listExceptions, requestException } from "./exceptions.js";
import { whyThisApplies, createRelease } from "./applicability.js";
import { standardsInboxItems } from "./inbox.js";
import { enc, one, setup, uid, type S } from "./test-fixtures.js";

const flag = env as unknown as { LOCKSTEP_STANDARDS: boolean; LOCKSTEP_CHECKS_ENABLED: boolean };
const prev = { ...flag };
before(() => {
  setBlobStore(new MemoryBlobStore());
  flag.LOCKSTEP_STANDARDS = true;
  flag.LOCKSTEP_CHECKS_ENABLED = true;
});
after(() => {
  setBlobStore(null);
  flag.LOCKSTEP_STANDARDS = prev.LOCKSTEP_STANDARDS;
  flag.LOCKSTEP_CHECKS_ENABLED = prev.LOCKSTEP_CHECKS_ENABLED;
});

const noExtract = async () => ({ rules: [], degraded: false });
const PRD_OK = `## Success metrics\nActivation up 10%.\n\n## Non-goals\nNo mobile.\n\n## Assumptions\nUsers have accounts.\n\n## Acceptance criteria\nA user can export a report.`;

/** Example C: a PRD standard with a structural check and a rubric, assigned to PRD work. */
async function prdSetup(s: S) {
  const std = await createItem(s.orgId, s.cto, {
    kind: "standard",
    name: `PRD quality ${uid()}`,
    content: { purpose: "Useful PRDs", taskTypes: ["prd"], requirements: [{ text: "States measurable success metrics", level: "required" }, { text: "Lists non-goals", level: "recommended" }] },
  });
  await publishVersion(s.orgId, s.cto, std.versionId);
  const { getItem } = await import("./catalog.js");
  const reqKeys = ((await getItem(s.orgId, std.itemId)).versions[0]!.content as { requirements: Array<{ key: string }> }).requirements.map((r) => r.key);
  const structural = await createItem(s.orgId, s.cto, {
    kind: "check",
    name: `PRD sections ${uid()}`,
    content: { artifactType: "prd", method: "structural", requiredSections: ["Success metrics", "Non-goals", "Assumptions", "Acceptance criteria"], requirementKeys: [reqKeys[0]] },
  });
  await publishVersion(s.orgId, s.cto, structural.versionId);
  const rubric = await createItem(s.orgId, s.cto, {
    kind: "check",
    name: `PRD rubric ${uid()}`,
    content: { artifactType: "prd", method: "rubric", requirementKeys: reqKeys, instructions: "Assess each requirement." },
  });
  await publishVersion(s.orgId, s.cto, rubric.versionId);
  const { assignmentId } = await applyChange(s.orgId, s.cto, {
    kind: "create",
    versionIds: [std.versionId, structural.versionId, rubric.versionId],
    selectors: { projects: [s.projectId], taskTypes: ["prd"] },
    level: "required",
  });
  return { std, reqKeys, structural, rubric, assignmentId: assignmentId! };
}

test("structural finder: present, missing and empty sections", () => {
  const f = structuralFindings("# T\n## Success metrics\nx\n## Non-goals\n\n## Other\ny", ["Success metrics", "Non-goals", "Assumptions"], "req_1");
  assert.deepEqual(f.map((x) => x.verdict), ["satisfied", "possible_violation", "possible_violation"]);
  assert.match(f[1]!.note, /empty/);
  assert.match(f[2]!.note, /No heading/);
});

test("PRD check: execution is separate from findings; nothing missing ever passes (A13)", async () => {
  const s = await setup();
  const doc = await saveNativeBrief(s.orgId, s.projectId, s.cto, { title: "Reports", content: "## Success metrics\nMore reports.\n" }, noExtract);

  // no applicable check → skipped, never a pass
  const none = await checkDocument(s.orgId, s.projectId, s.eng, { documentId: doc.documentId });
  assert.deepEqual(none.results.map((r) => r.execution), ["skipped"]);

  const p = await prdSetup(s);
  const noConsent = await checkDocument(s.orgId, s.projectId, s.eng, { documentId: doc.documentId });
  const by = (name: string) => noConsent.results.find((r) => r.name?.startsWith(name))!;
  assert.equal(by("PRD sections").execution, "completed");
  assert.deepEqual(by("PRD sections").findings.map((f) => f.verdict), ["satisfied", "possible_violation", "possible_violation", "possible_violation"]);
  assert.equal(by("PRD rubric").execution, "skipped", "hosted review needs an explicit per-submission request");

  const down: RubricJudge = async () => null;
  const unavailable = await checkDocument(s.orgId, s.projectId, s.eng, { documentId: doc.documentId, hostedReview: true }, down);
  const r = unavailable.results.find((x) => x.name?.startsWith("PRD rubric"))!;
  assert.equal(r.execution, "unavailable");
  assert.ok(r.findings.every((f) => f.verdict === "inconclusive"), "no provider → no pass");
  void p;
});

test("rubric evidence must be verbatim; results dedupe per revision and go stale on edit (A14)", async () => {
  const s = await setup();
  await prdSetup(s);
  const doc = await saveNativeBrief(s.orgId, s.projectId, s.cto, { title: "Export", content: PRD_OK }, noExtract);
  const judge: RubricJudge = async ({ requirement }) =>
    requirement.includes("success")
      ? { verdict: "satisfied", quotes: ["Activation up 10%."], note: "Metric stated." }
      : { verdict: "satisfied", quotes: ["We will never ship mobile."], note: "Invented quote." };
  const r1 = await checkDocument(s.orgId, s.projectId, s.eng, { documentId: doc.documentId, hostedReview: true }, judge);
  const rub = r1.results.find((x) => x.name?.startsWith("PRD rubric"))!;
  assert.equal(rub.execution, "completed");
  assert.deepEqual(rub.findings.map((f) => f.verdict).sort(), ["inconclusive", "satisfied"], "an unverifiable quote is downgraded");
  assert.equal(rub.findings.find((f) => f.verdict === "satisfied")!.evidence[0]!.quote, "Activation up 10%.");
  const struct = r1.results.find((x) => x.name?.startsWith("PRD sections"))!;
  assert.ok(struct.findings.every((f) => f.verdict === "satisfied"));

  const r2 = await checkDocument(s.orgId, s.projectId, s.eng, { documentId: doc.documentId, hostedReview: true }, judge);
  assert.equal(r2.results.find((x) => x.name?.startsWith("PRD rubric"))!.id, rub.id, "same revision + rules → same result");

  await saveNativeBrief(s.orgId, s.projectId, s.cto, { documentId: doc.documentId, baseVersion: doc.version, title: "Export", content: `${PRD_OK}\n\nMore.` }, noExtract);
  const list = await listChecks(s.orgId, s.projectId);
  const old = list.checks.find((c) => c.id === rub.id)!;
  assert.match(String(old.stale), /newer revision/, "old result stays, visibly stale");
});

test("finding actions: dismiss with rationale, or request an exception; once per member", async () => {
  const s = await setup();
  const p = await prdSetup(s);
  const doc = await saveNativeBrief(s.orgId, s.projectId, s.cto, { title: "Thin", content: "## Success metrics\n\n" }, noExtract);
  const res = await checkDocument(s.orgId, s.projectId, s.eng, { documentId: doc.documentId });
  const st = res.results.find((x) => x.name?.startsWith("PRD sections"))!;
  const [f1, f2] = st.findings.filter((f) => f.verdict === "possible_violation");
  await assert.rejects(actOnFinding(s.orgId, s.projectId, s.eng, { checkId: st.id, findingKey: f1!.key, action: "dismiss", rationale: " " }), /rationale/);
  await actOnFinding(s.orgId, s.projectId, s.eng, { checkId: st.id, findingKey: f1!.key, action: "dismiss", rationale: "Metrics live in the linked dashboard spec" });
  await assert.rejects(actOnFinding(s.orgId, s.projectId, s.eng, { checkId: st.id, findingKey: f1!.key, action: "dismiss", rationale: "again" }), /already acted/);
  const ex = await actOnFinding(s.orgId, s.projectId, s.eng, { checkId: st.id, findingKey: f2!.key, action: "exception_requested", rationale: "Discovery doc, not a PRD" });
  assert.ok(ex.exceptionId);
  const xs = await listExceptions(s.orgId, { projectId: s.projectId });
  assert.equal(xs.find((x) => x.id === ex.exceptionId)!.state, "requested");
  assert.equal(xs.find((x) => x.id === ex.exceptionId)!.requirementKey, p.reqKeys[0]);

  const inboxAdmin = await standardsInboxItems(s.orgId, s.projectId, s.cto, false);
  assert.ok(inboxAdmin.some((i) => i.kind === "exception_request" && i.severity === 2), "admins see requests");
  assert.ok(inboxAdmin.some((i) => i.kind === "check_finding"), "undismissed findings are actionable");
  const inboxMember = await standardsInboxItems(s.orgId, s.projectId, s.eng, false);
  assert.ok(!inboxMember.some((i) => i.kind === "exception_request"), "members don't decide");
});

test("exceptions bind to content: unchanged text carries forward, changed needs review, expiry restores (A12)", async () => {
  const s = await setup();
  const std = await createItem(s.orgId, s.cto, { kind: "standard", name: `API ${uid()}`, content: { taskTypes: ["code"], requirements: [{ text: "Version breaking changes", level: "required" }, { text: "Add tests", level: "required" }] } });
  await publishVersion(s.orgId, s.cto, std.versionId);
  const { getItem } = await import("./catalog.js");
  const v1 = (await getItem(s.orgId, std.itemId)).versions[0]!;
  const [k1, k2] = (v1.content as { requirements: Array<{ key: string }> }).requirements.map((r) => r.key);
  const { assignmentId } = await applyChange(s.orgId, s.cto, { kind: "create", versionIds: [v1.id], selectors: {}, level: "required" });
  const x = await requestException(s.orgId, s.eng, { target: "requirement", versionId: v1.id, requirementKey: k1!, scope: { projectId: s.projectId }, reason: "Legacy API frozen", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  await assert.rejects(decideException(s.orgId, s.eng, x.id, true), /owner or admin/);
  await decideException(s.orgId, s.cto, x.id, true, "Until the v2 migration");
  await assert.rejects(decideException(s.orgId, s.cto, x.id, false), /already approved/);

  const exempt = async () =>
    (await whyThisApplies(s.orgId, s.projectId, s.eng, {})).standards[0]!.requirements.find((r) => r.key === k1)!.exempt;
  assert.equal(await exempt(), true);

  // v2 changes only the OTHER requirement — still a new version: the preview warns, and after
  // applying, the exception stops applying and needs review (exact-version binding, PRD §7.6)
  const d2 = await saveDraft(s.orgId, s.cto, std.itemId, { content: { taskTypes: ["code"], requirements: [{ key: k1, text: "Version breaking changes", level: "required" }, { key: k2, text: "Add contract tests", level: "required" }] } });
  await publishVersion(s.orgId, s.cto, d2.versionId);
  const { previewChange } = await import("./rollouts.js");
  const pv = await previewChange(s.orgId, s.cto, { kind: "revise", assignmentId: assignmentId!, versionIds: [d2.versionId] });
  assert.deepEqual(pv.exceptionsNeedingReview.map((e) => e.id), [x.id]);
  await applyChange(s.orgId, s.cto, { kind: "revise", assignmentId: assignmentId!, versionIds: [d2.versionId] }, pv.basis);
  assert.equal(await exempt(), false, "never silently carried to a new version");
  assert.equal((await listExceptions(s.orgId)).find((e) => e.id === x.id)!.state, "needs_review");
  const d3 = { versionId: d2.versionId };

  // expiry: a job flips approved → expired (history kept)
  const y = await requestException(s.orgId, s.eng, { target: "requirement", versionId: d3.versionId, requirementKey: k2!, scope: {}, reason: "short", expiresAt: new Date(Date.now() + 60_000).toISOString() });
  await decideException(s.orgId, s.cto, y.id, true);
  const { expired } = await expireExceptions(new Date(Date.now() + 120_000));
  assert.ok(expired >= 1);
  const row = await withOrg(s.orgId, async (tx) => one(await tx.select().from(exceptions).where(eq(exceptions.id, y.id))));
  assert.equal(row.state, "expired");
  assert.equal(row.decidedBy, s.cto, "decision history preserved");
});

async function sessionFor(s: S, memberId: string) {
  const [p, repo] = await withSystem(async (tx) => {
    const m = one(await tx.select().from(members).where(eq(members.id, memberId)));
    return [one(await tx.select().from(principals).where(eq(principals.id, m.principalId!))), one(await tx.select().from(repos).where(eq(repos.id, s.repoId)))] as const;
  });
  return (await registerSession(p as never, { gitRemote: repo.gitRemote, vendor: "claude" }))!;
}

test("code diffs are evaluated by published code checks only, with their own instructions (review #8)", async () => {
  const s = await setup();
  const std = await createItem(s.orgId, s.cto, { kind: "standard", name: `No raw SQL ${uid()}`, content: { taskTypes: ["code"], requirements: [{ text: "Never build SQL by string concatenation", level: "required" }] } });
  await publishVersion(s.orgId, s.cto, std.versionId);
  const scope = { repos: [s.repoId], taskTypes: ["code"], pathGlobs: ["src/**"] };
  const c = await sessionFor(s, s.eng);
  const hunks = [{ file: "src/db.ts", text: '@@ -1,1 +1,2 @@\n x\n+const q = "SELECT * FROM t WHERE id=" + id;' }];
  const seen: string[] = [];
  const yes = async (_: unknown, qs: Record<string, { instructions: string }>) => {
    seen.push(...Object.values(qs).map((q) => q.instructions));
    return Object.fromEntries(Object.keys(qs).map((k) => [k, { type: "noul" as const, noul: 0.95 }]));
  };
  const { assignmentId: guidanceOnly } = await applyChange(s.orgId, s.cto, { kind: "create", versionIds: [std.versionId], selectors: scope, level: "required" });
  assert.equal((await runCheck(c, { hunks, surfaces: [] }, yes)).standards, null, "a standard without a check is guidance, not an evaluation");
  await applyChange(s.orgId, s.cto, { kind: "retire", assignmentId: guidanceOnly! });

  // a code-diff rubric check pinned by the standard
  const ck = await createItem(s.orgId, s.cto, { kind: "check", name: `SQL review ${uid()}`, content: { artifactType: "code_diff", method: "rubric", instructions: "Treat ORM query builders as safe." } });
  await publishVersion(s.orgId, s.cto, ck.versionId);
  const d2 = await saveDraft(s.orgId, s.cto, std.itemId, { content: { taskTypes: ["code"], requirements: [{ text: "Never build SQL by string concatenation", level: "required" }], checks: [{ itemId: ck.itemId, versionId: ck.versionId }] } });
  await publishVersion(s.orgId, s.cto, d2.versionId);
  await applyChange(s.orgId, s.cto, { kind: "create", versionIds: [d2.versionId], selectors: scope, level: "required" });
  const r = await runCheck(c, { hunks, surfaces: [] }, yes);
  assert.equal(r.standards?.length, 1);
  assert.equal(r.standards![0]!.checkVersionId, ck.versionId, "the result names the exact check version");
  assert.equal(r.standards![0]!.execution, "completed");
  assert.equal(r.standards![0]!.findings[0]!.verdict, "possible_violation");
  assert.equal(r.standards![0]!.findings[0]!.evidence[0]!.location, "src/db.ts:2");
  assert.ok(seen.some((q) => q.includes("Treat ORM query builders as safe.")), "the check's instructions reach the evaluator");

  const other = [{ file: "docs/readme.md", text: "@@ -1,1 +1,2 @@\n x\n+hello" }];
  assert.equal((await runCheck(c, { hunks: other, surfaces: [] }, yes)).standards, null, "path-scoped standard doesn't apply to docs/");

  const down = async () => null;
  const hunks2 = [{ file: "src/b.ts", text: "@@ -1,1 +1,2 @@\n x\n+const a = 1;" }];
  const u = await runCheck(c, { hunks: hunks2, surfaces: [] }, down);
  assert.equal(u.standards![0]!.execution, "unavailable");
  const retry = await runCheck(c, { hunks: hunks2, surfaces: [] }, yes);
  assert.equal(retry.standards![0]!.execution, "completed", "an unavailable run is retried, not cached (review #10)");

  // unsupported combination can't be published
  const bad = await createItem(s.orgId, s.cto, { kind: "check", name: `bad ${uid()}`, content: { artifactType: "code_diff", method: "structural", requiredSections: ["x"] } });
  await assert.rejects(publishVersion(s.orgId, s.cto, bad.versionId), /rubric method only/);
});

test("session briefing lists versioned requirements and skill pointers; repo-free brief export ≠ install (A15)", async () => {
  const s = await setup();
  const pkg = await storePackage(s.orgId, [{ path: "SKILL.md", bytes: enc("---\nname: prd-writer\n---\nWrite.") }], null);
  const sk = await createItem(s.orgId, s.cto, { kind: "skill", name: `PRD writer ${uid()}`, content: { whenToUse: "drafting a PRD" } });
  const skd = await saveDraft(s.orgId, s.cto, sk.itemId, { content: { whenToUse: "drafting a PRD" }, packageId: pkg.id });
  await publishVersion(s.orgId, s.cto, skd.versionId);
  const std = await createItem(s.orgId, s.cto, {
    kind: "standard",
    name: `Engineering ${uid()}`,
    content: { taskTypes: ["code", "prd"], requirements: [{ text: "Document compatibility", level: "required" }], skills: [{ itemId: sk.itemId, versionId: skd.versionId }] },
  });
  await publishVersion(s.orgId, s.cto, std.versionId);
  // the release pulls in the pinned skill version automatically
  const rel = await createRelease(s.orgId, s.cto, "eng", [std.versionId]);
  const { listAssignments } = await import("./rollouts.js");
  await applyChange(s.orgId, s.cto, { kind: "create", releaseId: rel.id, selectors: {}, level: "required" });
  const relRow = (await listAssignments(s.orgId)).releases.find((r) => r.id === rel.id)!;
  assert.equal(relRow.items.length, 2, "standard + pinned skill");

  const c = await sessionFor(s, s.eng);
  const cont = await continuity(c);
  assert.equal(cont.standards!.requirements[0]!.text, "Document compatibility");
  assert.equal(cont.standards!.requirements[0]!.version, 1);
  assert.deepEqual(cont.standards!.skills.map((k) => [k.whenToUse, k.version]), [["drafting a PRD", 1]]);

  const brief = await buildBrief({ orgId: s.orgId, projectId: s.projectId, memberId: s.eng });
  assert.match(brief.markdown, /## Organization standards for this work/);
  assert.match(brief.markdown, /\*\*Must\*\*: Document compatibility/);
  assert.match(brief.markdown, /recorded as an export/);
  const rc = await withOrg(s.orgId, (tx) => tx.select().from(receipts));
  assert.equal(rc.length, 0, "a brief never produces installation evidence");
  void usageEvents;
});
