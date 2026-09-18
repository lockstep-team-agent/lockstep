import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { buildApp } from "../api/app.js";
import { withOrg, withSystem } from "../db/rls.js";
import { principals, sessions, decisionChecks, usageEvents, projectMembers, nativeDocumentVersions } from "../db/schema.js";
import { issueTokenTx } from "../auth/tokens.js";
import { listDecisions } from "../ledger/ledger-service.js";
import { addedLines, boundHunks, interpretJudgments } from "./checks.js";
import { validateExtraction, type Extractor, type Judge } from "./providers.js";

const extractor: Extractor = async (sections) => ({ degraded: false, rules: sections.map((s) => ({ anchorKey: s.anchorKey, ruleText: s.text, evidence: s.text, rationale: "Explicit source rule", confidence: .95, decisionType: "rule", constraintKind: "behavioral" })) });
let seq = Date.now() + 900_000_000;
async function identity() {
  return withSystem(async (tx) => {
    const p = (await tx.insert(principals).values({ githubUserId: ++seq, githubLogin: `pilot-${seq}` }).returning())[0]!;
    return { p, token: await issueTokenTx(tx, p.id) };
  });
}
test("boundaries reject invented evidence and findings use added lines", () => {
  assert.deepEqual(addedLines("@@ -2,3 +2,4 @@\n same\n-old\n+new\n+new2\n end"), [3, 4]);
  const b = boundHunks([{ file: "../secret", text: "x" }, ...Array.from({ length: 25 }, () => ({ file: "src/a.ts", text: "a".repeat(4001) }))]);
  assert.equal(b.hunks.length, 20); assert.equal(b.partial, true); assert.equal(Buffer.byteLength(b.hunks[0]!.text), 3000);
  assert.deepEqual(validateExtraction({ rules: [{ anchorKey: "a", ruleText: "fake", evidence: "not in source", confidence: .9 }] }, [{ anchorKey: "a", headingPath: [], text: "original" }]), []);
  assert.equal(interpretJudgments([{ id: "rule", version: 1, ruleText: "rule" }], [{ file: "a", text: "@@ -1 +1 @@\n+x" }], { "0:0": { type: "noul", noul: Number.NaN } }).checked, 0);
});

test("pilot: independent PM → ratify/export → same-project developer → continuity/checks/revision/access", async (t) => {
  let available = true; let calls = 0;
  const judge: Judge = async (_state, questions) => { calls++; return available ? Object.fromEntries(Object.keys(questions).map((id) => [id, { type: "noul", noul: .95 }])) : null; };
  const app = buildApp({ extractor, judge }); t.after(() => app.close());
  const pm = await identity(); const stranger = await identity();
  const headers = { authorization: `Bearer ${pm.token}` };
  const request = async (method: "GET" | "POST", url: string, payload?: unknown, extra = {}) => {
    const r = await app.inject({ method, url, payload: payload as object, headers: { ...headers, ...extra } });
    assert.equal(r.statusCode, 200, `${method} ${url}: ${r.body}`); return r.json();
  };
  const project = await request("POST", "/pilot/projects", { name: "Independent PM pilot" });
  const { orgId, projectId } = project; const base = `/orgs/${orgId}/projects/${projectId}`;
  const content = "All exports must expire after 24 hours. Internal previews are exempt.";
  const brief = await request("POST", `${base}/native-documents`, { title: "Private exports", content });
  assert.equal(brief.status, "completed");
  const docs = await request("GET", `${base}/documents`); assert.equal(docs.documents.length, 1);
  const decisions = await listDecisions(orgId, projectId); assert.equal(decisions.length, 1); assert.equal(decisions[0]!.status, "proposed");
  const rule = decisions[0]!;
  const premature = await app.inject({ method: "POST", url: `${base}/review/${rule.id}`, headers, payload: { action: "ratify" } });
  assert.notEqual(premature.statusCode, 200, "must activate source before ratification");
  await request("POST", `${base}/documents/${brief.documentId}/state`, { state: "active" });
  await request("POST", `${base}/review/${rule.id}`, { action: "ratify" });
  const exported = await request("GET", `${base}/brief?documentId=${brief.documentId}`);
  assert.equal(exported.accepted, 1); assert.match(exported.markdown, /Internal previews are exempt/);
  await request("POST", `${base}/brief/exported`, { hash: exported.hash, filters: { documentId: brief.documentId } });
  await request("POST", `${base}/brief/exported`, { hash: exported.hash, filters: { documentId: brief.documentId } });
  assert.equal((await withOrg(orgId, (tx) => tx.select().from(sessions))).length, 0, "PM value before a repo or session");

  const remote = `github.com/pilot/repo-${seq}`;
  await request("POST", "/connect", { gitRemote: remote, projectId });
  const setup = await request("POST", "/sessions/register", { gitRemote: remote, vendor: "onboard" });
  await request("POST", "/continuity/receipt", { decisionIds: [rule.id] }, { "x-lockstep-session": setup.sessionId });
  assert.equal((await request("GET", `${base}/adoption`)).events.filter((e: { event: string }) => e.event === "agent_briefing_delivered").length, 0);
  const a = await request("POST", "/sessions/register", { gitRemote: remote, vendor: "claude", nativeSessionId: "claude-a" });
  const b = await request("POST", "/sessions/register", { gitRemote: remote, vendor: "claude", nativeSessionId: "claude-b" });
  const aAgain = await request("POST", "/sessions/register", { gitRemote: remote, vendor: "claude", nativeSessionId: "claude-a" }); assert.equal(aAgain.sessionId, a.sessionId);
  const ah = { "x-lockstep-session": a.sessionId }; const bh = { "x-lockstep-session": b.sessionId };
  assert.equal((await request("GET", "/continuity", undefined, ah)).decisions.length, 0, "feature constraints require relevant scope");
  const replay = await request("GET", `/continuity?featureRef=${brief.featureRef}`, undefined, ah); assert.equal(replay.decisions[0].id, rule.id);
  await request("POST", "/continuity/receipt", { decisionIds: [rule.id] }, ah);
  await request("POST", "/continuity/receipt", { decisionIds: [rule.id] }, ah);
  assert.equal((await request("GET", `/continuity?featureRef=${brief.featureRef}`, undefined, bh)).since, null, "parallel session retains starting baseline");

  const code = { hunks: [{ file: "src/export.ts", text: "@@ -1 +1 @@\n+const expiry = Infinity; // sensitive-code-marker" }], surfaces: [], featureRef: brief.featureRef };
  const check = await request("POST", "/checks", code, ah); assert.equal(check.status, "completed"); assert.equal(check.findings[0].line, 1);
  const repeated = await request("POST", "/checks", code, ah); assert.equal(repeated.id, check.id); assert.equal(calls, 1);
  const stored = await withOrg(orgId, (tx) => tx.select().from(decisionChecks)); assert.ok(!JSON.stringify(stored).includes("sensitive-code-marker"));
  await request("POST", `${base}/checks/${check.id}/feedback`, { decisionId: rule.id, verdict: "false_positive" });
  assert.equal((await request("GET", `/continuity?featureRef=${brief.featureRef}`, undefined, bh)).concerns.length, 0);
  available = false;
  const failed = await request("POST", "/checks", { ...code, base: "another-revision" }, ah); assert.equal(failed.status, "unavailable");
  available = true;
  const recovered = await request("POST", "/checks", { ...code, base: "another-revision" }, ah); assert.equal(recovered.status, "completed");

  const revised = await request("POST", `${base}/native-documents`, { documentId: brief.documentId, baseVersion: 1, title: "Private exports", content: "All exports must expire after 12 hours. Internal previews are exempt.", featureRef: brief.featureRef });
  assert.equal(revised.version, 2);
  assert.equal((await request("GET", `${base}/brief?documentId=${brief.documentId}`)).accepted, 0);
  assert.equal((await request("GET", `/continuity?featureRef=${brief.featureRef}`, undefined, ah)).decisions.length, 0);
  assert.equal((await request("GET", `${base}/native-documents/${brief.documentId}`)).versions.length, 2);
  const conflict = await app.inject({ method: "POST", url: `${base}/native-documents`, headers, payload: { documentId: brief.documentId, baseVersion: 1, title: "Private exports", content: "Concurrent edit", featureRef: brief.featureRef } }); assert.equal(conflict.statusCode, 409);

  const repoDoc = { commit: "abc", files: [{ path: "CLAUDE.md", sections: [{ anchorKey: "one", headingPath: ["Rule one"], text: "Always validate request payloads before writing to storage." }, { anchorKey: "two", headingPath: ["Rule two"], text: "Use UTC timestamps in all persistent audit records." }] }] };
  const imported = await request("POST", "/repo/distill", repoDoc, ah); assert.equal(imported.proposals.length, 2);
  for (const p of imported.proposals) await request("POST", `${base}/review/${p.decisionId}`, { action: "confirm" });
  const reimport = await request("POST", "/repo/distill", repoDoc, ah);
  assert.deepEqual(reimport.proposals.map((p: { decisionId: string }) => p.decisionId), imported.proposals.map((p: { decisionId: string }) => p.decisionId));
  assert.equal((await listDecisions(orgId, projectId)).filter((d) => d.scopeKind === "repo" && d.status === "binding").length, 2, "independent rules coexist");
  const manual = await request("POST", "/repo/decisions", { ruleText: "Encrypt export objects at rest." }, ah); await request("POST", `${base}/review/${manual.decisionId}`, { action: "confirm" });
  assert.equal((await listDecisions(orgId, projectId)).filter((d) => d.status === "binding").length, 3);

  for (const url of [`${base}/checks`, `${base}/brief`, `${base}/native-documents/${brief.documentId}`, `${base}/adoption`]) {
    const r = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${stranger.token}` } }); assert.equal(r.statusCode, 403, url);
  }
  const isolated = await request("POST", "/pilot/projects", { name: "Another tenant" });
  assert.equal((await withOrg(isolated.orgId, (tx) => tx.select().from(nativeDocumentVersions))).length, 0);
  // REGRESSION (QA P1): the briefing and the pack scope to the repo's own surfaces. Passing an empty
  // surface list made every surface-scoped binding decision invisible to the agent — the ledger was
  // written but never delivered back.
  const surfaceRule = await request("POST", "/decisions", { scopeKind: "surface", scopeRef: "http:POST /expenses", decisionType: "architecture", ruleText: "Expense approvals are recorded as immutable events.", baseVersion: 0 }, ah);
  assert.equal(surfaceRule.status, "binding", "own-area decision binds on assertion");
  await request("POST", "/surfaces", { surfaces: ["http:POST /expenses"] }, ah);
  const briefed = await request("GET", "/continuity", undefined, ah);
  assert.ok(briefed.decisions.some((d: { ruleText: string }) => /immutable events/.test(d.ruleText)), "session briefing delivers the surface-scoped rule");
  assert.match((await request("GET", "/continuity/pack", undefined, ah)).markdown, /immutable events/, "so does the decision pack");
  // REGRESSION (QA P1): naming a scope must RETURN that scope's decisions, not merely re-rank hits.
  const asked = await request("POST", "/query", { question: "What governs this endpoint?", scope: "http:POST /expenses" }, ah);
  assert.ok(asked.decisions.some((d: { scopeRef: string }) => d.scopeRef === "http:POST /expenses"), "query answers from the named scope");
  // REGRESSION (QA P1): re-inviting an already-invited handle is a no-op, not a 500.
  const first = await request("POST", `${base}/invite`, { githubLogin: "qa-dupe" });
  const again = await request("POST", `${base}/invite`, { githubLogin: "qa-dupe" });
  assert.equal(again.inviteId, first.inviteId, "duplicate invite returns the standing invite");

  const events = await withOrg(orgId, (tx) => tx.select().from(usageEvents));
  assert.equal(events.filter((e) => e.event === "brief_exported").length, 1); assert.equal(events.filter((e) => e.event === "agent_briefing_delivered").length, 1);
  await withOrg(orgId, (tx) => tx.update(projectMembers).set({ status: "revoked" }).where(eq(projectMembers.projectId, projectId)));
  const revoked = await app.inject({ method: "POST", url: "/checks", headers: { ...headers, ...ah }, payload: code }); assert.equal(revoked.statusCode, 403);
});
