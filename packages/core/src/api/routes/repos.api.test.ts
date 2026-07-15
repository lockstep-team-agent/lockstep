/**
 * Repo disconnect + project archive (Phase O), HTTP-level via Fastify inject() + service-level,
 * against real Postgres (DATABASE_URL). Disconnect: contracts + inboxes + repo row deleted, edges
 * deactivated both directions, live sessions ended, history retained, audit written, reconnect
 * possible, role-gated. Archive: hidden-but-flagged in the overview, connect/join + new sessions
 * rejected, sweeps + digests skip, unarchive restores.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../app.js";
import { withSystem, withOrg } from "../../db/rls.js";
import {
  orgs,
  principals,
  members,
  projects,
  projectMembers,
  repos,
  contracts,
  dependencyEdges,
  inboxes,
  inboxItems,
  sessions,
  auditEvents,
  sourceConnections,
  ingestAllowlist,
  writebacks,
} from "../../db/schema.js";
import { issueTokenTx } from "../../auth/tokens.js";
import { connectOrJoin, disconnectRepo } from "../../auth/auth-service.js";
import { registerSession } from "../session-context.js";
import { orgOverview } from "../../dashboard/dashboard-service.js";
import { listWork } from "../../ingest/ingest-service.js";
import { proposeDecision, setDecisionReview } from "../../ledger/ledger-service.js";
import { enqueueWeeklyDigests } from "../../documents/weekly-digest.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 850_000_000;
const uid = (): number => ++seq;

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `RepoCo-${n}` }).returning());
    const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `own-${n}` }).returning());
    const owner = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `own-${n}` })
        .returning(),
    );
    const pm = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `mem-${n}` }).returning());
    const plainMember = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: pm.id, githubUserId: pm.githubUserId, githubLogin: `mem-${n}` })
        .returning(),
    );
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "repoco", createdBy: owner.id }).returning());
    await tx.insert(projectMembers).values({ orgId: org.id, projectId: proj.id, memberId: owner.id, invitedGithubLogin: owner.githubLogin, role: "owner", status: "active" });
    await tx.insert(projectMembers).values({ orgId: org.id, projectId: proj.id, memberId: plainMember.id, invitedGithubLogin: plainMember.githubLogin, role: "member", status: "active" });
    const gitRemote = `github.com/repoco/svc-${n}`;
    const repo = one(await tx.insert(repos).values({ orgId: org.id, projectId: proj.id, gitRemote }).returning());
    const sibling = one(await tx.insert(repos).values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/repoco/web-${n}` }).returning());
    const token = await issueTokenTx(tx, p.id);
    const memberToken = await issueTokenTx(tx, pm.id);
    return {
      orgId: org.id,
      projectId: proj.id,
      ownerId: owner.id,
      ownerPrincipal: { id: p.id, githubUserId: p.githubUserId, githubLogin: p.githubLogin },
      repoId: repo.id,
      siblingRepoId: sibling.id,
      gitRemote,
      token,
      memberToken,
    };
  });
}

let app: FastifyInstance;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

test("repo disconnect: deletes derived state, deactivates edges, ends sessions, keeps history, allows reconnect", async () => {
  app = buildApp();
  const s = await setup();
  const surface = "http:GET /repoco/items";
  await withOrg(s.orgId, async (tx) => {
    await tx.insert(contracts).values({ orgId: s.orgId, repoId: s.repoId, surface });
    // Edges in both directions: repo as producer AND as consumer.
    await tx.insert(dependencyEdges).values({ orgId: s.orgId, projectId: s.projectId, consumerRepoId: s.siblingRepoId, producedRepoId: s.repoId, producedSurface: surface, active: true });
    await tx.insert(dependencyEdges).values({ orgId: s.orgId, projectId: s.projectId, consumerRepoId: s.repoId, producedRepoId: s.siblingRepoId, producedSurface: "http:GET /web/assets", active: true });
    const inbox = one(await tx.insert(inboxes).values({ orgId: s.orgId, memberId: s.ownerId, repoId: s.repoId, projectId: s.projectId }).returning());
    await tx.insert(inboxItems).values({ orgId: s.orgId, inboxId: inbox.id, kind: "question", refId: crypto.randomUUID() });
    await tx.insert(sessions).values({ orgId: s.orgId, memberId: s.ownerId, repoId: s.repoId, projectId: s.projectId, gitRemote: s.gitRemote, state: "live" });
  });

  // Role gate: a plain member may not disconnect.
  const forbidden = await app.inject({ method: "DELETE", url: `/orgs/${s.orgId}/projects/${s.projectId}/repos/${s.repoId}`, headers: auth(s.memberToken) });
  assert.equal(forbidden.statusCode, 403);

  const res = await app.inject({ method: "DELETE", url: `/orgs/${s.orgId}/projects/${s.projectId}/repos/${s.repoId}`, headers: auth(s.token) });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { contractsDeleted: number; edgesDeactivated: number; sessionsEnded: number };
  assert.equal(body.contractsDeleted, 1);
  assert.equal(body.edgesDeactivated, 2, "both producer- and consumer-side edges deactivated");
  assert.equal(body.sessionsEnded, 1);

  await withOrg(s.orgId, async (tx) => {
    assert.equal((await tx.select().from(repos).where(eq(repos.id, s.repoId))).length, 0, "repo row gone");
    assert.equal((await tx.select().from(contracts).where(eq(contracts.repoId, s.repoId))).length, 0);
    assert.equal((await tx.select().from(inboxes).where(eq(inboxes.repoId, s.repoId))).length, 0);
    const edges = await tx.select().from(dependencyEdges).where(eq(dependencyEdges.projectId, s.projectId));
    assert.ok(edges.every((e) => e.active === false));
    const sess = one(await tx.select().from(sessions).where(eq(sessions.repoId, s.repoId)));
    assert.equal(sess.state, "ended", "session row retained but ended");
    const audit = await tx
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, s.repoId), eq(auditEvents.action, "repo.disconnected")));
    assert.equal(audit.length, 1);
  });

  // Unknown repo → 404; reconnecting the same remote works (unique constraint freed).
  await assert.rejects(disconnectRepo(s.orgId, { projectId: s.projectId, repoId: s.repoId, memberId: s.ownerId }), /not found/);
  const reconnect = await app.inject({
    method: "POST",
    url: `/orgs/${s.orgId}/projects/${s.projectId}/repos`,
    headers: auth(s.token),
    payload: { gitRemote: s.gitRemote },
  });
  assert.equal(reconnect.statusCode, 200, "same remote reconnects after disconnect");
});

test("project archive: hidden-but-flagged, blocks connect/join + sessions, skips sweeps + digests; unarchive restores", async () => {
  const s = await setup();
  // Give the digest something it WOULD report (a due review), and the sweeper something it WOULD sweep.
  const d = await proposeDecision(s.orgId, { projectId: s.projectId, memberId: s.ownerId, scopeKind: "surface", scopeRef: "http:GET /repoco/due", ruleText: "Cache it.", baseVersion: 0 });
  await setDecisionReview(s.orgId, d.decisionId, s.ownerId, new Date(Date.now() - 86400000));
  await withOrg(s.orgId, async (tx) => {
    const conn = one(
      await tx.insert(sourceConnections).values({ orgId: s.orgId, projectId: s.projectId, tool: "slack", entity: s.projectId, status: "active" }).returning(),
    );
    await tx.insert(ingestAllowlist).values({ orgId: s.orgId, projectId: s.projectId, connectionId: conn.id, sourceKind: "channel", sourceRef: "C1", enabled: true });
    await tx.update(projects).set({ settings: { archived: true } }).where(eq(projects.id, s.projectId));
  });

  const ov = await orgOverview(s.orgId, s.ownerId);
  assert.equal(ov.projects.find((p) => p.id === s.projectId)?.archived, true, "flagged archived in the overview");

  await assert.rejects(connectOrJoin(s.ownerPrincipal, s.gitRemote), /archived/);
  assert.equal(await registerSession(s.ownerPrincipal, { gitRemote: s.gitRemote }), null, "no new sessions");
  assert.ok(!(await listWork()).some((w) => w.projectId === s.projectId), "sweeper skips the archived project");
  await enqueueWeeklyDigests();
  const wbs = await withOrg(s.orgId, (tx) => tx.select().from(writebacks).where(eq(writebacks.projectId, s.projectId)));
  assert.equal(wbs.length, 0, "no digest for an archived project");

  // Unarchive → everything resumes.
  await withOrg(s.orgId, (tx) => tx.update(projects).set({ settings: { archived: false } }).where(eq(projects.id, s.projectId)));
  const sess = await registerSession(s.ownerPrincipal, { gitRemote: s.gitRemote });
  assert.ok(sess, "sessions register again after unarchive");
  assert.ok((await listWork()).some((w) => w.projectId === s.projectId), "sweeper sees it again");
});
