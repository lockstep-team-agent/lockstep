/**
 * Review comments → proposed standards: recurring similar PR review comments (≥3 across ≥2 PRs) file
 * exactly ONE proposed decision; later similar comments fuse into it; dissimilar, bot, and short
 * comments never propose. Embeddings, the Jev judge and the LLM are stubbed off (Jaccard path).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { withSystem, withOrg } from "../db/rls.js";
import { orgs, principals, members, projects, repos, githubInstallations, decisions, decisionProvenances, reviewComments } from "../db/schema.js";
import { processGitHubEvent } from "./github-webhook-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 960_000_000;
const uid = (): number => ++seq;
const offline = { embed: async () => null, judge: async () => null, distill: async () => null };

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `RC-${n}` }).returning());
    const p = one(await tx.insert(principals).values({ githubUserId: n, githubLogin: `rc-${n}` }).returning());
    const m = one(
      await tx.insert(members).values({ orgId: org.id, principalId: p.id, githubUserId: n, githubLogin: `rc-${n}` }).returning(),
    );
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: `rc-${n}`, createdBy: m.id }).returning());
    await tx
      .insert(repos)
      .values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/acme/rc-${n}`, defaultBranch: "main" });
    await tx.insert(githubInstallations).values({ orgId: org.id, installationId: n, accountLogin: "acme" });
    return { orgId: org.id, projectId: proj.id, n };
  });
}

const comment = (s: { n: number }, pr: number, body: string, user: Record<string, unknown> = { id: s.n, login: `rc-${s.n}` }) => {
  const id = uid();
  return {
    action: "created",
    installation: { id: s.n },
    repository: { full_name: `acme/rc-${s.n}` },
    pull_request: { number: pr },
    comment: { id, body, html_url: `https://github.com/acme/rc-${s.n}/pull/${pr}#discussion_r${id}`, user },
  };
};

const proposals = (orgId: string, projectId: string) =>
  withOrg(orgId, (tx) => tx.select().from(decisions).where(eq(decisions.projectId, projectId)));

test("3 similar comments on 2 PRs → one proposal; a 4th fuses; redelivery is a no-op", async () => {
  const s = await setup();
  const a = await processGitHubEvent("pull_request_review_comment", comment(s, 1, "Please use maskedSerializer here, not toJSON — it leaks PII."), offline);
  const b = await processGitHubEvent("pull_request_review_comment", comment(s, 1, "Use maskedSerializer instead of toJSON, toJSON leaks PII."), offline);
  assert.deepEqual([a.proposed, b.proposed], [[], []], "below the threshold nothing is proposed");

  const c = await processGitHubEvent("pull_request_review_comment", comment(s, 2, "use maskedSerializer not toJSON, PII leaks otherwise"), offline);
  assert.equal(c.proposed?.length, 1);
  let ds = await proposals(s.orgId, s.projectId);
  assert.equal(ds.length, 1);
  assert.equal(ds[0]!.status, "proposed");
  assert.equal(ds[0]!.origin, "ingested");
  assert.equal(ds[0]!.scopeKind, "repo");
  assert.equal(ds[0]!.scopeRef, `github.com/acme/rc-${s.n}`);

  // A review summary (pull_request_review) with the same feedback, on a 3rd PR, from another reviewer.
  const fourth = await processGitHubEvent(
    "pull_request_review",
    {
      action: "submitted",
      installation: { id: s.n },
      repository: { full_name: `acme/rc-${s.n}` },
      pull_request: { number: 3 },
      review: { id: uid(), body: "Again: use maskedSerializer, toJSON leaks PII.", html_url: "https://x/r", user: { id: 7, login: "outsider" } },
    },
    offline,
  );
  assert.deepEqual(fourth.proposed, [ds[0]!.id], "the 4th fuses into the same decision");
  ds = await proposals(s.orgId, s.projectId);
  assert.equal(ds.length, 1, "still exactly one proposal");
  const provs = await withOrg(s.orgId, (tx) =>
    tx.select().from(decisionProvenances).where(eq(decisionProvenances.decisionId, ds[0]!.id)),
  );
  assert.equal(provs.length, 2, "the 4th comment attached as provenance");

  const fifthPayload = comment(s, 4, "maskedSerializer please, never toJSON (leaks PII)");
  await processGitHubEvent("pull_request_review_comment", fifthPayload, offline);
  const again = await processGitHubEvent("pull_request_review_comment", fifthPayload, offline);
  assert.equal(again.skipped, "duplicate delivery");
  assert.equal((await proposals(s.orgId, s.projectId)).length, 1);
  const folded = await withOrg(s.orgId, (tx) => tx.select().from(reviewComments).where(eq(reviewComments.projectId, s.projectId)));
  assert.equal(folded.length, 5);
  assert.ok(folded.every((r) => r.decisionId === ds[0]!.id), "every recurring comment is folded into the proposal");
});

test("dissimilar, bot, short and approval-only comments never propose", async () => {
  const s = await setup();
  await processGitHubEvent("pull_request_review_comment", comment(s, 1, "Use the shared fetch client from lib/http instead of raw fetch."), offline);
  await processGitHubEvent("pull_request_review_comment", comment(s, 2, "Rename this variable, the abbreviation is unclear to readers."), offline);
  const third = await processGitHubEvent("pull_request_review_comment", comment(s, 3, "This migration needs an index on created_at for the report query."), offline);
  assert.deepEqual(third.proposed, [], "three unrelated comments are not a standard");

  const bot = await processGitHubEvent(
    "pull_request_review_comment",
    comment(s, 4, "Use the shared fetch client from lib/http instead of raw fetch.", { id: 99, login: "coderabbit[bot]", type: "Bot" }),
    offline,
  );
  assert.equal(bot.skipped, "bot author");
  assert.equal((await processGitHubEvent("pull_request_review_comment", comment(s, 4, "use the client"), offline)).skipped, "not substantive");
  assert.equal((await processGitHubEvent("pull_request_review_comment", comment(s, 4, "LGTM, great work!! 🚀"), offline)).skipped, "not substantive");
  assert.equal((await proposals(s.orgId, s.projectId)).length, 0);
});
