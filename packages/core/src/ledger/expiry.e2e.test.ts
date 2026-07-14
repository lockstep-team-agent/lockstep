/**
 * v3 Phase E — the expiry job (FR-CORE-11) + the weekly operator digest, service-layer against real
 * Postgres (DATABASE_URL). A dated launch gate flips binding → expired past its window and retires its
 * conflicts; the weekly digest enqueues one Slack writeback per owner/pm, idempotent per ISO week.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { withSystem, withOrg } from "../db/rls.js";
import { orgs, principals, members, projects, projectMembers, repos, decisions, conflicts, writebacks } from "../db/schema.js";
import { registerDocument, setDocumentState, fileDocCandidates, type DocCandidateItem } from "../documents/document-service.js";
import { randomUUID } from "node:crypto";
import { ratifyDecision, proposeDecision, fileProposedDecision, setDecisionReview } from "./ledger-service.js";
import { expireConstraints } from "./expiry-job.js";
import { enqueueWeeklyDigests, isoWeek } from "../documents/weekly-digest.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 500_000_000;
const uid = (): number => ++seq;
const PAGE = () => `00000000-0000-4000-8000-${uid().toString(16).padStart(12, "0")}`;
const SURFACE = "http:POST /payments/init";

async function setup(settings: object = { productLayer: { enabled: true } }) {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `ExpCo-${n}` }).returning());
    const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `pm-${n}` }).returning());
    const pm = one(await tx.insert(members).values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `pm-${n}`, slackUserId: `U${n}PM` }).returning());
    const pe = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `eng-${n}` }).returning());
    const eng = one(await tx.insert(members).values({ orgId: org.id, principalId: pe.id, githubUserId: pe.githubUserId, githubLogin: `eng-${n}` }).returning());
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "acme", createdBy: pm.id, settings }).returning());
    await tx.insert(projectMembers).values({ orgId: org.id, projectId: proj.id, memberId: pm.id, invitedGithubLogin: pm.githubLogin, role: "pm", status: "active" });
    await tx.insert(repos).values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/acme/svc-${n}` });
    return { orgId: org.id, projectId: proj.id, pm: pm.id, eng: eng.id, pmSlack: `U${n}PM` };
  });
}

function candidate(pageId: string, over: Partial<DocCandidateItem> & { anchorKey: string }): DocCandidateItem {
  const { anchorKey, ...rest } = over;
  return {
    scopeKind: "surface",
    scopeRef: SURFACE,
    ruleText: "Guest checkout conversion must be at least 92% of the logged-in baseline.",
    constraintKind: "launch_gate",
    expiresAt: null,
    expiresHint: "",
    lowConfidence: false,
    confidence: 90,
    externalId: `${pageId}#${anchorKey}`,
    contentHash: `hash-${anchorKey}-${uid()}`,
    anchor: { type: "notion_block", pageId, blockId: anchorKey, headingPath: ["Launch"], snippet: "conversion ≥ 92%" },
    evidence: [{ externalId: `${pageId}#${anchorKey}`, quote: "…" }],
    rationale: "",
    surfaceCandidates: [],
    ...rest,
  };
}

/** Register + activate a native doc, file one candidate, ratify → a binding constraint id. */
async function ratifiedConstraint(s: Awaited<ReturnType<typeof setup>>, over: Partial<DocCandidateItem> = {}): Promise<string> {
  const pageId = PAGE();
  const reg = await registerDocument(s.orgId, { projectId: s.projectId, memberId: s.pm, url: `https://notion.so/prd-${pageId}` });
  await setDocumentState(s.orgId, reg.documentId, s.pm, "active");
  await fileDocCandidates(reg.documentId, [candidate(pageId, { anchorKey: "c4", ...over })]);
  const d = one(await withOrg(s.orgId, (tx) => tx.select().from(decisions).where(and(eq(decisions.projectId, s.projectId), eq(decisions.origin, "document"), eq(decisions.status, "proposed")))));
  await ratifyDecision(s.orgId, d.id, s.pm);
  return d.id;
}

test("isoWeek: stable per-week bucket", () => {
  assert.equal(isoWeek(new Date("2026-07-01T12:00:00Z")), isoWeek(new Date("2026-07-03T09:00:00Z")));
  assert.notEqual(isoWeek(new Date("2026-07-01T00:00:00Z")), isoWeek(new Date("2026-07-20T00:00:00Z")));
  assert.match(isoWeek(new Date("2026-07-01T00:00:00Z")), /^2026-W\d\d$/);
});

test("expiry: a past-due launch gate flips binding → expired and retires its open conflicts", async () => {
  const s = await setup();
  const pastId = await ratifiedConstraint(s, { expiresAt: new Date(Date.now() - 86400000).toISOString() });
  const futureId = await ratifiedConstraint(s, { scopeRef: "http:POST /refunds", expiresAt: new Date(Date.now() + 86400000).toISOString() });

  // An eng decision on the past-due constraint's surface → an open drift conflict.
  await proposeDecision(s.orgId, { projectId: s.projectId, memberId: s.eng, scopeKind: "surface", scopeRef: SURFACE, ruleText: "OTP on all payment inits.", baseVersion: 0 });
  const openBefore = one(await withOrg(s.orgId, (tx) => tx.select().from(conflicts).where(and(eq(conflicts.constraintDecisionId, pastId), eq(conflicts.status, "open")))));
  assert.ok(openBefore);

  const res = await expireConstraints();
  assert.ok(res.expired >= 1);
  assert.ok(res.conflictsDismissed >= 1);

  const past = one(await withOrg(s.orgId, (tx) => tx.select().from(decisions).where(eq(decisions.id, pastId))));
  assert.equal(past.status, "expired", "past-due launch gate expired");
  const future = one(await withOrg(s.orgId, (tx) => tx.select().from(decisions).where(eq(decisions.id, futureId))));
  assert.equal(future.status, "binding", "future-dated constraint untouched");
  const conflict = one(await withOrg(s.orgId, (tx) => tx.select().from(conflicts).where(eq(conflicts.id, openBefore.id))));
  assert.equal(conflict.status, "dismissed");
  assert.equal(conflict.dismissReason, "constraint_expired");

  // Idempotent: a second run touches nothing (the row is no longer binding).
  const again = await expireConstraints();
  const stillExpired = one(await withOrg(s.orgId, (tx) => tx.select().from(decisions).where(eq(decisions.id, pastId))));
  assert.equal(stillExpired.status, "expired");
  assert.equal(again.expired, 0);
});

test("weekly digest: one writeback per owner/pm slack id, idempotent per ISO week", async () => {
  const s = await setup();
  // An expired-this-week constraint + an open conflict give the digest something to report.
  const id = await ratifiedConstraint(s, { expiresAt: new Date(Date.now() - 2 * 86400000).toISOString() });
  await proposeDecision(s.orgId, { projectId: s.projectId, memberId: s.eng, scopeKind: "surface", scopeRef: SURFACE, ruleText: "OTP on all inits.", baseVersion: 0 });
  await expireConstraints(); // flips it to expired (expiresAt within the last week)
  void id;

  const r1 = await enqueueWeeklyDigests();
  assert.ok(r1.enqueued >= 1, "a weekly digest was enqueued for the pm");
  const wbs = await withOrg(s.orgId, (tx) => tx.select().from(writebacks).where(and(eq(writebacks.projectId, s.projectId), eq(writebacks.kind, "weekly_digest"))));
  assert.equal(wbs.length, 1);
  assert.equal(wbs[0]!.targetRef, s.pmSlack);
  const payload = wbs[0]!.payload as { expired: unknown[]; projectName: string };
  assert.equal(payload.projectName, "acme");
  assert.ok(payload.expired.length >= 1);

  // Second run in the same ISO week → dedupe, no new writeback.
  const r2 = await enqueueWeeklyDigests();
  assert.equal(r2.enqueued, 0);
  const after = await withOrg(s.orgId, (tx) => tx.select().from(writebacks).where(and(eq(writebacks.projectId, s.projectId), eq(writebacks.kind, "weekly_digest"))));
  assert.equal(after.length, 1);
});

test("weekly digest: a quiet project enqueues nothing", async () => {
  const s = await setup();
  await ratifiedConstraint(s); // binding, not expired, no conflicts
  const r = await enqueueWeeklyDigests();
  const wbs = await withOrg(s.orgId, (tx) => tx.select().from(writebacks).where(and(eq(writebacks.projectId, s.projectId), eq(writebacks.kind, "weekly_digest"))));
  assert.equal(wbs.length, 0, "nothing to report → no digest");
  void r;
});

test("weekly digest: review-due decisions and stale proposals are reported (Phase J)", async () => {
  const s = await setup();
  // A binding decision with a past review tripwire…
  const r = await proposeDecision(s.orgId, { projectId: s.projectId, memberId: s.eng, scopeKind: "surface", scopeRef: "http:GET /pj/due", ruleText: "Cache the summary endpoint.", baseVersion: 0 });
  await setDecisionReview(s.orgId, r.decisionId, s.eng, new Date(Date.now() - 86400000));
  // …and a proposal that, seen from a week out, has been waiting past the 7-day default window.
  await fileProposedDecision(s.orgId, {
    projectId: s.projectId,
    scopeKind: "surface",
    scopeRef: "http:GET /pj/stale",
    ruleText: "Nightly reindex of the search cluster.",
    provenance: { source: "slack", evidence: [{ externalId: "x", quote: "q" }] },
    connectionId: randomUUID(),
    externalId: randomUUID(),
    contentHash: randomUUID(),
    confidence: 70,
  });

  const vantage = new Date(Date.now() + 8 * 86400000);
  const res = await enqueueWeeklyDigests(vantage);
  assert.ok(res.enqueued >= 1);
  const wbs = await withOrg(s.orgId, (tx) => tx.select().from(writebacks).where(and(eq(writebacks.projectId, s.projectId), eq(writebacks.kind, "weekly_digest"))));
  const payload = one(wbs).payload as { reviewDue: Array<{ scopeRef: string }>; staleProposals: Array<{ scopeRef: string; ageDays: number }> };
  assert.ok(payload.reviewDue.some((d) => d.scopeRef === "http:GET /pj/due"));
  const stale = payload.staleProposals.find((d) => d.scopeRef === "http:GET /pj/stale");
  assert.ok(stale, "the waiting proposal is escalated");
  assert.ok(stale!.ageDays >= 8);
});

test("weekly digest: Phase J sections fire even with the product layer off", async () => {
  const s = await setup({}); // no product layer
  const r = await proposeDecision(s.orgId, { projectId: s.projectId, memberId: s.eng, scopeKind: "surface", scopeRef: "http:GET /pj/off-due", ruleText: "Rotate the API keys monthly.", baseVersion: 0 });
  await setDecisionReview(s.orgId, r.decisionId, s.eng, new Date(Date.now() - 86400000));
  const res = await enqueueWeeklyDigests();
  assert.ok(res.enqueued >= 1, "review tripwires escalate regardless of the product layer");
  const wbs = await withOrg(s.orgId, (tx) => tx.select().from(writebacks).where(and(eq(writebacks.projectId, s.projectId), eq(writebacks.kind, "weekly_digest"))));
  const payload = one(wbs).payload as { reviewDue: Array<{ scopeRef: string }>; expired: unknown[]; openConflicts: number };
  assert.ok(payload.reviewDue.some((d) => d.scopeRef === "http:GET /pj/off-due"));
  assert.equal(payload.expired.length, 0);
  assert.equal(payload.openConflicts, 0);
});
