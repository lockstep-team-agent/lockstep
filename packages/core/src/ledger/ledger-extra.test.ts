/** Extra coverage for ledger-service: CAS versioning, confirm-with-edits, supersession, and the
 *  v1 question/task/reconcile/query paths. Real Postgres. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withSystem } from "../db/rls.js";
import { orgs, principals, members, projects, repos } from "../db/schema.js";
import {
  proposeDecision,
  fileProposedDecision,
  confirmDecision,
  listDecisions,
  askQuestion,
  answerQuestion,
  createTask,
  completeTask,
  recordChange,
  reconcile,
  queryLedger,
  registerDependency,
} from "./ledger-service.js";
import { randomUUID } from "node:crypto";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 300_000_000;
const uid = (): number => ++seq;

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `LxCo-${n}` }).returning());
    const pa = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `a-${n}` }).returning());
    const pb = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `b-${n}` }).returning());
    const alice = one(await tx.insert(members).values({ orgId: org.id, principalId: pa.id, githubUserId: pa.githubUserId, githubLogin: `a-${n}` }).returning());
    const bob = one(await tx.insert(members).values({ orgId: org.id, principalId: pb.id, githubUserId: pb.githubUserId, githubLogin: `b-${n}` }).returning());
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "lx", createdBy: alice.id }).returning());
    const repo = one(await tx.insert(repos).values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/lx/svc-${n}` }).returning());
    return { orgId: org.id, projectId: proj.id, alice: alice.id, bob: bob.id, bobLogin: `b-${n}`, repo: repo.id };
  });
}

test("proposeDecision: version bumps on correct baseVersion, 409s on stale", async () => {
  const s = await setup();
  const scope = { scopeKind: "topic", scopeRef: `topic:cadence-${uid()}` };
  const v1 = await proposeDecision(s.orgId, { projectId: s.projectId, memberId: s.alice, ...scope, ruleText: "ship weekly", baseVersion: 0 });
  assert.equal(v1.version, 1);
  const v2 = await proposeDecision(s.orgId, { projectId: s.projectId, memberId: s.alice, ...scope, ruleText: "ship daily", baseVersion: 1 });
  assert.equal(v2.version, 2);
  await assert.rejects(
    proposeDecision(s.orgId, { projectId: s.projectId, memberId: s.alice, ...scope, ruleText: "stale", baseVersion: 0 }),
    /stale base_version/,
  );
});

test("confirmDecision with edits appends a new version and updates the rule text", async () => {
  const s = await setup();
  const filed = await fileProposedDecision(s.orgId, {
    projectId: s.projectId,
    scopeKind: "topic",
    scopeRef: `topic:edit-${uid()}`,
    ruleText: "original text",
    provenance: { source: "slack", evidence: [{ externalId: "e", quote: "q" }] },
    connectionId: randomUUID(),
    externalId: `e-${uid()}`,
    contentHash: `h-${uid()}`,
    confidence: 80,
  });
  const res = await confirmDecision(s.orgId, filed.decisionId, s.alice, { ruleText: "edited on confirm" });
  assert.equal(res.status, "binding");
  const got = (await listDecisions(s.orgId, s.projectId)).find((d) => d.id === filed.decisionId)!;
  assert.equal(got.version, 2, "edit appended a new version");
  assert.equal(got.ruleText, "edited on confirm");
});

test("confirmDecision rejects a non-proposed decision", async () => {
  const s = await setup();
  const filed = await fileProposedDecision(s.orgId, {
    projectId: s.projectId, scopeKind: "topic", scopeRef: `topic:once-${uid()}`, ruleText: "x",
    provenance: { source: "slack", evidence: [{ externalId: "e", quote: "q" }] },
    connectionId: randomUUID(), externalId: `e-${uid()}`, contentHash: `h-${uid()}`, confidence: 70,
  });
  await confirmDecision(s.orgId, filed.decisionId, s.alice);
  await assert.rejects(confirmDecision(s.orgId, filed.decisionId, s.alice), /not proposed/);
});

test("fileProposedDecision flags supersession when a binding decision exists on the same scope", async () => {
  const s = await setup();
  const scopeRef = `topic:policy-${uid()}`;
  // establish a binding decision (own-area, impact 0)
  const first = await fileProposedDecision(s.orgId, {
    projectId: s.projectId, scopeKind: "topic", scopeRef, ruleText: "Deploys happen on Fridays.",
    provenance: { source: "slack", evidence: [{ externalId: "a", quote: "fridays" }] },
    connectionId: randomUUID(), externalId: `a-${uid()}`, contentHash: `h-${uid()}`, confidence: 90,
  });
  await confirmDecision(s.orgId, first.decisionId, s.alice); // → binding
  // a contradictory rule on the same scope
  const second = await fileProposedDecision(s.orgId, {
    projectId: s.projectId, scopeKind: "topic", scopeRef, ruleText: "Never deploy on weekdays; releases are Sunday night only.",
    provenance: { source: "jira", evidence: [{ externalId: "b", quote: "sunday only" }] },
    connectionId: randomUUID(), externalId: `b-${uid()}`, contentHash: `h-${uid()}`, confidence: 85,
  });
  assert.equal(second.fused, false, "different rule → not fused");
  assert.equal(second.supersedes, first.decisionId, "flags the binding decision it may supersede");
});

test("questions, tasks, reconcile and query paths", async () => {
  const s = await setup();
  const surface = `http:POST /orders-${uid()}`;

  const q = await askQuestion(s.orgId, { projectId: s.projectId, memberId: s.alice, body: "what is our retry policy?", scopeRef: surface });
  const a = await answerQuestion(s.orgId, q.questionId, s.bob, "exponential backoff, max 5");
  assert.equal(a.status, "answered");

  const t = await createTask(s.orgId, { projectId: s.projectId, memberId: s.alice, title: "write the ADR", to: s.bobLogin });
  const done = await completeTask(s.orgId, t.taskId, s.bob);
  assert.equal(done.status, "done");

  // reconcile: a contract surface with no binding decision is a violation
  const before = await reconcile(s.orgId, s.projectId, [surface]);
  assert.equal(before.ok, false);
  assert.ok(before.violations.includes(surface));

  // make it binding, then reconcile passes
  await proposeDecision(s.orgId, { projectId: s.projectId, memberId: s.alice, scopeKind: "surface", scopeRef: surface, ruleText: "orders are idempotent", baseVersion: 0 });
  const after = await reconcile(s.orgId, s.projectId, [surface]);
  assert.equal(after.ok, true);

  await recordChange(s.orgId, { projectId: s.projectId, repoId: s.repo, memberId: s.alice, summary: "changed orders route", surface });
  const found = await queryLedger(s.orgId, s.projectId, "orders");
  assert.ok(found.decisions.length + found.changes.length > 0, "query finds the decision/change");
});

test("registerDependency then listConsumers via reconcile stale dependents", async () => {
  const s = await setup();
  const surface = `http:GET /catalog-${uid()}`;
  await registerDependency(s.orgId, { projectId: s.projectId, memberId: s.bob, consumerRepoId: s.repo, producedSurface: surface });
  const rec = await reconcile(s.orgId, s.projectId, [surface]);
  assert.ok(rec.staleDependents.some((d) => d.surface === surface));
});
