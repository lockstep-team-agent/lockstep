import { and, eq } from "drizzle-orm";
import { withOrg, type Tx } from "../db/rls.js";
import { graphNodes, graphEdges, members, projectMembers, decisions, decisionVersions } from "../db/schema.js";

/**
 * The org graph gives non-code decisions a blast radius. Nodes are teams/projects/docs/people/topics;
 * edges connect them. v2 auto-derives the obvious structure from what we already know (members, and the
 * people who participated in each distilled decision), and lets a human correct it. impactForScopeTx
 * reads this graph for topic-scoped decisions.
 */

export async function upsertNodeTx(
  tx: Tx,
  orgId: string,
  projectId: string,
  kind: string,
  ref: string,
  label: string,
  source = "derived",
): Promise<string> {
  const existing = (
    await tx
      .select()
      .from(graphNodes)
      .where(and(eq(graphNodes.projectId, projectId), eq(graphNodes.kind, kind), eq(graphNodes.ref, ref)))
      .limit(1)
  )[0];
  if (existing) return existing.id;
  const row = (await tx.insert(graphNodes).values({ orgId, projectId, kind, ref, label, source }).returning())[0]!;
  return row.id;
}

export async function upsertEdgeTx(
  tx: Tx,
  orgId: string,
  projectId: string,
  fromId: string,
  toId: string,
  kind: string,
  source = "derived",
): Promise<void> {
  const existing = (
    await tx
      .select()
      .from(graphEdges)
      .where(
        and(
          eq(graphEdges.projectId, projectId),
          eq(graphEdges.fromId, fromId),
          eq(graphEdges.toId, toId),
          eq(graphEdges.kind, kind),
        ),
      )
      .limit(1)
  )[0];
  if (existing) return;
  await tx.insert(graphEdges).values({ orgId, projectId, fromId, toId, kind, source });
}

/** Human-readable label from a capability ref (`feature:guest-checkout` → `guest checkout`). */
function capabilityLabel(ref: string): string {
  return ref.replace(/^feature:|^metric:/, "").replace(/-/g, " ");
}

/**
 * Create (or find) a capability→surface `governs` edge with an explicit status (v3 governs-edge
 * learning). Upserts both endpoint nodes. Idempotent on (projectId, fromId, toId, "governs"), and it
 * **never downgrades** an existing `confirmed` edge back to `proposed` — the anti-rot invariant.
 * Returns the edge id.
 */
export async function upsertGovernsEdgeTx(
  tx: Tx,
  orgId: string,
  projectId: string,
  capabilityRef: string,
  surface: string,
  status: "proposed" | "confirmed",
  source = "derived",
): Promise<string> {
  const capId = await upsertNodeTx(tx, orgId, projectId, "capability", capabilityRef, capabilityLabel(capabilityRef));
  const surfaceId = await upsertNodeTx(tx, orgId, projectId, "surface", surface, surface);
  const existing = (
    await tx
      .select()
      .from(graphEdges)
      .where(
        and(
          eq(graphEdges.projectId, projectId),
          eq(graphEdges.fromId, capId),
          eq(graphEdges.toId, surfaceId),
          eq(graphEdges.kind, "governs"),
        ),
      )
      .limit(1)
  )[0];
  if (existing) {
    // Only ever upgrade proposed → confirmed; never the reverse.
    if (status === "confirmed" && existing.status !== "confirmed") {
      await tx.update(graphEdges).set({ status }).where(eq(graphEdges.id, existing.id));
    }
    return existing.id;
  }
  const row = (
    await tx
      .insert(graphEdges)
      .values({ orgId, projectId, fromId: capId, toId: surfaceId, kind: "governs", status, source })
      .returning()
  )[0]!;
  return row.id;
}

/**
 * Flip proposed `governs` edges on any of `surfaces` to `confirmed` and return the affected capability
 * refs (so callers can recompute capability impact). Used by the pr-check reconcile path — a surface
 * that ships in a checked PR confirms its prospective feature mapping.
 */
export async function confirmGovernsEdgesForSurfacesTx(
  tx: Tx,
  projectId: string,
  surfaces: string[],
): Promise<Array<{ edgeId: string; capabilityRef: string; surface: string }>> {
  if (surfaces.length === 0) return [];
  const surfaceNodes = await tx
    .select()
    .from(graphNodes)
    .where(and(eq(graphNodes.projectId, projectId), eq(graphNodes.kind, "surface")));
  const wanted = new Set(surfaces);
  const surfaceById = new Map(surfaceNodes.filter((n) => wanted.has(n.ref)).map((n) => [n.id, n.ref] as const));
  if (surfaceById.size === 0) return [];
  const edges = await tx
    .select()
    .from(graphEdges)
    .where(and(eq(graphEdges.projectId, projectId), eq(graphEdges.kind, "governs"), eq(graphEdges.status, "proposed")));
  const caps = await tx
    .select()
    .from(graphNodes)
    .where(and(eq(graphNodes.projectId, projectId), eq(graphNodes.kind, "capability")));
  const capById = new Map(caps.map((n) => [n.id, n.ref] as const));
  const out: Array<{ edgeId: string; capabilityRef: string; surface: string }> = [];
  for (const e of edges) {
    const surface = surfaceById.get(e.toId);
    const capabilityRef = capById.get(e.fromId);
    if (!surface || !capabilityRef) continue;
    await tx.update(graphEdges).set({ status: "confirmed" }).where(eq(graphEdges.id, e.id));
    out.push({ edgeId: e.id, capabilityRef, surface });
  }
  return out;
}

/** Rebuild the derived portion of the graph from members + distilled decisions. Idempotent. */
export async function deriveGraph(orgId: string, projectId: string): Promise<{ nodes: number; edges: number }> {
  return withOrg(orgId, async (tx) => {
    const projectNode = await upsertNodeTx(tx, orgId, projectId, "project", `project:${projectId}`, "project");

    // People = active members of THIS project (not the whole org — org members who aren't on the
    // project must not appear in its graph). Resolve the login from the linked member row when the
    // invite has been accepted, else the invited handle.
    const pms = await tx
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.status, "active")));
    for (const pm of pms) {
      let login = pm.invitedGithubLogin;
      if (pm.memberId) {
        const mem = (await tx.select().from(members).where(eq(members.id, pm.memberId)).limit(1))[0];
        if (mem) login = mem.githubLogin;
      }
      if (!login) continue;
      const pid = await upsertNodeTx(tx, orgId, projectId, "person", `person:${login}`, login);
      await upsertEdgeTx(tx, orgId, projectId, pid, projectNode, "member");
    }

    const ds = await tx.select().from(decisions).where(eq(decisions.projectId, projectId));
    for (const d of ds) {
      if (d.status === "rejected") continue;
      if (d.scopeKind === "topic") {
        const topicId = await upsertNodeTx(
          tx,
          orgId,
          projectId,
          "topic",
          d.scopeRef,
          d.scopeRef.replace(/^topic:/, ""),
        );
        await upsertEdgeTx(tx, orgId, projectId, topicId, projectNode, "governs");
        // People who participated (decidedBy in the version provenance) → edges to the topic.
        const v = (
          await tx
            .select()
            .from(decisionVersions)
            .where(and(eq(decisionVersions.decisionId, d.id), eq(decisionVersions.version, d.currentVersion)))
            .limit(1)
        )[0];
        const decidedBy = ((v?.provenance as { decidedBy?: string[] })?.decidedBy ?? []).filter(Boolean);
        for (const who of decidedBy) {
          const handle = who.replace(/^@/, "");
          const pid = await upsertNodeTx(tx, orgId, projectId, "person", `person:${handle}`, handle);
          await upsertEdgeTx(tx, orgId, projectId, topicId, pid, "relates");
        }
      } else if (d.scopeKind === "surface" || d.scopeKind === "contract" || d.scopeKind === "shared") {
        const sid = await upsertNodeTx(tx, orgId, projectId, "surface", d.scopeRef, d.scopeRef);
        await upsertEdgeTx(tx, orgId, projectId, sid, projectNode, "governs");
      }
    }

    const nodes = (await tx.select().from(graphNodes).where(eq(graphNodes.projectId, projectId))).length;
    const edges = (await tx.select().from(graphEdges).where(eq(graphEdges.projectId, projectId))).length;
    return { nodes, edges };
  });
}

export async function listGraph(
  orgId: string,
  projectId: string,
): Promise<{
  nodes: Array<{ id: string; kind: string; ref: string; label: string | null; source: string }>;
  edges: Array<{ id: string; fromId: string; toId: string; kind: string; status: string }>;
}> {
  return withOrg(orgId, async (tx) => {
    const nodes = await tx.select().from(graphNodes).where(eq(graphNodes.projectId, projectId));
    const edges = await tx.select().from(graphEdges).where(eq(graphEdges.projectId, projectId));
    return {
      nodes: nodes.map((n) => ({ id: n.id, kind: n.kind, ref: n.ref, label: n.label, source: n.source })),
      edges: edges.map((e) => ({ id: e.id, fromId: e.fromId, toId: e.toId, kind: e.kind, status: e.status })),
    };
  });
}

/** Confirm a proposed governs edge (tech-lead action on the Features page). Idempotent. */
export async function setEdgeStatusTx(
  tx: Tx,
  projectId: string,
  edgeId: string,
  status: "proposed" | "confirmed",
): Promise<{ fromId: string } | null> {
  const e = (
    await tx
      .select()
      .from(graphEdges)
      .where(and(eq(graphEdges.projectId, projectId), eq(graphEdges.id, edgeId)))
      .limit(1)
  )[0];
  if (!e) return null;
  await tx.update(graphEdges).set({ status }).where(eq(graphEdges.id, edgeId));
  return { fromId: e.fromId };
}

/** Delete a proposed governs edge (tech-lead reject — it can be re-proposed later by the auto-link). */
export async function deleteEdgeTx(tx: Tx, projectId: string, edgeId: string): Promise<boolean> {
  const e = (
    await tx
      .select()
      .from(graphEdges)
      .where(and(eq(graphEdges.projectId, projectId), eq(graphEdges.id, edgeId)))
      .limit(1)
  )[0];
  if (!e) return false;
  await tx.delete(graphEdges).where(eq(graphEdges.id, edgeId));
  return true;
}

/** The `ref` of a capability node by its id, for impact-recompute after an edge change. */
export async function capabilityRefForNodeTx(tx: Tx, projectId: string, nodeId: string): Promise<string | null> {
  const n = (
    await tx
      .select()
      .from(graphNodes)
      .where(and(eq(graphNodes.projectId, projectId), eq(graphNodes.id, nodeId), eq(graphNodes.kind, "capability")))
      .limit(1)
  )[0];
  return n?.ref ?? null;
}

export async function addNode(
  orgId: string,
  input: { projectId: string; kind: string; ref: string; label?: string },
): Promise<{ id: string }> {
  return withOrg(orgId, async (tx) => {
    const id = await upsertNodeTx(
      tx,
      orgId,
      input.projectId,
      input.kind,
      input.ref,
      input.label ?? input.ref,
      "manual",
    );
    return { id };
  });
}

export async function addEdge(
  orgId: string,
  input: { projectId: string; fromId: string; toId: string; kind?: string },
): Promise<{ ok: boolean }> {
  await withOrg(orgId, async (tx) => {
    await upsertEdgeTx(tx, orgId, input.projectId, input.fromId, input.toId, input.kind ?? "relates", "manual");
  });
  return { ok: true };
}
