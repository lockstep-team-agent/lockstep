/** The approval brief: conflicts side by side, source + neighbours, and the cached summary. */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { withOrg, withSystem } from "../db/rls.js";
import { conflicts, members, orgs, principals, projectMembers, projects, repos } from "../db/schema.js";
import { fileProposedDecision, proposeDecision, syncProducedSurfaces } from "../ledger/ledger-service.js";
import { decisionBrief, decisionSummary, summaryInput } from "./brief.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
let seq = Date.now() + 996_000_000;
const uid = () => ++seq;
const one = <T>(r: T[]): T => r[0]!;

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(
      await tx
        .insert(orgs)
        .values({ name: `Brief-${n}` })
        .returning(),
    );
    const p = one(
      await tx
        .insert(principals)
        .values({ githubUserId: uid(), githubLogin: `b-${n}` })
        .returning(),
    );
    const m = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: p.githubLogin })
        .returning(),
    );
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "b", createdBy: m.id }).returning());
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
        .values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/b/api-${n}` })
        .returning(),
    );
    return { orgId: org.id, projectId: proj.id, memberId: m.id, repoId: r.id };
  });
}

test("brief: conflict shown with the other rule, evidence, concept and neighbours", async () => {
  const s = await setup();
  await syncProducedSurfaces(s.orgId, {
    projectId: s.projectId,
    repoId: s.repoId,
    memberId: s.memberId,
    surfaces: ["http:GET /files"],
  });
  const eng = await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    scopeKind: "surface",
    scopeRef: "http:GET /files",
    ruleText: "Files are paginated at 50",
    baseVersion: 0,
    rationale: "Large folders time out",
  });
  const c = await fileProposedDecision(
    s.orgId,
    {
      projectId: s.projectId,
      scopeKind: "surface",
      scopeRef: "http:GET /files",
      ruleText: "Files are only listed for paid plans",
      provenance: {
        source: "notion",
        url: "https://notion.so/x",
        evidence: [{ quote: "Listing files is a paid feature." }],
      },
      connectionId: "00000000-0000-0000-0000-000000000000",
      externalId: `b-${uid()}`,
      contentHash: `h-${uid()}`,
      origin: "document",
      constraintKind: "behavioral",
      confidence: 90,
    },
    async () => null,
    async () => null,
  );
  await withOrg(s.orgId, (tx) =>
    tx.insert(conflicts).values({
      orgId: s.orgId,
      projectId: s.projectId,
      constraintDecisionId: c.decisionId,
      engDecisionId: eng.decisionId,
      surface: "http:GET /files",
      kind: "pre_approval",
    }),
  );
  const b = (await decisionBrief(s.orgId, s.projectId, c.decisionId))!;
  assert.equal(b.raisedFrom.channel, "document");
  assert.equal(b.provenances[0]?.evidence?.[0]?.quote, "Listing files is a paid feature.");
  assert.equal(b.concept?.key, "http:files");
  assert.equal(b.conflictsDetail[0]?.side, "constraint");
  assert.equal(b.conflictsDetail[0]?.other?.ruleText, "Files are paginated at 50");
  assert.equal(b.neighbours[0]?.id, eng.decisionId);
  assert.equal(b.neighbours[0]?.sameScope, true);
  assert.match(summaryInput(b), /Open pre approval conflict with engineering decision: Files are paginated at 50/);
  assert.equal(await decisionBrief(s.orgId, (await setup()).projectId, c.decisionId), null, "other project → null");
});

test("summary: none without a key; generated once, then served from cache", async () => {
  const s = await setup();
  const d = await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    scopeKind: "topic",
    scopeRef: "topic:x",
    ruleText: "Retries use jitter",
    baseVersion: 0,
  });
  assert.equal(await decisionSummary(s.orgId, s.projectId, d.decisionId, undefined), null);
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(JSON.stringify({ content: [{ type: "text", text: "Raised to stop retry storms." }] }), {
      status: 200,
    });
  }) as typeof fetch;
  assert.equal((await decisionSummary(s.orgId, s.projectId, d.decisionId, "k"))?.text, "Raised to stop retry storms.");
  assert.equal((await decisionSummary(s.orgId, s.projectId, d.decisionId, "k"))?.text, "Raised to stop retry storms.");
  assert.equal(calls, 1, "cached per version");
  globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
  const d2 = await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    scopeKind: "topic",
    scopeRef: "topic:y",
    ruleText: "Y",
    baseVersion: 0,
  });
  assert.equal(
    await decisionSummary(s.orgId, s.projectId, d2.decisionId, "k"),
    null,
    "provider failure → null, never throws",
  );
});
