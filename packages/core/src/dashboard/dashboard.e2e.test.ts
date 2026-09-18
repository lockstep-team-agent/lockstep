/** Overview enrichment + decision detail read, against real Postgres (DATABASE_URL). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withSystem } from "../db/rls.js";
import { orgs, principals, members, projects, repos, projectMembers } from "../db/schema.js";
import { projectOverview, decisionDetail } from "./dashboard-service.js";
import {
  proposeDecision,
  ackDecision,
  askQuestion,
  answerQuestion,
  createTask,
  recordChange,
  registerDependency,
  syncProducedSurfaces,
} from "../ledger/ledger-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 970_000_000;
const uid = (): number => ++seq;

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `Dash-${n}` }).returning());
    const mk = async (login: string) => {
      const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: login }).returning());
      return one(
        await tx
          .insert(members)
          .values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: login })
          .returning(),
      );
    };
    const alice = await mk(`alice-${n}`);
    const bob = await mk(`bob-${n}`);
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "dash", createdBy: alice.id }).returning());
    for (const m of [alice, bob]) {
      await tx.insert(projectMembers).values({
        orgId: org.id,
        projectId: proj.id,
        memberId: m.id,
        invitedGithubLogin: m.githubLogin,
        role: "member",
        status: "active",
      });
    }
    const api = one(
      await tx.insert(repos).values({ orgId: org.id, projectId: proj.id, gitRemote: `https://github.com/t/api-${n}` }).returning(),
    );
    const app = one(
      await tx.insert(repos).values({ orgId: org.id, projectId: proj.id, gitRemote: `https://github.com/t/app-${n}` }).returning(),
    );
    return { orgId: org.id, projectId: proj.id, alice, bob, api, app };
  });
}

test("projectOverview: actors, impact, answers, assignees, consumer counts, and changes are resolved", async () => {
  const s = await setup();
  const ctxA = { projectId: s.projectId, repoId: s.api.id, memberId: s.alice.id };
  await syncProducedSurfaces(s.orgId, { ...ctxA, surfaces: ["http:POST /x"] });
  await registerDependency(s.orgId, {
    projectId: s.projectId,
    memberId: s.bob.id,
    consumerRepoId: s.app.id,
    producedSurface: "http:POST /x",
    producedRepoId: null,
    source: "test",
  });
  const d = await proposeDecision(s.orgId, {
    ...ctxA,
    scopeKind: "surface",
    scopeRef: "http:POST /x",
    ruleText: "X is idempotent.",
    baseVersion: 0,
  });
  const q = await askQuestion(s.orgId, {
    projectId: s.projectId,
    memberId: s.alice.id,
    body: "Who calls X?",
    scopeRef: "http:POST /x",
  });
  await answerQuestion(s.orgId, q.questionId, s.bob.id, "The app does.");
  await createTask(s.orgId, { projectId: s.projectId, memberId: s.alice.id, title: "Migrate", to: s.bob.githubLogin });
  await recordChange(s.orgId, { ...ctxA, summary: "Renamed X", surface: "http:POST /x", riskTier: "shared" });

  const o = await projectOverview(s.orgId, s.projectId, s.alice.id);
  const dec = o.decisions.find((x) => x.id === d.decisionId)!;
  assert.equal(dec.proposedBy, s.alice.githubLogin);
  assert.ok(dec.impact >= 1, "one consumer ⇒ impact ≥ 1");
  assert.ok(dec.createdAt instanceof Date);
  const qq = o.questions.find((x) => x.id === q.questionId)!;
  assert.equal(qq.askedBy, s.alice.githubLogin);
  assert.equal(qq.answer?.body, "The app does.");
  assert.equal(qq.answer?.by, s.bob.githubLogin);
  const t = o.tasks[0]!;
  assert.equal(t.delegatedTo, s.bob.githubLogin);
  assert.equal(t.delegatedBy, s.alice.githubLogin);
  const c = o.contracts.find((x) => x.surface === "http:POST /x")!;
  assert.equal(c.consumerCount, 1);
  assert.equal(o.changes.length, 1);
  assert.equal(o.changes[0]!.createdBy, s.alice.githubLogin);
  assert.equal(o.changes[0]!.surface, "http:POST /x");
  const proposed = o.audit.find((a) => a.action === "decision.proposed")!;
  assert.equal(proposed.actor, s.alice.githubLogin);
  assert.equal(proposed.entityId, d.decisionId);
  assert.equal(proposed.summary, "X is idempotent.");
});

test("decisionDetail: versions, approvals, consumers, lineage", async () => {
  const s = await setup();
  const ctxA = { projectId: s.projectId, repoId: s.api.id, memberId: s.alice.id };
  await registerDependency(s.orgId, {
    projectId: s.projectId,
    memberId: s.bob.id,
    consumerRepoId: s.app.id,
    producedSurface: "http:POST /y",
    producedRepoId: null,
    source: "test",
  });
  const d = await proposeDecision(s.orgId, {
    ...ctxA,
    scopeKind: "surface",
    scopeRef: "http:POST /y",
    ruleText: "Y v1.",
    baseVersion: 0,
    rationale: "because",
  });
  await ackDecision(s.orgId, d.decisionId, d.version, s.bob.id, "ack");
  const detail = await decisionDetail(s.orgId, s.projectId, d.decisionId);
  assert.ok(detail);
  assert.equal(detail!.ruleText, "Y v1.");
  assert.equal(detail!.rationale, "because");
  assert.equal(detail!.versions.length, 1);
  assert.equal(detail!.versions[0]!.proposedBy, s.alice.githubLogin);
  assert.equal(detail!.approvals.length, 1);
  assert.equal(detail!.approvals[0]!.reviewer, s.bob.githubLogin);
  assert.equal(detail!.consumers.length, 1);
  assert.equal(detail!.consumers[0]!.repoId, s.app.id);
  assert.equal(await decisionDetail(s.orgId, s.projectId, "00000000-0000-0000-0000-000000000000"), null);
});
