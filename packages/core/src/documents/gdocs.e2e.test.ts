/**
 * v3 Phase D core — GDocs registration + native lifecycle, fuzzy anchor relocation (the
 * reverify-never-silent invariant), the source:doc.tool fix, unregister, and reconcile openConflicts.
 * Service-layer against real Postgres (DATABASE_URL).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { withSystem, withOrg } from "../db/rls.js";
import { orgs, principals, members, projects, projectMembers, repos, sourceConnections, decisions, decisionProvenances, sourceDocuments } from "../db/schema.js";
import { proposeDecision, ratifyDecision, reconcile } from "../ledger/ledger-service.js";
import {
  registerDocument,
  setDocumentState,
  unregisterDocument,
  fileDocCandidates,
  getDocument,
  listDocuments,
  getDocumentWork,
  parseGDocsFileId,
  detectDocTool,
  type DocCandidateItem,
  type CurrentSection,
} from "./document-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 400_000_000;
const uid = (): number => ++seq;
const FILE = () => `1${"x".repeat(6)}${uid().toString(36)}_ABCDEFGHIJKLMNOP`;
const SURFACE = "http:POST /payments/init";

async function setup(gdocs = true) {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `GDocsCo-${n}` }).returning());
    const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `pm-${n}` }).returning());
    const pm = one(await tx.insert(members).values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `pm-${n}` }).returning());
    const pe = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `eng-${n}` }).returning());
    const eng = one(await tx.insert(members).values({ orgId: org.id, principalId: pe.id, githubUserId: pe.githubUserId, githubLogin: `eng-${n}` }).returning());
    const proj = one(
      await tx.insert(projects).values({ orgId: org.id, name: "acme", createdBy: pm.id, settings: { productLayer: { enabled: true, gdocs } } }).returning(),
    );
    await tx.insert(projectMembers).values({ orgId: org.id, projectId: proj.id, memberId: pm.id, invitedGithubLogin: pm.githubLogin, role: "pm", status: "active" });
    await tx.insert(repos).values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/acme/svc-${n}` });
    const conn = one(
      await tx
        .insert(sourceConnections)
        .values({ orgId: org.id, projectId: proj.id, tool: "gdocs", entity: proj.id, connectedAccountId: `ca-${n}`, status: "active" })
        .returning(),
    );
    return { orgId: org.id, projectId: proj.id, pm: pm.id, eng: eng.id, connectionId: conn.id };
  });
}

const GDOC_URL = (fileId: string) => `https://docs.google.com/document/d/${fileId}/edit`;

function gdocCandidate(fileId: string, over: Partial<DocCandidateItem> & { anchorKey: string; snippet: string }): DocCandidateItem {
  const { anchorKey, snippet, ...rest } = over;
  return {
    scopeKind: "surface",
    scopeRef: SURFACE,
    ruleText: "The guest flow must not present an OTP challenge before payment.",
    constraintKind: "behavioral",
    expiresAt: null,
    expiresHint: "",
    lowConfidence: false,
    confidence: 91,
    externalId: `${fileId}#${anchorKey}`,
    contentHash: `hash-${anchorKey}-${uid()}`,
    anchor: { type: "gdoc_fuzzy", pageId: fileId, blockId: anchorKey, headingPath: ["Requirements"], snippet },
    evidence: [{ externalId: `${fileId}#${anchorKey}`, quote: snippet }],
    rationale: "",
    surfaceCandidates: [],
    ...rest,
  };
}

test("URL parsing: GDocs file id, Notion page id, tool detection", () => {
  const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
  assert.equal(parseGDocsFileId(`https://docs.google.com/document/d/${id}/edit#heading=h.x`), id);
  assert.equal(detectDocTool(`https://docs.google.com/document/d/${id}/edit`)?.tool, "gdocs");
  assert.equal(detectDocTool("https://www.notion.so/acme/Guest-00000000000040008000000000000abc")?.tool, "notion");
  assert.equal(detectDocTool("https://example.com/nope"), null);
});

test("register a GDoc by URL → native/review with tool=gdocs, attaches the gdocs connection", async () => {
  const s = await setup();
  const fileId = FILE();
  const reg = await registerDocument(s.orgId, { projectId: s.projectId, memberId: s.pm, url: GDOC_URL(fileId) });
  assert.equal(reg.externalId, fileId);
  assert.equal(reg.state, "review");
  const doc = one((await listDocuments(s.orgId, s.projectId)).documents);
  assert.equal(doc.tool, "gdocs");
  assert.equal(doc.stateAuthority, "native");
  const row = one(await withOrg(s.orgId, (tx) => tx.select().from(sourceDocuments).where(eq(sourceDocuments.id, doc.id))));
  assert.equal(row.connectionId, s.connectionId, "attaches the project's gdocs connection");

  // The source:doc.tool fix — a gdocs constraint's provenance is found (anchors surface).
  await setDocumentState(s.orgId, doc.id, s.pm, "active");
  await fileDocCandidates(doc.id, [gdocCandidate(fileId, { anchorKey: "guest-flow", snippet: "must not present an OTP challenge before payment" })]);
  const detail = (await getDocument(s.orgId, doc.id)) as { constraints: Array<{ anchor: { healthy: boolean } }> };
  assert.equal(detail.constraints.length, 1, "gdocs constraint is found via source=gdocs provenance (DD6)");
  assert.equal(detail.constraints[0]!.anchor.healthy, true);
});

test("fuzzy anchor relocation: snippet moves → valid (heading re-pointed); snippet gone → reverify, never re-pointed", async () => {
  const s = await setup();
  const fileId = FILE();
  const reg = await registerDocument(s.orgId, { projectId: s.projectId, memberId: s.pm, url: GDOC_URL(fileId) });
  await setDocumentState(s.orgId, reg.documentId, s.pm, "active");
  const snippet = "guests must be able to complete checkout without an account";
  await fileDocCandidates(reg.documentId, [gdocCandidate(fileId, { anchorKey: "guest-flow", snippet, ruleText: "Guests check out without an account." })]);
  const prov0 = one(
    await withOrg(s.orgId, (tx) =>
      tx.select().from(decisionProvenances).where(eq(decisionProvenances.source, "gdocs")),
    ),
  );
  assert.equal(prov0.anchorStatus, "valid");

  // Re-sweep: the snippet still exists but under a RENAMED heading → relocates valid, headingPath updated.
  const moved: CurrentSection[] = [{ anchorKey: "checkout-flow", headingPath: ["Requirements", "Checkout flow"], snippet }];
  const r1 = await fileDocCandidates(reg.documentId, [], "h2", ["checkout-flow"], moved);
  assert.equal(r1.reverified, 0);
  const prov1 = one(await withOrg(s.orgId, (tx) => tx.select().from(decisionProvenances).where(eq(decisionProvenances.id, prov0.id))));
  assert.equal(prov1.anchorStatus, "valid");
  assert.deepEqual((prov1.anchor as { headingPath: string[] }).headingPath, ["Requirements", "Checkout flow"], "heading re-pointed on a confident match");
  assert.equal((prov1.anchor as { snippet: string }).snippet, snippet, "snippet is NEVER rewritten");

  // Re-sweep: the snippet is gone entirely → reverify, anchor untouched.
  const gone: CurrentSection[] = [{ anchorKey: "other", headingPath: ["Something else"], snippet: "totally unrelated content about billing cycles" }];
  const r2 = await fileDocCandidates(reg.documentId, [], "h3", ["other"], gone);
  assert.equal(r2.reverified, 1);
  const prov2 = one(await withOrg(s.orgId, (tx) => tx.select().from(decisionProvenances).where(eq(decisionProvenances.id, prov0.id))));
  assert.equal(prov2.anchorStatus, "reverify");
  assert.equal((prov2.anchor as { snippet: string }).snippet, snippet, "lost anchor is never silently re-pointed");

  // Sources health surfaces it.
  const doc = one((await listDocuments(s.orgId, s.projectId)).documents);
  assert.equal(doc.anchors.needsReverify, 1);
});

test("unregister: constraints go stale, conflicts dismiss, the row disappears", async () => {
  const s = await setup();
  const fileId = FILE();
  const reg = await registerDocument(s.orgId, { projectId: s.projectId, memberId: s.pm, url: GDOC_URL(fileId) });
  await setDocumentState(s.orgId, reg.documentId, s.pm, "active");
  await fileDocCandidates(reg.documentId, [gdocCandidate(fileId, { anchorKey: "a", snippet: "no OTP before payment" })]);
  const constraint = one(await withOrg(s.orgId, (tx) => tx.select().from(decisions).where(eq(decisions.projectId, s.projectId))));
  await ratifyDecision(s.orgId, constraint.id, s.pm);

  await unregisterDocument(s.orgId, reg.documentId, s.pm);
  const after = one(await withOrg(s.orgId, (tx) => tx.select().from(decisions).where(eq(decisions.id, constraint.id))));
  assert.equal(after.status, "stale");
  assert.equal((await listDocuments(s.orgId, s.projectId)).documents.length, 0, "row removed");
});

test("getDocumentWork: gdocs native docs ride the gdocs connection with tool + debounce", async () => {
  const s = await setup();
  const fileId = FILE();
  await registerDocument(s.orgId, { projectId: s.projectId, memberId: s.pm, url: GDOC_URL(fileId) });
  const work = one((await getDocumentWork()).filter((w) => w.connectionId === s.connectionId));
  const d = one(work.docs.filter((x) => x.externalId === fileId));
  assert.equal(d.tool, "gdocs");
  // getDocumentWork stamps lastSweptAt on hand-out → within the debounce it's now suppressed.
  const again = (await getDocumentWork()).find((w) => w.connectionId === s.connectionId);
  assert.equal((again?.docs ?? []).find((x) => x.externalId === fileId), undefined, "debounced on the second pass");

  // Flag off ⇒ gdocs connection disappears from doc work.
  await withOrg(s.orgId, (tx) => tx.update(projects).set({ settings: { productLayer: { enabled: true, gdocs: false } } }).where(eq(projects.id, s.projectId)));
  assert.equal((await getDocumentWork()).find((w) => w.connectionId === s.connectionId), undefined);
});

test("reconcile returns openConflicts on changed surfaces, enriched with rule texts", async () => {
  const s = await setup();
  const fileId = FILE();
  const reg = await registerDocument(s.orgId, { projectId: s.projectId, memberId: s.pm, url: GDOC_URL(fileId) });
  await setDocumentState(s.orgId, reg.documentId, s.pm, "active");
  await fileDocCandidates(reg.documentId, [gdocCandidate(fileId, { anchorKey: "a", snippet: "no OTP before payment" })]);
  const constraint = one(await withOrg(s.orgId, (tx) => tx.select().from(decisions).where(and(eq(decisions.projectId, s.projectId), eq(decisions.origin, "document")))));
  await ratifyDecision(s.orgId, constraint.id, s.pm);
  // An eng decision binds on the same surface → drift.
  await proposeDecision(s.orgId, { projectId: s.projectId, memberId: s.eng, scopeKind: "surface", scopeRef: SURFACE, ruleText: "OTP on all payment inits.", baseVersion: 0 });

  const rec = await reconcile(s.orgId, s.projectId, [SURFACE]);
  assert.equal(rec.openConflicts.length, 1);
  assert.equal(rec.openConflicts[0]!.surface, SURFACE);
  assert.match(rec.openConflicts[0]!.constraintRuleText, /OTP challenge before payment/);
  assert.match(rec.openConflicts[0]!.engRuleText, /OTP on all/);
  assert.ok(rec.openConflicts[0]!.conflictId);
  // A surface with no conflict → empty.
  const clean = await reconcile(s.orgId, s.projectId, ["http:GET /health"]);
  assert.equal(clean.openConflicts.length, 0);
});
