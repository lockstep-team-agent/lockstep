/** Verdict write-backs: PRD-sourced → page comment on its own tool, Slack-sourced → thread reply. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { withOrg, withSystem } from "../db/rls.js";
import { members, orgs, principals, projectMembers, projects, sourceDocuments, writebacks } from "../db/schema.js";
import { fileProposedDecision, proposeDecision } from "../ledger/ledger-service.js";
import { composeVerdictText, enqueueVerdictWriteback } from "./verdict-writeback.js";

let seq = Date.now() + 997_000_000;
const uid = () => ++seq;
const one = <T>(r: T[]): T => r[0]!;

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(
      await tx
        .insert(orgs)
        .values({ name: `Verdict-${n}` })
        .returning(),
    );
    const p = one(
      await tx
        .insert(principals)
        .values({ githubUserId: uid(), githubLogin: `pm-${n}` })
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
      role: "pm",
      status: "active",
    });
    return { orgId: org.id, projectId: proj.id, memberId: m.id, login: m.githubLogin };
  });
}

const file = (s: Awaited<ReturnType<typeof setup>>, provenance: unknown, origin = "document") =>
  fileProposedDecision(
    s.orgId,
    {
      projectId: s.projectId,
      scopeKind: "topic",
      scopeRef: `topic:${uid()}`,
      ruleText: "Exports require consent",
      provenance,
      connectionId: "00000000-0000-0000-0000-000000000000",
      externalId: `x-${uid()}`,
      contentHash: `h-${uid()}`,
      origin,
    },
    async () => null,
    async () => null,
  );

const rowsFor = (orgId: string, decisionId: string) =>
  withOrg(orgId, (tx) =>
    tx
      .select()
      .from(writebacks)
      .where(sql`payload->>'decisionId' = ${decisionId}`),
  );

test("a PRD-sourced verdict comments on that document's own tool; once per verdict+version", async () => {
  const s = await setup();
  const connectionId = crypto.randomUUID(); // unique per run: (connection, external id) is unique
  const doc = await withOrg(s.orgId, async (tx) =>
    one(
      await tx
        .insert(sourceDocuments)
        .values({
          orgId: s.orgId,
          projectId: s.projectId,
          connectionId,
          tool: "confluence",
          externalId: `page-${uid()}`,
          title: "Spec: Exports",
          state: "active",
        })
        .returning(),
    ),
  );
  const d = await file(s, { source: "confluence", documentId: doc.id });
  const t = await enqueueVerdictWriteback(
    s.orgId,
    d.decisionId,
    "ratified",
    s.memberId,
    "  Ship it behind the consent modal. ",
  );
  assert.equal(t?.tool, "confluence");
  await enqueueVerdictWriteback(s.orgId, d.decisionId, "ratified", s.memberId, "again");
  const rows = await rowsFor(s.orgId, d.decisionId);
  assert.equal(rows.length, 1, "deduped");
  const r = rows[0]!;
  assert.equal(r.kind, "decision_comment");
  assert.equal(r.tool, "confluence");
  assert.equal(r.targetRef, doc.externalId);
  assert.equal(r.connectionId, connectionId);
  const body = (r.payload as { body: string }).body;
  assert.match(body, new RegExp(`Ratified in Lockstep by @${s.login}`));
  assert.match(body, /Note: Ship it behind the consent modal\.$/m);
});

test("a Slack-sourced verdict replies in the thread; agent decisions post nothing", async () => {
  const s = await setup();
  const d = await file(
    s,
    { source: "slack", url: "https://x.slack.com/archives/C1/p1", evidence: [{ quote: "ok" }] },
    "ingested",
  );
  // the Slack unit key lives on the provenance row's external id
  await withOrg(s.orgId, (tx) =>
    tx.execute(
      sql`UPDATE decision_provenances SET external_id = 'C0PLATFORM/1726000000.123456' WHERE decision_id = ${d.decisionId}`,
    ),
  );
  const t = await enqueueVerdictWriteback(s.orgId, d.decisionId, "rejected", s.memberId, null);
  assert.equal(t?.kind, "slack_thread_reply");
  const r = one(await rowsFor(s.orgId, d.decisionId));
  assert.deepEqual(
    { channel: (r.payload as { channel: string }).channel, threadTs: (r.payload as { threadTs: string }).threadTs },
    { channel: "C0PLATFORM", threadTs: "1726000000.123456" },
  );
  assert.match((r.payload as { text: string }).text, /^Rejected in Lockstep/);

  const a = await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    scopeKind: "topic",
    scopeRef: "topic:z",
    ruleText: "Z",
    baseVersion: 0,
  });
  assert.equal(await enqueueVerdictWriteback(s.orgId, a.decisionId, "confirmed", s.memberId), null);
  assert.equal((await rowsFor(s.orgId, a.decisionId)).length, 0);
});

test("composeVerdictText", () => {
  assert.equal(
    composeVerdictText({ verdict: "confirmed", login: "ana", ruleText: "R", note: null, link: "https://l/x" }),
    "Confirmed in Lockstep by @ana: “R” is now a binding rule — coding agents working on this area will follow it.\nDetails: https://l/x",
  );
});
