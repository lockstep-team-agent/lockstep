import { auditEvents } from "../db/schema.js";
import type { Tx } from "../db/rls.js";

export interface AuditInput {
  orgId: string;
  projectId?: string | null;
  actorMemberId?: string | null;
  action: string; // e.g. "decision.proposed", "contract.verified", "inbox.delivered"
  entityKind?: string | null;
  entityId?: string | null;
  entityVersion?: number | null;
  payload?: unknown;
}

/**
 * Write one immutable audit row in the SAME transaction as the mutation it records.
 * Every mutating endpoint must call this — non-repudiation is the enterprise budget line.
 */
export async function writeAudit(tx: Tx, e: AuditInput): Promise<void> {
  await tx.insert(auditEvents).values({
    orgId: e.orgId,
    projectId: e.projectId ?? null,
    actorMemberId: e.actorMemberId ?? null,
    action: e.action,
    entityKind: e.entityKind ?? null,
    entityId: e.entityId ?? null,
    entityVersion: e.entityVersion ?? null,
    payload: e.payload ?? null,
  });
}
