import { and, eq } from "drizzle-orm";
import type { Tx } from "../db/rls.js";
import { projectMembers } from "../db/schema.js";

/**
 * #2 per-project visibility mode. "shared" (default, and today's behavior) = any org member can read
 * the project; "walled" = only active project_members may read it. Stored in projects.settings.
 */
export function projectVisibility(settings: unknown): "shared" | "walled" {
  const s = settings as { visibility?: string } | null;
  return s?.visibility === "walled" ? "walled" : "shared";
}

/**
 * Archived = inert, not deleted (hard delete fights the append-only ledger). An archived project is
 * hidden from overviews, rejects connect/join + new sessions, and is skipped by sweeps/digests.
 * Data (decisions, audit, versions) is fully retained; unarchive restores everything. Stored in
 * projects.settings — same merge-patch route as visibility/productLayer.
 */
export function projectArchived(settings: unknown): boolean {
  return Boolean((settings as { archived?: boolean } | null)?.archived);
}

/**
 * Role-based action gates (v3). Pages stay open to every member — permissions gate ACTIONS only
 * (ratify, resolve, mapping admin). Roles live on project_members: owner | pm | member.
 */
export async function getProjectRoleTx(tx: Tx, projectId: string, memberId: string): Promise<string | null> {
  const row = (
    await tx
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.memberId, memberId),
          eq(projectMembers.status, "active"),
        ),
      )
      .limit(1)
  )[0];
  return row?.role ?? null;
}

/**
 * §15 doc-management gate: the member who registered the doc, the resolved doc owner, or a project
 * owner/pm. Governs ratification AND the doc-lifecycle mutations (state change, unregister, resync) —
 * the destructive/state-changing operations. Enforced server-side.
 */
export async function canManageDocTx(
  tx: Tx,
  input: { projectId: string; memberId: string; doc: { registeredBy: string | null; ownerMemberId: string | null } },
): Promise<boolean> {
  if (input.doc.registeredBy === input.memberId || input.doc.ownerMemberId === input.memberId) return true;
  const role = await getProjectRoleTx(tx, input.projectId, input.memberId);
  return role === "owner" || role === "pm";
}

/** Ratification uses the same §15 predicate. Kept as a named alias for call-site clarity. */
export const canRatifyTx = canManageDocTx;
