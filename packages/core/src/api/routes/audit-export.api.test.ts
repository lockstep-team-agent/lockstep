/**
 * Audit export — one row per decision version with proposer, approvals, sources and linked PRs;
 * CSV escapes commas/quotes/newlines and downloads as an attachment. Guarded like its neighbours.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { withSystem } from "../../db/rls.js";
import { orgs, principals, members, projects, repos, contracts, decisionProvenances } from "../../db/schema.js";
import { issueTokenTx } from "../../auth/tokens.js";
import { proposeDecision, ackDecision } from "../../ledger/ledger-service.js";
import { csvField } from "../../dashboard/audit-export.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 990_000_000;
const uid = (): number => ++seq;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

test("audit export: CSV + JSON rows per version, approvals/sources/PRs joined, guarded", async (t) => {
  const app: FastifyInstance = buildApp();
  t.after(() => app.close());
  const n = uid();
  const s = await withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `Audit-${n}` }).returning());
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "Pay Ments" }).returning());
    const repo = one(await tx.insert(repos).values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/a/r-${n}` }).returning());
    const mk = async (login: string, orgId: string) => {
      const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `${login}-${n}` }).returning());
      const m = one(
        await tx.insert(members).values({ orgId, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `${login}-${n}` }).returning(),
      );
      return { memberId: m.id, login: m.githubLogin, token: await issueTokenTx(tx, p.id) };
    };
    const author = await mk("author", org.id);
    const reviewer = await mk("reviewer", org.id);
    const otherOrg = one(await tx.insert(orgs).values({ name: `Other-${n}` }).returning());
    const stranger = await mk("stranger", otherOrg.id);
    await tx.insert(contracts).values({
      orgId: org.id,
      repoId: repo.id,
      surface: "http:POST /pay",
      delta: { kind: "pr-merge", prNumber: 42 },
    });
    return { orgId: org.id, projectId: proj.id, author, reviewer, stranger };
  });

  const tricky = 'Use "JWT", always,\nno server sessions';
  const base = { projectId: s.projectId, memberId: s.author.memberId, scopeKind: "surface", scopeRef: "http:POST /pay" };
  const v1 = await proposeDecision(s.orgId, { ...base, ruleText: tricky, baseVersion: 0 });
  await ackDecision(s.orgId, v1.decisionId, 1, s.reviewer.memberId, "approve");
  await proposeDecision(s.orgId, { ...base, ruleText: "=v2 rule", baseVersion: 1 });
  await withSystem((tx) =>
    tx.insert(decisionProvenances).values({ orgId: s.orgId, decisionId: v1.decisionId, source: "slack", url: "https://slack.example/t/1" }),
  );

  const url = `/orgs/${s.orgId}/projects/${s.projectId}/audit-export`;
  const csv = await app.inject({ method: "GET", url, headers: auth(s.author.token) });
  assert.equal(csv.statusCode, 200);
  assert.match(csv.headers["content-type"] as string, /^text\/csv/);
  assert.match(
    csv.headers["content-disposition"] as string,
    /^attachment; filename="lockstep-audit-pay-ments-\d{4}-\d{2}-\d{2}\.csv"$/,
  );
  const body = csv.body;
  assert.ok(
    body.startsWith(
      "decision_id,rule_text,decision_type,status,scope,version,proposed_by,created_at,approvals,sources,linked_prs,superseded_by,expires_at\r\n",
    ),
  );
  assert.ok(body.includes('"Use ""JWT"", always,\nno server sessions"'), "comma/quote/newline field is quoted + escaped");
  assert.ok(body.includes(",'=v2 rule,"), "formula-leading text is neutralised");

  const json = await app.inject({ method: "GET", url: `${url}?format=json`, headers: auth(s.author.token) });
  assert.equal(json.statusCode, 200);
  assert.match(json.headers["content-disposition"] as string, /\.json"$/);
  const rows = json.json().rows as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2, "one row per version");
  const [r1, r2] = rows;
  assert.equal(r1!.ruleText, tricky);
  assert.equal(r1!.version, 1);
  assert.equal(r1!.scope, "surface:http:POST /pay");
  assert.equal(r1!.proposedBy, s.author.login);
  assert.match(r1!.createdAt as string, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(r1!.approvals as string, new RegExp(`^${s.reviewer.login} approve \\d{4}-.*Z$`));
  assert.equal(r1!.sources, "slack https://slack.example/t/1");
  assert.equal(r1!.linkedPrs, "#42");
  assert.equal(r2!.version, 2);
  assert.equal(r2!.approvals, "", "approvals are per version");

  assert.equal((await app.inject({ method: "GET", url: `${url}?format=xml`, headers: auth(s.author.token) })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url, headers: auth(s.stranger.token) })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
});

test("csvField: RFC 4180 quoting", () => {
  assert.equal(csvField("plain"), "plain");
  assert.equal(csvField('a "b"'), '"a ""b"""');
  assert.equal(csvField("a,b"), '"a,b"');
  assert.equal(csvField("a\r\nb"), '"a\r\nb"');
  assert.equal(csvField(null), "");
  assert.equal(csvField("@SUM(A1)"), "'@SUM(A1)");
});
