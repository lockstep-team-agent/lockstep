import { and, eq } from "drizzle-orm";
import { withOrg, withSystem, type Tx } from "../db/rls.js";
import { principals, members, projects, projectMembers, orgs, githubCredentials, repos } from "../db/schema.js";
import { issueTokenTx, type Principal } from "./tokens.js";
import * as gh from "./github.js";
import { encrypt, decrypt } from "./crypto.js";
import { env } from "../env.js";
import { ingestCodeownersFromGitHub } from "../graph/ownership-service.js";
import { writeAudit } from "../audit/audit-service.js";
import { getProjectRoleTx } from "./permissions.js";

const PROJECT_ROLES = ["member", "pm", "owner"];

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}

/**
 * Backfill an authoritative project_members row for a member who joined by creating a project or by
 * repo auto-join (not by invite). #2 "walled" visibility gates reads on this roster, so creators and
 * auto-joiners MUST appear here — invites already do (activateInvites). Idempotent on the
 * (projectId, invitedGithubLogin) unique index; never touches an existing row's role/status.
 */
async function ensureProjectMemberTx(
  tx: Tx,
  v: { orgId: string; projectId: string; memberId: string; githubLogin: string; role?: string },
): Promise<void> {
  await tx
    .insert(projectMembers)
    .values({
      orgId: v.orgId,
      projectId: v.projectId,
      memberId: v.memberId,
      invitedGithubLogin: v.githubLogin,
      role: v.role ?? "member",
      status: "active",
    })
    .onConflictDoNothing({ target: [projectMembers.projectId, projectMembers.invitedGithubLogin] });
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
    await ensureProjectMemberTx(tx, {
      orgId,
      projectId: p.id,
      memberId: me.id,
      githubLogin: principal.githubLogin,
      role: "owner",
    });
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
  // Whitelist the role — it lands verbatim in project_members and (post-#2) gates every write.
  if (!PROJECT_ROLES.includes(role)) throw Object.assign(new Error("invalid role"), { statusCode: 400 });
  const me = await ensureMember(orgId, principal.id);
  return withOrg(orgId, async (tx) => {
    // Inviting is a project-admin action: only owners/PMs may invite at all, and only an owner may
    // grant owner/pm (a PM can invite members only). Org membership alone is NOT enough — otherwise any
    // org member could self-invite into a walled project or mint themselves owner on any project.
    const actorRole = await getProjectRoleTx(tx, projectId, me.id);
    if (actorRole !== "owner" && actorRole !== "pm")
      throw Object.assign(new Error("only owners/PMs can invite"), { statusCode: 403 });
    if ((role === "owner" || role === "pm") && actorRole !== "owner")
      throw Object.assign(new Error("only owners can grant owner/pm"), { statusCode: 403 });
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
  /** True only when a brand-new workspace (org) was created — the CLI warns about accidental-solo. */
  createdOrg?: boolean;
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
      // Backfill the project roster on this path too — org members who created/auto-joined before the
      // roster existed (or who simply reconnect) otherwise never get a project_members row and vanish
      // from the Members page + org graph. Idempotent (onConflictDoNothing).
      await withSystem(async (tx) => {
        const m = (
          await tx
            .select()
            .from(members)
            .where(and(eq(members.orgId, repo.orgId), eq(members.principalId, principal.id)))
            .limit(1)
        )[0];
        if (m)
          await ensureProjectMemberTx(tx, {
            orgId: repo.orgId,
            projectId: repo.projectId,
            memberId: m.id,
            githubLogin: principal.githubLogin,
          });
      });
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
          const m = one(
            await tx
              .insert(members)
              .values({
                orgId: repo.orgId,
                principalId: principal.id,
                githubUserId: principal.githubUserId,
                githubLogin: principal.githubLogin,
                displayName: principal.githubLogin,
              })
              .returning(),
          );
          // #2 roster: the auto-joiner becomes a project member of the repo's project (default role).
          await ensureProjectMemberTx(tx, {
            orgId: repo.orgId,
            projectId: repo.projectId,
            memberId: m.id,
            githubLogin: principal.githubLogin,
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

  // Repo isn't connected anywhere yet. The orgs this principal already belongs to — populated by
  // invites activated at login (see activateInvites), which is how a teammate joins a cross-service
  // project they don't share a repo with.
  const memberOrgs = await withSystem(async (tx) => {
    const ms = await tx.select().from(members).where(eq(members.principalId, principal.id));
    return [...new Set(ms.map((m) => m.orgId))];
  });
  const pname = projectName ?? gitRemote.split("/").pop() ?? "project";

  // 1) JOIN: if a project with this name already exists in one of the user's orgs (e.g. the project
  //    they were invited to), connect this repo into it. This is the cross-service teammate path.
  for (const oid of memberOrgs) {
    const existing = await withOrg(
      oid,
      async (tx) =>
        (
          await tx
            .select()
            .from(projects)
            .where(and(eq(projects.orgId, oid), eq(projects.name, pname)))
            .limit(1)
        )[0],
    );
    if (existing) {
      await connectRepo(principal, oid, existing.id, gitRemote);
      // #2 roster: ensure the joiner is a project member (a prior invite may already have activated it).
      await withOrg(oid, async (tx) => {
        const me = (
          await tx
            .select()
            .from(members)
            .where(and(eq(members.orgId, oid), eq(members.principalId, principal.id)))
            .limit(1)
        )[0];
        if (me)
          await ensureProjectMemberTx(tx, {
            orgId: oid,
            projectId: existing.id,
            memberId: me.id,
            githubLogin: principal.githubLogin,
          });
      });
      return {
        orgId: oid,
        projectId: existing.id,
        projectName: pname,
        status: "joined",
        createdOrg: false,
      };
    }
  }

  // 2) CREATE: no matching project. Use the user's existing workspace if they have one; otherwise
  //    spin up a new workspace — the "you might be going solo" case the CLI warns about.
  let orgId = memberOrgs[0];
  let createdOrg = false;
  if (!orgId) {
    orgId = (await createOrg(principal, `${principal.githubLogin}'s workspace`)).orgId;
    createdOrg = true;
  }
  const projectId = await withOrg(orgId, async (tx) => {
    const me = (
      await tx
        .select()
        .from(members)
        .where(and(eq(members.orgId, orgId!), eq(members.principalId, principal.id)))
        .limit(1)
    )[0];
    const p = one(await tx.insert(projects).values({ orgId: orgId!, name: pname, createdBy: me?.id }).returning());
    if (me) {
      await ensureProjectMemberTx(tx, {
        orgId: orgId!,
        projectId: p.id,
        memberId: me.id,
        githubLogin: principal.githubLogin,
        role: "owner",
      });
    }
    return p.id;
  });
  await connectRepo(principal, orgId, projectId, gitRemote);
  return { orgId, projectId, projectName: pname, status: "created", createdOrg };
}

/**
 * Set a member's Slack user id — the manual, always-works path for lighting up the Slack loop
 * (ratification digests, drift alerts, weekly digests, interactive buttons all resolve through
 * members.slack_user_id). Pass `null` to unlink. Audited.
 */
export async function setMemberSlackId(
  orgId: string,
  memberId: string,
  slackUserId: string | null,
  actorMemberId: string,
): Promise<void> {
  await withOrg(orgId, async (tx) => {
    await tx
      .update(members)
      .set({ slackUserId })
      .where(and(eq(members.orgId, orgId), eq(members.id, memberId)));
    await writeAudit(tx, {
      orgId,
      actorMemberId,
      action: "member.slack_linked",
      entityKind: "member",
      entityId: memberId,
      payload: { slackUserId, via: "manual" },
    });
  });
}

/**
 * Best-effort auto-link: given a Slack workspace's users (id + email, from a Composio users-list
 * call in the worker), fill in members.slack_user_id for org members whose email matches — but ONLY
 * where it's currently null, so a manual link is never clobbered. Match is case-insensitive against
 * the member's email or, failing that, their principal's GitHub email. Returns the count linked.
 */
export async function reconcileSlackMembersByEmail(
  orgId: string,
  users: Array<{ slackUserId: string; email: string | null }>,
): Promise<{ matched: number }> {
  const byEmail = new Map<string, string>();
  for (const u of users) {
    if (u.email && u.slackUserId) byEmail.set(u.email.toLowerCase(), u.slackUserId);
  }
  if (byEmail.size === 0) return { matched: 0 };
  // withSystem: `principals` is an RLS system-only table, so the principal-email fallback join is
  // invisible under withOrg. The query is still explicitly scoped to this org via the members filter.
  return withSystem(async (tx) => {
    const rows = await tx
      .select({
        memberId: members.id,
        slackUserId: members.slackUserId,
        mEmail: members.email,
        pEmail: principals.email,
      })
      .from(members)
      .leftJoin(principals, eq(members.principalId, principals.id))
      .where(eq(members.orgId, orgId));
    let matched = 0;
    for (const r of rows) {
      if (r.slackUserId) continue; // never overwrite an existing (possibly manual) link
      const email = (r.mEmail ?? r.pEmail)?.toLowerCase();
      if (!email) continue;
      const sid = byEmail.get(email);
      if (!sid) continue;
      await tx.update(members).set({ slackUserId: sid }).where(eq(members.id, r.memberId));
      await writeAudit(tx, {
        orgId,
        actorMemberId: null,
        action: "member.slack_linked",
        entityKind: "member",
        entityId: r.memberId,
        payload: { slackUserId: sid, via: "email_automatch" },
      });
      matched++;
    }
    return { matched };
  });
}

export async function listMemberships(
  principalId: string,
): Promise<{ orgId: string; memberId: string; githubLogin: string }[]> {
  return withSystem(async (tx) => {
    const ms = await tx.select().from(members).where(eq(members.principalId, principalId));
    return ms.map((m) => ({ orgId: m.orgId, memberId: m.id, githubLogin: m.githubLogin }));
  });
}
