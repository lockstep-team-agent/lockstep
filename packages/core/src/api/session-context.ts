import { and, eq } from "drizzle-orm";
import { withSystem } from "../db/rls.js";
import { repos, members, sessions } from "../db/schema.js";
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
  input: { gitRemote: string; cwd?: string; vendor?: string },
): Promise<SessionContext | null> {
  return withSystem(async (tx) => {
    const candidates = await tx.select().from(repos).where(eq(repos.gitRemote, input.gitRemote));
    for (const repo of candidates) {
      const m = (
        await tx
          .select()
          .from(members)
          .where(and(eq(members.orgId, repo.orgId), eq(members.principalId, principal.id)))
          .limit(1)
      )[0];
      if (m) {
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
              vendor: input.vendor ?? null,
              state: "live",
            })
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
    return { sessionId: s.id, orgId: s.orgId, projectId: s.projectId, repoId: s.repoId, memberId: s.memberId };
  });
}
