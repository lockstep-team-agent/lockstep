import { and, eq } from "drizzle-orm";
import { withOrg, withSystem, type Tx } from "../db/rls.js";
import { principals, members, projects, projectMembers, orgs, githubCredentials, repos } from "../db/schema.js";
import { issueTokenTx, type Principal } from "./tokens.js";
import * as gh from "./github.js";
import { encrypt } from "./crypto.js";
import { env } from "../env.js";
import { ingestCodeownersFromGitHub } from "../graph/ownership-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}

export interface LoginOutcome {
  token: string;
  principalId: string;
  githubLogin: string;
  activatedProjects: string[];
}

async function upsertPrincipal(
  tx: Tx,
  githubUserId: number,
  githubLogin: string,
  name: string | null,
  email: string | null,
): Promise<string> {
  const existing = (
    await tx.select().from(principals).where(eq(principals.githubUserId, githubUserId)).limit(1)
  )[0];
  if (existing) {
    await tx.update(principals).set({ githubLogin }).where(eq(principals.id, existing.id));
    return existing.id;
  }
  return one(
    await tx.insert(principals).values({ githubUserId, githubLogin, displayName: name, email }).returning(),
  ).id;
}

/** Match pending invites by login → create member rows + flip to active. */
async function activateInvites(
  tx: Tx,
  principalId: string,
  githubLogin: string,
  githubUserId: number,
  name: string | null,
  email: string | null,
): Promise<string[]> {
  const invites = await tx
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.invitedGithubLogin, githubLogin), eq(projectMembers.status, "invited")));
  const activated: string[] = [];
  for (const inv of invites) {
    let m = (
      await tx
        .select()
        .from(members)
        .where(and(eq(members.orgId, inv.orgId), eq(members.principalId, principalId)))
        .limit(1)
    )[0];
    if (!m) {
      m = one(
        await tx
          .insert(members)
          .values({ orgId: inv.orgId, principalId, githubUserId, githubLogin, displayName: name, email })
          .returning(),
      );
    }
    await tx.update(projectMembers).set({ status: "active", memberId: m.id }).where(eq(projectMembers.id, inv.id));
    activated.push(inv.projectId);
  }
  return activated;
}

/** Real login: exchange a GitHub user-to-server token → principal + Lockstep token. */
export async function completeLogin(userToken: string): Promise<LoginOutcome> {
  const u = await gh.getUser(userToken);
  return withSystem(async (tx) => {
    const principalId = await upsertPrincipal(tx, u.id, u.login, u.name, u.email);
    const cred = (
      await tx.select().from(githubCredentials).where(eq(githubCredentials.principalId, principalId)).limit(1)
    )[0];
    const enc = encrypt(userToken);
    if (cred) await tx.update(githubCredentials).set({ accessTokenEnc: enc }).where(eq(githubCredentials.id, cred.id));
    else await tx.insert(githubCredentials).values({ principalId, accessTokenEnc: enc });
    const activatedProjects = await activateInvites(tx, principalId, u.login, u.id, u.name, u.email);
    const token = await issueTokenTx(tx, principalId);
    return { token, principalId, githubLogin: u.login, activatedProjects };
  });
}

/** Dev-only login bypass (no GitHub) so the flow is testable. Gated by env in the route. */
export async function devLogin(githubUserId: number, githubLogin: string): Promise<LoginOutcome> {
  return withSystem(async (tx) => {
    const principalId = await upsertPrincipal(tx, githubUserId, githubLogin, githubLogin, null);
    const activatedProjects = await activateInvites(tx, principalId, githubLogin, githubUserId, githubLogin, null);
    const token = await issueTokenTx(tx, principalId);
    return { token, principalId, githubLogin, activatedProjects };
  });
}

/** Verify a principal is a member of an org; returns the member row or throws 403. */
export async function ensureMember(orgId: string, principalId: string): Promise<{ id: string; role?: string }> {
  return withOrg(orgId, async (tx) => {
    const m = (
      await tx
        .select()
        .from(members)
        .where(and(eq(members.orgId, orgId), eq(members.principalId, principalId)))
        .limit(1)
    )[0];
    if (!m) throw Object.assign(new Error("not a member of this org"), { statusCode: 403 });
    return { id: m.id };
  });
}

export async function createOrg(principal: Principal, name: string): Promise<{ orgId: string }> {
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name, deployment: env.LOCKSTEP_DEPLOYMENT }).returning());
    await tx.insert(members).values({
      orgId: org.id,
      principalId: principal.id,
      githubUserId: principal.githubUserId,
      githubLogin: principal.githubLogin,
      displayName: principal.githubLogin,
    });
    return { orgId: org.id };
  });
}

export async function createProject(
  principal: Principal,
  orgId: string,
  name: string,
): Promise<{ projectId: string }> {
  const me = await ensureMember(orgId, principal.id);
  return withOrg(orgId, async (tx) => {
    const p = one(await tx.insert(projects).values({ orgId, name, createdBy: me.id }).returning());
    return { projectId: p.id };
  });
}

export async function invite(
  principal: Principal,
  orgId: string,
  projectId: string,
  githubLogin: string,
  role = "member",
): Promise<{ inviteId: string; status: string }> {
  const me = await ensureMember(orgId, principal.id);
  return withOrg(orgId, async (tx) => {
    const row = one(
      await tx
        .insert(projectMembers)
        .values({ orgId, projectId, invitedGithubLogin: githubLogin, role, invitedBy: me.id })
        .returning(),
    );
    return { inviteId: row.id, status: row.status };
  });
}

export async function connectRepo(
  principal: Principal,
  orgId: string,
  projectId: string,
  gitRemote: string,
  isMonorepo = false,
): Promise<{ repoId: string }> {
  await ensureMember(orgId, principal.id);
  const { repoId } = await withOrg(orgId, async (tx) => {
    const r = one(await tx.insert(repos).values({ orgId, projectId, gitRemote, isMonorepo }).returning());
    return { repoId: r.id };
  });
  // Best-effort: pull CODEOWNERS via the GitHub App so ownership routing works immediately.
  try {
    await ingestCodeownersFromGitHub(orgId, repoId, gitRemote);
  } catch {
    /* App not installed / no CODEOWNERS — fine, ownership graph just stays empty */
  }
  return { repoId };
}

export async function listMemberships(
  principalId: string,
): Promise<{ orgId: string; memberId: string; githubLogin: string }[]> {
  return withSystem(async (tx) => {
    const ms = await tx.select().from(members).where(eq(members.principalId, principalId));
    return ms.map((m) => ({ orgId: m.orgId, memberId: m.id, githubLogin: m.githubLogin }));
  });
}
