/**
 * v3 Phase C — the drift loop, end-to-end at the service layer (real Postgres via DATABASE_URL):
 * an engineering decision binding on a surface an active constraint governs opens a `drift` conflict,
 * notifies the PM (writeback) + the eng author (inbox), and can be resolved (holds / dismiss) or
 * conceded (edit the PRD → re-version → re-ratify → auto-resolve). Plus implementation suppression,
 * the stale pass, and the governs-confirm backstop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { withSystem, withOrg } from "../db/rls.js";
import { orgs, principals, members, projects, projectMembers, repos, decisions, decisionVersions, conflicts, writebacks, graphEdges } from "../db/schema.js";
import { proposeDecision, ackDecision, ratifyDecision, registerDependency, reconcile } from "../ledger/ledger-service.js";
import { registerDocument, fileDocCandidates, setDocumentState, type DocCandidateItem } from "./document-service.js";
import { listConflicts, resolveConflict } from "./reconcile-service.js";
import { confirmGovernsEdge } from "./features-service.js";
import { readInbox } from "../inbox/inbox-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 300_000_000;
const uid = (): number => ++seq;
const PAGE = () => `00000000-0000-4000-8000-${uid().toString(16).padStart(12, "0")}`;
const SURFACE = "http:POST /payments/init";
const CAP = "feature:guest-checkout";
const CAP_SURFACE = "http:POST /checkout/guest";

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `DriftCo-${n}` }).returning());
    const pp = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `priya-${n}` }).returning());
    const pm = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: pp.id, githubUserId: pp.githubUserId, githubLogin: `priya-${n}`, slackUserId: `U${n}PRIYA` })
        .returning(),
    );
    const pe = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `meera-${n}` }).returning());
    const eng = one(
      await tx.insert(members).values({ orgId: org.id, principalId: pe.id, githubUserId: pe.githubUserId, githubLogin: `meera-${n}` }).returning(),
    );
    const proj = one(
      await tx.insert(projects).values({ orgId: org.id, name: "acme", createdBy: pm.id, settings: { productLayer: { enabled: true } } }).returning(),
    );
    for (const [m, role] of [[pm, "pm"], [eng, "member"]] as const) {
      await tx.insert(projectMembers).values({ orgId: org.id, projectId: proj.id, memberId: m.id, invitedGithubLogin: m.githubLogin, role, status: "active" });
    }
    const authRepo = one(await tx.insert(repos).values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/acme/auth-${n}` }).returning());
    return { orgId: org.id, projectId: proj.id, pm: pm.id, eng: eng.id, pmSlack: `U${n}PRIYA`, authRepo: authRepo.id };
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
    contentHash: `hash-${anchorKey}-${uid()}`,
    anchor: { type: "notion_block", pageId, blockId: anchorKey, headingPath: ["Requirements"], snippet: "…" },
    evidence: [{ externalId: `${pageId}#${anchorKey}`, quote: "…" }],
    rationale: "",
    surfaceCandidates: [],
    ...rest,
  };
}

/** Register a native PRD, activate it, file candidates, ratify all → binding constraints. */
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

/** Propose an own-area (impact 0, no consumers) engineering decision → binds immediately. */
async function engDecision(
  s: Awaited<ReturnType<typeof setup>>,
  ruleText: string,
  opts: { surface?: string; baseVersion?: number; capabilityRef?: string } = {},
) {
  return proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.eng,
    scopeKind: "surface",
    scopeRef: opts.surface ?? SURFACE,
    ruleText,
    baseVersion: opts.baseVersion ?? 0,
    capabilityRef: opts.capabilityRef,
  });
}

test("C-1: an eng decision binding on a constraint's surface opens drift + notifies PM and eng author", async () => {
  const s = await setup();
  await ratifiedDoc(s, PAGE(), [candidate(PAGE(), { anchorKey: "c2" })]);

  const d203 = await engDecision(s, "All payment initiations require an OTP challenge, no exceptions.");
  assert.equal(d203.status, "binding", "own-area eng decision binds immediately");

  const open = await listConflicts(s.orgId, s.projectId, "open");
  const drift = open.find((c) => c.kind === "drift");
  assert.ok(drift, "a drift conflict opened");
  assert.equal(drift!.surface, SURFACE);
  assert.equal(drift!.engDecisionId, d203.decisionId);
  assert.match(drift!.constraintRuleText, /OTP challenge before payment/);
  assert.match(drift!.engRuleText ?? "", /no exceptions/);

  // PM gets an informational drift_alert writeback to their slack id.
  const wbs = await withOrg(s.orgId, (tx) => tx.select().from(writebacks).where(and(eq(writebacks.projectId, s.projectId), eq(writebacks.kind, "drift_alert"))));
  assert.equal(wbs.length, 1);
  assert.equal(wbs[0]!.targetRef, s.pmSlack);
  assert.equal((wbs[0]!.payload as { conflictId: string }).conflictId, drift!.id);

  // Eng author's inbox surfaces the conflict.
  const inbox = await readInbox(s.orgId, { memberId: s.eng, repoId: s.authRepo, projectId: s.projectId });
  assert.ok(inbox.conflicts.some((c) => c.id === drift!.id), "eng author sees the drift in their inbox");

  // Idempotent: re-binding the same decision (new version) does not open a second drift or re-notify.
  await proposeDecision(s.orgId, {
    projectId: s.projectId, memberId: s.eng, scopeKind: "surface", scopeRef: SURFACE,
    ruleText: "All payment initiations require an OTP challenge, no exceptions (v2).", baseVersion: d203.version,
  });
  const open2 = await listConflicts(s.orgId, s.projectId, "open");
  assert.equal(open2.filter((c) => c.kind === "drift").length, 1, "one drift conflict per (constraint, eng) pair");
});

test("C-3: an eng decision tagged with the constraint's feature does NOT trip drift (implementation suppression)", async () => {
  const s = await setup();
  const pageId = PAGE();
  // The doc owns feature:guest-checkout (a capability constraint is ratified), so C-2 (surface) belongs to it.
  await ratifiedDoc(s, pageId, [
    candidate(pageId, { anchorKey: "c1", scopeKind: "capability", scopeRef: CAP, ruleText: "Guests check out without an account." }),
    candidate(pageId, { anchorKey: "c2" }),
  ]);

  // Meera's decision IS the intended implementation of guest checkout — tagged with the feature.
  const impl = await engDecision(s, "Guest checkout skips OTP via a payment-intent flag.", { capabilityRef: CAP });
  assert.equal(impl.status, "binding");
  const open = await listConflicts(s.orgId, s.projectId, "open");
  assert.equal(open.filter((c) => c.kind === "drift").length, 0, "same-feature implementation is suppressed");

  // A later UNtagged revision of that decision (same scope, next version) now trips drift.
  const untagged = await engDecision(s, "OTP required on all payment inits, no exceptions.", { baseVersion: impl.version });
  const open2 = await listConflicts(s.orgId, s.projectId, "open");
  assert.equal(open2.filter((c) => c.kind === "drift" && c.engDecisionId === untagged.decisionId).length, 1);
});

test("resolve holds → resolved_eng_revised + eng author re-notified; dismiss → dismissed", async () => {
  const s = await setup();
  const SURFACE2 = "http:POST /refunds";
  const pageId = PAGE();
  // Two surface-scoped constraints on two surfaces so we get two independent drift conflicts.
  await ratifiedDoc(s, pageId, [
    candidate(pageId, { anchorKey: "c2" }),
    candidate(pageId, { anchorKey: "c3", scopeRef: SURFACE2, ruleText: "Refunds must not require OTP." }),
  ]);
  await engDecision(s, "OTP required on all payment inits.");
  const drift = one((await listConflicts(s.orgId, s.projectId, "open")).filter((c) => c.kind === "drift" && c.surface === SURFACE));

  // A plain member cannot resolve.
  await assert.rejects(() => resolveConflict(s.orgId, drift.id, s.eng, { resolution: "holds" }), (e: Error & { statusCode?: number }) => e.statusCode === 403);

  const held = await resolveConflict(s.orgId, drift.id, s.pm, { resolution: "holds" });
  assert.equal(held.status, "resolved_eng_revised");
  const resolved = await listConflicts(s.orgId, s.projectId, "resolved_eng_revised");
  assert.ok(resolved.some((c) => c.id === drift.id));
  // Re-resolving a closed conflict is a 409.
  await assert.rejects(() => resolveConflict(s.orgId, drift.id, s.pm, { resolution: "dismiss" }), (e: Error & { statusCode?: number }) => e.statusCode === 409);

  // A second, independent drift on the refunds surface — dismissed with a reason.
  await engDecision(s, "Refunds now require OTP for fraud.", { surface: SURFACE2 });
  const drift2 = one((await listConflicts(s.orgId, s.projectId, "open")).filter((c) => c.kind === "drift" && c.surface === SURFACE2));
  const dismissed = await resolveConflict(s.orgId, drift2.id, s.pm, { resolution: "dismiss", reason: "intentional exception" });
  assert.equal(dismissed.status, "dismissed");
});

test("concede: editing the PRD re-versions the constraint (no duplicate) and re-ratifying auto-resolves drift", async () => {
  const s = await setup();
  const pageId = PAGE();
  const reg = await registerDocument(s.orgId, { projectId: s.projectId, memberId: s.pm, url: `https://notion.so/prd-${pageId}` });
  await setDocumentState(s.orgId, reg.documentId, s.pm, "active");
  const c2 = candidate(pageId, { anchorKey: "c2", contentHash: "h-c2-v1" });
  await fileDocCandidates(reg.documentId, [c2]);
  const constraint = one(
    await withOrg(s.orgId, (tx) => tx.select().from(decisions).where(and(eq(decisions.projectId, s.projectId), eq(decisions.origin, "document")))),
  );
  await ratifyDecision(s.orgId, constraint.id, s.pm);

  // Drift opens.
  await engDecision(s, "OTP required on all payment inits.");
  const drift = one((await listConflicts(s.orgId, s.projectId, "open")).filter((c) => c.kind === "drift"));

  const decisionsBefore = await withOrg(s.orgId, (tx) => tx.select().from(decisions).where(eq(decisions.projectId, s.projectId)));

  // PM concedes: edits the C-2 section (same anchor, new text, new hash) → re-version, NOT a duplicate.
  const edited = candidate(pageId, {
    anchorKey: "c2",
    contentHash: "h-c2-v2",
    ruleText: "The guest flow must not present an OTP challenge before payment (guest sessions only).",
  });
  const res = await fileDocCandidates(reg.documentId, [edited], "doc-hash-2", ["c2"]);
  assert.equal(res.reversioned, 1, "edited section re-versions the existing constraint");
  assert.equal(res.filed, 0, "no fresh duplicate decision");

  const decisionsAfter = await withOrg(s.orgId, (tx) => tx.select().from(decisions).where(eq(decisions.projectId, s.projectId)));
  assert.equal(decisionsAfter.length, decisionsBefore.length, "no duplicate decision minted for the edited anchor");

  // The constraint is back to proposed with a bumped version; ratify the amendment → drift auto-resolves.
  const reC2 = one(await withOrg(s.orgId, (tx) => tx.select().from(decisions).where(eq(decisions.id, constraint.id))));
  assert.equal(reC2.status, "proposed");
  assert.equal(reC2.currentVersion, 2);
  await ratifyDecision(s.orgId, constraint.id, s.pm);
  const closed = one((await listConflicts(s.orgId, s.projectId)).filter((c) => c.id === drift.id));
  assert.equal(closed.status, "resolved_prd_amended", "re-ratifying the amended constraint auto-resolves the drift");
});

test("stale pass: a section re-visited but no longer yielding its constraint retires it", async () => {
  const s = await setup();
  const pageId = PAGE();
  const reg = await registerDocument(s.orgId, { projectId: s.projectId, memberId: s.pm, url: `https://notion.so/prd-${pageId}` });
  await setDocumentState(s.orgId, reg.documentId, s.pm, "active");
  await fileDocCandidates(reg.documentId, [candidate(pageId, { anchorKey: "c2", contentHash: "h1" })]);
  const constraint = one(await withOrg(s.orgId, (tx) => tx.select().from(decisions).where(eq(decisions.projectId, s.projectId))));
  await ratifyDecision(s.orgId, constraint.id, s.pm);

  // Re-sweep: the c2 section was re-visited (in extractedAnchorKeys) but produced NO candidate → removed.
  const res = await fileDocCandidates(reg.documentId, [], "doc-hash-2", ["c2"]);
  assert.equal(res.staled, 1);
  const after = one(await withOrg(s.orgId, (tx) => tx.select().from(decisions).where(eq(decisions.id, constraint.id))));
  assert.equal(after.status, "stale");
});

test("backstop: confirming a governs edge opens drift against a pre-existing binding eng decision", async () => {
  const s = await setup();
  const pageId = PAGE();
  // A capability constraint governing CAP_SURFACE, seeded proposed via surfaceCandidates at ratify.
  const reg = await registerDocument(s.orgId, { projectId: s.projectId, memberId: s.pm, url: `https://notion.so/prd-${pageId}` });
  await setDocumentState(s.orgId, reg.documentId, s.pm, "active");
  await fileDocCandidates(reg.documentId, [
    candidate(pageId, { anchorKey: "c1", scopeKind: "capability", scopeRef: CAP, ruleText: "Guests check out without an account.", surfaceCandidates: [CAP_SURFACE] }),
  ]);
  const constraint = one(await withOrg(s.orgId, (tx) => tx.select().from(decisions).where(and(eq(decisions.projectId, s.projectId), eq(decisions.origin, "document")))));
  await ratifyDecision(s.orgId, constraint.id, s.pm);

  // A binding eng decision already exists on CAP_SURFACE (no consumers → binds), BEFORE the edge confirms.
  const eng = await proposeDecision(s.orgId, { projectId: s.projectId, memberId: s.eng, scopeKind: "surface", scopeRef: CAP_SURFACE, ruleText: "Checkout requires a logged-in session.", baseVersion: 0 });
  assert.equal(eng.status, "binding");
  assert.equal((await listConflicts(s.orgId, s.projectId, "open")).filter((c) => c.kind === "drift").length, 0, "proposed governs edge doesn't scope drift yet");

  // Confirm the governs edge → backstop scan opens drift against the pre-existing eng decision.
  const edge = one(await withOrg(s.orgId, (tx) => tx.select().from(graphEdges).where(and(eq(graphEdges.projectId, s.projectId), eq(graphEdges.kind, "governs"), eq(graphEdges.status, "proposed")))));
  await confirmGovernsEdge(s.orgId, s.projectId, edge.id, s.pm);
  const drift = (await listConflicts(s.orgId, s.projectId, "open")).filter((c) => c.kind === "drift" && c.engDecisionId === eng.decisionId);
  assert.equal(drift.length, 1, "backstop opened drift on governs-edge confirmation");
});
