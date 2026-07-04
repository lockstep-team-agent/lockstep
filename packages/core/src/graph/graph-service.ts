import { and, eq } from "drizzle-orm";
import { withOrg, type Tx } from "../db/rls.js";
import { graphNodes, graphEdges, members, decisions, decisionVersions } from "../db/schema.js";

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

/** Rebuild the derived portion of the graph from members + distilled decisions. Idempotent. */
export async function deriveGraph(
  orgId: string,
  projectId: string,
): Promise<{ nodes: number; edges: number }> {
  return withOrg(orgId, async (tx) => {
    const projectNode = await upsertNodeTx(tx, orgId, projectId, "project", `project:${projectId}`, "project");

    for (const m of await tx.select().from(members).where(eq(members.orgId, orgId))) {
      const pid = await upsertNodeTx(tx, orgId, projectId, "person", `person:${m.githubLogin}`, m.githubLogin);
      await upsertEdgeTx(tx, orgId, projectId, pid, projectNode, "member");
    }

    const ds = await tx.select().from(decisions).where(eq(decisions.projectId, projectId));
    for (const d of ds) {
      if (d.status === "rejected") continue;
      if (d.scopeKind === "topic") {
        const topicId = await upsertNodeTx(tx, orgId, projectId, "topic", d.scopeRef, d.scopeRef.replace(/^topic:/, ""));
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
  edges: Array<{ fromId: string; toId: string; kind: string }>;
}> {
  return withOrg(orgId, async (tx) => {
    const nodes = await tx.select().from(graphNodes).where(eq(graphNodes.projectId, projectId));
    const edges = await tx.select().from(graphEdges).where(eq(graphEdges.projectId, projectId));
    return {
      nodes: nodes.map((n) => ({ id: n.id, kind: n.kind, ref: n.ref, label: n.label, source: n.source })),
      edges: edges.map((e) => ({ fromId: e.fromId, toId: e.toId, kind: e.kind })),
    };
  });
}

export async function addNode(
  orgId: string,
  input: { projectId: string; kind: string; ref: string; label?: string },
): Promise<{ id: string }> {
  return withOrg(orgId, async (tx) => {
    const id = await upsertNodeTx(tx, orgId, input.projectId, input.kind, input.ref, input.label ?? input.ref, "manual");
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
