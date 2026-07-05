/**
 * Populating members.slack_user_id — the fix for the "Slack loop silently no-ops" MVP gap. Two paths:
 * a manual link route (owner/PM links anyone; a member links themselves) and reconcileSlackMembersByEmail
 * (worker hands over the workspace's users; core fills NULL slack ids by email, never clobbering a link).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { withSystem } from "../../db/rls.js";
import { orgs, principals, members, projects, projectMembers } from "../../db/schema.js";
import { issueTokenTx } from "../../auth/tokens.js";
import { reconcileSlackMembersByEmail } from "../../auth/auth-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 970_000_000;
const uid = (): number => ++seq;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const slackOf = (orgId: string, memberId: string) =>
  withSystem(async (tx) =>
    (await tx.select().from(members).where(and(eq(members.orgId, orgId), eq(members.id, memberId))).limit(1))[0]
      ?.slackUserId ?? null,
  );

/** memberEmail set on the members row; principalEmail on the principal (GitHub email); either may be null. */
async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `SlackCo-${n}` }).returning());
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "slack" }).returning());
    const mk = async (login: string, role: string, memberEmail: string | null, principalEmail: string | null, slack?: string) => {
      const p = one(
        await tx
          .insert(principals)
          .values({ githubUserId: uid(), githubLogin: `${login}-${n}`, email: principalEmail })
          .returning(),
      );
      const m = one(
        await tx
          .insert(members)
          .values({
            orgId: org.id,
            principalId: p.id,
            githubUserId: p.githubUserId,
            githubLogin: `${login}-${n}`,
            email: memberEmail,
            slackUserId: slack ?? null,
          })
          .returning(),
      );
      await tx.insert(projectMembers).values({
        orgId: org.id,
        projectId: proj.id,
        memberId: m.id,
        invitedGithubLogin: m.githubLogin,
        role,
        status: "active",
      });
      return { memberId: m.id, token: await issueTokenTx(tx, p.id) };
    };
    const owner = await mk("owner", "owner", `owner-${n}@x.com`, null);
    const alice = await mk("alice", "member", null, `alice-${n}@x.com`); // member.email null → falls back to principal email
    const bob = await mk("bob", "member", `bob-${n}@x.com`, null, "UBOB_EXISTING"); // already linked
    return { orgId: org.id, projectId: proj.id, n, owner, alice, bob };
  });
}

test("reconcileSlackMembersByEmail: matches by member/principal email (case-insensitive), fills nulls only", async () => {
  const s = await setup();
  const res = await reconcileSlackMembersByEmail(s.orgId, [
    { slackUserId: "UOWNER", email: `OWNER-${s.n}@x.com` }, // upper-case → still matches owner.email
    { slackUserId: "UALICE", email: `alice-${s.n}@x.com` }, // matches via principal email (member.email null)
    { slackUserId: "UBOB_NEW", email: `bob-${s.n}@x.com` }, // bob already linked → must NOT clobber
    { slackUserId: "UGHOST", email: `nobody-${s.n}@x.com` }, // no member → ignored
  ]);
  assert.equal(res.matched, 2, "owner + alice linked; bob skipped");
  assert.equal(await slackOf(s.orgId, s.owner.memberId), "UOWNER");
  assert.equal(await slackOf(s.orgId, s.alice.memberId), "UALICE");
  assert.equal(await slackOf(s.orgId, s.bob.memberId), "UBOB_EXISTING", "existing link never clobbered");

  // Idempotent: a second run links nothing new.
  const again = await reconcileSlackMembersByEmail(s.orgId, [{ slackUserId: "UOWNER", email: `owner-${s.n}@x.com` }]);
  assert.equal(again.matched, 0);
});

test("manual link route: a member links themselves; only owners/PMs link others", async (t) => {
  const app: FastifyInstance = buildApp();
  t.after(() => app.close());
  const s = await setup();
  const base = `/orgs/${s.orgId}/projects/${s.projectId}/members`;

  // Alice (plain member) links her own Slack id.
  const self = await app.inject({
    method: "POST",
    url: `${base}/${s.alice.memberId}/slack`,
    headers: auth(s.alice.token),
    payload: { slackUserId: "UALICE_SELF" },
  });
  assert.equal(self.statusCode, 200);
  assert.equal(await slackOf(s.orgId, s.alice.memberId), "UALICE_SELF");

  // Alice cannot link Bob (she's not owner/PM).
  const forbidden = await app.inject({
    method: "POST",
    url: `${base}/${s.bob.memberId}/slack`,
    headers: auth(s.alice.token),
    payload: { slackUserId: "HACK" },
  });
  assert.equal(forbidden.statusCode, 403);

  // Owner can link Bob (clearing then setting), and can clear with null.
  const byOwner = await app.inject({
    method: "POST",
    url: `${base}/${s.bob.memberId}/slack`,
    headers: auth(s.owner.token),
    payload: { slackUserId: "UBOB_BY_OWNER" },
  });
  assert.equal(byOwner.statusCode, 200);
  assert.equal(await slackOf(s.orgId, s.bob.memberId), "UBOB_BY_OWNER");

  const cleared = await app.inject({
    method: "POST",
    url: `${base}/${s.owner.memberId}/slack`,
    headers: auth(s.owner.token),
    payload: { slackUserId: "" },
  });
  assert.equal(cleared.statusCode, 200);
  assert.equal(await slackOf(s.orgId, s.owner.memberId), null, "empty string clears the link");
});
