import { and, eq } from "drizzle-orm";
import { withOrg, type Tx } from "../db/rls.js";
import {
  decisions,
  decisionVersions,
  graphNodes,
  graphEdges,
  conflicts,
  changeFeedEntries,
  sourceDocuments,
} from "../db/schema.js";
import { writeAudit } from "../audit/audit-service.js";
import { getProjectRoleTx } from "../auth/permissions.js";
import { recomputeCapabilityImpactTx } from "../ledger/ledger-service.js";
import { setEdgeStatusTx, deleteEdgeTx, capabilityRefForNodeTx } from "../graph/graph-service.js";

/**
 * The Features layer: capabilities as the org graph sees them (`graphNodes.kind='capability'`), their
 * governed surfaces (governs edges, confirmed + proposed), the product constraints scoped to them, and
 * the engineering activity on those surfaces — the PM's build-vs-spec reconciliation view.
 */

interface GovernedSurface {
  surface: string;
  status: string; // proposed | confirmed
  edgeId: string;
}

/** Governs edges out of a capability node → surface refs + edge status. */
async function governedSurfacesTx(tx: Tx, projectId: string, capNodeId: string): Promise<GovernedSurface[]> {
  const edges = await tx
    .select()
    .from(graphEdges)
    .where(and(eq(graphEdges.projectId, projectId), eq(graphEdges.fromId, capNodeId), eq(graphEdges.kind, "governs")));
  if (edges.length === 0) return [];
  const surfaceNodes = await tx
    .select()
    .from(graphNodes)
    .where(and(eq(graphNodes.projectId, projectId), eq(graphNodes.kind, "surface")));
  const refById = new Map(surfaceNodes.map((n) => [n.id, n.ref] as const));
  return edges
    .map((e) => ({ surface: refById.get(e.toId) ?? "", status: e.status, edgeId: e.id }))
    .filter((g) => g.surface);
}

/** Document constraints belonging to a feature: capability-scoped to it, or surface-scoped to a confirmed governed surface. */
async function featureConstraintsTx(
  tx: Tx,
  projectId: string,
  ref: string,
  confirmedSurfaces: Set<string>,
): Promise<Array<{ decision: typeof decisions.$inferSelect; ruleText: string; provenance: Record<string, unknown> }>> {
  const rows = await tx
    .select()
    .from(decisions)
    .where(and(eq(decisions.projectId, projectId), eq(decisions.origin, "document")));
  const out = [];
  for (const d of rows) {
    if (d.status === "rejected" || d.status === "superseded") continue;
    const belongs =
      (d.scopeKind === "capability" && d.scopeRef === ref) ||
      (d.scopeKind === "surface" && confirmedSurfaces.has(d.scopeRef));
    if (!belongs) continue;
    const v = (
      await tx
        .select()
        .from(decisionVersions)
        .where(and(eq(decisionVersions.decisionId, d.id), eq(decisionVersions.version, d.currentVersion)))
        .limit(1)
    )[0];
    out.push({ decision: d, ruleText: v?.ruleText ?? "", provenance: (v?.provenance ?? {}) as Record<string, unknown> });
  }
  return out;
}

async function hasOpenConflictTx(tx: Tx, decisionId: string): Promise<boolean> {
  const r = (
    await tx
      .select({ id: conflicts.id })
      .from(conflicts)
      .where(and(eq(conflicts.constraintDecisionId, decisionId), eq(conflicts.status, "open")))
      .limit(1)
  )[0];
  return Boolean(r);
}

/** Implementing activity on a surface = engineering decisions + change-feed entries touching it. */
async function implementingCountsTx(tx: Tx, projectId: string, surface: string): Promise<{ decisions: number; changes: number }> {
  const ds = await tx
    .select({ id: decisions.id })
    .from(decisions)
    .where(and(eq(decisions.projectId, projectId), eq(decisions.scopeRef, surface), eq(decisions.origin, "agent")));
  const ch = await tx
    .select({ id: changeFeedEntries.id })
    .from(changeFeedEntries)
    .where(and(eq(changeFeedEntries.projectId, projectId), eq(changeFeedEntries.surface, surface)));
  return { decisions: ds.length, changes: ch.length };
}

/** Resolve a feature's owning document via a constraint's provenance.documentId (mints during ratify). */
async function featureDocTx(
  tx: Tx,
  provenances: Array<Record<string, unknown>>,
): Promise<{ id: string; title: string | null; url: string | null; state: string } | null> {
  for (const p of provenances) {
    const docId = p.documentId as string | undefined;
    if (!docId) continue;
    const doc = (await tx.select().from(sourceDocuments).where(eq(sourceDocuments.id, docId)).limit(1))[0];
    if (doc) return { id: doc.id, title: doc.title, url: doc.url, state: doc.state };
  }
  return null;
}

export async function listFeatures(
  orgId: string,
  projectId: string,
): Promise<{
  features: Array<{
    ref: string;
    label: string | null;
    docId: string | null;
    docTitle: string | null;
    constraintCounts: { binding: number; proposed: number; stale: number; expired: number; total: number };
    governedSurfaces: { confirmed: number; proposed: number };
    openConflicts: number;
  }>;
}> {
  return withOrg(orgId, async (tx) => {
    const caps = await tx
      .select()
      .from(graphNodes)
      .where(and(eq(graphNodes.projectId, projectId), eq(graphNodes.kind, "capability")));
    const features = [];
    for (const cap of caps) {
      const governed = await governedSurfacesTx(tx, projectId, cap.id);
      const confirmed = new Set(governed.filter((g) => g.status === "confirmed").map((g) => g.surface));
      const constraints = await featureConstraintsTx(tx, projectId, cap.ref, confirmed);
      const counts = { binding: 0, proposed: 0, stale: 0, expired: 0, total: constraints.length };
      let openConflicts = 0;
      for (const c of constraints) {
        const k = c.decision.status;
        if (k === "binding" || k === "proposed" || k === "stale" || k === "expired") counts[k]++;
        if (await hasOpenConflictTx(tx, c.decision.id)) openConflicts++;
      }
      const doc = await featureDocTx(tx, constraints.map((c) => c.provenance));
      features.push({
        ref: cap.ref,
        label: cap.label,
        docId: doc?.id ?? null,
        docTitle: doc?.title ?? null,
        constraintCounts: counts,
        governedSurfaces: {
          confirmed: governed.filter((g) => g.status === "confirmed").length,
          proposed: governed.filter((g) => g.status === "proposed").length,
        },
        openConflicts,
      });
    }
    features.sort((a, b) => (a.label ?? a.ref).localeCompare(b.label ?? b.ref));
    return { features };
  });
}

export async function getFeature(
  orgId: string,
  projectId: string,
  ref: string,
): Promise<Record<string, unknown> | null> {
  return withOrg(orgId, async (tx) => {
    const cap = (
      await tx
        .select()
        .from(graphNodes)
        .where(and(eq(graphNodes.projectId, projectId), eq(graphNodes.kind, "capability"), eq(graphNodes.ref, ref)))
        .limit(1)
    )[0];
    if (!cap) return null;
    const governed = await governedSurfacesTx(tx, projectId, cap.id);
    const confirmed = new Set(governed.filter((g) => g.status === "confirmed").map((g) => g.surface));
    const constraints = await featureConstraintsTx(tx, projectId, ref, confirmed);

    const constraintOut = [];
    let withActivity = 0;
    let openConflicts = 0;
    for (const c of constraints) {
      const conflict = await hasOpenConflictTx(tx, c.decision.id);
      if (conflict) openConflicts++;
      const anchor = (c.provenance.url as string | undefined) ?? null;
      // A constraint has implementing activity if any confirmed governed surface (or its own surface)
      // carries engineering decisions/changes.
      const surfacesToCheck = c.decision.scopeKind === "surface" ? [c.decision.scopeRef] : [...confirmed];
      let active = false;
      for (const s of surfacesToCheck) {
        const impl = await implementingCountsTx(tx, projectId, s);
        if (impl.decisions + impl.changes > 0) {
          active = true;
          break;
        }
      }
      if (active) withActivity++;
      constraintOut.push({
        id: c.decision.id,
        ruleText: c.ruleText,
        status: c.decision.status,
        constraintKind: c.decision.constraintKind,
        scopeRef: c.decision.scopeRef,
        anchorUrl: anchor,
        conflict,
      });
    }

    const governedOut = [];
    for (const g of governed) {
      const impl = await implementingCountsTx(tx, projectId, g.surface);
      governedOut.push({ surface: g.surface, status: g.status, edgeId: g.edgeId, implementing: impl });
    }

    const doc = await featureDocTx(tx, constraints.map((c) => c.provenance));
    return {
      ref,
      label: cap.label,
      doc,
      constraints: constraintOut,
      governedSurfaces: governedOut,
      coverage: { constraintsWithActivity: withActivity, totalConstraints: constraints.length, openConflicts },
    };
  });
}

/** Tech-lead confirm of a proposed governs edge (Features page). role in (owner, pm). */
export async function confirmGovernsEdge(
  orgId: string,
  projectId: string,
  edgeId: string,
  memberId: string,
): Promise<{ ok: boolean }> {
  return withOrg(orgId, async (tx) => {
    const role = await getProjectRoleTx(tx, projectId, memberId);
    if (role !== "owner" && role !== "pm") throw Object.assign(new Error("confirming a mapping requires owner/pm role"), { statusCode: 403 });
    const res = await setEdgeStatusTx(tx, projectId, edgeId, "confirmed");
    if (!res) throw Object.assign(new Error("edge not found"), { statusCode: 404 });
    const capRef = await capabilityRefForNodeTx(tx, projectId, res.fromId);
    if (capRef) await recomputeCapabilityImpactTx(tx, projectId, capRef);
    await writeAudit(tx, { orgId, projectId, actorMemberId: memberId, action: "edge.confirmed", entityKind: "graph_edge", entityId: edgeId });
    return { ok: true };
  });
}

/** Reject (delete) a proposed governs edge — it can be re-proposed by the auto-link later. */
export async function rejectGovernsEdge(
  orgId: string,
  projectId: string,
  edgeId: string,
  memberId: string,
): Promise<{ ok: boolean }> {
  return withOrg(orgId, async (tx) => {
    const role = await getProjectRoleTx(tx, projectId, memberId);
    if (role !== "owner" && role !== "pm") throw Object.assign(new Error("rejecting a mapping requires owner/pm role"), { statusCode: 403 });
    const ok = await deleteEdgeTx(tx, projectId, edgeId);
    if (!ok) throw Object.assign(new Error("edge not found"), { statusCode: 404 });
    await writeAudit(tx, { orgId, projectId, actorMemberId: memberId, action: "edge.rejected", entityKind: "graph_edge", entityId: edgeId });
    return { ok: true };
  });
}
