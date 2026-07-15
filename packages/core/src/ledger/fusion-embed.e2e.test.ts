/**
 * #6 embedding fusion/supersession, service-layer against real Postgres (DATABASE_URL) with an
 * INJECTED fake embedder — no network, no key. The contract under test: paraphrases fuse where
 * Jaccard would not; a null embedder is byte-identical to the pre-#6 Jaccard behavior; the cache is
 * lazy + version-stamped; audits record {method, score}; deduped resends never call the embedder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withSystem, withOrg } from "../db/rls.js";
import { orgs, principals, members, projects, decisions, decisionEmbeddings, ingestArtifacts, auditEvents } from "../db/schema.js";
import { fileProposedDecision, confirmDecision } from "./ledger-service.js";
import { cosine, embedTexts, type Embedder } from "./embeddings.js";

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
    const org = one(await tx.insert(orgs).values({ name: `Emb-${n}` }).returning());
    const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `u-${n}` }).returning());
    const m = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `u-${n}` })
        .returning(),
    );
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "emb", createdBy: m.id }).returning());
    return { orgId: org.id, projectId: proj.id, memberId: m.id };
  });
}

/**
 * A deterministic fake embedder: rules mentioning "jwt" (however phrased) share one direction,
 * everything else gets an orthogonal one — so paraphrase pairs score cosine ~1 while Jaccard ~0.
 */
const byTopic: Embedder = async (texts) =>
  texts.map((t) => (/jwt|json web token/i.test(t) ? [1, 0, 0] : [0, 1, 0]));

const fileWith = (
  s: { orgId: string; projectId: string },
  ruleText: string,
  embedder: Embedder | undefined,
  extra: Partial<Parameters<typeof fileProposedDecision>[1]> = {},
) =>
  fileProposedDecision(
    s.orgId,
    {
      projectId: s.projectId,
      scopeKind: "surface",
      scopeRef: "http:POST /emb/auth",
      ruleText,
      provenance: { source: "slack", evidence: [{ externalId: "x", quote: "q" }] },
      connectionId: randomUUID(),
      externalId: randomUUID(),
      contentHash: randomUUID(),
      confidence: 80,
      ...extra,
    },
    embedder,
  );

test("cosine: unit behavior", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([], []), 0);
  assert.equal(cosine([1], [1, 2]), 0, "length mismatch scores 0, never throws");
});

test("embedTexts returns null without a key (the wholesale-Jaccard cheap-out)", async () => {
  assert.equal(process.env.VOYAGE_API_KEY, undefined, "test env must not carry a key");
  assert.equal(await embedTexts(["anything"]), null);
});

test("a paraphrase fuses via embeddings where Jaccard would file a duplicate", async () => {
  const s = await setup();
  const first = await fileWith(s, "Auth tokens are JWT with 15-minute expiry.", byTopic);
  // Same decision, zero content-word overlap ("JSON Web Token" vs "JWT", "quarter hour" vs "15-minute").
  const second = await fileWith(s, "Use JSON Web Tokens that lapse after a quarter hour.", byTopic);
  assert.equal(second.fused, true, "cosine ≥ EMBED_FUSE_MIN fuses the paraphrase");
  assert.equal(second.decisionId, first.decisionId);
  const audit = await withOrg(s.orgId, (tx) =>
    tx
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, first.decisionId), eq(auditEvents.action, "decision.provenance_added"))),
  );
  const payload = one(audit).payload as { similarity?: { method: string; score: number } };
  assert.equal(payload.similarity?.method, "embedding");
  assert.ok(payload.similarity!.score >= 0.85);

  // Sanity: the same pair WITHOUT an embedder mints a separate decision (Jaccard can't see it).
  const s2 = await setup();
  const a = await fileWith(s2, "Auth tokens are JWT with 15-minute expiry.", undefined);
  const b = await fileWith(s2, "Use JSON Web Tokens that lapse after a quarter hour.", undefined);
  assert.equal(b.fused, false);
  assert.notEqual(a.decisionId, b.decisionId);
});

test("embedding supersession hint records method+score; lazy cache heals after a version bump", async () => {
  const s = await setup();
  const first = await fileWith(s, "Auth tokens are JWT with 15-minute expiry.", byTopic);
  await confirmDecision(s.orgId, first.decisionId, s.memberId); // impact 0 → binding

  // Orthogonal topic on the same scope → cosine 0 < EMBED_SUPERSEDE_MAX → supersedes hint.
  const second = await fileWith(s, "Rate-limit login attempts to five per minute.", byTopic);
  assert.equal(second.supersedes, first.decisionId);

  const cacheRows = await withOrg(s.orgId, (tx) =>
    tx.select().from(decisionEmbeddings).where(eq(decisionEmbeddings.decisionId, first.decisionId)),
  );
  assert.equal(cacheRows.length, 1, "the scope scan lazily populated the mate's cache");
  const d = await withOrg(s.orgId, async (tx) =>
    one(await tx.select().from(decisions).where(eq(decisions.id, first.decisionId))),
  );
  assert.equal(cacheRows[0]!.version, d.currentVersion, "cache is stamped with the compared version");
});

test("a deduped resend short-circuits before any embedding call", async () => {
  const s = await setup();
  let calls = 0;
  const counting: Embedder = async (texts) => {
    calls++;
    return byTopic(texts);
  };
  const dedupe = { connectionId: randomUUID(), externalId: randomUUID(), contentHash: randomUUID() };
  const first = await fileWith(s, "Auth tokens are JWT.", counting, dedupe);
  const callsAfterFirst = calls;
  const again = await fileWith(s, "Auth tokens are JWT.", counting, dedupe);
  assert.equal(again.deduped, true);
  assert.equal(again.decisionId, first.decisionId);
  assert.equal(calls, callsAfterFirst, "the re-seen unit never reaches the embedder");
});

test("embedder outage (null) mid-flight degrades to Jaccard, not an error", async () => {
  const s = await setup();
  const broken: Embedder = async () => null;
  const a = await fileWith(s, "Auth tokens are JWT with 15-minute expiry.", broken);
  const b = await fileWith(s, "Auth tokens are JWT with 15-minute expiry lock it in.", broken);
  assert.equal(b.fused, true, "high Jaccard overlap still fuses on the fallback path");
  assert.equal(b.decisionId, a.decisionId);
  const artifact = await withOrg(s.orgId, (tx) =>
    tx.select().from(ingestArtifacts).where(eq(ingestArtifacts.decisionId, a.decisionId)),
  );
  assert.ok(artifact.length >= 2);
});
