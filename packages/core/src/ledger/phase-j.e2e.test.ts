/**
 * Phase J — ADR/decision-quality primitives, service-layer against real Postgres (DATABASE_URL).
 * Deliberation fields (rationale/alternatives) round-trip and survive edits as appended versions;
 * supersession flips on every bind path (confirm, ack) with the supersededById link + audit; the
 * review tripwire (reviewAt) is a query-time flag plus a human-attributed mutation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { withSystem, withOrg } from "../db/rls.js";
import { orgs, principals, members, projects, repos, decisions, decisionVersions, auditEvents } from "../db/schema.js";
import {
  proposeDecision,
  fileProposedDecision,
  confirmDecision,
  ackDecision,
  rejectDecision,
  setDecisionReview,
  listDecisions,
  registerDependency,
} from "./ledger-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 700_000_000;
const uid = (): number => ++seq;

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `PJ-${n}` }).returning());
    const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `u-${n}` }).returning());
    const m = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `u-${n}` })
        .returning(),
    );
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "pj", createdBy: m.id }).returning());
    const repo = one(
      await tx
        .insert(repos)
        .values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/pj/r-${n}` })
        .returning(),
    );
    return { orgId: org.id, projectId: proj.id, memberId: m.id, repoId: repo.id };
  });
}

const fileIngested = (
  s: { orgId: string; projectId: string },
  scopeRef: string,
  ruleText: string,
  extra: Partial<Parameters<typeof fileProposedDecision>[1]> = {},
) =>
  fileProposedDecision(s.orgId, {
    projectId: s.projectId,
    scopeKind: "surface",
    scopeRef,
    ruleText,
    provenance: { source: "slack", evidence: [{ externalId: "x", quote: "q" }] },
    connectionId: randomUUID(),
    externalId: randomUUID(),
    contentHash: randomUUID(),
    confidence: 80,
    ...extra,
  });

const byId = async (orgId: string, id: string) =>
  one(await withOrg(orgId, (tx) => tx.select().from(decisions).where(eq(decisions.id, id))));

test("deliberation fields round-trip: propose → listDecisions carries rationale/alternatives/reviewAt", async () => {
  const s = await setup();
  const reviewAt = new Date(Date.now() + 30 * 86400000);
  const r = await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    scopeKind: "surface",
    scopeRef: "http:GET /pj/roundtrip",
    ruleText: "Cache lookups for five minutes.",
    baseVersion: 0,
    rationale: "Upstream rate-limits us at 60 rpm.",
    alternatives: ["No caching", "Redis with 1h TTL"],
    reviewAt,
  });
  assert.equal(r.status, "binding"); // impact 0 → binds on assertion
  const d = one((await listDecisions(s.orgId, s.projectId)).filter((x) => x.id === r.decisionId));
  assert.equal(d.rationale, "Upstream rate-limits us at 60 rpm.");
  assert.deepEqual(d.alternatives, ["No caching", "Redis with 1h TTL"]);
  assert.equal(d.reviewAt?.getTime(), reviewAt.getTime());
  assert.equal(d.dueForReview, false, "future reviewAt is not due");
  assert.ok(d.proposedAt instanceof Date);
});

test("review tripwire: past reviewAt on a binding decision → dueForReview; set/clear is guarded + audited", async () => {
  const s = await setup();
  const r = await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    scopeKind: "surface",
    scopeRef: "http:GET /pj/tripwire",
    ruleText: "Feature-flag the new parser.",
    baseVersion: 0,
  });
  await setDecisionReview(s.orgId, r.decisionId, s.memberId, new Date(Date.now() - 86400000));
  let d = one((await listDecisions(s.orgId, s.projectId)).filter((x) => x.id === r.decisionId));
  assert.equal(d.dueForReview, true, "past reviewAt on a binding decision is due");
  assert.equal(d.status, "binding", "due for review never unbinds");

  // Clear ("mark reviewed") → no longer due.
  await setDecisionReview(s.orgId, r.decisionId, s.memberId, null);
  d = one((await listDecisions(s.orgId, s.projectId)).filter((x) => x.id === r.decisionId));
  assert.equal(d.reviewAt, null);
  assert.equal(d.dueForReview, false);

  const audits = await withOrg(s.orgId, (tx) =>
    tx
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, r.decisionId), eq(auditEvents.action, "decision.review_updated"))),
  );
  assert.equal(audits.length, 2, "set + clear are both human-attributed audit events");
  assert.ok(audits.every((a) => a.actorMemberId === s.memberId));

  // Only binding decisions carry a tripwire.
  const prop = await fileIngested(s, "http:GET /pj/tripwire-proposed", "Batch writes nightly.");
  await assert.rejects(
    setDecisionReview(s.orgId, prop.decisionId, s.memberId, new Date()),
    /proposed, not binding/,
  );
});

test("confirm with edits appends a version carrying rationale/alternatives; reviewAt lands on the decision", async () => {
  const s = await setup();
  const filed = await fileIngested(s, "http:GET /pj/edit", "Retry failed jobs three times.", {
    rationale: "Transient S3 errors dominate the failure logs.",
    alternatives: ["Dead-letter immediately"],
  });
  const reviewAt = new Date(Date.now() + 14 * 86400000);
  const r = await confirmDecision(s.orgId, filed.decisionId, s.memberId, {
    rationale: "Transient S3 errors dominate; three retries clears 99% of them.",
    reviewAt,
  });
  assert.equal(r.status, "binding");
  const versions = await withOrg(s.orgId, (tx) =>
    tx.select().from(decisionVersions).where(eq(decisionVersions.decisionId, filed.decisionId)),
  );
  assert.equal(versions.length, 2, "a rationale edit appends a version (append-only)");
  const v2 = one(versions.filter((v) => v.version === 2));
  assert.equal(v2.rationale, "Transient S3 errors dominate; three retries clears 99% of them.");
  assert.deepEqual(v2.alternatives, ["Dead-letter immediately"], "unedited alternatives carry forward");
  const d = await byId(s.orgId, filed.decisionId);
  assert.equal(d.reviewAt?.getTime(), reviewAt.getTime());
});

test("supersession flips on confirm: old binding decision → superseded + supersededById + lineage + audit", async () => {
  const s = await setup();
  const scopeRef = "http:POST /pj/supersede-confirm";
  const old = await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    scopeKind: "surface",
    scopeRef,
    ruleText: "Sessions expire after thirty days.",
    baseVersion: 0,
  });
  assert.equal(old.status, "binding");
  // Different rule, same scope, low lexical overlap → the funnel files it with a supersedes hint.
  const filed = await fileIngested(s, scopeRef, "Require multi-factor login on every device change.");
  assert.equal(filed.supersedes, old.decisionId, "scope scan hinted the prior binding decision");

  await confirmDecision(s.orgId, filed.decisionId, s.memberId);
  const oldRow = await byId(s.orgId, old.decisionId);
  assert.equal(oldRow.status, "superseded");
  assert.equal(oldRow.supersededById, filed.decisionId);

  const list = await listDecisions(s.orgId, s.projectId);
  const newer = one(list.filter((d) => d.id === filed.decisionId));
  assert.deepEqual(newer.supersedes, [old.decisionId], "reverse lineage on the superseding decision");
  const older = one(list.filter((d) => d.id === old.decisionId));
  assert.equal(older.supersededById, filed.decisionId);

  const audit = await withOrg(s.orgId, (tx) =>
    tx
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, old.decisionId), eq(auditEvents.action, "decision.superseded"))),
  );
  assert.equal(audit.length, 1);

  // Idempotency: confirming again is guarded (status is no longer proposed), and the flip's CAS
  // predicate (status='binding') means a re-run flips nothing.
  await assert.rejects(confirmDecision(s.orgId, filed.decisionId, s.memberId), /not proposed/);
  assert.equal((await byId(s.orgId, old.decisionId)).status, "superseded");
});

test("supersession flips on ack (cross-cutting confirm lands open, binds on ack)", async () => {
  const s = await setup();
  const scopeRef = "http:POST /pj/supersede-ack";
  // Give the surface a consumer so decisions on it are cross-cutting (impact > 0).
  await registerDependency(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    consumerRepoId: s.repoId,
    producedSurface: scopeRef,
  });
  const old = await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    scopeKind: "surface",
    scopeRef,
    ruleText: "Paginate responses at one hundred rows.",
    baseVersion: 0,
  });
  assert.equal(old.status, "open");
  await ackDecision(s.orgId, old.decisionId, old.version, s.memberId);
  assert.equal((await byId(s.orgId, old.decisionId)).status, "binding");

  const filed = await fileIngested(s, scopeRef, "Stream results over websockets instead.");
  assert.equal(filed.supersedes, old.decisionId);
  const confirmed = await confirmDecision(s.orgId, filed.decisionId, s.memberId);
  assert.equal(confirmed.status, "open", "cross-cutting confirm awaits an ack");
  assert.equal((await byId(s.orgId, old.decisionId)).status, "binding", "no flip before the new decision binds");

  const filedRow = await byId(s.orgId, filed.decisionId);
  await ackDecision(s.orgId, filed.decisionId, filedRow.currentVersion, s.memberId);
  const oldRow = await byId(s.orgId, old.decisionId);
  assert.equal(oldRow.status, "superseded", "binding on ack flips the hinted decision");
  assert.equal(oldRow.supersededById, filed.decisionId);
});

test("rejecting a hinted proposal leaves its target untouched", async () => {
  const s = await setup();
  const scopeRef = "http:POST /pj/supersede-reject";
  const old = await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    scopeKind: "surface",
    scopeRef,
    ruleText: "Encrypt exports with the org key.",
    baseVersion: 0,
  });
  const filed = await fileIngested(s, scopeRef, "Ship raw dumps to the analytics bucket nightly.");
  assert.equal(filed.supersedes, old.decisionId);
  await rejectDecision(s.orgId, filed.decisionId, s.memberId);
  const oldRow = await byId(s.orgId, old.decisionId);
  assert.equal(oldRow.status, "binding", "flip only happens at bind — a rejected proposal never fires it");
  assert.equal(oldRow.supersededById, null);
});

test("ingested deliberation fields land as first-class columns", async () => {
  const s = await setup();
  const filed = await fileIngested(s, "http:GET /pj/ingested-fields", "Index the events table by tenant.", {
    rationale: "Tenant-scoped queries do full scans today.",
    alternatives: ["Partition by month"],
    reviewAt: new Date(Date.now() + 7 * 86400000),
  });
  const d = one((await listDecisions(s.orgId, s.projectId)).filter((x) => x.id === filed.decisionId));
  assert.equal(d.rationale, "Tenant-scoped queries do full scans today.");
  assert.deepEqual(d.alternatives, ["Partition by month"]);
  assert.ok(d.reviewAt);
});
