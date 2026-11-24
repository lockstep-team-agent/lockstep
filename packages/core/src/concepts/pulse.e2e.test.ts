/** Pulse — Home's proof strip counts only this project's activity inside the window. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withSystem } from "../db/rls.js";
import { orgs, principals, members, projects, repos, usageEvents, decisions } from "../db/schema.js";
import { getPulse } from "./pulse.js";

test("pulse: counts briefings and binding rules in window, scoped to the project", async () => {
  const n = Date.now();
  const s = await withSystem(async (tx) => {
    const [org] = await tx.insert(orgs).values({ name: `Pulse-${n}` }).returning();
    const [proj] = await tx.insert(projects).values({ orgId: org!.id, name: "p" }).returning();
    const [other] = await tx.insert(projects).values({ orgId: org!.id, name: "other" }).returning();
    const [repo] = await tx.insert(repos).values({ orgId: org!.id, projectId: proj!.id, gitRemote: `github.com/p/${n}` }).returning();
    const [p] = await tx.insert(principals).values({ githubUserId: n % 1e9, githubLogin: `pulse-${n}` }).returning();
    const [m] = await tx
      .insert(members)
      .values({ orgId: org!.id, principalId: p!.id, githubUserId: p!.githubUserId, githubLogin: p!.githubLogin })
      .returning();
    const ev = (projectId: string, key: string, daysAgo: number) => ({
      orgId: org!.id,
      projectId,
      memberId: m!.id,
      repoId: repo!.id,
      event: "agent_briefing_delivered",
      eventKey: key,
      createdAt: new Date(Date.now() - daysAgo * 86_400_000),
    });
    await tx.insert(usageEvents).values([ev(proj!.id, "a", 1), ev(proj!.id, "b", 3), ev(proj!.id, "old", 30), ev(other!.id, "x", 1)]);
    const d = (projectId: string, status: string) => ({ orgId: org!.id, projectId, scopeKind: "project", scopeRef: projectId, status });
    await tx.insert(decisions).values([d(proj!.id, "binding"), d(proj!.id, "proposed"), d(other!.id, "binding")]);
    return { orgId: org!.id, projectId: proj!.id };
  });

  const p = await getPulse(s.orgId, s.projectId, 7);
  assert.equal(p.briefed, 2, "in-window briefings for this project only");
  assert.equal(p.rulesInForce, 1);
  assert.equal(p.newRules, 1);
  assert.equal(p.routed, 0);
  assert.equal(p.caught, 0);
});
