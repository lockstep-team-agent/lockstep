import { and, eq } from "drizzle-orm";
import { withOrg, withSystem } from "../db/rls.js";
import { sourceConnections, ingestAllowlist, ingestWatermarks } from "../db/schema.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}

export interface WorkSource {
  sourceRef: string;
  sourceName: string | null;
  cursor: string | null;
}
export interface WorkItem {
  orgId: string;
  projectId: string;
  connectionId: string;
  tool: string;
  entity: string;
  connectedAccountId: string | null;
  sources: WorkSource[];
}

/**
 * Cross-org enumeration of everything the worker should sweep: active connections with at least one
 * enabled allowlisted source, each carrying its watermark cursor. Trusted system read (the worker is
 * authenticated by the shared ingest token). Only allowlisted sources are ever returned.
 */
export async function listWork(): Promise<WorkItem[]> {
  return withSystem(async (tx) => {
    const conns = await tx.select().from(sourceConnections).where(eq(sourceConnections.status, "active"));
    const items: WorkItem[] = [];
    for (const c of conns) {
      const allow = await tx
        .select()
        .from(ingestAllowlist)
        .where(and(eq(ingestAllowlist.connectionId, c.id), eq(ingestAllowlist.enabled, true)));
      if (allow.length === 0) continue;
      const marks = await tx.select().from(ingestWatermarks).where(eq(ingestWatermarks.connectionId, c.id));
      const cursorFor = (ref: string) => marks.find((m) => m.sourceRef === ref)?.cursor ?? null;
      items.push({
        orgId: c.orgId,
        projectId: c.projectId,
        connectionId: c.id,
        tool: c.tool,
        entity: c.entity,
        connectedAccountId: c.connectedAccountId,
        sources: allow.map((a) => ({ sourceRef: a.sourceRef, sourceName: a.sourceName, cursor: cursorFor(a.sourceRef) })),
      });
    }
    return items;
  });
}

/** Advance the incremental-sweep cursor for one allowlisted source. */
export async function setWatermark(
  orgId: string,
  connectionId: string,
  sourceRef: string,
  cursor: string,
): Promise<void> {
  await withOrg(orgId, async (tx) => {
    const existing = (
      await tx
        .select()
        .from(ingestWatermarks)
        .where(and(eq(ingestWatermarks.connectionId, connectionId), eq(ingestWatermarks.sourceRef, sourceRef)))
        .limit(1)
    )[0];
    if (existing) {
      await tx
        .update(ingestWatermarks)
        .set({ cursor, updatedAt: new Date() })
        .where(eq(ingestWatermarks.id, existing.id));
    } else {
      await tx.insert(ingestWatermarks).values({ orgId, connectionId, sourceRef, cursor });
    }
  });
}

export async function createConnection(
  orgId: string,
  input: { projectId: string; tool: string; entity: string; createdBy: string },
): Promise<{ connectionId: string; entity: string }> {
  return withOrg(orgId, async (tx) => {
    const existing = (
      await tx
        .select()
        .from(sourceConnections)
        .where(
          and(
            eq(sourceConnections.projectId, input.projectId),
            eq(sourceConnections.tool, input.tool),
          ),
        )
        .limit(1)
    )[0];
    if (existing) return { connectionId: existing.id, entity: existing.entity };
    const c = one(
      await tx
        .insert(sourceConnections)
        .values({
          orgId,
          projectId: input.projectId,
          tool: input.tool,
          entity: input.entity,
          status: "pending",
          createdBy: input.createdBy,
        })
        .returning(),
    );
    return { connectionId: c.id, entity: c.entity };
  });
}

/** Mark a connection active once Composio OAuth completed (called by the worker after `connect`). */
export async function finalizeConnection(connectionId: string, connectedAccountId: string): Promise<void> {
  await withSystem(async (tx) => {
    await tx
      .update(sourceConnections)
      .set({ connectedAccountId, status: "active" })
      .where(eq(sourceConnections.id, connectionId));
  });
}

export async function listConnections(
  orgId: string,
  projectId: string,
): Promise<Array<{ id: string; tool: string; entity: string; status: string; connectedAccountId: string | null }>> {
  return withOrg(orgId, async (tx) => {
    const rows = await tx.select().from(sourceConnections).where(eq(sourceConnections.projectId, projectId));
    return rows.map((r) => ({
      id: r.id,
      tool: r.tool,
      entity: r.entity,
      status: r.status,
      connectedAccountId: r.connectedAccountId,
    }));
  });
}

export async function addAllowlist(
  orgId: string,
  input: { projectId: string; connectionId: string; sourceKind: string; sourceRef: string; sourceName?: string },
): Promise<{ id: string }> {
  return withOrg(orgId, async (tx) => {
    const existing = (
      await tx
        .select()
        .from(ingestAllowlist)
        .where(
          and(eq(ingestAllowlist.connectionId, input.connectionId), eq(ingestAllowlist.sourceRef, input.sourceRef)),
        )
        .limit(1)
    )[0];
    if (existing) {
      await tx.update(ingestAllowlist).set({ enabled: true, sourceName: input.sourceName ?? existing.sourceName }).where(eq(ingestAllowlist.id, existing.id));
      return { id: existing.id };
    }
    const a = one(
      await tx
        .insert(ingestAllowlist)
        .values({
          orgId,
          projectId: input.projectId,
          connectionId: input.connectionId,
          sourceKind: input.sourceKind,
          sourceRef: input.sourceRef,
          sourceName: input.sourceName ?? null,
          enabled: true,
        })
        .returning(),
    );
    return { id: a.id };
  });
}

export async function listAllowlist(
  orgId: string,
  projectId: string,
): Promise<Array<{ id: string; connectionId: string; sourceKind: string; sourceRef: string; sourceName: string | null; enabled: boolean }>> {
  return withOrg(orgId, async (tx) => {
    const rows = await tx.select().from(ingestAllowlist).where(eq(ingestAllowlist.projectId, projectId));
    return rows.map((r) => ({
      id: r.id,
      connectionId: r.connectionId,
      sourceKind: r.sourceKind,
      sourceRef: r.sourceRef,
      sourceName: r.sourceName,
      enabled: r.enabled,
    }));
  });
}
