import { and, eq } from "drizzle-orm";
import { withSystem } from "../db/rls.js";
import { repos, members, sessions, projects, briefingCursors, projectMembers } from "../db/schema.js";
import { projectArchived, projectVisibility, getProjectRoleTx } from "../auth/permissions.js";
import type { Principal } from "../auth/tokens.js";

export interface SessionContext {
  sessionId: string;
  orgId: string;
  projectId: string;
  repoId: string;
  memberId: string;
}

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}

/**
 * Register a session: resolve git remote → repo → project → org where this principal
 * is a member. Returns null (→ unregistered_repo) if the repo isn't connected to a
 * project the principal belongs to.
 */
export async function registerSession(
  principal: Principal,
  input: { gitRemote: string; cwd?: string; vendor?: string; nativeSessionId?: string },
): Promise<SessionContext | null> {
  return withSystem(async (tx) => {
    const candidates = await tx.select().from(repos).where(eq(repos.gitRemote, input.gitRemote));
    for (const repo of candidates) {
      // Archived projects are inert — no new sessions (the capture hook degrades silently by design).
      const proj = (await tx.select().from(projects).where(eq(projects.id, repo.projectId)).limit(1))[0];
      if (proj && projectArchived(proj.settings)) continue;
      const m = (
        await tx
          .select()
          .from(members)
          .where(and(eq(members.orgId, repo.orgId), eq(members.principalId, principal.id)))
          .limit(1)
      )[0];
      if (m) {
        const roster = (await tx.select().from(projectMembers).where(and(eq(projectMembers.projectId, repo.projectId), eq(projectMembers.memberId, m.id))).limit(1))[0];
        if (roster?.status === "revoked") continue;
        if (projectVisibility(proj?.settings) === "walled" && !(await getProjectRoleTx(tx, repo.projectId, m.id))) continue;
        const native = input.nativeSessionId;
        if (native) {
          const existing = (await tx.select().from(sessions).where(and(
            eq(sessions.memberId, m.id), eq(sessions.repoId, repo.id),
            eq(sessions.vendor, input.vendor ?? "unknown"), eq(sessions.nativeSessionId, native),
          )).limit(1))[0];
          if (existing) return { sessionId: existing.id, orgId: repo.orgId, projectId: repo.projectId, repoId: repo.id, memberId: m.id };
        }
        const cursor = native ? (await tx.select().from(briefingCursors).where(and(
          eq(briefingCursors.memberId, m.id), eq(briefingCursors.repoId, repo.id),
        )).limit(1))[0] : undefined;
        const sess = one(
          await tx
            .insert(sessions)
            .values({
              orgId: repo.orgId,
              memberId: m.id,
              repoId: repo.id,
              projectId: repo.projectId,
              gitRemote: input.gitRemote,
              cwd: input.cwd ?? null,
              vendor: input.vendor ?? "unknown",
              state: "live",
              nativeSessionId: native ?? null,
              briefingBaseline: cursor?.seenAt ?? null,
            })
            .onConflictDoUpdate({ target: [sessions.memberId, sessions.repoId, sessions.vendor, sessions.nativeSessionId], set: { lastHeartbeat: new Date() } })
            .returning(),
        );
        return { sessionId: sess.id, orgId: repo.orgId, projectId: repo.projectId, repoId: repo.id, memberId: m.id };
      }
    }
    return null;
  });
}

/** Resolve a session id to its context, verifying it belongs to the calling principal. */
export async function resolveSession(principal: Principal, sessionId: string): Promise<SessionContext | null> {
  return withSystem(async (tx) => {
    const s = (await tx.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1))[0];
    if (!s) return null;
    const m = (
      await tx
        .select()
        .from(members)
        .where(and(eq(members.id, s.memberId), eq(members.principalId, principal.id)))
        .limit(1)
    )[0];
    if (!m) return null;
    const proj = (await tx.select().from(projects).where(eq(projects.id, s.projectId)).limit(1))[0];
    if (!proj || projectArchived(proj.settings)) return null;
    const roster = (await tx.select().from(projectMembers).where(and(eq(projectMembers.projectId, s.projectId), eq(projectMembers.memberId, m.id))).limit(1))[0];
    if (roster?.status === "revoked" || (projectVisibility(proj.settings) === "walled" && roster?.status !== "active")) return null;
    return { sessionId: s.id, orgId: s.orgId, projectId: s.projectId, repoId: s.repoId, memberId: s.memberId };
  });
}
