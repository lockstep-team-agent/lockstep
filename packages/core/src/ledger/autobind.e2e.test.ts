/**
 * Auto-bind (#8, opt-in / default OFF). fileProposedDecision auto-binds an ingested rule only when the
 * project opted in AND impact is 0 (own-area) AND confidence >= floor AND it isn't a document constraint.
 * Runs against a real Postgres (DATABASE_URL).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withSystem } from "../db/rls.js";
import { orgs, principals, members, projects, repos, decisions } from "../db/schema.js";
import { fileProposedDecision, registerDependency } from "./ledger-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 500_000_000;
const uid = (): number => ++seq;

async function setup(settings: object) {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(
      await tx
        .insert(orgs)
        .values({ name: `AB-${n}` })
        .returning(),
    );
    const p = one(
      await tx
        .insert(principals)
        .values({ githubUserId: uid(), githubLogin: `u-${n}` })
        .returning(),
    );
    const m = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `u-${n}` })
        .returning(),
    );
    const proj = one(
      await tx.insert(projects).values({ orgId: org.id, name: "ab", createdBy: m.id, settings }).returning(),
    );
    const consumer = one(
      await tx
        .insert(repos)
        .values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/ab/c-${n}` })
        .returning(),
    );
    return { orgId: org.id, projectId: proj.id, memberId: m.id, consumerRepo: consumer.id };
  });
}

async function statusOf(orgId: string, projectId: string, scopeRef: string): Promise<string> {
  return withSystem(async (tx) => {
    const d = (
      await tx
        .select()
        .from(decisions)
        .where(and(eq(decisions.projectId, projectId), eq(decisions.scopeRef, scopeRef)))
        .limit(1)
    )[0];
    return d?.status ?? "(none)";
  });
}

const file = (orgId: string, projectId: string, scopeRef: string, confidence: number, origin?: string) =>
  fileProposedDecision(orgId, {
    projectId,
    scopeKind: "surface",
    scopeRef,
    ruleText: `rule for ${scopeRef}`,
    origin,
    provenance: { source: "slack", evidence: [{ externalId: "x", quote: "q" }] },
    connectionId: randomUUID(),
    externalId: randomUUID(),
    contentHash: randomUUID(),
    confidence,
  });

test("auto-bind OFF (default) → proposed even at high confidence", async () => {
  const s = await setup({});
  await file(s.orgId, s.projectId, "http:GET /ab/off", 99);
  assert.equal(await statusOf(s.orgId, s.projectId, "http:GET /ab/off"), "proposed");
});

test("auto-bind ON + impact 0 + confidence >= floor → binding", async () => {
  const s = await setup({ autoBind: { enabled: true, floor: 80 } });
  await file(s.orgId, s.projectId, "http:GET /ab/on", 90);
  assert.equal(await statusOf(s.orgId, s.projectId, "http:GET /ab/on"), "binding");
});

test("auto-bind ON but confidence < floor → proposed", async () => {
  const s = await setup({ autoBind: { enabled: true, floor: 80 } });
  await file(s.orgId, s.projectId, "http:GET /ab/lowconf", 50);
  assert.equal(await statusOf(s.orgId, s.projectId, "http:GET /ab/lowconf"), "proposed");
});

test("auto-bind ON but impact > 0 (has a consumer) → proposed", async () => {
  const s = await setup({ autoBind: { enabled: true, floor: 80 } });
  const surface = "http:GET /ab/shared";
  await registerDependency(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    consumerRepoId: s.consumerRepo,
    producedSurface: surface,
  });
  await file(s.orgId, s.projectId, surface, 95);
  assert.equal(await statusOf(s.orgId, s.projectId, surface), "proposed");
});

test("document constraints never auto-bind", async () => {
  const s = await setup({ autoBind: { enabled: true, floor: 80 } });
  await file(s.orgId, s.projectId, "http:GET /ab/doc", 99, "document");
  assert.equal(await statusOf(s.orgId, s.projectId, "http:GET /ab/doc"), "proposed");
});

test("auto-bind is a bind: a hinted prior decision flips to superseded (Phase J)", async () => {
  const s = await setup({ autoBind: { enabled: true, floor: 80 } });
  const scopeRef = "http:GET /ab/supersede";
  const first = await fileProposedDecision(s.orgId, {
    projectId: s.projectId,
    scopeKind: "surface",
    scopeRef,
    ruleText: "Serve cached weather snapshots hourly.",
    provenance: { source: "slack", evidence: [{ externalId: "x", quote: "q" }] },
    connectionId: randomUUID(),
    externalId: randomUUID(),
    contentHash: randomUUID(),
    confidence: 95,
  });
  assert.equal(await statusOf(s.orgId, s.projectId, scopeRef), "binding");

  // Same scope, lexically unrelated rule → supersedes hint; auto-bind fires the flip immediately.
  const second = await fileProposedDecision(s.orgId, {
    projectId: s.projectId,
    scopeKind: "surface",
    scopeRef,
    ruleText: "Proxy live radar imagery straight from the upstream provider.",
    provenance: { source: "slack", evidence: [{ externalId: "y", quote: "q2" }] },
    connectionId: randomUUID(),
    externalId: randomUUID(),
    contentHash: randomUUID(),
    confidence: 95,
  });
  assert.equal(second.supersedes, first.decisionId);
  const old = await withSystem(async (tx) =>
    one(await tx.select().from(decisions).where(eq(decisions.id, first.decisionId))),
  );
  assert.equal(old.status, "superseded");
  assert.equal(old.supersededById, second.decisionId);
});
