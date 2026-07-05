/**
 * v3 Phase E — the Insights metrics slice, end-to-end at the service layer (real Postgres via
 * DATABASE_URL). Seeds document decisions (binding/rejected/low-confidence), conflicts
 * (dismissed/resolved/open) with dismiss reasons, and provenance rows with mixed anchorStatus, then
 * asserts the four computed rates + the dismiss-reason histogram.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withSystem, type Tx } from "../db/rls.js";
import {
  orgs,
  principals,
  members,
  projects,
  projectMembers,
  decisions,
  decisionVersions,
  decisionProvenances,
  conflicts,
} from "../db/schema.js";
import { projectInsights } from "./insights-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 700_000_000;
const uid = (): number => ++seq;
const SURFACE = "http:POST /payments/init";

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `InsightsCo-${n}` }).returning());
    const pp = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `pm-${n}` }).returning());
    const pm = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: pp.id, githubUserId: pp.githubUserId, githubLogin: `pm-${n}` })
        .returning(),
    );
    const proj = one(
      await tx
        .insert(projects)
        .values({ orgId: org.id, name: "acme", createdBy: pm.id, settings: { productLayer: { enabled: true } } })
        .returning(),
    );
    await tx
      .insert(projectMembers)
      .values({ orgId: org.id, projectId: proj.id, memberId: pm.id, invitedGithubLogin: pm.githubLogin, role: "pm", status: "active" });
    return { orgId: org.id, projectId: proj.id, pm: pm.id };
  });
}

/** Seed one origin=document decision with a current version carrying a lowConfidence-tagged provenance. */
async function docDecision(
  tx: Tx,
  s: { orgId: string; projectId: string },
  opts: { status: string; lowConfidence: boolean; anchorStatus?: string },
): Promise<string> {
  const d = one(
    await tx
      .insert(decisions)
      .values({
        orgId: s.orgId,
        projectId: s.projectId,
        scopeKind: "surface",
        scopeRef: SURFACE,
        origin: "document",
        status: opts.status,
        currentVersion: 1,
      })
      .returning(),
  );
  await tx.insert(decisionVersions).values({
    orgId: s.orgId,
    decisionId: d.id,
    version: 1,
    baseVersion: 0,
    ruleText: "The guest flow must not present an OTP challenge before payment.",
    provenance: { lowConfidence: opts.lowConfidence, source: "notion" },
    status: opts.status,
  });
  if (opts.anchorStatus) {
    await tx.insert(decisionProvenances).values({
      orgId: s.orgId,
      decisionId: d.id,
      source: "notion",
      anchorStatus: opts.anchorStatus,
    });
  }
  return d.id;
}

test("projectInsights: approval, dismiss, low-confidence, and anchor-validity rates", async () => {
  const s = await setup();

  const ids = await withSystem(async (tx) => {
    // Ratification: 2 binding + 1 rejected → 2/3. Anchor validity: 2 valid + 1 reverify → 2/3.
    const d1 = await docDecision(tx, s, { status: "binding", lowConfidence: false, anchorStatus: "valid" });
    const d2 = await docDecision(tx, s, { status: "binding", lowConfidence: true, anchorStatus: "valid" }); // low-conf binding
    const d3 = await docDecision(tx, s, { status: "rejected", lowConfidence: false, anchorStatus: "reverify" });
    // Low-confidence acceptance: d2 (binding, low-conf) + d5 (proposed, low-conf) → 1/2.
    const d5 = await docDecision(tx, s, { status: "proposed", lowConfidence: true });

    // A non-document decision must be ignored entirely by every metric.
    await tx.insert(decisions).values({
      orgId: s.orgId,
      projectId: s.projectId,
      scopeKind: "surface",
      scopeRef: SURFACE,
      origin: "agent",
      status: "binding",
      currentVersion: 0,
    });

    // Conflicts: 1 dismissed + 1 resolved_eng_revised → dismiss rate 1/2. One open conflict is
    // excluded from the resolved denominator. dismissReasons histogram comes from the dismissed rows.
    await tx.insert(conflicts).values([
      {
        orgId: s.orgId,
        projectId: s.projectId,
        constraintDecisionId: d1,
        surface: SURFACE,
        kind: "pre_approval",
        status: "dismissed",
        dismissReason: "intentional_exception",
      },
      {
        orgId: s.orgId,
        projectId: s.projectId,
        constraintDecisionId: d2,
        surface: SURFACE,
        kind: "drift",
        status: "resolved_eng_revised",
      },
      {
        orgId: s.orgId,
        projectId: s.projectId,
        constraintDecisionId: d3,
        surface: SURFACE,
        kind: "pre_approval",
        status: "open",
      },
    ]);
    return { d1, d2, d3, d5 };
  });
  assert.ok(ids.d5);

  const i = await projectInsights(s.orgId, s.projectId);

  // Ratification approval rate: 2 binding / (2 binding + 1 rejected) = 2/3.
  assert.equal(i.ratification.ratified, 2);
  assert.equal(i.ratification.rejected, 1);
  assert.ok(Math.abs(i.ratification.rate - 2 / 3) < 1e-9);

  // Conflict dismiss rate: 1 dismissed / 2 resolved (dismissed + eng_revised) = 1/2.
  assert.equal(i.conflicts.dismissed, 1);
  assert.equal(i.conflicts.resolved, 2);
  assert.equal(i.conflicts.rate, 0.5);
  assert.deepEqual(i.conflicts.dismissReasons, [{ reason: "intentional_exception", count: 1 }]);

  // Low-confidence acceptance: 1 accepted (binding) / 2 flagged low-confidence = 1/2.
  assert.equal(i.lowConfidence.accepted, 1);
  assert.equal(i.lowConfidence.total, 2);
  assert.equal(i.lowConfidence.rate, 0.5);

  // Anchor validity: 2 valid / 3 provenance rows = 2/3.
  assert.equal(i.anchors.valid, 2);
  assert.equal(i.anchors.total, 3);
  assert.ok(Math.abs(i.anchors.rate - 2 / 3) < 1e-9);
});

test("projectInsights: empty project → every rate guards divide-by-zero (0)", async () => {
  const s = await setup();
  const i = await projectInsights(s.orgId, s.projectId);
  assert.deepEqual(i, {
    ratification: { ratified: 0, rejected: 0, rate: 0 },
    conflicts: { dismissed: 0, resolved: 0, rate: 0, dismissReasons: [] },
    lowConfidence: { accepted: 0, total: 0, rate: 0 },
    anchors: { valid: 0, total: 0, rate: 0 },
  });
});
