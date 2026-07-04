import { and, eq } from "drizzle-orm";
import type { Tx } from "../db/rls.js";
import { projectMembers } from "../db/schema.js";

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
 * Ratification of a document constraint: project owner or PM, the member who registered the doc,
 * or the resolved doc owner. Enforced server-side; the dashboard renders disabled buttons with a
 * reason tooltip off the same check.
 */
export async function canRatifyTx(
  tx: Tx,
  input: { projectId: string; memberId: string; doc: { registeredBy: string | null; ownerMemberId: string | null } },
): Promise<boolean> {
  if (input.doc.registeredBy === input.memberId || input.doc.ownerMemberId === input.memberId) return true;
  const role = await getProjectRoleTx(tx, input.projectId, input.memberId);
  return role === "owner" || role === "pm";
}
