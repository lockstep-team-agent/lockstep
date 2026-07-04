/**
 * End-to-end proof of the v2 ingestion loop at the service layer:
 *   distilled unit → fileProposedDecision (proposed/ingested, idempotent) → confirmDecision → binding,
 *   and it shows up in the ledger the agent briefing reads. Cross-cutting proposals stay open until ack.
 *
 * Runs against a real Postgres (DATABASE_URL), like loop.e2e.test.ts. No network, no Composio, no LLM —
 * this is the StubConnector → core path (the funnel's LLM stages are exercised in the real-Slack test).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { withSystem } from "../db/rls.js";
import { orgs, principals, members, projects, repos } from "../db/schema.js";
import {
  fileProposedDecision,
  confirmDecision,
  rejectDecision,
  listDecisions,
  listProvenancesForProject,
  registerDependency,
} from "../ledger/ledger-service.js";
import { deriveGraph } from "../graph/graph-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}

// Offset well past the other e2e file's Date.now()-based seq so github_user_ids never collide in the
// shared test-runner process.
let seq = Date.now() + 500_000_000;
const uid = (): number => ++seq;

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `IngestCo-${n}` }).returning());
    const pAlice = one(
      await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `alice-${n}` }).returning(),
    );
    const alice = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: pAlice.id, githubUserId: pAlice.githubUserId, githubLogin: `alice-${n}` })
        .returning(),
    );
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "ingest", createdBy: alice.id }).returning());
    const consumerRepo = one(
      await tx
        .insert(repos)
        .values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/ingestco/web-${n}` })
        .returning(),
    );
    return { orgId: org.id, projectId: proj.id, alice: alice.id, consumerRepo: consumerRepo.id };
  });
}

test("INGEST: a distilled unit files a proposed/ingested decision, idempotently", async () => {
  const s = await setup();
  const connectionId = randomUUID();
  const args = {
    projectId: s.projectId,
    scopeKind: "topic",
    scopeRef: "topic:authentication",
    ruleText: "Auth tokens are JWT with 15-minute expiry.",
    decisionType: "rule",
    provenance: {
      source: "slack",
      connectionId,
      externalId: "C_STUB/1699000001.0001",
      evidence: [{ externalId: "C_STUB/1699000001.0001", quote: "let's lock it: JWT with 15-minute expiry" }],
      confidence: 0.9,
    },
    connectionId,
    externalId: "C_STUB/1699000001.0001",
    contentHash: "hash-abc",
    confidence: 90,
  };

  const first = await fileProposedDecision(s.orgId, args);
  assert.equal(first.deduped, false);
  assert.ok(first.decisionId);

  // Re-seeing the same unit must not mint a duplicate (idempotency backstop).
  const again = await fileProposedDecision(s.orgId, args);
  assert.equal(again.deduped, true);
  assert.equal(again.decisionId, first.decisionId);

  const proposed = await listDecisions(s.orgId, s.projectId, undefined, { status: "proposed" });
  const got = proposed.find((d) => d.id === first.decisionId);
  assert.ok(got, "proposed decision is in the review queue");
  assert.equal(got!.origin, "ingested");
  assert.equal(got!.status, "proposed");
  assert.ok(got!.ruleText.includes("JWT"));
});

test("INGEST: confirming an own-area proposal binds it and it enters the ledger the briefing reads", async () => {
  const s = await setup();
  const connectionId = randomUUID();
  const filed = await fileProposedDecision(s.orgId, {
    projectId: s.projectId,
    scopeKind: "topic",
    scopeRef: "topic:billing",
    ruleText: "Invoices are generated in UTC and stored as immutable snapshots.",
    provenance: { source: "slack", evidence: [{ externalId: "x", quote: "we bill in UTC, snapshots are immutable" }] },
    connectionId,
    externalId: "C_STUB/2",
    contentHash: "hash-billing",
    confidence: 88,
  });

  const confirmed = await confirmDecision(s.orgId, filed.decisionId, s.alice);
  assert.equal(confirmed.impact, 0, "topic scope, no consumers → impact 0");
  assert.equal(confirmed.status, "binding", "own-area confirmed decision binds");

  // It's now an ordinary binding decision — exactly what the agent session-start briefing lists.
  const all = await listDecisions(s.orgId, s.projectId);
  const got = all.find((d) => d.id === filed.decisionId);
  assert.ok(got);
  assert.equal(got!.status, "binding");
  assert.equal(got!.origin, "ingested");
});

test("INGEST: confirming a cross-cutting proposal stays open until an affected team acks", async () => {
  const s = await setup();
  const surface = "http:POST /orders";
  await registerDependency(s.orgId, {
    projectId: s.projectId,
    memberId: s.alice,
    consumerRepoId: s.consumerRepo,
    producedSurface: surface,
  });
  const filed = await fileProposedDecision(s.orgId, {
    projectId: s.projectId,
    scopeKind: "surface",
    scopeRef: surface,
    ruleText: "Orders require an idempotency key.",
    provenance: { source: "slack", evidence: [{ externalId: "y", quote: "orders must carry an idempotency key" }] },
    connectionId: randomUUID(),
    externalId: "C_STUB/3",
    contentHash: "hash-orders",
    confidence: 80,
  });
  const confirmed = await confirmDecision(s.orgId, filed.decisionId, s.alice);
  assert.equal(confirmed.impact, 1, "one declared consumer → cross-cutting");
  assert.equal(confirmed.status, "open", "cross-cutting confirmed decision awaits ack, does not bind yet");
});

test("FUSION: a similar decision from another tool attaches as provenance, not a duplicate", async () => {
  const s = await setup();
  const scopeRef = "topic:authentication";
  const rule = "Auth tokens are JWT with 15-minute expiry.";

  const slack = await fileProposedDecision(s.orgId, {
    projectId: s.projectId,
    scopeKind: "topic",
    scopeRef,
    ruleText: rule,
    provenance: { source: "slack", evidence: [{ externalId: "sl1", quote: "lock it: JWT, 15 min" }] },
    connectionId: randomUUID(),
    externalId: "slack/1",
    contentHash: "h-slack",
    confidence: 90,
  });
  assert.equal(slack.fused, false);

  // Same rule, different tool → should fuse into the slack decision.
  const jira = await fileProposedDecision(s.orgId, {
    projectId: s.projectId,
    scopeKind: "topic",
    scopeRef,
    ruleText: "Auth tokens must be JWT with 15-minute expiry.",
    provenance: { source: "jira", evidence: [{ externalId: "AUTH-12", quote: "JWT 15 min expiry" }] },
    connectionId: randomUUID(),
    externalId: "jira/AUTH-12",
    contentHash: "h-jira",
    confidence: 85,
  });
  assert.equal(jira.fused, true, "second source fuses");
  assert.equal(jira.decisionId, slack.decisionId, "into the same decision");

  const provs = await listProvenancesForProject(s.orgId, s.projectId);
  const sources = (provs[slack.decisionId] ?? []).map((p) => p.source).sort();
  assert.deepEqual(sources, ["jira", "slack"], "one decision, two provenances");

  // Only one proposed decision exists for this scope.
  const proposed = await listDecisions(s.orgId, s.projectId, scopeRef, { status: "proposed" });
  assert.equal(proposed.length, 1);
});

test("GRAPH: a topic decision gets non-code impact from the org graph (participants)", async () => {
  const s = await setup();
  const filed = await fileProposedDecision(s.orgId, {
    projectId: s.projectId,
    scopeKind: "topic",
    scopeRef: "topic:release-process",
    ruleText: "Releases ship on Tuesdays behind a feature flag.",
    provenance: {
      source: "slack",
      evidence: [{ externalId: "r1", quote: "we ship Tuesdays behind a flag" }],
      decidedBy: ["@alice", "@bob", "@carol"],
    },
    connectionId: randomUUID(),
    externalId: "slack/rel",
    contentHash: "h-rel",
    confidence: 88,
  });

  // Build the graph from members + this decision's participants.
  const g = await deriveGraph(s.orgId, s.projectId);
  assert.ok(g.nodes > 0 && g.edges > 0);

  // Confirming now reads the graph: 3 participants → impact 3 → cross-cutting (stays open until ack).
  const confirmed = await confirmDecision(s.orgId, filed.decisionId, s.alice);
  assert.equal(confirmed.impact, 3, "topic impact = distinct participants in the graph");
  assert.equal(confirmed.status, "open");
});

test("INGEST: a rejected proposal never appears as a binding decision", async () => {
  const s = await setup();
  const filed = await fileProposedDecision(s.orgId, {
    projectId: s.projectId,
    scopeKind: "topic",
    scopeRef: "topic:noise",
    ruleText: "Not actually a decision.",
    provenance: { source: "slack", evidence: [{ externalId: "z", quote: "maybe we should..." }] },
    connectionId: randomUUID(),
    externalId: "C_STUB/4",
    contentHash: "hash-noise",
    confidence: 55,
  });
  const rejected = await rejectDecision(s.orgId, filed.decisionId, s.alice);
  assert.equal(rejected.status, "rejected");
  const proposed = await listDecisions(s.orgId, s.projectId, undefined, { status: "proposed" });
  assert.equal(proposed.find((d) => d.id === filed.decisionId), undefined, "no longer in the review queue");
});
