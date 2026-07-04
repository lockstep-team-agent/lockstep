import type { FastifyReply, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { withSystem, withOrg } from "../db/rls.js";
import { members, projects } from "../db/schema.js";
import { productLayerEnabled } from "../documents/document-service.js";
import { env } from "../env.js";

/** Gate the worker endpoints on the shared ingest service token. */
export function workerAuthed(req: FastifyRequest, reply: FastifyReply): boolean {
  const expected = env.LOCKSTEP_INGEST_TOKEN;
  const got = req.headers["x-lockstep-ingest-token"];
  if (!expected || got !== expected) {
    reply.code(401).send({ error: "ingest token required" });
    return false;
  }
  return true;
}

/** Resolve the caller's member id in an org (principal must be a member), else 401/403. */
export async function ensureMember(req: FastifyRequest, reply: FastifyReply, orgId: string): Promise<string | null> {
  const p = req.principal;
  if (!p) {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  const memberId = await withSystem(async (tx) => {
    const m = (
      await tx
        .select()
        .from(members)
        .where(and(eq(members.orgId, orgId), eq(members.principalId, p.id)))
        .limit(1)
    )[0];
    return m?.id ?? null;
  });
  if (!memberId) {
    reply.code(403).send({ error: "not a member of this org" });
    return null;
  }
  return memberId;
}

/** v3 product layer is per-project opt-in (projects.settings.productLayer.enabled), else 403. */
export async function requireProductLayer(reply: FastifyReply, orgId: string, projectId: string): Promise<boolean> {
  const enabled = await withOrg(orgId, async (tx) => {
    const p = (await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
    return p ? productLayerEnabled(p.settings) : false;
  });
  if (!enabled) {
    reply.code(403).send({ error: "feature_disabled" });
    return false;
  }
  return true;
}
