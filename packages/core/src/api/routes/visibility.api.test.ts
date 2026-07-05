/**
 * #2 per-project visibility — HTTP-level coverage via inject(). A "shared" project (default) is
 * readable by any org member; flipping it to "walled" (via the owner-only settings patch) makes the
 * project's overview / graph / proposed / insights / org-overview listing require an active
 * project_members row. Also asserts createProject backfills an owner roster row (F1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq, and } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { withSystem } from "../../db/rls.js";
import { orgs, principals, members, projects, projectMembers } from "../../db/schema.js";
import { issueTokenTx } from "../../auth/tokens.js";
import { createProject } from "../../auth/auth-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 950_000_000;
const uid = (): number => ++seq;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `VisCo-${n}` }).returning());
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "vis" }).returning());
    const mk = async (login: string, projRole: string | null) => {
      const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `${login}-${n}` }).returning());
      const m = one(
        await tx
          .insert(members)
          .values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `${login}-${n}` })
          .returning(),
      );
      if (projRole) {
        await tx.insert(projectMembers).values({
          orgId: org.id,
          projectId: proj.id,
          memberId: m.id,
          invitedGithubLogin: m.githubLogin,
          role: projRole,
          status: "active",
        });
      }
      return { memberId: m.id, token: await issueTokenTx(tx, p.id) };
    };
    const owner = await mk("owner", "owner"); // project member (owner) — can flip settings
    const member = await mk("member", "member"); // project member
    const outsider = await mk("outsider", null); // org member, NOT a project member
    return { orgId: org.id, projectId: proj.id, owner, member, outsider };
  });
}

test("visibility: shared project is org-readable; walled project gates on project membership", async (t) => {
  const app: FastifyInstance = buildApp();
  t.after(() => app.close());
  const s = await setup();
  const base = `/orgs/${s.orgId}/projects/${s.projectId}`;
  const reads = [`${base}/overview`, `${base}/graph`, `${base}/proposed`, `${base}/insights`];

  // Shared (default): the outsider (org member, not a project member) reads everything.
  for (const url of reads) {
    const res = await app.inject({ method: "GET", url, headers: auth(s.outsider.token) });
    assert.equal(res.statusCode, 200, `shared read ${url} → 200`);
  }

  // Owner walls the project.
  const flip = await app.inject({
    method: "POST",
    url: `${base}/settings`,
    headers: auth(s.owner.token),
    payload: { visibility: "walled" },
  });
  assert.equal(flip.statusCode, 200);
  assert.equal(flip.json().settings.visibility, "walled");

  // Walled: the outsider is now 403 project_forbidden on every read; a project member still reads.
  for (const url of reads) {
    const denied = await app.inject({ method: "GET", url, headers: auth(s.outsider.token) });
    assert.equal(denied.statusCode, 403, `walled read ${url} → 403`);
    assert.equal(denied.json().error, "project_forbidden");
    const ok = await app.inject({ method: "GET", url, headers: auth(s.member.token) });
    assert.equal(ok.statusCode, 200, `member still reads ${url}`);
  }
});

test("visibility: org overview hides a walled project from non-members", async (t) => {
  const app: FastifyInstance = buildApp();
  t.after(() => app.close());
  const s = await setup();
  await withSystem((tx) =>
    tx.update(projects).set({ settings: { visibility: "walled" } }).where(eq(projects.id, s.projectId)),
  );

  const asOutsider = await app.inject({ method: "GET", url: `/orgs/${s.orgId}/overview`, headers: auth(s.outsider.token) });
  assert.equal(asOutsider.statusCode, 200);
  assert.ok(
    !asOutsider.json().projects.some((p: { id: string }) => p.id === s.projectId),
    "walled project hidden from a non-member",
  );

  const asMember = await app.inject({ method: "GET", url: `/orgs/${s.orgId}/overview`, headers: auth(s.member.token) });
  assert.ok(
    asMember.json().projects.some((p: { id: string }) => p.id === s.projectId),
    "walled project visible to its member",
  );
});

test("F1 roster: createProject backfills an active owner project_members row", async () => {
  const n = uid();
  const { orgId, principal } = await withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `RosterCo-${n}` }).returning());
    const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `creator-${n}` }).returning());
    await tx.insert(members).values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `creator-${n}` });
    return { orgId: org.id, principal: { id: p.id, githubUserId: p.githubUserId, githubLogin: `creator-${n}` } };
  });
  const { projectId } = await createProject(principal, orgId, "rostered");
  const row = await withSystem((tx) =>
    tx
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.status, "active")))
      .limit(1),
  );
  assert.equal(row[0]?.role, "owner", "creator is an active owner in the roster");
});
