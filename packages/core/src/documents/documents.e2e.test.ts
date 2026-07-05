/**
 * End-to-end proof of the v3 product layer at the service layer, against a real Postgres
 * (DATABASE_URL), mirroring ingest.e2e.test.ts. No network, no Composio, no LLM — the worker's
 * document funnel is exercised in packages/ingest; this file covers everything from
 * "swept doc reported to core" onward:
 *
 *   sweep upsert (mirrored state mapping, never-guess) → candidates filed (origin=document,
 *   idempotent, anchored) → pre-approval co-location conflict + write-back queued exactly once →
 *   ratification (doc-active + role gates, no fanout, capability mint) → digest queueing → archive.
 *
 * Maps to acceptance scenarios A-1..A-4 and Sec-1 (service half) of the v3 PRD.
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
  sourceConnections,
  ingestAllowlist,
  decisions,
  decisionApprovals,
  graphNodes,
  graphEdges,
  inboxItems,
  writebacks,
  conflicts as conflictsTable,
  auditEvents,
} from "../db/schema.js";
import {
  registerDocument,
  setDocumentState,
  requestResync,
  upsertDocumentsFromSweep,
  getDocumentWork,
  fileDocCandidates,
  listDocuments,
  getDocument,
  listRatifications,
  projectCounts,
  setStateMapping,
  setStatusProperty,
  listStateMappings,
  pendingWritebacks,
  markWritebackDone,
  parseNotionPageId,
  type DocCandidateItem,
} from "./document-service.js";
import { composeConflictComment, listConflicts, dismissConflict } from "./reconcile-service.js";
import { proposeDecision, ratifyDecision, listDecisions } from "../ledger/ledger-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}

let seq = Date.now() + 700_000_000;
const uid = (): number => ++seq;

const PAGE_ID = () => {
  // unique dashed-uuid-shaped Notion page id per call
  const h = uid().toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${h}`;
};

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `ProdCo-${n}` }).returning());
    const mk = async (login: string, role: string, slackUserId?: string) => {
      const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `${login}-${n}` }).returning());
      const m = one(
        await tx
          .insert(members)
          .values({
            orgId: org.id,
            principalId: p.id,
            githubUserId: p.githubUserId,
            githubLogin: `${login}-${n}`,
            email: `${login}-${n}@acme.dev`,
            slackUserId: slackUserId ?? null,
          })
          .returning(),
      );
      return m;
    };
    const owner = await mk("dev", "owner");
    const priya = await mk("priya", "pm", `U${n}PRIYA`);
    const meera = await mk("meera", "member");
    const proj = one(
      await tx
        .insert(projects)
        .values({ orgId: org.id, name: "acme-commerce", createdBy: owner.id, settings: { productLayer: { enabled: true } } })
        .returning(),
    );
    for (const [m, role] of [
      [owner, "owner"],
      [priya, "pm"],
      [meera, "member"],
    ] as const) {
      await tx.insert(projectMembers).values({
        orgId: org.id,
        projectId: proj.id,
        memberId: m.id,
        invitedGithubLogin: m.githubLogin,
        role,
        status: "active",
      });
    }
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
      sourceName: "PRDs 2026",
    });
    return {
      orgId: org.id,
      projectId: proj.id,
      owner: owner.id,
      priya: priya.id,
      meera: meera.id,
      connectionId: conn.id,
      containerRef: `db-${n}`,
    };
  });
}

/** Standard mapping used by most tests: Draft/In review/Approved/Archived → the canonical four. */
async function mapStates(s: Awaited<ReturnType<typeof setup>>) {
  await setStatusProperty(s.orgId, {
    projectId: s.projectId,
    connectionId: s.connectionId,
    containerRef: s.containerRef,
    statusProperty: "Status",
    memberId: s.owner,
  });
  for (const [sourceValue, canonicalState] of [
    ["Draft", "draft"],
    ["In review", "review"],
    ["Approved", "active"],
    ["Archived", "archived"],
  ] as const) {
    await setStateMapping(s.orgId, {
      projectId: s.projectId,
      connectionId: s.connectionId,
      containerRef: s.containerRef,
      sourceValue,
      canonicalState,
      memberId: s.owner,
    });
  }
}

function sweptDoc(s: Awaited<ReturnType<typeof setup>>, pageId: string, rawStateValue: string, extra?: Partial<Parameters<typeof upsertDocumentsFromSweep>[1][0]>) {
  return {
    externalId: pageId,
    containerRef: s.containerRef,
    title: "PRD-142 · Guest Checkout",
    url: `https://notion.so/prd-142-${pageId.replace(/-/g, "")}`,
    rawStateValue,
    ownerRef: null,
    lastEditedTime: new Date().toISOString(),
    ...extra,
  };
}

function candidate(pageId: string, over?: Partial<DocCandidateItem>): DocCandidateItem {
  return {
    scopeKind: "surface",
    scopeRef: "http:POST /payments/init",
    ruleText: "The guest flow must not present an OTP challenge before payment.",
    constraintKind: "behavioral",
    expiresAt: null,
    expiresHint: "",
    lowConfidence: false,
    confidence: 91,
    externalId: `${pageId}#blk-guest-flow`,
    contentHash: "hash-c2",
    anchor: {
      type: "notion_block",
      pageId,
      blockId: "blk-guest-flow",
      headingPath: ["Requirements", "Guest flow"],
      snippet: "must not present an OTP challenge",
    },
    evidence: [{ externalId: `${pageId}#blk-guest-flow`, quote: "The guest flow must not present an OTP challenge before payment." }],
    rationale: "Guests abandon at OTP.",
    ...over,
  };
}

test("A-1/A-4: mirrored state mapping — draft is silent, review extracts, transitions audit", async () => {
  const s = await setup();
  await mapStates(s);
  const pageId = PAGE_ID();

  // Draft ⇒ registered but inert: no extraction directive.
  let res = await upsertDocumentsFromSweep(s.connectionId, [sweptDoc(s, pageId, "Draft")]);
  assert.equal(res.length, 1);
  assert.equal(res[0]!.state, "draft");
  assert.equal(res[0]!.shouldExtract, false, "draft documents are never extracted");

  // Status → In review ⇒ canonical review, extraction unlocked.
  res = await upsertDocumentsFromSweep(s.connectionId, [sweptDoc(s, pageId, "In review")]);
  assert.equal(res[0]!.state, "review");
  assert.equal(res[0]!.shouldExtract, true);

  const { documents } = await listDocuments(s.orgId, s.projectId);
  const doc = documents.find((d) => d.title?.includes("Guest Checkout"));
  assert.ok(doc);
  assert.equal(doc!.state, "review");
  assert.equal(doc!.stateAuthority, "mirrored");

  const audit = await withOrg(s.orgId, (tx) =>
    tx.select().from(auditEvents).where(and(eq(auditEvents.projectId, s.projectId), eq(auditEvents.action, "document.state_changed"))),
  );
  assert.ok(audit.length >= 1, "state transition is audited");
});

test("A-3: an unmapped status value is queued for the admin and the doc holds its last-known state", async () => {
  const s = await setup();
  await mapStates(s);
  const pageId = PAGE_ID();
  await upsertDocumentsFromSweep(s.connectionId, [sweptDoc(s, pageId, "In review")]);

  // A NEW value appears — never guessed: doc holds `review`, value lands in pendingValues.
  const res = await upsertDocumentsFromSweep(s.connectionId, [sweptDoc(s, pageId, "On hold")]);
  assert.equal(res[0]!.state, "review", "doc holds last-known canonical state");

  const { containers } = await listStateMappings(s.orgId, s.projectId, s.connectionId);
  const c = containers.find((x) => x.containerRef === s.containerRef);
  assert.deepEqual(c!.pendingValues.map((p) => p.value), ["On hold"]);

  // Re-sweep does not duplicate the pending value.
  await upsertDocumentsFromSweep(s.connectionId, [sweptDoc(s, pageId, "On hold")]);
  const again = await listStateMappings(s.orgId, s.projectId, s.connectionId);
  assert.equal(again.containers.find((x) => x.containerRef === s.containerRef)!.pendingValues.length, 1);

  // The pending value surfaces in the Sources payload and the nav counts.
  const { pendingStatusValues } = await listDocuments(s.orgId, s.projectId);
  assert.equal(pendingStatusValues.length, 1);
  const counts = await projectCounts(s.orgId, s.projectId);
  assert.equal(counts.sources, 1);

  // Mapping the value resolves the queue.
  await setStateMapping(s.orgId, {
    projectId: s.projectId,
    connectionId: s.connectionId,
    containerRef: s.containerRef,
    sourceValue: "On hold",
    canonicalState: "draft",
    memberId: s.owner,
  });
  const resolved = await listStateMappings(s.orgId, s.projectId, s.connectionId);
  assert.equal(resolved.containers.find((x) => x.containerRef === s.containerRef)!.pendingValues.length, 0);
});

test("A-1: candidates file as anchored document constraints, idempotently, and never enter /proposed", async () => {
  const s = await setup();
  await mapStates(s);
  const pageId = PAGE_ID();
  await upsertDocumentsFromSweep(s.connectionId, [sweptDoc(s, pageId, "In review")]);
  const { documents } = await listDocuments(s.orgId, s.projectId);
  const docId = documents[0]!.id;

  const first = await fileDocCandidates(docId, [candidate(pageId)], "doc-hash-1");
  assert.equal(first.filed, 1);
  const again = await fileDocCandidates(docId, [candidate(pageId)], "doc-hash-1");
  assert.equal(again.deduped, 1, "same section content is never re-filed");

  const proposed = await listDecisions(s.orgId, s.projectId, undefined, { status: "proposed", origin: "document" });
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0]!.scopeRef, "http:POST /payments/init");

  // Anchor lands on the doc detail + ratifications payloads.
  const detail = (await getDocument(s.orgId, docId)) as { constraints: Array<{ anchor: { heading: string | null; url: string | null; healthy: boolean } }> };
  assert.equal(detail.constraints.length, 1);
  assert.equal(detail.constraints[0]!.anchor.heading, "Guest flow");
  assert.ok(detail.constraints[0]!.anchor.url?.includes("#blk-guest-flow".replace(/-/g, "")) || detail.constraints[0]!.anchor.url?.includes("blkguestflow"), "anchor deep-links to the block");
  assert.equal(detail.constraints[0]!.anchor.healthy, true);

  const rats = await listRatifications(s.orgId, s.projectId, s.priya);
  assert.equal(rats.candidates.length, 1);
  assert.equal(rats.candidates[0]!.canRatify, false, "ratify locked while the doc is in review");
  assert.equal(rats.candidates[0]!.blockedReason, "PRD not yet approved in Notion");
});

test("A-2: co-location with a binding decision opens a pre_approval conflict and queues the comment exactly once", async () => {
  const s = await setup();
  await mapStates(s);

  // Pre-existing binding engineering decision D-88 on the same surface (impact 0 ⇒ binds on assertion).
  const d88 = await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.meera,
    scopeKind: "surface",
    scopeRef: "http:POST /payments/init",
    ruleText: "All payment initiations require an OTP challenge (fraud rule).",
    baseVersion: 0,
  });
  assert.equal(d88.status, "binding");

  const pageId = PAGE_ID();
  await upsertDocumentsFromSweep(s.connectionId, [sweptDoc(s, pageId, "In review")]);
  const docId = (await listDocuments(s.orgId, s.projectId)).documents[0]!.id;
  const filed = await fileDocCandidates(docId, [candidate(pageId)], "doc-hash-1");
  assert.equal(filed.conflicts, 1, "C-2 vs D-88 co-location detected");

  const open = await listConflicts(s.orgId, s.projectId, "open");
  assert.equal(open.length, 1);
  assert.equal(open[0]!.kind, "pre_approval");
  assert.equal(open[0]!.surface, "http:POST /payments/init");
  assert.equal(open[0]!.engDecisionId, d88.decisionId);

  // Exactly one write-back comment queued, with the honest language.
  const wbs = await withOrg(s.orgId, (tx) => tx.select().from(writebacks).where(eq(writebacks.projectId, s.projectId)));
  const comments = wbs.filter((w) => w.kind === "conflict_comment");
  assert.equal(comments.length, 1);
  const body = (comments[0]!.payload as { body: string }).body;
  assert.ok(body.includes("may conflict"), "language discipline: may conflict");
  assert.ok(!body.toLowerCase().includes("contradict"), "the word 'contradicts' is banned");
  assert.ok(body.includes("review both"));

  // Re-filing a slightly different extraction of the same rule fuses — no duplicate conflict/comment.
  await fileDocCandidates(docId, [candidate(pageId, { contentHash: "hash-c2-v2", ruleText: "The guest flow must not present an OTP challenge before payment step." })]);
  const openAgain = await listConflicts(s.orgId, s.projectId, "open");
  assert.equal(openAgain.length, 1, "one open conflict per (constraint, eng) pair");

  // Worker drains the queue; done records the comment ref on the conflict row.
  const pending = await pendingWritebacks(50, s.orgId);
  const mine = pending.find((w) => (w.payload as { conflictId?: string })?.conflictId === open[0]!.id);
  assert.ok(mine, "comment is drainable with connection info");
  assert.equal(mine!.connection?.connectedAccountId?.startsWith("ca-"), true);
  await markWritebackDone(mine!.id, true, "notion-comment-1");
  const after = await withOrg(s.orgId, (tx) => tx.select().from(conflictsTable).where(eq(conflictsTable.id, open[0]!.id)));
  assert.equal(after[0]!.writeBackRef, "notion-comment-1");

  // The pure comment composer keeps both texts.
  const txt = composeConflictComment({ constraintText: "A", engRuleText: "B", surface: "http:POST /x" });
  assert.ok(txt.includes('"A"') && txt.includes('"B"') && txt.includes("http:POST /x"));
});

test("RATIFY: doc-active gate, role gates, verdict=ratify, binding without fanout, edit = CAS version", async () => {
  const s = await setup();
  await mapStates(s);
  const pageId = PAGE_ID();
  await upsertDocumentsFromSweep(s.connectionId, [sweptDoc(s, pageId, "In review")]);
  const docId = (await listDocuments(s.orgId, s.projectId)).documents[0]!.id;
  await fileDocCandidates(docId, [candidate(pageId)], "h1");
  const constraint = (await listDecisions(s.orgId, s.projectId, undefined, { status: "proposed", origin: "document" }))[0]!;

  // Ratification is locked until the doc reaches active.
  await assert.rejects(
    () => ratifyDecision(s.orgId, constraint.id, s.priya),
    (e: Error & { statusCode?: number }) => e.message === "document_not_active" && e.statusCode === 409,
  );

  await upsertDocumentsFromSweep(s.connectionId, [sweptDoc(s, pageId, "Approved")]);

  // A plain member (not owner/pm/doc-owner) cannot ratify.
  await assert.rejects(
    () => ratifyDecision(s.orgId, constraint.id, s.meera),
    (e: Error & { statusCode?: number }) => e.statusCode === 403,
  );

  // PM ratifies with an edited rule — appends a CAS version, binds, no inbox fanout.
  const r = await ratifyDecision(s.orgId, constraint.id, s.priya, {
    ruleText: "The guest flow must not present an OTP challenge before payment (guest sessions only).",
  });
  assert.equal(r.status, "binding");
  assert.equal(r.version, 2, "edit appended a version");

  const approvals = await withOrg(s.orgId, (tx) =>
    tx.select().from(decisionApprovals).where(eq(decisionApprovals.decisionId, constraint.id)),
  );
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.verdict, "ratify");

  const items = await withOrg(s.orgId, (tx) => tx.select().from(inboxItems).where(eq(inboxItems.refId, constraint.id)));
  assert.equal(items.length, 0, "ratification never fans out to inboxes");

  // Already-ratified → 409; the second attempt cannot double-bind.
  await assert.rejects(() => ratifyDecision(s.orgId, constraint.id, s.priya), /not proposed/);
});

test("RATIFY: capability-scoped constraint mints the capability node and doc→capability edge once", async () => {
  const s = await setup();
  await mapStates(s);
  const pageId = PAGE_ID();
  await upsertDocumentsFromSweep(s.connectionId, [sweptDoc(s, pageId, "Approved")]);
  const docId = (await listDocuments(s.orgId, s.projectId)).documents[0]!.id;
  const c1 = candidate(pageId, {
    scopeKind: "capability",
    scopeRef: "feature:guest-checkout",
    ruleText: "Guests must be able to complete checkout without creating an account.",
    externalId: `${pageId}#blk-c1`,
    contentHash: "hash-c1",
    anchor: { type: "notion_block", pageId, blockId: "blk-c1", headingPath: ["Requirements", "Guest flow"], snippet: "complete checkout without creating an account" },
  });
  const c3 = candidate(pageId, {
    scopeKind: "capability",
    scopeRef: "feature:guest-checkout",
    ruleText: "Guest orders must be claimable post-purchase via phone number.",
    externalId: `${pageId}#blk-c3`,
    contentHash: "hash-c3",
    anchor: { type: "notion_block", pageId, blockId: "blk-c3", headingPath: ["Requirements", "Guest flow"], snippet: "claimable post-purchase via phone number" },
  });
  await fileDocCandidates(docId, [c1, c3], "h1");
  const proposed = await listDecisions(s.orgId, s.projectId, undefined, { status: "proposed", origin: "document" });
  assert.equal(proposed.length, 2);
  for (const p of proposed) await ratifyDecision(s.orgId, p.id, s.priya);

  const caps = await withOrg(s.orgId, (tx) =>
    tx
      .select()
      .from(graphNodes)
      .where(and(eq(graphNodes.projectId, s.projectId), eq(graphNodes.kind, "capability"))),
  );
  assert.equal(caps.length, 1, "capability node minted exactly once");
  assert.equal(caps[0]!.ref, "feature:guest-checkout");

  const docNodes = await withOrg(s.orgId, (tx) =>
    tx.select().from(graphNodes).where(and(eq(graphNodes.projectId, s.projectId), eq(graphNodes.kind, "doc"))),
  );
  assert.equal(docNodes.length, 1);
  const edges = await withOrg(s.orgId, (tx) =>
    tx.select().from(graphEdges).where(and(eq(graphEdges.projectId, s.projectId), eq(graphEdges.kind, "owns"))),
  );
  assert.ok(edges.some((e) => e.fromId === docNodes[0]!.id && e.toId === caps[0]!.id), "doc owns capability");
});

test("DIGEST: activation queues one Slack digest to the PM, excluding low-confidence candidates", async () => {
  const s = await setup();
  await mapStates(s);
  const pageId = PAGE_ID();

  // Seed a binding decision so the digest carries the conflict warning.
  await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.meera,
    scopeKind: "surface",
    scopeRef: "http:POST /payments/init",
    ruleText: "All payment initiations require an OTP challenge (fraud rule).",
    baseVersion: 0,
  });

  // Owner is resolvable via the Notion owner email hint → Priya (who has a Slack id).
  const priyaEmail = await withSystem(async (tx) => one(await tx.select().from(members).where(eq(members.id, s.priya))).email);
  await upsertDocumentsFromSweep(s.connectionId, [sweptDoc(s, pageId, "In review", { ownerRef: priyaEmail })]);
  const docId = (await listDocuments(s.orgId, s.projectId)).documents[0]!.id;
  await fileDocCandidates(docId, [
    candidate(pageId),
    candidate(pageId, {
      externalId: `${pageId}#blk-low`,
      contentHash: "hash-low",
      ruleText: "Checkout page should load fast.",
      lowConfidence: true,
      confidence: 62,
      anchor: { type: "notion_block", pageId, blockId: "blk-low", headingPath: ["Requirements"], snippet: "load fast" },
      scopeKind: "capability",
      scopeRef: "feature:guest-checkout",
    }),
  ]);

  // Approved → digest queued for Priya's Slack id with only the high-confidence candidate.
  await upsertDocumentsFromSweep(s.connectionId, [sweptDoc(s, pageId, "Approved", { ownerRef: priyaEmail })]);
  const wbs = await withOrg(s.orgId, (tx) => tx.select().from(writebacks).where(eq(writebacks.projectId, s.projectId)));
  const digests = wbs.filter((w) => w.kind === "slack_digest");
  assert.equal(digests.length, 1, "one digest per doc per activation");
  assert.ok(digests[0]!.targetRef.startsWith("U"), "targeted at the PM's slack user id");
  const payload = digests[0]!.payload as { candidates: Array<{ ruleText: string; conflict: unknown }> };
  assert.equal(payload.candidates.length, 1, "low-confidence candidates are excluded from Slack digests");
  assert.ok(payload.candidates[0]!.conflict, "pre-approval warning rides along");

  // Re-sweeping the same Approved state does not queue a second digest.
  await upsertDocumentsFromSweep(s.connectionId, [sweptDoc(s, pageId, "Approved", { ownerRef: priyaEmail })]);
  const after = await withOrg(s.orgId, (tx) => tx.select().from(writebacks).where(eq(writebacks.projectId, s.projectId)));
  assert.equal(after.filter((w) => w.kind === "slack_digest").length, 1);
});

test("ARCHIVE: source archived ⇒ constraints go stale and open conflicts auto-dismiss", async () => {
  const s = await setup();
  await mapStates(s);
  await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.meera,
    scopeKind: "surface",
    scopeRef: "http:POST /payments/init",
    ruleText: "All payment initiations require an OTP challenge (fraud rule).",
    baseVersion: 0,
  });
  const pageId = PAGE_ID();
  await upsertDocumentsFromSweep(s.connectionId, [sweptDoc(s, pageId, "In review")]);
  const docId = (await listDocuments(s.orgId, s.projectId)).documents[0]!.id;
  await fileDocCandidates(docId, [candidate(pageId)], "h1");
  assert.equal((await listConflicts(s.orgId, s.projectId, "open")).length, 1);

  await upsertDocumentsFromSweep(s.connectionId, [sweptDoc(s, pageId, "Archived")]);
  const constraint = (await listDecisions(s.orgId, s.projectId)).find((d) => d.origin === "document");
  assert.equal(constraint!.status, "stale");
  assert.equal((await listConflicts(s.orgId, s.projectId, "open")).length, 0);
  const dismissed = await listConflicts(s.orgId, s.projectId, "dismissed");
  assert.equal(dismissed[0]!.dismissReason, "source_archived");
});

test("NATIVE/Sec-1: pasted-URL registration starts at review; mirrored docs 403 on state writes", async () => {
  const s = await setup();
  await mapStates(s);

  const pageId = PAGE_ID();
  const reg = await registerDocument(s.orgId, {
    projectId: s.projectId,
    memberId: s.priya,
    url: `https://www.notion.so/acme/Guest-Checkout-${pageId.replace(/-/g, "")}`,
  });
  assert.equal(reg.externalId, pageId, "bare 32-hex URL tail normalizes to the dashed page id");
  assert.equal(reg.state, "review", "native registration IS the review signal");

  // The registrant flips it active — that click is the approval moment.
  const flipped = await setDocumentState(s.orgId, reg.documentId, s.priya, "active");
  assert.equal(flipped.state, "active");

  // Mirrored docs reject state writes with the specific error (Sec-1).
  await upsertDocumentsFromSweep(s.connectionId, [sweptDoc(s, PAGE_ID(), "Draft")]);
  const mirrored = (await listDocuments(s.orgId, s.projectId)).documents.find((d) => d.stateAuthority === "mirrored")!;
  await assert.rejects(
    () => setDocumentState(s.orgId, mirrored.id, s.owner, "active"),
    (e: Error & { statusCode?: number }) => e.message === "state_authority_mirrored" && e.statusCode === 403,
  );

  // parseNotionPageId handles dashed ids and rejects junk.
  assert.equal(parseNotionPageId(`https://notion.so/x-${pageId}`), pageId);
  assert.equal(parseNotionPageId("https://example.com/nope"), null);
});

test("WORK: getDocumentWork enumerates flagged projects only, with containers and native docs", async () => {
  const s = await setup();
  await mapStates(s);
  const pageId = PAGE_ID();
  await registerDocument(s.orgId, { projectId: s.projectId, memberId: s.priya, url: `https://notion.so/n-${pageId}` });

  const work = await getDocumentWork();
  const mine = work.find((w) => w.connectionId === s.connectionId);
  assert.ok(mine, "flagged project with an allowlisted database appears");
  assert.equal(mine!.containers.length, 1);
  assert.equal(mine!.containers[0]!.statusProperty, "Status");
  assert.equal(mine!.docs.length, 1, "native doc awaiting extraction rides along");
  assert.equal(mine!.docs[0]!.externalId, pageId);

  // Flag off ⇒ project disappears from the work list.
  await withOrg(s.orgId, (tx) =>
    tx.update(projects).set({ settings: { productLayer: { enabled: false } } }).where(eq(projects.id, s.projectId)),
  );
  const after = await getDocumentWork();
  assert.equal(after.find((w) => w.connectionId === s.connectionId), undefined);
});

test("RESYNC + counts + dismiss: manual resync flags work; counts split the review badge", async () => {
  const s = await setup();
  await mapStates(s);
  await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.meera,
    scopeKind: "surface",
    scopeRef: "http:POST /payments/init",
    ruleText: "All payment initiations require an OTP challenge (fraud rule).",
    baseVersion: 0,
  });
  const pageId = PAGE_ID();
  await upsertDocumentsFromSweep(s.connectionId, [sweptDoc(s, pageId, "In review")]);
  const docId = (await listDocuments(s.orgId, s.projectId)).documents[0]!.id;
  await fileDocCandidates(docId, [candidate(pageId)], "h1");

  const counts = await projectCounts(s.orgId, s.projectId);
  assert.equal(counts.review.ratifications, 1);
  assert.equal(counts.review.proposed, 0, "document constraints never count as conversation proposals");
  assert.equal(counts.review.conflicts, 1);

  await requestResync(s.orgId, docId, s.owner);
  const swept = await upsertDocumentsFromSweep(s.connectionId, [
    sweptDoc(s, pageId, "In review", { lastEditedTime: new Date(Date.now() - 86400e3).toISOString() }),
  ]);
  assert.equal(swept[0]!.shouldExtract, true, "forceResync overrides the edited-since check");
  assert.ok(swept[0]!.knownSectionHashes.includes("hash-c2"), "known section hashes ride the directive");

  const open = await listConflicts(s.orgId, s.projectId, "open");
  const d = await dismissConflict(s.orgId, open[0]!.id, s.priya, "intentional exception");
  assert.equal(d.status, "dismissed");
});
