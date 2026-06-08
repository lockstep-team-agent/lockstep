import { and, eq } from "drizzle-orm";
import { withOrg, withSystem, type Tx } from "../db/rls.js";
import { principals, members, projects, projectMembers, orgs, githubCredentials, repos } from "../db/schema.js";
import { issueTokenTx, type Principal } from "./tokens.js";
import * as gh from "./github.js";
import { encrypt, decrypt } from "./crypto.js";
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
  const existing = (await tx.select().from(principals).where(eq(principals.githubUserId, githubUserId)).limit(1))[0];
  if (existing) {
    await tx.update(principals).set({ githubLogin }).where(eq(principals.id, existing.id));
    return existing.id;
  }
  return one(await tx.insert(principals).values({ githubUserId, githubLogin, displayName: name, email }).returning())
    .id;
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

export async function createProject(principal: Principal, orgId: string, name: string): Promise<{ projectId: string }> {
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

async function getGithubToken(principalId: string): Promise<string | null> {
  return withSystem(async (tx) => {
    const c = (
      await tx.select().from(githubCredentials).where(eq(githubCredentials.principalId, principalId)).limit(1)
    )[0];
    if (!c?.accessTokenEnc) return null;
    try {
      return decrypt(c.accessTokenEnc);
    } catch {
      return null;
    }
  });
}

async function isMemberOf(orgId: string, principalId: string): Promise<boolean> {
  return withSystem(async (tx) => {
    const m = (
      await tx
        .select()
        .from(members)
        .where(and(eq(members.orgId, orgId), eq(members.principalId, principalId)))
        .limit(1)
    )[0];
    return !!m;
  });
}

async function projectNameOf(orgId: string, projectId: string): Promise<string> {
  return withOrg(orgId, async (tx) => {
    const p = (await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
    return p?.name ?? "project";
  });
}

export interface ConnectResult {
  orgId: string;
  projectId: string;
  projectName: string;
  status: "already-connected" | "joined" | "created";
}

/**
 * Smart connect: resolve the repo's remote → join if already connected (GitHub access = auth),
 * else create a project and connect it. No owner-approval step — GitHub repo access authorizes.
 */
export async function connectOrJoin(
  principal: Principal,
  gitRemote: string,
  projectName?: string,
): Promise<ConnectResult> {
  const candidates = await withSystem((tx) => tx.select().from(repos).where(eq(repos.gitRemote, gitRemote)));

  // already a member of a connected org → open it
  for (const repo of candidates) {
    if (await isMemberOf(repo.orgId, principal.id)) {
      return {
        orgId: repo.orgId,
        projectId: repo.projectId,
        projectName: await projectNameOf(repo.orgId, repo.projectId),
        status: "already-connected",
      };
    }
  }

  // connected, not a member → auto-join iff the user has GitHub access to the repo
  if (candidates.length > 0) {
    const parts = gitRemote.split("/");
    const token = await getGithubToken(principal.id);
    if (token && parts[0] === "github.com" && parts.length >= 3) {
      const hasAccess = await gh.userCanAccessRepo(token, parts[1]!, parts[2]!).catch(() => false);
      if (hasAccess) {
        const repo = candidates[0]!;
        await withSystem(async (tx) => {
          await tx.insert(members).values({
            orgId: repo.orgId,
            principalId: principal.id,
            githubUserId: principal.githubUserId,
            githubLogin: principal.githubLogin,
            displayName: principal.githubLogin,
          });
        });
        return {
          orgId: repo.orgId,
          projectId: repo.projectId,
          projectName: await projectNameOf(repo.orgId, repo.projectId),
          status: "joined",
        };
      }
    }
    throw Object.assign(
      new Error(
        "This repo is connected to a Lockstep project, but we couldn't verify your GitHub access. Re-run `lockstep login`, or ask the owner to `lockstep invite` you.",
      ),
      { statusCode: 403 },
    );
  }

  // not connected anywhere → create
  let orgId = await withSystem(async (tx) => {
    const ms = await tx.select().from(members).where(eq(members.principalId, principal.id));
    return ms[0]?.orgId;
  });
  if (!orgId) orgId = (await createOrg(principal, `${principal.githubLogin}'s workspace`)).orgId;

  const pname = projectName ?? gitRemote.split("/").pop() ?? "project";
  const projectId = await withOrg(orgId, async (tx) => {
    const existing = (
      await tx
        .select()
        .from(projects)
        .where(and(eq(projects.orgId, orgId!), eq(projects.name, pname)))
        .limit(1)
    )[0];
    if (existing) return existing.id;
    const me = (
      await tx
        .select()
        .from(members)
        .where(and(eq(members.orgId, orgId!), eq(members.principalId, principal.id)))
        .limit(1)
    )[0];
    return one(await tx.insert(projects).values({ orgId: orgId!, name: pname, createdBy: me?.id }).returning()).id;
  });
  await connectRepo(principal, orgId, projectId, gitRemote);
  return { orgId, projectId, projectName: pname, status: "created" };
}

export async function listMemberships(
  principalId: string,
): Promise<{ orgId: string; memberId: string; githubLogin: string }[]> {
  return withSystem(async (tx) => {
    const ms = await tx.select().from(members).where(eq(members.principalId, principalId));
    return ms.map((m) => ({ orgId: m.orgId, memberId: m.id, githubLogin: m.githubLogin }));
  });
}
