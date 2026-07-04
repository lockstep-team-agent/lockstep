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
import { orgs, principals, members, projects } from "../../db/schema.js";
import { issueTokenTx } from "../../auth/tokens.js";

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
    await tx.insert(members).values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `m-${n}` });
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "api" }).returning());
    const token = await issueTokenTx(tx, p.id);
    // an outsider principal — has a token but is NOT a member of the org
    const outsider = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `o-${n}` }).returning());
    const outsiderToken = await issueTokenTx(tx, outsider.id);
    return { orgId: org.id, projectId: proj.id, token, outsiderToken };
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
