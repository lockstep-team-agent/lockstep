/**
 * Member-wide ack (IMPROVEMENTS #5), service-layer against real Postgres (DATABASE_URL). Fan-out
 * replicates a ping into one inbox per (member, repo); acking from ONE session must clear the same
 * refId from the member's other repo inboxes in the project — without blind-clearing items only
 * another repo's inbox ever held, and without touching other members.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withSystem, withOrg } from "../db/rls.js";
import { orgs, principals, members, projects, repos, inboxes, inboxItems } from "../db/schema.js";
import { fanoutToProjectTx } from "../routing/routing-engine.js";
import { ackInbox, peekInbox } from "./inbox-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 800_000_000;
const uid = (): number => ++seq;

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `Inbox-${n}` }).returning());
    const mk = async (label: string) => {
      const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `${label}-${n}` }).returning());
      return one(
        await tx
          .insert(members)
          .values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `${label}-${n}` })
          .returning(),
      );
    };
    const alice = await mk("alice");
    const bob = await mk("bob");
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "inbox", createdBy: alice.id }).returning());
    const repoA = one(await tx.insert(repos).values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/i/a-${n}` }).returning());
    const repoB = one(await tx.insert(repos).values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/i/b-${n}` }).returning());
    return { orgId: org.id, projectId: proj.id, alice: alice.id, bob: bob.id, repoA: repoA.id, repoB: repoB.id };
  });
}

const unreadFor = async (s: Awaited<ReturnType<typeof setup>>, memberId: string, repoId: string): Promise<number> =>
  (await peekInbox(s.orgId, { memberId, repoId, projectId: s.projectId })).unread;

test("acking a refId in one repo session clears the member's other repo inboxes", async () => {
  const s = await setup();
  const questionId = randomUUID();
  // Bob asks → the question fans out to Alice across BOTH her repo inboxes.
  await withOrg(s.orgId, (tx) =>
    fanoutToProjectTx(tx, s.orgId, {
      projectId: s.projectId,
      refId: questionId,
      kind: "question",
      senderMemberId: s.bob,
      reason: { body: "which auth scheme?" },
    }),
  );
  assert.equal(await unreadFor(s, s.alice, s.repoA), 1);
  assert.equal(await unreadFor(s, s.alice, s.repoB), 1);

  const r = await ackInbox(s.orgId, { memberId: s.alice, repoId: s.repoA, projectId: s.projectId }, [questionId]);
  assert.equal(r.acknowledged, 2, "both replicas cleared in one ack");
  assert.equal(await unreadFor(s, s.alice, s.repoA), 0);
  assert.equal(await unreadFor(s, s.alice, s.repoB), 0, "the sibling session stops nagging");
});

test("ack-all clears member-wide only what the current session saw; other members untouched", async () => {
  const s = await setup();
  const pingId = randomUUID();
  const changeId = randomUUID();
  await withOrg(s.orgId, async (tx) => {
    // A project-wide ping lands in every (member, repo) inbox…
    await fanoutToProjectTx(tx, s.orgId, {
      projectId: s.projectId,
      refId: pingId,
      kind: "decision",
      senderMemberId: s.bob,
      reason: { ruleText: "JWT everywhere" },
    });
    // …and a change item delivered ONLY to Alice's repoB inbox (the per-consumer-repo shape
    // fanoutChangeTx produces) — repoA's session never saw it.
    const repoBInbox = one(
      await tx
        .select()
        .from(inboxes)
        .where(and(eq(inboxes.memberId, s.alice), eq(inboxes.repoId, s.repoB), eq(inboxes.projectId, s.projectId))),
    );
    await tx.insert(inboxItems).values({
      orgId: s.orgId,
      inboxId: repoBInbox.id,
      kind: "change",
      refId: changeId,
      reason: { summary: "renamed field" },
    });
  });
  assert.equal(await unreadFor(s, s.alice, s.repoA), 1);
  assert.equal(await unreadFor(s, s.alice, s.repoB), 2);

  await ackInbox(s.orgId, { memberId: s.alice, repoId: s.repoA, projectId: s.projectId });
  assert.equal(await unreadFor(s, s.alice, s.repoA), 0);
  assert.equal(await unreadFor(s, s.alice, s.repoB), 1, "repoB-only change item survives repoA's ack-all");

  // Bob's own inboxes never got the ping (sender excluded) — but ensure Alice's ack didn't create
  // or clear anything for him either.
  assert.equal(await unreadFor(s, s.bob, s.repoA), 0);
  assert.equal(await unreadFor(s, s.bob, s.repoB), 0);
});

test("ack with no inbox for the current repo acknowledges nothing", async () => {
  const s = await setup();
  const r = await ackInbox(s.orgId, { memberId: s.alice, repoId: s.repoA, projectId: s.projectId });
  assert.equal(r.acknowledged, 0);
});
