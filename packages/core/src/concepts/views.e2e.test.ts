/** Smoke the new read models against Postgres: inbox ranking/pagination, ledger tabs, search, graph. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withSystem } from "../db/rls.js";
import { members, orgs, principals, projectMembers, projects, repos } from "../db/schema.js";
import { askQuestion, proposeDecision, syncProducedSurfaces } from "../ledger/ledger-service.js";
import { getGraph, getInbox, getLedger, searchProject } from "./views.js";

let seq = Date.now() + 995_000_000;
const uid = () => ++seq;
const one = <T>(r: T[]): T => r[0]!;

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(
      await tx
        .insert(orgs)
        .values({ name: `Views-${n}` })
        .returning(),
    );
    const p = one(
      await tx
        .insert(principals)
        .values({ githubUserId: uid(), githubLogin: `v-${n}` })
        .returning(),
    );
    const m = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: p.githubLogin })
        .returning(),
    );
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "v", createdBy: m.id }).returning());
    await tx.insert(projectMembers).values({
      orgId: org.id,
      projectId: proj.id,
      memberId: m.id,
      invitedGithubLogin: m.githubLogin,
      role: "owner",
      status: "active",
    });
    const r = one(
      await tx
        .insert(repos)
        .values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/v/api-${n}` })
        .returning(),
    );
    return { orgId: org.id, projectId: proj.id, memberId: m.id, repoId: r.id };
  });
}

test("inbox: urgent question outranks proposals; pagination is stable; ledger/search/graph respond", async () => {
  const s = await setup();
  await syncProducedSurfaces(s.orgId, {
    projectId: s.projectId,
    repoId: s.repoId,
    memberId: s.memberId,
    surfaces: ["http:GET /orders", "http:GET /users"],
  });
  await askQuestion(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    body: "Is the orders API stable?",
    urgent: true,
  });
  for (let i = 0; i < 55; i++) {
    await proposeDecision(s.orgId, {
      projectId: s.projectId,
      memberId: s.memberId,
      scopeKind: "topic",
      scopeRef: `t${i}`,
      ruleText: `rule ${i}`,
      baseVersion: 0,
    });
  }
  // proposals bind immediately at impact 0 → not in the inbox; the question must be
  const first = await getInbox(s.orgId, s.projectId, s.memberId);
  assert.equal(first.items[0]?.kind, "question");
  assert.equal(first.items[0]?.severity, 3);

  const led = await getLedger(s.orgId, s.projectId, "decisions");
  assert.equal(led.rows.length, 50);
  assert.ok(led.nextCursor);
  const led2 = await getLedger(s.orgId, s.projectId, "decisions", { cursor: led.nextCursor! });
  assert.equal(led2.rows.length, 5);
  assert.equal(new Set([...led.rows, ...led2.rows].map((r) => r.id)).size, 55, "no overlap across pages");

  const contracts = await getLedger(s.orgId, s.projectId, "contracts", { q: "orders" });
  assert.equal(contracts.rows.length, 1);
  const found = await searchProject(s.orgId, s.projectId, "users");
  assert.equal(found.concepts[0]?.key, "http:users");
  const g = await getGraph(s.orgId, s.projectId);
  assert.ok(g.nodes.length >= 1);
});
