/**
 * End-to-end proof of the magic loop — the thing that was silently broken before:
 *   producer changes a canonical surface → consumer that declared a dependency on it gets an
 *   impact-ranked inbox item. Plus the impact-driven binding model and the "who uses X" query.
 *
 * Runs against a real Postgres (DATABASE_URL). Exercises the service layer directly so it doesn't
 * depend on session/auth plumbing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withSystem } from "../db/rls.js";
import { orgs, principals, members, projects, repos } from "../db/schema.js";
import { proposeDecision, ackDecision, registerDependency, recordChange, listConsumers } from "./ledger-service.js";
import { readInbox } from "../inbox/inbox-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}

const SURFACE = "http:POST /auth/session";

// Unique per call so re-runs (and the 4 tests) don't collide on the unique github_user_id / remote.
let seq = Date.now();
const uid = (): number => ++seq;

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `LoopCo-${n}` }).returning());
    const pAlice = one(
      await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `alice-${n}` }).returning(),
    );
    const pBob = one(
      await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `bob-${n}` }).returning(),
    );
    const alice = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: pAlice.id, githubUserId: pAlice.githubUserId, githubLogin: `alice-${n}` })
        .returning(),
    );
    const bob = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: pBob.id, githubUserId: pBob.githubUserId, githubLogin: `bob-${n}` })
        .returning(),
    );
    const proj = one(
      await tx.insert(projects).values({ orgId: org.id, name: "loop", createdBy: alice.id }).returning(),
    );
    const producerRepo = one(
      await tx
        .insert(repos)
        .values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/loopco/auth-service-${n}` })
        .returning(),
    );
    const consumerRepo = one(
      await tx
        .insert(repos)
        .values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/loopco/web-${n}` })
        .returning(),
    );
    return {
      orgId: org.id,
      projectId: proj.id,
      alice: alice.id,
      bob: bob.id,
      producerRepo: producerRepo.id,
      consumerRepo: consumerRepo.id,
    };
  });
}

test("LOOP: producer surface change reaches the declared consumer's inbox, ranked by impact", async () => {
  const s = await setup();

  // Bob's repo declares (via lockstep.yaml manifest sync) that it consumes the auth surface.
  await registerDependency(s.orgId, {
    projectId: s.projectId,
    memberId: s.bob,
    consumerRepoId: s.consumerRepo,
    producedSurface: SURFACE,
    source: "manifest",
  });

  // Alice (the producer) changes that exact canonical surface.
  const change = await recordChange(s.orgId, {
    projectId: s.projectId,
    repoId: s.producerRepo,
    memberId: s.alice,
    summary: "Stop: changed 1 file(s): src/routes/session.ts",
    surface: SURFACE,
    riskTier: "shared",
  });
  assert.equal(change.impact, 1, "impact = blast radius = 1 consumer");
  assert.equal(change.delivered, 1, "fanned out to exactly the consumer");

  // Bob's inbox shows the change, carrying its impact for ranking.
  const inbox = await readInbox(s.orgId, { memberId: s.bob, repoId: s.consumerRepo, projectId: s.projectId });
  const got = inbox.changes.find((c) => c.surface === SURFACE);
  assert.ok(got, "consumer received the producer's change");
  assert.equal(got!.impact, 1);
});

test("LOOP: registering a dependency is idempotent (manifest re-syncs every session)", async () => {
  const s = await setup();
  const a = await registerDependency(s.orgId, {
    projectId: s.projectId,
    memberId: s.bob,
    consumerRepoId: s.consumerRepo,
    producedSurface: SURFACE,
  });
  const b = await registerDependency(s.orgId, {
    projectId: s.projectId,
    memberId: s.bob,
    consumerRepoId: s.consumerRepo,
    producedSurface: SURFACE,
  });
  assert.equal(a.edgeId, b.edgeId, "same edge returned, not duplicated");
});

test("BINDING: own-area decision (impact 0) binds on assertion; cross-cutting (impact>0) stays open until ack", async () => {
  const s = await setup();

  // No consumers yet → impact 0 → binds immediately.
  const ownArea = await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.alice,
    scopeKind: "surface",
    scopeRef: SURFACE,
    ruleText: "sessions are JWT, 15-min expiry",
    decisionType: "rule",
    baseVersion: 0,
  });
  assert.equal(ownArea.impact, 0);
  assert.equal(ownArea.status, "binding", "own-area decision binds on assertion");

  // Now a consumer exists → a decision on that surface is cross-cutting → open until acked.
  await registerDependency(s.orgId, {
    projectId: s.projectId,
    memberId: s.bob,
    consumerRepoId: s.consumerRepo,
    producedSurface: "http:POST /orders",
  });
  const crossCut = await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.alice,
    scopeKind: "surface",
    scopeRef: "http:POST /orders",
    ruleText: "orders require an idempotency key",
    baseVersion: 0,
  });
  assert.equal(crossCut.impact, 1);
  assert.equal(crossCut.status, "open", "cross-cutting decision awaits acknowledgement");

  const acked = await ackDecision(s.orgId, crossCut.decisionId, crossCut.version, s.bob, "ack");
  assert.equal(acked.status, "binding", "an affected team's ack promotes it to binding");
});

test("WHO-USES-X: listConsumers answers from the graph and excludes the asker", async () => {
  const s = await setup();
  await registerDependency(s.orgId, {
    projectId: s.projectId,
    memberId: s.bob,
    consumerRepoId: s.consumerRepo,
    producedSurface: SURFACE,
  });

  const fromProducer = await listConsumers(s.orgId, s.projectId, SURFACE, s.producerRepo);
  assert.equal(fromProducer.count, 1);
  assert.equal(fromProducer.consumers[0]!.repoId, s.consumerRepo);

  // The asking repo is excluded from its own "who uses this" answer.
  const fromConsumer = await listConsumers(s.orgId, s.projectId, SURFACE, s.consumerRepo);
  assert.equal(fromConsumer.count, 0);
});
