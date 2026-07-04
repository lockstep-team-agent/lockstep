import { and, desc, eq } from "drizzle-orm";
import { withOrg, type Tx } from "../db/rls.js";
import {
  decisions,
  decisionVersions,
  decisionApprovals,
  dependencyEdges,
  changeFeedEntries,
  contracts,
  questions,
  answers,
  tasks,
  members,
  repos,
  ingestArtifacts,
  decisionProvenances,
  graphNodes,
  graphEdges,
} from "../db/schema.js";
import { writeAudit } from "../audit/audit-service.js";
import { fanoutChangeTx, fanoutToProjectTx } from "../routing/routing-engine.js";
import { upsertNodeTx, upsertEdgeTx } from "../graph/graph-service.js";
import { canRatifyTx } from "../auth/permissions.js";
import { sourceDocuments } from "../db/schema.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409 });
}

const SURFACE_SCOPES = new Set(["surface", "contract", "shared"]);

/** Distinct consumers of a surface in the usage graph = its blast radius. */
async function consumerCountTx(tx: Tx, projectId: string, surface: string): Promise<number> {
  const edges = await tx
    .select()
    .from(dependencyEdges)
    .where(
      and(
        eq(dependencyEdges.projectId, projectId),
        eq(dependencyEdges.producedSurface, surface),
        eq(dependencyEdges.active, true),
      ),
    );
  return new Set(edges.map((e) => e.consumerRepoId)).size;
}

/**
 * Impact = blast radius of a scoped decision/change, derived from the usage graph. Surface-scoped
 * items use their consumer count; a project-wide rule affects every other repo; other scopes default
 * low. This single number drives the binding model and session-start ranking (see the product thesis).
 */
async function impactForScopeTx(tx: Tx, projectId: string, scopeKind: string, scopeRef: string): Promise<number> {
  if (SURFACE_SCOPES.has(scopeKind)) return consumerCountTx(tx, projectId, scopeRef);
  if (scopeKind === "project") {
    const rs = await tx.select().from(repos).where(eq(repos.projectId, projectId));
    return Math.max(0, rs.length - 1);
  }
  // Non-code decision: blast radius = how many people/teams the org graph links to this topic.
  if (scopeKind === "topic") return topicImpactTx(tx, projectId, scopeRef);
  // v3 product constraint scoped to a feature: max consumer count across its confirmed governed
  // surfaces (max, not sum — one hot surface should rank the constraint high even if the feature
  // also touches dead endpoints).
  if (scopeKind === "capability") return capabilityImpactTx(tx, projectId, scopeRef);
  return 0;
}

/** Governed surfaces of a capability node — CONFIRMED governs edges only (proposed edges never scope). */
export async function capabilitySurfacesTx(tx: Tx, projectId: string, capabilityRef: string): Promise<string[]> {
  const node = (
    await tx
      .select()
      .from(graphNodes)
      .where(and(eq(graphNodes.projectId, projectId), eq(graphNodes.kind, "capability"), eq(graphNodes.ref, capabilityRef)))
      .limit(1)
  )[0];
  if (!node) return [];
  const edges = await tx
    .select()
    .from(graphEdges)
    .where(and(eq(graphEdges.projectId, projectId), eq(graphEdges.fromId, node.id), eq(graphEdges.kind, "governs"), eq(graphEdges.status, "confirmed")));
  if (edges.length === 0) return [];
  const surfaces = await tx
    .select()
    .from(graphNodes)
    .where(and(eq(graphNodes.projectId, projectId), eq(graphNodes.kind, "surface")));
  const toIds = new Set(edges.map((e) => e.toId));
  return surfaces.filter((s) => toIds.has(s.id)).map((s) => s.ref);
}

async function capabilityImpactTx(tx: Tx, projectId: string, capabilityRef: string): Promise<number> {
  const surfaces = await capabilitySurfacesTx(tx, projectId, capabilityRef);
  let max = 0;
  for (const s of surfaces) max = Math.max(max, await consumerCountTx(tx, projectId, s));
  return max;
}

/** Org-graph impact for a topic node: distinct person/team neighbours (0 if the graph isn't derived yet). */
async function topicImpactTx(tx: Tx, projectId: string, topicRef: string): Promise<number> {
  const node = (
    await tx
      .select()
      .from(graphNodes)
      .where(and(eq(graphNodes.projectId, projectId), eq(graphNodes.kind, "topic"), eq(graphNodes.ref, topicRef)))
      .limit(1)
  )[0];
  if (!node) return 0;
  const edges = await tx.select().from(graphEdges).where(eq(graphEdges.projectId, projectId));
  const neighbourIds = new Set<string>();
  for (const e of edges) {
    if (e.fromId === node.id) neighbourIds.add(e.toId);
    else if (e.toId === node.id) neighbourIds.add(e.fromId);
  }
  if (neighbourIds.size === 0) return 0;
  const people = await tx.select().from(graphNodes).where(and(eq(graphNodes.projectId, projectId), eq(graphNodes.kind, "person")));
  return people.filter((p) => neighbourIds.has(p.id)).length;
}

export interface ProposeInput {
  projectId: string;
  memberId: string;
  scopeKind: string; // surface | repo | topic | project | shared | contract
  scopeRef: string;
  ruleText: string;
  baseVersion: number; // CAS: must equal the decision's current version (0 for new)
  decisionType?: string; // rule | architecture (default rule)
  provenance?: unknown;
}

/**
 * Propose a decision with optimistic concurrency. New version only commits if
 * baseVersion matches the decision's current version, else 409 (caller re-bases).
 * Owner-scoped → binding immediately; shared/contract → open until acked.
 */
export async function proposeDecision(
  orgId: string,
  input: ProposeInput,
): Promise<{ decisionId: string; version: number; status: string; impact: number }> {
  return withOrg(orgId, async (tx: Tx) => {
    const existing = (
      await tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.projectId, input.projectId),
            eq(decisions.scopeKind, input.scopeKind),
            eq(decisions.scopeRef, input.scopeRef),
          ),
        )
        .limit(1)
    )[0];

    let decisionId: string;
    let currentVersion: number;

    if (!existing) {
      if (input.baseVersion !== 0) throw conflict(`stale base_version: expected 0, got ${input.baseVersion}`);
      const d = one(
        await tx
          .insert(decisions)
          .values({
            orgId,
            projectId: input.projectId,
            scopeKind: input.scopeKind,
            scopeRef: input.scopeRef,
            decisionType: input.decisionType ?? "rule",
            currentVersion: 0,
            status: "open",
          })
          .returning(),
      );
      decisionId = d.id;
      currentVersion = 0;
    } else {
      if (existing.currentVersion !== input.baseVersion) {
        throw conflict(`stale base_version: current is ${existing.currentVersion}, got ${input.baseVersion}`);
      }
      decisionId = existing.id;
      currentVersion = existing.currentVersion;
    }

    // Mixed binding model (impact-driven): a cross-cutting decision (impact > 0 — touches a surface
    // others consume, or a project-wide rule) stays `open` until an affected team acks it; an
    // own-area decision (impact 0) binds on assertion. Replaces the old scopeKind-name gate.
    const impact = await impactForScopeTx(tx, input.projectId, input.scopeKind, input.scopeRef);
    const needsAck = impact > 0;
    const version = currentVersion + 1;
    const status = needsAck ? "open" : "binding";
    await tx.insert(decisionVersions).values({
      orgId,
      decisionId,
      version,
      baseVersion: input.baseVersion,
      ruleText: input.ruleText,
      provenance: input.provenance ?? null,
      status,
      proposedBy: input.memberId,
    });
    await tx
      .update(decisions)
      .set({ currentVersion: version, status, impact })
      .where(eq(decisions.id, decisionId));
    await writeAudit(tx, {
      orgId,
      projectId: input.projectId,
      actorMemberId: input.memberId,
      action: "decision.proposed",
      entityKind: "decision",
      entityId: decisionId,
      entityVersion: version,
      payload: { scopeKind: input.scopeKind, scopeRef: input.scopeRef, status, impact },
    });
    // Fan out decisions awaiting acknowledgement so affected members see them in their inbox.
    if (needsAck) {
      await fanoutToProjectTx(tx, orgId, {
        projectId: input.projectId,
        refId: decisionId,
        kind: "decision",
        senderMemberId: input.memberId,
        reason: { scopeRef: input.scopeRef, ruleText: input.ruleText, impact },
      });
    }
    return { decisionId, version, status, impact };
  });
}

/** Ack/review a shared decision; an approval promotes it to binding (v1: first ack binds). */
export async function ackDecision(
  orgId: string,
  decisionId: string,
  version: number,
  memberId: string,
  verdict = "ack",
): Promise<{ status: string }> {
  return withOrg(orgId, async (tx) => {
    const d = (await tx.select().from(decisions).where(eq(decisions.id, decisionId)).limit(1))[0];
    if (!d) throw Object.assign(new Error("decision not found"), { statusCode: 404 });
    await tx.insert(decisionApprovals).values({ orgId, decisionId, version, reviewerId: memberId, verdict });
    let status = d.status;
    if ((verdict === "ack" || verdict === "approve") && d.status === "open") {
      status = "binding";
      await tx.update(decisions).set({ status }).where(eq(decisions.id, decisionId));
    }
    await writeAudit(tx, {
      orgId,
      projectId: d.projectId,
      actorMemberId: memberId,
      action: "decision.acked",
      entityKind: "decision",
      entityId: decisionId,
      entityVersion: version,
      payload: { verdict, status },
    });
    return { status };
  });
}

/* ───────────────────────────── v2: ingested (proposed) decisions ───────────────────────────── */

const STOPWORDS = new Set(["the", "a", "an", "is", "are", "to", "of", "and", "or", "for", "with", "we", "our", "be", "on", "in"]);

/** Cheap lexical similarity (Jaccard over content words) — the v1 dedup/fusion signal (no embeddings yet). */
function similar(a: string, b: string): number {
  const toks = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
    );
  const A = toks(a);
  const B = toks(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

async function addProvenanceTx(
  tx: Tx,
  orgId: string,
  decisionId: string,
  prov: {
    source?: string;
    url?: string | null;
    evidence?: unknown;
    externalId?: string | null;
    confidence?: number;
    anchor?: unknown; // v3 document constraints: exact origin location in the source doc
  },
): Promise<void> {
  const source = prov.source ?? "unknown";
  const externalId = prov.externalId ?? null;
  const existing = (
    await tx
      .select()
      .from(decisionProvenances)
      .where(
        and(
          eq(decisionProvenances.decisionId, decisionId),
          eq(decisionProvenances.source, source),
          externalId === null ? eq(decisionProvenances.externalId, "") : eq(decisionProvenances.externalId, externalId),
        ),
      )
      .limit(1)
  )[0];
  if (existing) return;
  await tx.insert(decisionProvenances).values({
    orgId,
    decisionId,
    source,
    externalId,
    url: prov.url ?? null,
    evidence: prov.evidence ?? null,
    confidence: prov.confidence ?? null,
    anchor: prov.anchor ?? null,
  });
}

/** All provenance rows for a project's decisions, grouped by decision id (for the review queue UI). */
export async function listProvenancesForProject(
  orgId: string,
  projectId: string,
): Promise<Record<string, Array<{ source: string; externalId: string | null; url: string | null; evidence: unknown; confidence: number | null }>>> {
  return withOrg(orgId, async (tx) => {
    const ds = await tx.select({ id: decisions.id }).from(decisions).where(eq(decisions.projectId, projectId));
    const ids = new Set(ds.map((d) => d.id));
    const rows = await tx.select().from(decisionProvenances).where(eq(decisionProvenances.orgId, orgId));
    const out: Record<string, Array<{ source: string; externalId: string | null; url: string | null; evidence: unknown; confidence: number | null }>> = {};
    for (const r of rows) {
      if (!ids.has(r.decisionId)) continue;
      (out[r.decisionId] ??= []).push({ source: r.source, externalId: r.externalId, url: r.url, evidence: r.evidence, confidence: r.confidence });
    }
    return out;
  });
}

export interface FileProposedInput {
  projectId: string;
  scopeKind: string; // surface | repo | topic | project | shared | contract | capability (v3)
  scopeRef: string;
  ruleText: string;
  decisionType?: string; // rule | architecture
  provenance: unknown; // {source, connectionId, externalId, url, evidence[], extractorModel, confidence, decidedBy, decidedAt}
  // idempotency + tuning audit keys (from the ingest funnel)
  connectionId: string;
  externalId: string;
  contentHash: string;
  confidence?: number; // 0..100
  // v3 document constraints (origin=document). The v2 conversation path leaves all of these unset.
  origin?: string; // ingested (default) | document
  constraintKind?: string; // behavioral | launch_gate | scope_exclusion
  expiresAt?: Date | null;
  anchor?: unknown; // stored on the provenance row — exact origin location in the source doc
}

/**
 * File a decision distilled from a human tool (Slack/Jira/Notion) as a **proposed** draft. It is
 * `origin:"ingested"`, `status:"proposed"`, non-binding, and does NOT fan out — a human confirms it in
 * the review queue before it can bind. Idempotent on (connectionId, externalId, contentHash): a
 * re-seen unit returns the existing decision instead of minting a duplicate.
 */
export async function fileProposedDecision(
  orgId: string,
  input: FileProposedInput,
): Promise<{ decisionId: string; deduped: boolean; fused: boolean; supersedes?: string }> {
  const prov = (input.provenance ?? {}) as { source?: string; url?: string | null; evidence?: unknown };
  const origin = input.origin ?? "ingested";
  const provRow = {
    source: prov.source,
    url: prov.url ?? null,
    evidence: prov.evidence,
    externalId: input.externalId,
    confidence: input.confidence,
    anchor: input.anchor ?? null,
  };
  return withOrg(orgId, async (tx) => {
    // Idempotency: a re-seen unit (same content) is never re-processed.
    const seen = (
      await tx
        .select()
        .from(ingestArtifacts)
        .where(
          and(
            eq(ingestArtifacts.connectionId, input.connectionId),
            eq(ingestArtifacts.externalId, input.externalId),
            eq(ingestArtifacts.contentHash, input.contentHash),
          ),
        )
        .limit(1)
    )[0];
    if (seen) return { decisionId: seen.decisionId ?? "", deduped: true, fused: false };

    // Fusion + supersession: scan live decisions in the same scope. Document constraints only ever
    // fuse into other document constraints — fusing a PRD constraint into a binding engineering
    // decision would swallow it before ratification (and the co-location conflict, not a supersedes
    // hint, is the honest signal for that collision).
    const scopeMates = await tx
      .select()
      .from(decisions)
      .where(and(eq(decisions.projectId, input.projectId), eq(decisions.scopeRef, input.scopeRef)));
    let fuseInto: string | null = null;
    let supersedes: string | undefined;
    for (const m of scopeMates) {
      if (m.status === "rejected" || m.status === "superseded") continue;
      if (origin === "document" && m.origin !== "document") continue;
      const v = (
        await tx
          .select()
          .from(decisionVersions)
          .where(and(eq(decisionVersions.decisionId, m.id), eq(decisionVersions.version, m.currentVersion)))
          .limit(1)
      )[0];
      const sim = similar(input.ruleText, v?.ruleText ?? "");
      if (sim >= 0.6) {
        fuseInto = m.id;
        break;
      }
      if (origin !== "document" && m.status === "binding" && sim < 0.4) supersedes = m.id; // different rule, same scope → likely supersession
    }

    if (fuseInto) {
      // One decision, many provenances — attach this source instead of minting a duplicate.
      await addProvenanceTx(tx, orgId, fuseInto, provRow);
      await tx.insert(ingestArtifacts).values({
        orgId,
        connectionId: input.connectionId,
        externalId: input.externalId,
        contentHash: input.contentHash,
        status: "fused",
        confidence: input.confidence ?? null,
        decisionId: fuseInto,
      });
      await writeAudit(tx, {
        orgId,
        projectId: input.projectId,
        action: "decision.provenance_added",
        entityKind: "decision",
        entityId: fuseInto,
        payload: { source: prov.source, externalId: input.externalId },
      });
      return { decisionId: fuseInto, deduped: false, fused: true };
    }

    const d = one(
      await tx
        .insert(decisions)
        .values({
          orgId,
          projectId: input.projectId,
          scopeKind: input.scopeKind,
          scopeRef: input.scopeRef,
          decisionType: input.decisionType ?? "rule",
          currentVersion: 1,
          status: "proposed",
          origin,
          constraintKind: input.constraintKind ?? null,
          expiresAt: input.expiresAt ?? null,
        })
        .returning(),
    );
    await tx.insert(decisionVersions).values({
      orgId,
      decisionId: d.id,
      version: 1,
      baseVersion: 0,
      ruleText: input.ruleText,
      provenance: supersedes ? { ...(input.provenance as object), supersedes } : (input.provenance ?? null),
      status: "proposed",
    });
    await addProvenanceTx(tx, orgId, d.id, provRow);
    await tx.insert(ingestArtifacts).values({
      orgId,
      connectionId: input.connectionId,
      externalId: input.externalId,
      contentHash: input.contentHash,
      status: "proposed",
      confidence: input.confidence ?? null,
      decisionId: d.id,
    });
    await writeAudit(tx, {
      orgId,
      projectId: input.projectId,
      action: "decision.proposed",
      entityKind: "decision",
      entityId: d.id,
      entityVersion: 1,
      payload: { scopeKind: input.scopeKind, scopeRef: input.scopeRef, origin, status: "proposed", supersedes },
    });
    return { decisionId: d.id, deduped: false, fused: false, supersedes };
  });
}

/**
 * Confirm a proposed (ingested) decision: run the same impact/binding path as an agent-authored
 * decision (own-area binds on assertion; cross-cutting stays `open` until acked and fans out). Optional
 * `edits` overwrite the current version's rule text / scope before confirming.
 */
export async function confirmDecision(
  orgId: string,
  decisionId: string,
  memberId: string,
  edits?: { ruleText?: string; scopeKind?: string; scopeRef?: string },
): Promise<{ status: string; impact: number }> {
  return withOrg(orgId, async (tx) => {
    const d = (await tx.select().from(decisions).where(eq(decisions.id, decisionId)).limit(1))[0];
    if (!d) throw Object.assign(new Error("decision not found"), { statusCode: 404 });
    if (d.status !== "proposed") throw conflict(`decision is ${d.status}, not proposed`);

    // decision_versions is append-only, so edits are a new version, never an in-place UPDATE.
    const cur = (
      await tx
        .select()
        .from(decisionVersions)
        .where(and(eq(decisionVersions.decisionId, decisionId), eq(decisionVersions.version, d.currentVersion)))
        .limit(1)
    )[0];
    const scopeKind = edits?.scopeKind ?? d.scopeKind;
    const scopeRef = edits?.scopeRef ?? d.scopeRef;
    const ruleText = edits?.ruleText ?? cur?.ruleText ?? "";
    const edited = Boolean(edits?.ruleText || edits?.scopeKind || edits?.scopeRef);

    const impact = await impactForScopeTx(tx, d.projectId, scopeKind, scopeRef);
    const needsAck = impact > 0;
    const status = needsAck ? "open" : "binding";
    let version = d.currentVersion;
    if (edited) {
      version = d.currentVersion + 1;
      await tx.insert(decisionVersions).values({
        orgId,
        decisionId,
        version,
        baseVersion: d.currentVersion,
        ruleText,
        provenance: cur?.provenance ?? null,
        status,
        proposedBy: memberId,
      });
    }
    await tx
      .update(decisions)
      .set({ scopeKind, scopeRef, status, impact, currentVersion: version })
      .where(eq(decisions.id, decisionId));
    await writeAudit(tx, {
      orgId,
      projectId: d.projectId,
      actorMemberId: memberId,
      action: "decision.confirmed",
      entityKind: "decision",
      entityId: decisionId,
      entityVersion: version,
      payload: { scopeKind, scopeRef, status, impact, origin: d.origin },
    });
    if (needsAck) {
      await fanoutToProjectTx(tx, orgId, {
        projectId: d.projectId,
        refId: decisionId,
        kind: "decision",
        senderMemberId: memberId,
        reason: { scopeRef, ruleText, impact },
      });
    }
    return { status, impact };
  });
}

/**
 * Ratify a proposed document constraint (v3). Deliberately NOT confirmDecision: a ratified product
 * constraint binds on the PM's word regardless of impact and never fans out to inboxes — impact is
 * recomputed for ranking only. Requires the source document to be `active` (extraction runs at
 * `review`, but nothing binds from a PRD that might die in review) and an authorized member
 * (owner/pm role, doc owner, or registrant). An edited ruleText appends a CAS version — the anchor
 * keeps pointing at the source; the edit is attributable in decision_versions.
 */
export async function ratifyDecision(
  orgId: string,
  decisionId: string,
  memberId: string,
  opts?: { ruleText?: string },
): Promise<{ status: string; version: number; impact: number }> {
  return withOrg(orgId, async (tx) => {
    const d = (await tx.select().from(decisions).where(eq(decisions.id, decisionId)).limit(1))[0];
    if (!d) throw Object.assign(new Error("decision not found"), { statusCode: 404 });
    if (d.origin !== "document") throw conflict(`only document constraints are ratified (origin is ${d.origin})`);
    if (d.status !== "proposed") throw conflict(`decision is ${d.status}, not proposed`);

    const cur = (
      await tx
        .select()
        .from(decisionVersions)
        .where(and(eq(decisionVersions.decisionId, decisionId), eq(decisionVersions.version, d.currentVersion)))
        .limit(1)
    )[0];
    const provJson = (cur?.provenance ?? {}) as { documentId?: string };
    const doc = provJson.documentId
      ? (await tx.select().from(sourceDocuments).where(eq(sourceDocuments.id, provJson.documentId)).limit(1))[0]
      : undefined;
    if (!doc) throw conflict("constraint has no source document");
    if (doc.state !== "active")
      throw Object.assign(new Error("document_not_active"), { statusCode: 409, code: "document_not_active" });
    if (!(await canRatifyTx(tx, { projectId: d.projectId, memberId, doc })))
      throw Object.assign(new Error("ratify requires owner/pm role or document ownership"), { statusCode: 403 });

    // decision_versions is append-only — an edited rule is a new version, never an in-place UPDATE.
    let version = d.currentVersion;
    const editedText = opts?.ruleText?.trim();
    if (editedText && editedText !== cur?.ruleText) {
      version = d.currentVersion + 1;
      await tx.insert(decisionVersions).values({
        orgId,
        decisionId,
        version,
        baseVersion: d.currentVersion,
        ruleText: editedText,
        provenance: cur?.provenance ?? null,
        status: "binding",
        proposedBy: memberId,
      });
    }
    const impact = await impactForScopeTx(tx, d.projectId, d.scopeKind, d.scopeRef);
    await tx.insert(decisionApprovals).values({ orgId, decisionId, version, reviewerId: memberId, verdict: "ratify" });
    await tx.update(decisions).set({ status: "binding", impact, currentVersion: version }).where(eq(decisions.id, decisionId));

    // First ratification of a capability-scoped constraint mints the capability node and links the
    // source doc to it, giving the org graph its product layer.
    if (d.scopeKind === "capability") {
      const label = d.scopeRef.replace(/^feature:|^metric:/, "").replace(/-/g, " ");
      const capId = await upsertNodeTx(tx, orgId, d.projectId, "capability", d.scopeRef, doc.title ?? label);
      const docNodeId = await upsertNodeTx(
        tx,
        orgId,
        d.projectId,
        "doc",
        `${doc.tool}:${doc.externalId}`,
        doc.title ?? doc.externalId,
      );
      await upsertEdgeTx(tx, orgId, d.projectId, docNodeId, capId, "owns");
    }

    await writeAudit(tx, {
      orgId,
      projectId: d.projectId,
      actorMemberId: memberId,
      action: "constraint.ratified",
      entityKind: "decision",
      entityId: decisionId,
      entityVersion: version,
      payload: { scopeKind: d.scopeKind, scopeRef: d.scopeRef, documentId: doc.id, edited: version !== d.currentVersion },
    });
    return { status: "binding", version, impact };
  });
}

/** Reject a proposed (ingested or document) decision — a human declined it. It never binds. */
export async function rejectDecision(
  orgId: string,
  decisionId: string,
  memberId: string,
): Promise<{ status: string }> {
  return withOrg(orgId, async (tx) => {
    const d = (await tx.select().from(decisions).where(eq(decisions.id, decisionId)).limit(1))[0];
    if (!d) throw Object.assign(new Error("decision not found"), { statusCode: 404 });
    // decision_versions is append-only; the live status lives on decisions.status.
    await tx.update(decisions).set({ status: "rejected" }).where(eq(decisions.id, decisionId));
    await writeAudit(tx, {
      orgId,
      projectId: d.projectId,
      actorMemberId: memberId,
      action: d.origin === "document" ? "constraint.rejected" : "decision.rejected",
      entityKind: "decision",
      entityId: decisionId,
      entityVersion: d.currentVersion,
    });
    return { status: "rejected" };
  });
}

export async function listDecisions(
  orgId: string,
  projectId: string,
  scopeRef?: string,
  opts?: { status?: string; origin?: string },
): Promise<
  Array<{
    id: string;
    scopeKind: string;
    scopeRef: string;
    status: string;
    origin: string;
    version: number;
    ruleText: string;
    provenance: unknown;
    decisionType: string;
    impact: number;
    createdAt: Date;
  }>
> {
  return withOrg(orgId, async (tx) => {
    const ds = await tx.select().from(decisions).where(eq(decisions.projectId, projectId));
    const out = [];
    for (const d of ds) {
      if (scopeRef && d.scopeRef !== scopeRef) continue;
      if (opts?.status && d.status !== opts.status) continue;
      if (opts?.origin && d.origin !== opts.origin) continue;
      const v = (
        await tx
          .select()
          .from(decisionVersions)
          .where(and(eq(decisionVersions.decisionId, d.id), eq(decisionVersions.version, d.currentVersion)))
          .limit(1)
      )[0];
      out.push({
        id: d.id,
        scopeKind: d.scopeKind,
        scopeRef: d.scopeRef,
        status: d.status,
        origin: d.origin,
        version: d.currentVersion,
        ruleText: v?.ruleText ?? "",
        provenance: v?.provenance ?? null,
        decisionType: d.decisionType,
        impact: d.impact,
        createdAt: d.createdAt,
      });
    }
    return out;
  });
}

export async function registerDependency(
  orgId: string,
  input: {
    projectId: string;
    memberId: string;
    consumerRepoId: string;
    producedSurface: string;
    producedRepoId?: string | null;
    source?: string;
  },
): Promise<{ edgeId: string }> {
  return withOrg(orgId, async (tx) => {
    // Idempotent: the manifest is re-synced every session, so an identical (consumer, surface) edge
    // must not duplicate. Return the existing active edge if present.
    const existing = (
      await tx
        .select()
        .from(dependencyEdges)
        .where(
          and(
            eq(dependencyEdges.consumerRepoId, input.consumerRepoId),
            eq(dependencyEdges.producedSurface, input.producedSurface),
            eq(dependencyEdges.active, true),
          ),
        )
        .limit(1)
    )[0];
    if (existing) return { edgeId: existing.id };

    const edge = one(
      await tx
        .insert(dependencyEdges)
        .values({
          orgId,
          projectId: input.projectId,
          consumerRepoId: input.consumerRepoId,
          producedRepoId: input.producedRepoId ?? null,
          producedSurface: input.producedSurface,
          source: input.source ?? "register_dependency",
          createdBy: input.memberId,
        })
        .returning(),
    );
    await writeAudit(tx, {
      orgId,
      projectId: input.projectId,
      actorMemberId: input.memberId,
      action: "dependency.registered",
      entityKind: "dependency_edge",
      entityId: edge.id,
      payload: { consumerRepoId: input.consumerRepoId, producedSurface: input.producedSurface },
    });
    return { edgeId: edge.id };
  });
}

/**
 * Who consumes a given surface? Backs the agent's "does anyone use this endpoint?" question so it can
 * answer instantly from the usage graph instead of pinging a human. Excludes the asking repo.
 */
export async function listConsumers(
  orgId: string,
  projectId: string,
  surface: string,
  askingRepoId?: string,
): Promise<{ surface: string; count: number; consumers: Array<{ repoId: string; gitRemote: string }> }> {
  return withOrg(orgId, async (tx) => {
    const edges = await tx
      .select()
      .from(dependencyEdges)
      .where(
        and(
          eq(dependencyEdges.projectId, projectId),
          eq(dependencyEdges.producedSurface, surface),
          eq(dependencyEdges.active, true),
        ),
      );
    const repoIds = [...new Set(edges.map((e) => e.consumerRepoId))].filter((r) => r !== askingRepoId);
    const consumers: Array<{ repoId: string; gitRemote: string }> = [];
    for (const repoId of repoIds) {
      const r = (await tx.select().from(repos).where(eq(repos.id, repoId)).limit(1))[0];
      consumers.push({ repoId, gitRemote: r?.gitRemote ?? "(unknown)" });
    }
    return { surface, count: consumers.length, consumers };
  });
}

export interface NotifyInput {
  projectId: string;
  repoId: string;
  memberId: string;
  summary: string;
  surface?: string;
  contractDelta?: unknown;
  riskTier?: string; // owned | shared | contract
  verified?: boolean;
  verifiedAgainst?: string;
  diffHash?: string;
}

/** Record a change-feed entry (+ contract if a delta is supplied). Routing happens in P5. */
export async function recordChange(
  orgId: string,
  input: NotifyInput,
): Promise<{ changeId: string; publishState: string; delivered: number; impact: number }> {
  const riskTier = input.riskTier ?? "owned";
  const publishState = riskTier === "owned" ? "published" : "pending_confirm";
  return withOrg(orgId, async (tx) => {
    let contractId: string | null = null;
    if (input.contractDelta !== undefined && input.surface) {
      const c = one(
        await tx
          .insert(contracts)
          .values({
            orgId,
            repoId: input.repoId,
            surface: input.surface,
            delta: input.contractDelta ?? null,
            verified: input.verified ?? false,
            verifiedAgainst: input.verifiedAgainst ?? null,
            verificationStatus: input.verified ? "verified" : "asserted_unverified",
            createdBy: input.memberId,
          })
          .returning(),
      );
      contractId = c.id;
    }
    // Impact = blast radius: how many repos consume the changed surface (the precise fan-out target).
    const impact = input.surface ? await consumerCountTx(tx, input.projectId, input.surface) : 0;
    const change = one(
      await tx
        .insert(changeFeedEntries)
        .values({
          orgId,
          projectId: input.projectId,
          repoId: input.repoId,
          summary: input.summary,
          contractId,
          surface: input.surface ?? null,
          riskTier,
          impact,
          publishState,
          diffHash: input.diffHash ?? null,
          createdBy: input.memberId,
        })
        .returning(),
    );
    await writeAudit(tx, {
      orgId,
      projectId: input.projectId,
      actorMemberId: input.memberId,
      action: "change.published",
      entityKind: "change_feed_entry",
      entityId: change.id,
      payload: { surface: input.surface, riskTier, publishState },
    });

    // Route to consumers of the changed surface (dependency-graph fan-out).
    let delivered = 0;
    if (input.surface) {
      delivered = await fanoutChangeTx(tx, orgId, {
        projectId: input.projectId,
        changeId: change.id,
        surface: input.surface,
        senderRepoId: input.repoId,
        senderMemberId: input.memberId,
      });
    }
    return { changeId: change.id, publishState, delivered, impact };
  });
}

/* ───────────────────────────── Questions ───────────────────────────── */

export async function askQuestion(
  orgId: string,
  input: { projectId: string; memberId: string; body: string; scopeRef?: string; urgent?: boolean },
): Promise<{ questionId: string; status: string }> {
  return withOrg(orgId, async (tx) => {
    const q = one(
      await tx
        .insert(questions)
        .values({
          orgId,
          projectId: input.projectId,
          scopeKind: input.scopeRef ? "surface" : "project",
          scopeRef: input.scopeRef ?? null,
          body: input.body,
          urgent: input.urgent ?? false,
          askedBy: input.memberId,
        })
        .returning(),
    );
    await writeAudit(tx, {
      orgId,
      projectId: input.projectId,
      actorMemberId: input.memberId,
      action: "question.asked",
      entityKind: "question",
      entityId: q.id,
    });
    await fanoutToProjectTx(tx, orgId, {
      projectId: input.projectId,
      refId: q.id,
      kind: "question",
      senderMemberId: input.memberId,
      reason: { body: input.body, scopeRef: input.scopeRef ?? null, urgent: input.urgent ?? false },
    });
    return { questionId: q.id, status: q.status };
  });
}

export async function answerQuestion(
  orgId: string,
  questionId: string,
  memberId: string,
  response: string,
): Promise<{ answerId: string; status: string }> {
  return withOrg(orgId, async (tx) => {
    const q = (await tx.select().from(questions).where(eq(questions.id, questionId)).limit(1))[0];
    if (!q) throw Object.assign(new Error("question not found"), { statusCode: 404 });
    const ans = one(
      await tx.insert(answers).values({ orgId, questionId, body: response, answeredBy: memberId }).returning(),
    );
    await tx.update(questions).set({ status: "answered" }).where(eq(questions.id, questionId));
    await writeAudit(tx, {
      orgId,
      projectId: q.projectId,
      actorMemberId: memberId,
      action: "question.answered",
      entityKind: "question",
      entityId: questionId,
    });
    return { answerId: ans.id, status: "answered" };
  });
}

/* ───────────────────────────── Tasks ───────────────────────────── */

export async function createTask(
  orgId: string,
  input: { projectId: string; memberId: string; title: string; to?: string; refs?: unknown },
): Promise<{ taskId: string; runState: string }> {
  return withOrg(orgId, async (tx) => {
    let delegatedTo: string | null = null;
    if (input.to) {
      const m = (
        await tx
          .select()
          .from(members)
          .where(and(eq(members.orgId, orgId), eq(members.githubLogin, input.to)))
          .limit(1)
      )[0];
      delegatedTo = m?.id ?? null;
    }
    const t = one(
      await tx
        .insert(tasks)
        .values({
          orgId,
          projectId: input.projectId,
          title: input.title,
          refs: input.refs ?? null,
          delegatedBy: input.memberId,
          delegatedTo,
          approver: delegatedTo,
          runState: "queued",
          status: "open",
        })
        .returning(),
    );
    await writeAudit(tx, {
      orgId,
      projectId: input.projectId,
      actorMemberId: input.memberId,
      action: "task.delegated",
      entityKind: "task",
      entityId: t.id,
    });
    await fanoutToProjectTx(tx, orgId, {
      projectId: input.projectId,
      refId: t.id,
      kind: "task",
      senderMemberId: input.memberId,
      targetMemberId: delegatedTo,
      reason: { title: input.title, to: input.to ?? null },
    });
    return { taskId: t.id, runState: t.runState };
  });
}

export async function completeTask(orgId: string, taskId: string, memberId: string): Promise<{ status: string }> {
  return withOrg(orgId, async (tx) => {
    const t = (await tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0];
    if (!t) throw Object.assign(new Error("task not found"), { statusCode: 404 });
    await tx.update(tasks).set({ runState: "done", status: "closed" }).where(eq(tasks.id, taskId));
    await writeAudit(tx, {
      orgId,
      projectId: t.projectId,
      actorMemberId: memberId,
      action: "task.completed",
      entityKind: "task",
      entityId: taskId,
    });
    return { status: "done" };
  });
}

/* ───────────────────────────── Tier-2 reconcile (the hard gate) ───────────────────────────── */

/**
 * Reconcile a set of changed contract surfaces against the ledger. A contract change
 * with no binding decision is a violation (PR check fails). Also surfaces stale dependents.
 */
export async function reconcile(
  orgId: string,
  projectId: string,
  contractSurfaces: string[],
): Promise<{ ok: boolean; violations: string[]; staleDependents: Array<{ surface: string; consumers: string[] }> }> {
  return withOrg(orgId, async (tx) => {
    const violations: string[] = [];
    const staleDependents: Array<{ surface: string; consumers: string[] }> = [];
    for (const surface of contractSurfaces) {
      const d = (
        await tx
          .select()
          .from(decisions)
          .where(and(eq(decisions.projectId, projectId), eq(decisions.scopeRef, surface)))
          .limit(1)
      )[0];
      if (!d || d.status !== "binding") violations.push(surface);
      const deps = await tx
        .select()
        .from(dependencyEdges)
        .where(and(eq(dependencyEdges.producedSurface, surface), eq(dependencyEdges.active, true)));
      if (deps.length > 0) {
        staleDependents.push({ surface, consumers: [...new Set(deps.map((e) => e.consumerRepoId))] });
      }
    }
    return { ok: violations.length === 0, violations, staleDependents };
  });
}

/** Retrieval for query(): the agent synthesizes the answer; the core only returns rows. */
export async function queryLedger(
  orgId: string,
  projectId: string,
  q: string,
): Promise<{ decisions: unknown[]; changes: unknown[]; answeredQuestions: unknown[] }> {
  const needle = q.toLowerCase();
  return withOrg(orgId, async (tx) => {
    const ds = await tx.select().from(decisions).where(eq(decisions.projectId, projectId));
    const decRows = [];
    for (const d of ds) {
      const v = (
        await tx
          .select()
          .from(decisionVersions)
          .where(and(eq(decisionVersions.decisionId, d.id), eq(decisionVersions.version, d.currentVersion)))
          .limit(1)
      )[0];
      const hay = `${d.scopeRef} ${v?.ruleText ?? ""}`.toLowerCase();
      if (hay.includes(needle)) decRows.push({ scopeRef: d.scopeRef, status: d.status, ruleText: v?.ruleText ?? "" });
    }
    const changes = (
      await tx
        .select()
        .from(changeFeedEntries)
        .where(eq(changeFeedEntries.projectId, projectId))
        .orderBy(desc(changeFeedEntries.createdAt))
        .limit(20)
    ).filter((c) => `${c.summary} ${c.surface ?? ""}`.toLowerCase().includes(needle));
    const answeredQuestions = (
      await tx
        .select()
        .from(questions)
        .where(and(eq(questions.projectId, projectId), eq(questions.status, "answered")))
    ).filter((qq) => qq.body.toLowerCase().includes(needle));
    return { decisions: decRows, changes, answeredQuestions };
  });
}
