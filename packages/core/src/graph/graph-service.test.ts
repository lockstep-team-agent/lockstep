/** Unit tests for the org-graph service (derive / list / manual node+edge). Real Postgres. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withSystem } from "../db/rls.js";
import { orgs, principals, members, projects, projectMembers } from "../db/schema.js";
import { fileProposedDecision } from "../ledger/ledger-service.js";
import { deriveGraph, listGraph, addNode, addEdge } from "./graph-service.js";
import { randomUUID } from "node:crypto";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 900_000_000;
const uid = (): number => ++seq;

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `GraphCo-${n}` }).returning());
    const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `dev-${n}` }).returning());
    const m = one(
      await tx.insert(members).values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `dev-${n}` }).returning(),
    );
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "g", createdBy: m.id }).returning());
    // derive now scopes persons to active project_members (not org members).
    await tx
      .insert(projectMembers)
      .values({ orgId: org.id, projectId: proj.id, memberId: m.id, invitedGithubLogin: `dev-${n}`, role: "owner", status: "active" });
    return { orgId: org.id, projectId: proj.id, login: `dev-${n}` };
  });
}

test("deriveGraph builds project + person + topic nodes and edges, idempotently", async () => {
  const s = await setup();
  await fileProposedDecision(s.orgId, {
    projectId: s.projectId,
    scopeKind: "topic",
    scopeRef: "topic:oncall",
    ruleText: "On-call rotates weekly on Mondays.",
    provenance: { source: "slack", evidence: [{ externalId: "t1", quote: "rotate weekly" }], decidedBy: ["@x", "@y"] },
    connectionId: randomUUID(),
    externalId: "t1",
    contentHash: "h1",
    confidence: 80,
  });

  const first = await deriveGraph(s.orgId, s.projectId);
  const second = await deriveGraph(s.orgId, s.projectId);
  assert.deepEqual(first, second, "derive is idempotent");

  const g = await listGraph(s.orgId, s.projectId);
  assert.ok(g.nodes.some((n) => n.kind === "project"));
  assert.ok(g.nodes.some((n) => n.kind === "topic" && n.ref === "topic:oncall"));
  assert.ok(g.nodes.some((n) => n.kind === "person" && n.ref === `person:${s.login}`), "member became a person node");
  assert.ok(g.nodes.some((n) => n.kind === "person" && n.ref === "person:x"), "participant became a person node");
  // topic connected to its 2 participants
  const topic = g.nodes.find((n) => n.kind === "topic")!;
  const topicEdges = g.edges.filter((e) => e.fromId === topic.id || e.toId === topic.id);
  assert.ok(topicEdges.length >= 3, "governs project + relates to 2 participants");
});

test("addNode and addEdge create manual graph entries", async () => {
  const s = await setup();
  const a = await addNode(s.orgId, { projectId: s.projectId, kind: "team", ref: "team:platform", label: "Platform" });
  const b = await addNode(s.orgId, { projectId: s.projectId, kind: "topic", ref: "topic:auth" });
  await addEdge(s.orgId, { projectId: s.projectId, fromId: a.id, toId: b.id, kind: "owns" });
  const g = await listGraph(s.orgId, s.projectId);
  assert.ok(g.nodes.find((n) => n.id === a.id && n.source === "manual"));
  assert.ok(g.edges.find((e) => e.fromId === a.id && e.toId === b.id && e.kind === "owns"));
});
