/**
 * v3 Phase B end-to-end at the service layer (real Postgres via DATABASE_URL): product-constraint
 * scoping into the briefing, the pull tool, governs-edge learning (auto-link + reconcile confirm +
 * tech-lead confirm/reject), capability impact recompute, and the Features reconciliation view.
 *
 * Maps to acceptance B-1 (briefing scope), B-2 (budget/pull), B-3 (auto-link + confirm).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { withSystem, withOrg } from "../db/rls.js";
import {
  orgs,
  principals,
  members,
  projects,
  projectMembers,
  repos,
  graphNodes,
  graphEdges,
  decisions,
} from "../db/schema.js";
import {
  registerDependency,
  recordChange,
  reconcile,
  ratifyDecision,
  proposeDecision,
  constraintsInScope,
  briefingConstraints,
  getProductContext,
} from "../ledger/ledger-service.js";
import { registerDocument, fileDocCandidates, setDocumentState, listDocuments, type DocCandidateItem } from "./document-service.js";
import { listFeatures, getFeature, confirmGovernsEdge, rejectGovernsEdge } from "./features-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 900_000_000;
const uid = (): number => ++seq;
const PAGE = () => `00000000-0000-4000-8000-${uid().toString(16).padStart(12, "0")}`;

const SURFACE = "http:POST /payments/init";
const CAP = "feature:guest-checkout";
const CAP_SURFACE = "http:POST /checkout/guest";

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `FeatCo-${n}` }).returning());
    const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `pm-${n}` }).returning());
    const pm = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `pm-${n}` })
        .returning(),
    );
    const p2 = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `eng-${n}` }).returning());
    const eng = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: p2.id, githubUserId: p2.githubUserId, githubLogin: `eng-${n}` })
        .returning(),
    );
    const proj = one(
      await tx
        .insert(projects)
        .values({ orgId: org.id, name: "acme", createdBy: pm.id, settings: { productLayer: { enabled: true } } })
        .returning(),
    );
    for (const [m, role] of [[pm, "pm"], [eng, "member"]] as const) {
      await tx.insert(projectMembers).values({ orgId: org.id, projectId: proj.id, memberId: m.id, invitedGithubLogin: m.githubLogin, role, status: "active" });
    }
    // product-service consumes the payment surface + the (future) guest-checkout surface.
    const productRepo = one(await tx.insert(repos).values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/acme/product-${n}` }).returning());
    // orders-service consumes an unrelated surface.
    const ordersRepo = one(await tx.insert(repos).values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/acme/orders-${n}` }).returning());
    return { orgId: org.id, projectId: proj.id, pm: pm.id, eng: eng.id, productRepo: productRepo.id, ordersRepo: ordersRepo.id };
  });
}

function candidate(pageId: string, over: Partial<DocCandidateItem> & { anchorKey: string }): DocCandidateItem {
  const { anchorKey, ...rest } = over;
  return {
    scopeKind: "surface",
    scopeRef: SURFACE,
    ruleText: "The guest flow must not present an OTP challenge before payment.",
    constraintKind: "behavioral",
    expiresAt: null,
    expiresHint: "",
    lowConfidence: false,
    confidence: 91,
    externalId: `${pageId}#${anchorKey}`,
    contentHash: `hash-${anchorKey}`,
    anchor: { type: "notion_block", pageId, blockId: anchorKey, headingPath: ["Requirements"], snippet: "…" },
    evidence: [{ externalId: `${pageId}#${anchorKey}`, quote: "…" }],
    rationale: "",
    surfaceCandidates: [],
    ...rest,
  };
}

/** Register a native PRD, activate it, file candidates, ratify them all. Returns the doc id. */
async function ratifiedDoc(s: Awaited<ReturnType<typeof setup>>, pageId: string, items: DocCandidateItem[]): Promise<string> {
  const reg = await registerDocument(s.orgId, { projectId: s.projectId, memberId: s.pm, url: `https://notion.so/prd-${pageId}` });
  await setDocumentState(s.orgId, reg.documentId, s.pm, "active");
  await fileDocCandidates(reg.documentId, items);
  const proposed = await withOrg(s.orgId, (tx) =>
    tx.select().from(decisions).where(and(eq(decisions.projectId, s.projectId), eq(decisions.status, "proposed"), eq(decisions.origin, "document"))),
  );
  for (const d of proposed) await ratifyDecision(s.orgId, d.id, s.pm);
  return reg.documentId;
}

test("B-1: a surface-scoped constraint reaches a consuming repo's briefing, but not an unrelated repo", async () => {
  const s = await setup();
  await registerDependency(s.orgId, { projectId: s.projectId, memberId: s.eng, consumerRepoId: s.productRepo, producedSurface: SURFACE });
  await registerDependency(s.orgId, { projectId: s.projectId, memberId: s.eng, consumerRepoId: s.ordersRepo, producedSurface: "http:GET /orders" });
  const pageId = PAGE();
  await ratifiedDoc(s, pageId, [candidate(pageId, { anchorKey: "c2" })]);

  const inScope = await constraintsInScope(s.orgId, s.projectId, s.productRepo);
  assert.equal(inScope.length, 1, "product-service consumes the payment surface → sees C-2");
  assert.equal(inScope[0]!.scopeRef, SURFACE);
  assert.equal(inScope[0]!.docState, "active");

  const brief = await briefingConstraints(s.orgId, s.projectId, s.productRepo);
  assert.equal(brief.constraints.length, 1);
  assert.match(brief.constraints[0]!.line, /⚠ \[ratified · .*\] .* \(impact \d+\)/);
  assert.equal(brief.overflow, 0);

  const ordersScope = await constraintsInScope(s.orgId, s.projectId, s.ordersRepo);
  assert.equal(ordersScope.length, 0, "orders-service has no intersecting surface → sees nothing");
});

test("B-1: archiving the source doc drops its constraints from the briefing (stale ≠ binding)", async () => {
  const s = await setup();
  await registerDependency(s.orgId, { projectId: s.projectId, memberId: s.eng, consumerRepoId: s.productRepo, producedSurface: SURFACE });
  const pageId = PAGE();
  const docId = await ratifiedDoc(s, pageId, [candidate(pageId, { anchorKey: "c2" })]);
  assert.equal((await constraintsInScope(s.orgId, s.projectId, s.productRepo)).length, 1);
  await setDocumentState(s.orgId, docId, s.pm, "archived");
  assert.equal((await constraintsInScope(s.orgId, s.projectId, s.productRepo)).length, 0, "archived-doc constraints are stale, out of briefings");
});

test("B-3: recordChange with capabilityRef proposes a governs edge; reconcile confirms it on a checked PR", async () => {
  const s = await setup();
  // A change on a surface while feature context is set → proposed governs edge (auto-link).
  await recordChange(s.orgId, {
    projectId: s.projectId,
    repoId: s.productRepo,
    memberId: s.eng,
    summary: "add guest checkout endpoint",
    surface: CAP_SURFACE,
    riskTier: "owned",
    capabilityRef: CAP,
  });
  const proposed = await withOrg(s.orgId, (tx) =>
    tx.select().from(graphEdges).where(and(eq(graphEdges.projectId, s.projectId), eq(graphEdges.kind, "governs"), eq(graphEdges.status, "proposed"))),
  );
  assert.equal(proposed.length, 1, "auto-link created one proposed governs edge");

  // Re-publishing the same change does not duplicate (idempotent upsert).
  await recordChange(s.orgId, { projectId: s.projectId, repoId: s.productRepo, memberId: s.eng, summary: "again", surface: CAP_SURFACE, riskTier: "owned", capabilityRef: CAP });
  const stillOne = await withOrg(s.orgId, (tx) =>
    tx.select().from(graphEdges).where(and(eq(graphEdges.projectId, s.projectId), eq(graphEdges.kind, "governs"))),
  );
  assert.equal(stillOne.length, 1);

  // pr-check reconcile on that surface confirms the edge and reports it.
  const rec = await reconcile(s.orgId, s.projectId, [CAP_SURFACE]);
  assert.equal(rec.confirmedGovernsEdges.length, 1);
  assert.equal(rec.confirmedGovernsEdges[0]!.capabilityRef, CAP);
  const confirmed = await withOrg(s.orgId, (tx) =>
    tx.select().from(graphEdges).where(and(eq(graphEdges.projectId, s.projectId), eq(graphEdges.kind, "governs"), eq(graphEdges.status, "confirmed"))),
  );
  assert.equal(confirmed.length, 1, "reconcile flipped proposed → confirmed");
});

test("B-3: a capability-scoped constraint only reaches briefings once its governs edge is confirmed; impact recomputes", async () => {
  const s = await setup();
  // product-service consumes the guest-checkout surface.
  await registerDependency(s.orgId, { projectId: s.projectId, memberId: s.eng, consumerRepoId: s.productRepo, producedSurface: CAP_SURFACE });
  await registerDependency(s.orgId, { projectId: s.projectId, memberId: s.ordersRepo === s.productRepo ? s.eng : s.eng, consumerRepoId: s.ordersRepo, producedSurface: CAP_SURFACE });
  const pageId = PAGE();
  // C-1 is capability-scoped; its extraction named the guest-checkout surface → seeds a PROPOSED edge at ratify.
  await ratifiedDoc(s, pageId, [
    candidate(pageId, {
      anchorKey: "c1",
      scopeKind: "capability",
      scopeRef: CAP,
      ruleText: "Guests must be able to complete checkout without creating an account.",
      surfaceCandidates: [CAP_SURFACE],
    }),
  ]);

  // Proposed edge does NOT scope briefings yet.
  assert.equal((await constraintsInScope(s.orgId, s.projectId, s.productRepo)).length, 0, "capability constraint invisible while its governs edge is proposed");
  const edge = one(
    await withOrg(s.orgId, (tx) =>
      tx.select().from(graphEdges).where(and(eq(graphEdges.projectId, s.projectId), eq(graphEdges.kind, "governs"), eq(graphEdges.status, "proposed"))),
    ),
  );

  // Tech lead confirms → capability constraint now in scope, and impact recomputed to the consumer count (2).
  await confirmGovernsEdge(s.orgId, s.projectId, edge.id, s.pm);
  const scoped = await constraintsInScope(s.orgId, s.projectId, s.productRepo);
  assert.equal(scoped.length, 1, "confirmed governs edge brings the capability constraint into scope");
  assert.equal(scoped[0]!.scopeRef, CAP);
  assert.equal(scoped[0]!.impact, 2, "capability impact = max consumer count over confirmed surfaces");

  // A plain member cannot confirm/reject.
  await assert.rejects(() => confirmGovernsEdge(s.orgId, s.projectId, edge.id, s.eng), (e: Error & { statusCode?: number }) => e.statusCode === 403);
});

test("B-2: get_product_context resolves capability / surface / free-text scopes", async () => {
  const s = await setup();
  await registerDependency(s.orgId, { projectId: s.projectId, memberId: s.eng, consumerRepoId: s.productRepo, producedSurface: SURFACE });
  const pageId = PAGE();
  await ratifiedDoc(s, pageId, [
    candidate(pageId, { anchorKey: "c2" }),
    candidate(pageId, { anchorKey: "c1", scopeKind: "capability", scopeRef: CAP, ruleText: "Guests check out without an account.", surfaceCandidates: [CAP_SURFACE] }),
  ]);

  const byCap = await getProductContext(s.orgId, s.projectId, CAP);
  assert.equal(byCap.constraints.length, 1);
  assert.equal(byCap.constraints[0]!.scopeRef, CAP);

  const bySurface = await getProductContext(s.orgId, s.projectId, SURFACE);
  assert.ok(bySurface.constraints.some((c) => c.scopeRef === SURFACE), "surface scope returns the direct constraint");

  const byText = await getProductContext(s.orgId, s.projectId, "OTP challenge");
  assert.ok(byText.constraints.some((c) => c.ruleText.includes("OTP")), "free text matches rule text");
});

test("Features: index counts + reconciliation detail (constraints, governed surfaces, coverage)", async () => {
  const s = await setup();
  await registerDependency(s.orgId, { projectId: s.projectId, memberId: s.eng, consumerRepoId: s.productRepo, producedSurface: CAP_SURFACE });
  const pageId = PAGE();
  await ratifiedDoc(s, pageId, [
    candidate(pageId, { anchorKey: "c1", scopeKind: "capability", scopeRef: CAP, ruleText: "Guests check out without an account.", surfaceCandidates: [CAP_SURFACE] }),
  ]);
  // Some engineering activity on the governed surface.
  await proposeDecision(s.orgId, { projectId: s.projectId, memberId: s.eng, scopeKind: "surface", scopeRef: CAP_SURFACE, ruleText: "Guest checkout uses a payment-intent flag.", baseVersion: 0 });
  await recordChange(s.orgId, { projectId: s.projectId, repoId: s.productRepo, memberId: s.eng, summary: "impl guest checkout", surface: CAP_SURFACE, riskTier: "owned" });

  const { features } = await listFeatures(s.orgId, s.projectId);
  const f = features.find((x) => x.ref === CAP);
  assert.ok(f, "capability appears in the Features index");
  assert.equal(f!.constraintCounts.binding, 1);
  assert.equal(f!.governedSurfaces.proposed, 1, "seeded governs edge is proposed until confirmed");

  const detail = (await getFeature(s.orgId, s.projectId, CAP)) as {
    constraints: Array<{ scopeRef: string; conflict: boolean }>;
    governedSurfaces: Array<{ surface: string; status: string; edgeId: string; implementing: { decisions: number; changes: number } }>;
    coverage: { constraintsWithActivity: number; totalConstraints: number };
  };
  assert.equal(detail.governedSurfaces.length, 1);
  const gs = detail.governedSurfaces[0]!;
  assert.equal(gs.surface, CAP_SURFACE);
  assert.equal(gs.status, "proposed");
  assert.ok(gs.implementing.decisions >= 1 && gs.implementing.changes >= 1, "engineering activity shows on the governed surface");

  // Confirm the edge, then the capability constraint counts as having implementing activity.
  await confirmGovernsEdge(s.orgId, s.projectId, gs.edgeId, s.pm);
  const detail2 = (await getFeature(s.orgId, s.projectId, CAP)) as { coverage: { constraintsWithActivity: number; totalConstraints: number } };
  assert.equal(detail2.coverage.totalConstraints, 1);
  assert.equal(detail2.coverage.constraintsWithActivity, 1);

  // Reject path removes a proposed edge (re-seed a fresh one first).
  await recordChange(s.orgId, { projectId: s.projectId, repoId: s.productRepo, memberId: s.eng, summary: "touch another", surface: "http:POST /checkout/apply-coupon", riskTier: "owned", capabilityRef: CAP });
  const proposedEdge = one(
    await withOrg(s.orgId, (tx) =>
      tx.select().from(graphEdges).where(and(eq(graphEdges.projectId, s.projectId), eq(graphEdges.kind, "governs"), eq(graphEdges.status, "proposed"))),
    ),
  );
  await rejectGovernsEdge(s.orgId, s.projectId, proposedEdge.id, s.pm);
  const gone = await withOrg(s.orgId, (tx) => tx.select().from(graphEdges).where(eq(graphEdges.id, proposedEdge.id)));
  assert.equal(gone.length, 0, "reject deletes the proposed edge");
});

test("Features: capability node minted once at ratify with a doc→capability owns edge", async () => {
  const s = await setup();
  const pageId = PAGE();
  await ratifiedDoc(s, pageId, [
    candidate(pageId, { anchorKey: "c1", scopeKind: "capability", scopeRef: CAP, ruleText: "Guests check out without an account." }),
    candidate(pageId, { anchorKey: "c3", scopeKind: "capability", scopeRef: CAP, ruleText: "Guest orders are claimable by phone." }),
  ]);
  const caps = await withOrg(s.orgId, (tx) =>
    tx.select().from(graphNodes).where(and(eq(graphNodes.projectId, s.projectId), eq(graphNodes.kind, "capability"))),
  );
  assert.equal(caps.length, 1, "capability minted exactly once across two ratifications");
});
