/**
 * Organization authority: explicit owner/admin roles (never inferred from project ownership) and
 * lightweight teams. Teams target audiences; they never grant access to projects or artifacts.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { withOrg, type Tx } from "../db/rls.js";
import { members, orgRoles, teamMembers, teams } from "../db/schema.js";
import { writeAudit } from "../audit/audit-service.js";

export type OrgRole = "owner" | "admin";

export class OrgError extends Error {
  constructor(
    public readonly statusCode: 400 | 403 | 404 | 409 | 410,
    message: string,
  ) {
    super(message);
  }
}

export async function getOrgRoleTx(tx: Tx, orgId: string, memberId: string): Promise<OrgRole | null> {
  const r = (
    await tx
      .select({ role: orgRoles.role })
      .from(orgRoles)
      .where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.memberId, memberId)))
      .limit(1)
  )[0];
  return (r?.role as OrgRole | undefined) ?? null;
}

export async function getOrgRole(orgId: string, memberId: string): Promise<OrgRole | null> {
  return withOrg(orgId, (tx) => getOrgRoleTx(tx, orgId, memberId));
}

async function requireRoleTx(tx: Tx, orgId: string, actor: string, roles: OrgRole[]): Promise<OrgRole> {
  const r = await getOrgRoleTx(tx, orgId, actor);
  if (!r || !roles.includes(r)) throw new OrgError(403, `requires org ${roles.join(" or ")}`);
  return r;
}

async function memberInOrgTx(tx: Tx, orgId: string, memberId: string): Promise<void> {
  const m = (
    await tx
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.id, memberId), eq(members.orgId, orgId)))
      .limit(1)
  )[0];
  if (!m) throw new OrgError(404, "member not found in this org");
}

/** Every org member with their org role (null = member). Drives role and team pickers. */
export async function listOrgRoles(orgId: string) {
  return withOrg(orgId, (tx) =>
    tx
      .select({
        memberId: members.id,
        role: orgRoles.role,
        login: members.githubLogin,
        createdAt: orgRoles.createdAt,
      })
      .from(members)
      .leftJoin(orgRoles, and(eq(orgRoles.memberId, members.id), eq(orgRoles.orgId, orgId)))
      .where(eq(members.orgId, orgId))
      .orderBy(members.githubLogin),
  );
}

/** Owners manage owners and admins. The last owner can never be removed or demoted. */
export async function setOrgRole(orgId: string, actor: string, memberId: string, role: OrgRole | null): Promise<void> {
  await withOrg(orgId, async (tx) => {
    await requireRoleTx(tx, orgId, actor, ["owner"]);
    await memberInOrgTx(tx, orgId, memberId);
    const current = await getOrgRoleTx(tx, orgId, memberId);
    if (current === "owner" && role !== "owner") {
      const [n] = (await tx.execute(
        sql`SELECT count(*)::int AS n FROM org_roles WHERE org_id = ${orgId} AND role = 'owner'`,
      )) as unknown as Array<{ n: number }>;
      if ((n?.n ?? 0) <= 1) throw new OrgError(409, "an org must keep at least one owner");
    }
    if (role === null) await tx.delete(orgRoles).where(and(eq(orgRoles.orgId, orgId), eq(orgRoles.memberId, memberId)));
    else
      await tx
        .insert(orgRoles)
        .values({ orgId, memberId, role, grantedBy: actor })
        .onConflictDoUpdate({ target: [orgRoles.orgId, orgRoles.memberId], set: { role, grantedBy: actor } });
    await writeAudit(tx, {
      orgId,
      actorMemberId: actor,
      action: role ? "org.role_granted" : "org.role_revoked",
      entityKind: "member",
      entityId: memberId,
      payload: { role, previous: current },
    });
  });
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "team";

export async function listTeams(orgId: string) {
  return withOrg(orgId, async (tx) => {
    const ts = await tx.select().from(teams).where(eq(teams.orgId, orgId)).orderBy(teams.name);
    const ms = ts.length
      ? await tx
          .select({ teamId: teamMembers.teamId, memberId: teamMembers.memberId, login: members.githubLogin })
          .from(teamMembers)
          .innerJoin(members, eq(members.id, teamMembers.memberId))
          .where(
            inArray(
              teamMembers.teamId,
              ts.map((t) => t.id),
            ),
          )
      : [];
    return ts.map((t) => ({ id: t.id, slug: t.slug, name: t.name, members: ms.filter((m) => m.teamId === t.id) }));
  });
}

export async function createTeam(orgId: string, actor: string, name: string): Promise<{ id: string }> {
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new OrgError(400, "team name required");
  return withOrg(orgId, async (tx) => {
    await requireRoleTx(tx, orgId, actor, ["owner", "admin"]);
    const [t] = await tx
      .insert(teams)
      .values({ orgId, slug: slugify(clean), name: clean, createdBy: actor })
      .onConflictDoNothing()
      .returning();
    if (!t) throw new OrgError(409, "a team with that name already exists");
    await writeAudit(tx, {
      orgId,
      actorMemberId: actor,
      action: "team.created",
      entityKind: "team",
      entityId: t.id,
      payload: { name: clean },
    });
    return { id: t.id };
  });
}

export async function deleteTeam(orgId: string, actor: string, teamId: string): Promise<void> {
  await withOrg(orgId, async (tx) => {
    await requireRoleTx(tx, orgId, actor, ["owner", "admin"]);
    const [t] = await tx
      .delete(teams)
      .where(and(eq(teams.id, teamId), eq(teams.orgId, orgId)))
      .returning();
    if (!t) throw new OrgError(404, "team not found");
    await tx.delete(teamMembers).where(eq(teamMembers.teamId, teamId));
    await writeAudit(tx, {
      orgId,
      actorMemberId: actor,
      action: "team.deleted",
      entityKind: "team",
      entityId: teamId,
      payload: { name: t.name },
    });
  });
}

/** Admin-managed membership: members can't add themselves to gain an audience. */
export async function setTeamMember(
  orgId: string,
  actor: string,
  teamId: string,
  memberId: string,
  present: boolean,
): Promise<void> {
  await withOrg(orgId, async (tx) => {
    await requireRoleTx(tx, orgId, actor, ["owner", "admin"]);
    const t = (
      await tx
        .select()
        .from(teams)
        .where(and(eq(teams.id, teamId), eq(teams.orgId, orgId)))
        .limit(1)
    )[0];
    if (!t) throw new OrgError(404, "team not found");
    await memberInOrgTx(tx, orgId, memberId);
    if (present) await tx.insert(teamMembers).values({ orgId, teamId, memberId, addedBy: actor }).onConflictDoNothing();
    else await tx.delete(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.memberId, memberId)));
    await writeAudit(tx, {
      orgId,
      actorMemberId: actor,
      action: present ? "team.member_added" : "team.member_removed",
      entityKind: "team",
      entityId: teamId,
      payload: { memberId },
    });
  });
}

export async function orgMe(orgId: string, memberId: string) {
  return withOrg(orgId, async (tx) => {
    const role = await getOrgRoleTx(tx, orgId, memberId);
    const ts = await tx
      .select({ id: teams.id, name: teams.name })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(eq(teamMembers.memberId, memberId));
    return { memberId, role, teams: ts };
  });
}

export async function teamIdsForMemberTx(tx: Tx, memberId: string): Promise<string[]> {
  return (await tx.select({ id: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.memberId, memberId))).map(
    (t) => t.id,
  );
}
