/**
 * HTTP-level coverage of the v3 document routes via inject() — feature-flag gate, membership and
 * role gates, native registration → ratification over HTTP, state mappings, counts, and the
 * worker endpoints (success assertions only when LOCKSTEP_INGEST_TOKEN is set, matching
 * ingest.api.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { env } from "../../env.js";
import { withSystem } from "../../db/rls.js";
import { orgs, principals, members, projects, projectMembers, sourceConnections, ingestAllowlist } from "../../db/schema.js";
import { issueTokenTx } from "../../auth/tokens.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 850_000_000;
const uid = (): number => ++seq;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const PAGE = () => `00000000-0000-4000-8000-${uid().toString(16).padStart(12, "0")}`;

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `DocApiCo-${n}` }).returning());
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "docapi" }).returning());
    const mk = async (login: string, role: string | null) => {
      const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `${login}-${n}` }).returning());
      const m = one(
        await tx
          .insert(members)
          .values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `${login}-${n}` })
          .returning(),
      );
      if (role) {
        await tx.insert(projectMembers).values({
          orgId: org.id,
          projectId: proj.id,
          memberId: m.id,
          invitedGithubLogin: m.githubLogin,
          role,
          status: "active",
        });
      }
      return { memberId: m.id, token: await issueTokenTx(tx, p.id) };
    };
    const owner = await mk("owner", "owner");
    const pm = await mk("pm", "pm");
    const plain = await mk("plain", "member");
    const conn = one(
      await tx
        .insert(sourceConnections)
        .values({ orgId: org.id, projectId: proj.id, tool: "notion", entity: proj.id, connectedAccountId: `ca-${n}`, status: "active" })
        .returning(),
    );
    await tx.insert(ingestAllowlist).values({
      orgId: org.id,
      projectId: proj.id,
      connectionId: conn.id,
      sourceKind: "database",
      sourceRef: `db-${n}`,
      sourceName: "PRDs",
    });
    return { orgId: org.id, projectId: proj.id, owner, pm, plain, connectionId: conn.id, containerRef: `db-${n}` };
  });
}

test("documents API: flag gate → settings → register → ratify → mappings → counts → roles", async (t) => {
  const app: FastifyInstance = buildApp();
  t.after(() => app.close());
  const s = await setup();
  const base = `/orgs/${s.orgId}/projects/${s.projectId}`;

  // Feature flag off ⇒ 403 feature_disabled; a non-owner cannot flip it.
  const gated = await app.inject({ method: "GET", url: `${base}/documents`, headers: auth(s.pm.token) });
  assert.equal(gated.statusCode, 403);
  assert.equal(gated.json().error, "feature_disabled");
  const denied = await app.inject({
    method: "POST",
    url: `${base}/settings`,
    headers: auth(s.pm.token),
    payload: { productLayer: { enabled: true } },
  });
  assert.equal(denied.statusCode, 403, "only owners flip flags");
  const flipped = await app.inject({
    method: "POST",
    url: `${base}/settings`,
    headers: auth(s.owner.token),
    payload: { productLayer: { enabled: true } },
  });
  assert.equal(flipped.statusCode, 200);

  // Register a native doc by URL (PM registers ⇒ PM is the registrant).
  const pageId = PAGE();
  const reg = await app.inject({
    method: "POST",
    url: `${base}/documents`,
    headers: auth(s.pm.token),
    payload: { url: `https://notion.so/prd-${pageId}` },
  });
  assert.equal(reg.statusCode, 200);
  const docId = reg.json().documentId as string;
  assert.equal(reg.json().state, "review");

  const list = await app.inject({ method: "GET", url: `${base}/documents`, headers: auth(s.pm.token) });
  assert.equal(list.statusCode, 200);
  assert.equal((list.json().documents as unknown[]).length, 1);

  // Worker endpoints: 401 without token; full candidate filing when the token is configured.
  const noToken = await app.inject({ method: "GET", url: "/internal/documents/work" });
  assert.equal(noToken.statusCode, 401);
  if (env.LOCKSTEP_INGEST_TOKEN) {
    const w = { "x-lockstep-ingest-token": env.LOCKSTEP_INGEST_TOKEN };
    const work = await app.inject({ method: "GET", url: "/internal/documents/work", headers: w });
    assert.equal(work.statusCode, 200);
    assert.ok((work.json().work as Array<{ connectionId: string }>).some((x) => x.connectionId === s.connectionId));
    const filed = await app.inject({
      method: "POST",
      url: `/internal/documents/${docId}/candidates`,
      headers: w,
      payload: {
        docContentHash: "dch-1",
        items: [
          {
            scopeKind: "capability",
            scopeRef: "feature:api-test",
            ruleText: "Guests must be able to check out without an account.",
            constraintKind: "behavioral",
            expiresAt: null,
            expiresHint: "",
            lowConfidence: false,
            confidence: 92,
            externalId: `${pageId}#b1`,
            contentHash: "sec-1",
            anchor: { type: "notion_block", pageId, blockId: "b1", headingPath: ["Requirements"], snippet: "without an account" },
            evidence: [{ externalId: `${pageId}#b1`, quote: "Guests must be able to check out without an account." }],
            rationale: "",
          },
        ],
      },
    });
    assert.equal(filed.statusCode, 200);
    assert.equal(filed.json().filed, 1);

    // Ratifications queue over HTTP: locked until active, then PM ratifies; plain member 403.
    let rats = await app.inject({ method: "GET", url: `${base}/ratifications`, headers: auth(s.pm.token) });
    assert.equal(rats.statusCode, 200);
    const cand = (rats.json().candidates as Array<{ id: string; canRatify: boolean; blockedReason: string }>)[0]!;
    assert.equal(cand.canRatify, false);
    assert.equal(cand.blockedReason, "Document not yet active");

    // §15: a plain member (not registrant, doc owner, or owner/pm) cannot change doc state.
    const plainState = await app.inject({
      method: "POST",
      url: `${base}/documents/${docId}/state`,
      headers: auth(s.plain.token),
      payload: { state: "active" },
    });
    assert.equal(plainState.statusCode, 403, "member role cannot change doc state (§15)");

    const activate = await app.inject({
      method: "POST",
      url: `${base}/documents/${docId}/state`,
      headers: auth(s.pm.token),
      payload: { state: "active" },
    });
    assert.equal(activate.statusCode, 200);

    const asPlain = await app.inject({
      method: "POST",
      url: `/orgs/${s.orgId}/decisions/${cand.id}/ratify`,
      headers: auth(s.plain.token),
      payload: {},
    });
    assert.equal(asPlain.statusCode, 403, "member role cannot ratify");
    const ratified = await app.inject({
      method: "POST",
      url: `/orgs/${s.orgId}/decisions/${cand.id}/ratify`,
      headers: auth(s.pm.token),
      payload: {},
    });
    assert.equal(ratified.statusCode, 200);
    assert.equal(ratified.json().status, "binding");

    // Doc detail reflects the binding constraint + anchor.
    const detail = await app.inject({ method: "GET", url: `${base}/documents/${docId}`, headers: auth(s.pm.token) });
    const constraints = detail.json().constraints as Array<{ status: string }>;
    assert.equal(constraints[0]!.status, "binding");

    const pending = await app.inject({ method: "GET", url: "/internal/writebacks/pending", headers: w });
    assert.equal(pending.statusCode, 200);
  }

  // State mappings CRUD.
  const setProp = await app.inject({
    method: "POST",
    url: `${base}/connections/${s.connectionId}/state-mappings/property`,
    headers: auth(s.owner.token),
    payload: { containerRef: s.containerRef, statusProperty: "Status" },
  });
  assert.equal(setProp.statusCode, 200);
  const setMap = await app.inject({
    method: "POST",
    url: `${base}/connections/${s.connectionId}/state-mappings`,
    headers: auth(s.owner.token),
    payload: { containerRef: s.containerRef, sourceValue: "In review", canonicalState: "review" },
  });
  assert.equal(setMap.statusCode, 200);
  const badMap = await app.inject({
    method: "POST",
    url: `${base}/connections/${s.connectionId}/state-mappings`,
    headers: auth(s.owner.token),
    payload: { containerRef: s.containerRef, sourceValue: "X", canonicalState: "not-a-state" },
  });
  assert.equal(badMap.statusCode, 400);
  const mappings = await app.inject({
    method: "GET",
    url: `${base}/connections/${s.connectionId}/state-mappings`,
    headers: auth(s.owner.token),
  });
  const container = (mappings.json().containers as Array<{ containerRef: string; statusProperty: string; mappings: unknown[] }>).find(
    (c) => c.containerRef === s.containerRef,
  )!;
  assert.equal(container.statusProperty, "Status");
  assert.equal(container.mappings.length, 1);

  // Counts + conflicts list respond.
  const counts = await app.inject({ method: "GET", url: `${base}/counts`, headers: auth(s.pm.token) });
  assert.equal(counts.statusCode, 200);
  assert.ok(counts.json().review);
  const conflicts = await app.inject({ method: "GET", url: `${base}/conflicts?status=open`, headers: auth(s.pm.token) });
  assert.equal(conflicts.statusCode, 200);

  // Role changes: only owners.
  const pmRow = await withSystem(async (tx) =>
    one(
      (await tx.select().from(projectMembers).where(eq(projectMembers.projectId, s.projectId))).filter(
        (r) => r.memberId === s.plain.memberId,
      ),
    ),
  );
  const roleDenied = await app.inject({
    method: "POST",
    url: `${base}/members/${pmRow.id}/role`,
    headers: auth(s.pm.token),
    payload: { role: "pm" },
  });
  assert.equal(roleDenied.statusCode, 403);
  const roleOk = await app.inject({
    method: "POST",
    url: `${base}/members/${pmRow.id}/role`,
    headers: auth(s.owner.token),
    payload: { role: "pm" },
  });
  assert.equal(roleOk.statusCode, 200);
  const badRole = await app.inject({
    method: "POST",
    url: `${base}/members/${pmRow.id}/role`,
    headers: auth(s.owner.token),
    payload: { role: "queen" },
  });
  assert.equal(badRole.statusCode, 400);
});
