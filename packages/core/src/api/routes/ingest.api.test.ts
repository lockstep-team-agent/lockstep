/**
 * HTTP-level coverage of the ingest routes via Fastify's inject() — no socket. Exercises principal
 * auth + org membership, the admin/review/graph/search endpoints, and the service-token worker
 * endpoints (worker-success assertions run only when LOCKSTEP_INGEST_TOKEN is set — the `coverage`
 * script sets it; plain `test` covers the 401 branch).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { env } from "../../env.js";
import { withSystem } from "../../db/rls.js";
import { randomUUID } from "node:crypto";
import { orgs, principals, members, projects, projectMembers } from "../../db/schema.js";
import { issueTokenTx } from "../../auth/tokens.js";
import { proposeDecision, fileProposedDecision } from "../../ledger/ledger-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 950_000_000;
const uid = (): number => ++seq;

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `ApiCo-${n}` }).returning());
    const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `m-${n}` }).returning());
    const m = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `m-${n}` })
        .returning(),
    );
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "api" }).returning());
    // Connector plumbing + graph mutations are owner/pm operations — the actor is a project owner.
    await tx.insert(projectMembers).values({
      orgId: org.id,
      projectId: proj.id,
      memberId: m.id,
      invitedGithubLogin: m.githubLogin,
      role: "owner",
      status: "active",
    });
    const token = await issueTokenTx(tx, p.id);
    // an outsider principal — has a token but is NOT a member of the org
    const outsider = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `o-${n}` }).returning());
    const outsiderToken = await issueTokenTx(tx, outsider.id);
    return { orgId: org.id, projectId: proj.id, memberId: m.id, token, outsiderToken };
  });
}

let app: FastifyInstance;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

test("ingest API: full admin → worker → review → graph → search flow", async () => {
  app = buildApp();
  const s = await setup();
  const base = `/orgs/${s.orgId}/projects/${s.projectId}`;

  // membership gate
  const forbidden = await app.inject({ method: "GET", url: `${base}/connections`, headers: auth(s.outsiderToken) });
  assert.equal(forbidden.statusCode, 403, "non-member is rejected");
  const unauth = await app.inject({ method: "GET", url: `${base}/connections` });
  assert.equal(unauth.statusCode, 401, "no token is unauthorized");

  // create + list connection
  const created = await app.inject({ method: "POST", url: `${base}/connections`, headers: auth(s.token), payload: { tool: "slack" } });
  assert.equal(created.statusCode, 200);
  const connectionId = created.json().connectionId as string;
  const conns = await app.inject({ method: "GET", url: `${base}/connections`, headers: auth(s.token) });
  assert.ok((conns.json().connections as unknown[]).length >= 1);

  // allowlist
  const allow = await app.inject({ method: "POST", url: `${base}/allowlist`, headers: auth(s.token), payload: { connectionId, sourceRef: "C1", sourceName: "#eng" } });
  assert.equal(allow.statusCode, 200);
  const allowMissing = await app.inject({ method: "POST", url: `${base}/allowlist`, headers: auth(s.token), payload: { connectionId } });
  assert.equal(allowMissing.statusCode, 400, "sourceRef required");

  // worker endpoints (service token)
  const noToken = await app.inject({ method: "GET", url: "/ingest/work" });
  assert.equal(noToken.statusCode, 401, "worker endpoint needs the ingest token");

  const ingestToken = env.LOCKSTEP_INGEST_TOKEN;
  if (ingestToken) {
    const wtok = { "x-lockstep-ingest-token": ingestToken };
    await app.inject({ method: "POST", url: `/ingest/connections/${connectionId}/finalize`, headers: wtok, payload: { connectedAccountId: "acct-1" } });
    const work = await app.inject({ method: "GET", url: "/ingest/work", headers: wtok });
    assert.equal(work.statusCode, 200);

    const filed = await app.inject({
      method: "POST",
      url: "/ingest/proposed-decisions",
      headers: wtok,
      payload: {
        items: [
          {
            orgId: s.orgId,
            projectId: s.projectId,
            scopeKind: "topic",
            scopeRef: "topic:api-test",
            ruleText: "API tests run via inject.",
            provenance: { source: "slack", evidence: [{ externalId: "z", quote: "use inject" }], decidedBy: ["@a"] },
            connectionId,
            externalId: "z",
            contentHash: "hz",
            confidence: 80,
          },
        ],
      },
    });
    assert.equal(filed.statusCode, 200);
    assert.equal(filed.json().filed, 1);

    await app.inject({ method: "POST", url: "/ingest/watermark", headers: wtok, payload: { orgId: s.orgId, connectionId, sourceRef: "C1", cursor: "5.0" } });

    // review queue → confirm
    const proposed = await app.inject({ method: "GET", url: `${base}/proposed`, headers: auth(s.token) });
    const decision = (proposed.json().decisions as Array<{ id: string; scopeRef: string }>).find((d) => d.scopeRef === "topic:api-test");
    assert.ok(decision, "proposed decision shows in the review queue");
    const confirmed = await app.inject({ method: "POST", url: `/orgs/${s.orgId}/decisions/${decision!.id}/confirm`, headers: auth(s.token), payload: {} });
    assert.equal(confirmed.statusCode, 200);
  }

  // graph derive + list
  const derived = await app.inject({ method: "POST", url: `${base}/graph/derive`, headers: auth(s.token), payload: {} });
  assert.equal(derived.statusCode, 200);
  const graph = await app.inject({ method: "GET", url: `${base}/graph`, headers: auth(s.token) });
  assert.ok((graph.json().nodes as unknown[]).length >= 1);
  const node = await app.inject({ method: "POST", url: `${base}/graph/nodes`, headers: auth(s.token), payload: { kind: "team", ref: "team:x" } });
  assert.equal(node.statusCode, 200);

  // search (with filters exercised)
  const search = await app.inject({ method: "GET", url: `${base}/decisions/search?q=api&status=binding&origin=ingested&from=2000-01-01&to=2100-01-01`, headers: auth(s.token) });
  assert.equal(search.statusCode, 200);
  assert.ok(Array.isArray(search.json().decisions));

  // validation + membership negative paths (branch coverage)
  const graphNodeBad = await app.inject({ method: "POST", url: `${base}/graph/nodes`, headers: auth(s.token), payload: {} });
  assert.equal(graphNodeBad.statusCode, 400);
  const graphEdgeBad = await app.inject({ method: "POST", url: `${base}/graph/edges`, headers: auth(s.token), payload: { fromId: "x" } });
  assert.equal(graphEdgeBad.statusCode, 400);
  const confirmForbidden = await app.inject({ method: "POST", url: `/orgs/${s.orgId}/decisions/${crypto.randomUUID()}/confirm`, headers: auth(s.outsiderToken), payload: {} });
  assert.equal(confirmForbidden.statusCode, 403);
  const rejectForbidden = await app.inject({ method: "POST", url: `/orgs/${s.orgId}/decisions/${crypto.randomUUID()}/reject`, headers: auth(s.outsiderToken), payload: {} });
  assert.equal(rejectForbidden.statusCode, 403);

  if (env.LOCKSTEP_INGEST_TOKEN) {
    const wtok = { "x-lockstep-ingest-token": env.LOCKSTEP_INGEST_TOKEN };
    const wmBad = await app.inject({ method: "POST", url: "/ingest/watermark", headers: wtok, payload: { orgId: s.orgId } });
    assert.equal(wmBad.statusCode, 400);
    const finBad = await app.inject({ method: "POST", url: `/ingest/connections/${connectionId}/finalize`, headers: wtok, payload: {} });
    assert.equal(finBad.statusCode, 400);
    const emptyItems = await app.inject({ method: "POST", url: "/ingest/proposed-decisions", headers: wtok, payload: { items: [] } });
    assert.equal(emptyItems.json().filed, 0);
  }
});

test("Phase J API: review tripwire route + staleness-decorated review queue + confirm edits", async () => {
  app = buildApp();
  const s = await setup();
  const base = `/orgs/${s.orgId}/projects/${s.projectId}`;

  // A binding decision to hang the tripwire on (impact 0 → binds on assertion).
  const bound = await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    scopeKind: "surface",
    scopeRef: "http:GET /pj/api-review",
    ruleText: "Compress responses above ten kilobytes.",
    baseVersion: 0,
  });

  // Set → snooze → clear, plus the validation and guard branches.
  const past = new Date(Date.now() - 86400000).toISOString();
  const set = await app.inject({ method: "POST", url: `/orgs/${s.orgId}/decisions/${bound.decisionId}/review`, headers: auth(s.token), payload: { reviewAt: past } });
  assert.equal(set.statusCode, 200);
  assert.ok(set.json().reviewAt);
  const clear = await app.inject({ method: "POST", url: `/orgs/${s.orgId}/decisions/${bound.decisionId}/review`, headers: auth(s.token), payload: { reviewAt: null } });
  assert.equal(clear.statusCode, 200);
  assert.equal(clear.json().reviewAt, null);
  const missing = await app.inject({ method: "POST", url: `/orgs/${s.orgId}/decisions/${bound.decisionId}/review`, headers: auth(s.token), payload: {} });
  assert.equal(missing.statusCode, 400, "reviewAt key is required (null clears)");
  const badDate = await app.inject({ method: "POST", url: `/orgs/${s.orgId}/decisions/${bound.decisionId}/review`, headers: auth(s.token), payload: { reviewAt: "not-a-date" } });
  assert.equal(badDate.statusCode, 400);
  const outsider = await app.inject({ method: "POST", url: `/orgs/${s.orgId}/decisions/${bound.decisionId}/review`, headers: auth(s.outsiderToken), payload: { reviewAt: past } });
  assert.equal(outsider.statusCode, 403);

  // A proposed (ingested) decision → the review queue decorates it with ageDays/stale.
  const filed = await fileProposedDecision(s.orgId, {
    projectId: s.projectId,
    scopeKind: "surface",
    scopeRef: "http:GET /pj/api-stale",
    ruleText: "Archive raw request logs after ninety days.",
    provenance: { source: "slack", evidence: [{ externalId: "x", quote: "q" }] },
    connectionId: randomUUID(),
    externalId: randomUUID(),
    contentHash: randomUUID(),
    confidence: 75,
    rationale: "Storage costs doubled last quarter.",
    alternatives: ["Keep forever", "Thirty-day retention"],
  });
  const q = await app.inject({ method: "GET", url: `${base}/proposed`, headers: auth(s.token) });
  assert.equal(q.statusCode, 200);
  const row = (q.json().decisions as Array<{ id: string; ageDays: number; stale: boolean; rationale: string; alternatives: string[] }>).find((d) => d.id === filed.decisionId);
  assert.ok(row, "the filed proposal is in the queue");
  assert.equal(row!.stale, false, "a fresh proposal is not stale under the 7-day default");
  assert.equal(row!.ageDays, 0);
  assert.equal(row!.rationale, "Storage costs doubled last quarter.");
  assert.deepEqual(row!.alternatives, ["Keep forever", "Thirty-day retention"]);

  // A proposal can't take a tripwire (only binding decisions can).
  const notBinding = await app.inject({ method: "POST", url: `/orgs/${s.orgId}/decisions/${filed.decisionId}/review`, headers: auth(s.token), payload: { reviewAt: past } });
  assert.equal(notBinding.statusCode, 409);

  // Confirm with Phase J edits: rationale + reviewAt flow through the route.
  const future = new Date(Date.now() + 30 * 86400000).toISOString();
  const confirmBad = await app.inject({ method: "POST", url: `/orgs/${s.orgId}/decisions/${filed.decisionId}/confirm`, headers: auth(s.token), payload: { reviewAt: "garbage" } });
  assert.equal(confirmBad.statusCode, 400);
  const confirmed = await app.inject({
    method: "POST",
    url: `/orgs/${s.orgId}/decisions/${filed.decisionId}/confirm`,
    headers: auth(s.token),
    payload: { rationale: "Compliance only needs ninety days.", reviewAt: future },
  });
  assert.equal(confirmed.statusCode, 200);
  const search = await app.inject({ method: "GET", url: `${base}/decisions/search?q=ninety`, headers: auth(s.token) });
  const found = (search.json().decisions as Array<{ id: string; rationale: string | null; reviewAt: string | null }>).find((d) => d.id === filed.decisionId);
  assert.ok(found);
  assert.equal(found!.rationale, "Compliance only needs ninety days.");
  assert.ok(found!.reviewAt);
});
