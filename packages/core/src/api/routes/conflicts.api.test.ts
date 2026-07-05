/**
 * HTTP coverage of the Phase C conflict routes: GET /conflicts (enriched rows) and
 * POST /conflicts/:id/resolve (holds | dismiss) with role gating + validation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { withSystem, withOrg } from "../../db/rls.js";
import { orgs, principals, members, projects, projectMembers, repos, decisions, conflicts } from "../../db/schema.js";
import { issueTokenTx } from "../../auth/tokens.js";
import { proposeDecision, ratifyDecision } from "../../ledger/ledger-service.js";
import { registerDocument, fileDocCandidates, setDocumentState } from "../../documents/document-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 320_000_000;
const uid = (): number => ++seq;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const PAGE = () => `00000000-0000-4000-8000-${uid().toString(16).padStart(12, "0")}`;
const SURFACE = "http:POST /payments/init";

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `ConfApi-${n}` }).returning());
    const pp = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `pm-${n}` }).returning());
    const pm = one(await tx.insert(members).values({ orgId: org.id, principalId: pp.id, githubUserId: pp.githubUserId, githubLogin: `pm-${n}` }).returning());
    const pe = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `eng-${n}` }).returning());
    const eng = one(await tx.insert(members).values({ orgId: org.id, principalId: pe.id, githubUserId: pe.githubUserId, githubLogin: `eng-${n}` }).returning());
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "acme", settings: { productLayer: { enabled: true } } }).returning());
    await tx.insert(projectMembers).values({ orgId: org.id, projectId: proj.id, memberId: pm.id, invitedGithubLogin: pm.githubLogin, role: "pm", status: "active" });
    await tx.insert(projectMembers).values({ orgId: org.id, projectId: proj.id, memberId: eng.id, invitedGithubLogin: eng.githubLogin, role: "member", status: "active" });
    await tx.insert(repos).values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/acme/auth-${n}` });
    return { orgId: org.id, projectId: proj.id, pm: pm.id, eng: eng.id, pmToken: await issueTokenTx(tx, pp.id), engToken: await issueTokenTx(tx, pe.id) };
  });
}

test("conflicts API: list enriched + resolve holds/dismiss with role gating", async (t) => {
  const app: FastifyInstance = buildApp();
  t.after(() => app.close());
  const s = await setup();
  const base = `/orgs/${s.orgId}/projects/${s.projectId}`;

  // Seed a binding constraint (active native doc) + an eng decision on the same surface → drift.
  const pageId = PAGE();
  const reg = await registerDocument(s.orgId, { projectId: s.projectId, memberId: s.pm, url: `https://notion.so/prd-${pageId}` });
  await setDocumentState(s.orgId, reg.documentId, s.pm, "active");
  await fileDocCandidates(reg.documentId, [
    {
      scopeKind: "surface", scopeRef: SURFACE, ruleText: "No OTP before payment.", constraintKind: "behavioral",
      expiresAt: null, expiresHint: "", lowConfidence: false, confidence: 90,
      externalId: `${pageId}#c2`, contentHash: "h-c2",
      anchor: { type: "notion_block", pageId, blockId: "c2", headingPath: ["Requirements"], snippet: "…" },
      evidence: [{ externalId: `${pageId}#c2`, quote: "…" }], rationale: "", surfaceCandidates: [],
    },
  ]);
  const constraint = one(await withOrg(s.orgId, (tx) => tx.select().from(decisions).where(and(eq(decisions.projectId, s.projectId), eq(decisions.origin, "document")))));
  await ratifyDecision(s.orgId, constraint.id, s.pm);
  await proposeDecision(s.orgId, { projectId: s.projectId, memberId: s.eng, scopeKind: "surface", scopeRef: SURFACE, ruleText: "OTP on all payment inits.", baseVersion: 0 });

  // GET /conflicts returns an enriched drift row with both rule texts.
  const list = await app.inject({ method: "GET", url: `${base}/conflicts?status=open`, headers: auth(s.pmToken) });
  assert.equal(list.statusCode, 200);
  const rows = (list.json() as { conflicts: Array<{ id: string; kind: string; constraintRuleText: string; engRuleText: string | null }> }).conflicts;
  const drift = rows.find((c) => c.kind === "drift");
  assert.ok(drift, "drift row present");
  assert.match(drift!.constraintRuleText, /No OTP/);
  assert.match(drift!.engRuleText ?? "", /OTP on all/);

  // Validation + gating.
  const bad = await app.inject({ method: "POST", url: `/orgs/${s.orgId}/conflicts/${drift!.id}/resolve`, headers: auth(s.pmToken), payload: { resolution: "nope" } });
  assert.equal(bad.statusCode, 400);
  const denied = await app.inject({ method: "POST", url: `/orgs/${s.orgId}/conflicts/${drift!.id}/resolve`, headers: auth(s.engToken), payload: { resolution: "holds" } });
  assert.equal(denied.statusCode, 403, "a plain member cannot resolve");

  const ok = await app.inject({ method: "POST", url: `/orgs/${s.orgId}/conflicts/${drift!.id}/resolve`, headers: auth(s.pmToken), payload: { resolution: "holds" } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().status, "resolved_eng_revised");
  const after = one(await withOrg(s.orgId, (tx) => tx.select().from(conflicts).where(eq(conflicts.id, drift!.id))));
  assert.equal(after.status, "resolved_eng_revised");

  // Back-compat dismiss alias still works (on a fresh conflict — re-resolving is 409).
  const reResolve = await app.inject({ method: "POST", url: `/orgs/${s.orgId}/conflicts/${drift!.id}/dismiss`, headers: auth(s.pmToken), payload: { reason: "x" } });
  assert.equal(reResolve.statusCode, 409, "already resolved");
});
