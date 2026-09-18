/**
 * Jev relation verdicts in the fusion/supersession scan, service-layer against real Postgres
 * (DATABASE_URL) with an INJECTED fake judge — no network, no key. The contract under test: a
 * confident same_rule fuses where Jaccard would not; a confident replaces hints supersession where
 * Jaccard would not; a confident unrelated keeps two decisions apart where Jaccard would fuse; a
 * low-confidence verdict abstains (lexical path decides); a null judge is byte-identical to before.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withSystem, withOrg } from "../db/rls.js";
import { orgs, principals, members, projects, auditEvents } from "../db/schema.js";
import { fileProposedDecision, confirmDecision } from "./ledger-service.js";
import { JEV_RELATION_MIN_CONF, judgeWithJev, type ScopeJudge, type Relation } from "./jev.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 960_000_000;
const uid = (): number => ++seq;

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `Jev-${n}` }).returning());
    const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `u-${n}` }).returning());
    const m = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `u-${n}` })
        .returning(),
    );
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "jev", createdBy: m.id }).returning());
    return { orgId: org.id, projectId: proj.id, memberId: m.id };
  });
}

/** Fake judge: the same verdict for every mate — no network. */
const judge =
  (relation: Relation, confidence: number): ScopeJudge =>
  async (_newRule, mates) =>
    new Map(mates.map((m) => [m.id, { relation, confidence }]));

const fileWith = (s: { orgId: string; projectId: string }, ruleText: string, j: ScopeJudge | undefined) =>
  fileProposedDecision(
    s.orgId,
    {
      projectId: s.projectId,
      scopeKind: "surface",
      scopeRef: "http:POST /jev/auth",
      ruleText,
      provenance: { source: "slack", evidence: [{ externalId: "x", quote: "q" }] },
      connectionId: randomUUID(),
      externalId: randomUUID(),
      contentHash: randomUUID(),
      confidence: 80,
    },
    undefined,
    j,
  );

test("judgeWithJev returns null without a key (wholesale fall-through)", async () => {
  assert.equal(process.env.TYPESAFE_API_KEY, undefined, "test env must not carry a key");
  assert.equal(await judgeWithJev("a", [{ id: "1", ruleText: "b" }]), null);
});

test("same_rule at high confidence fuses a zero-overlap paraphrase; audit records method=jev", async () => {
  const s = await setup();
  const first = await fileWith(s, "Auth tokens are JWT with 15-minute expiry.", judge("unrelated", 1));
  const second = await fileWith(s, "Use JSON Web Tokens that lapse after a quarter hour.", judge("same_rule", 0.99));
  assert.equal(second.fused, true);
  assert.equal(second.decisionId, first.decisionId);
  const audit = await withOrg(s.orgId, (tx) =>
    tx
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, first.decisionId), eq(auditEvents.action, "decision.provenance_added"))),
  );
  const payload = one(audit).payload as { similarity?: { method: string; score: number } };
  assert.equal(payload.similarity?.method, "jev");
  assert.equal(payload.similarity?.score, 0.99);
});

test("replaces on a binding mate yields a supersedes hint even when Jaccard overlap is high", async () => {
  const s = await setup();
  const first = await fileWith(s, "Auth tokens are JWT with 15-minute expiry.", judge("unrelated", 1));
  await confirmDecision(s.orgId, first.decisionId, s.memberId); // impact 0 → binding
  // Jaccard between these two is above 0.4 (shared: auth, tokens, jwt, expiry), so the lexical path
  // would NOT hint supersession. Jev sees the flip.
  const second = await fileWith(s, "Auth tokens are opaque; JWT expiry rules no longer apply.", judge("replaces", 0.97));
  assert.equal(second.fused, false);
  assert.equal(second.supersedes, first.decisionId);
});

test("unrelated at high confidence files a separate decision even when Jaccard would fuse", async () => {
  const s = await setup();
  const first = await fileWith(s, "Auth tokens are JWT with 15-minute expiry.", judge("unrelated", 1));
  const second = await fileWith(s, "Auth refresh tokens are JWT with 15-day expiry.", judge("unrelated", 0.95));
  assert.equal(second.fused, false);
  assert.notEqual(second.decisionId, first.decisionId);
});

test("a low-confidence verdict falls through to the lexical path (same rule text ⇒ Jaccard fuses)", async () => {
  assert.equal(JEV_RELATION_MIN_CONF, 0.8);
  const s = await setup();
  const first = await fileWith(s, "Auth tokens are JWT with 15-minute expiry.", judge("unrelated", 1));
  const second = await fileWith(s, "Auth tokens are JWT with 15-minute expiry.", judge("unrelated", 0.5));
  assert.equal(second.fused, true, "Jev abstained (conf < 0.8); Jaccard 1.0 fused it");
  assert.equal(second.decisionId, first.decisionId);
});

test("a null judge is byte-identical to the pre-Jev behavior", async () => {
  const s = await setup();
  const nullJudge: ScopeJudge = async () => null;
  const a = await fileWith(s, "Auth tokens are JWT with 15-minute expiry.", nullJudge);
  const b = await fileWith(s, "Use JSON Web Tokens that lapse after a quarter hour.", nullJudge);
  assert.equal(b.fused, false, "Jaccard cannot see the paraphrase");
  assert.notEqual(a.decisionId, b.decisionId);
});
