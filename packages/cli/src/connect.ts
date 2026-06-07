import { cloud } from "./cloud.js";
import { gitRemote } from "./mcp/git.js";

interface Me {
  principal: { githubLogin: string };
  memberships: Array<{ orgId: string }>;
}
interface Overview {
  projects: Array<{ id: string; name: string }>;
}
interface ProjectOverview {
  repos: Array<{ gitRemote: string }>;
}

/**
 * Connect the current repo to a Lockstep project so agent sessions can register.
 * Creates an org/project on first use. Idempotent — re-running is a no-op.
 */
export async function runConnect(opts: { org?: string; project?: string }): Promise<void> {
  const remote = gitRemote(process.cwd());
  if (!remote) {
    console.error("No git 'origin' remote here — Lockstep identifies a repo by its remote.");
    process.exit(1);
  }

  const me = await cloud.get<Me>("/me");
  let orgId = me.memberships[0]?.orgId;
  if (!orgId) {
    const created = await cloud.post<{ orgId: string }>("/orgs", {
      name: opts.org ?? `${me.principal.githubLogin}'s workspace`,
    });
    orgId = created.orgId;
  }

  const projectName = opts.project ?? remote.split("/").pop() ?? "default";
  const overview = await cloud.get<Overview>(`/orgs/${orgId}/overview`);
  let projectId = overview?.projects.find((p) => p.name === projectName)?.id;
  if (!projectId) {
    projectId = (await cloud.post<{ projectId: string }>(`/orgs/${orgId}/projects`, { name: projectName })).projectId;
  }

  const po = await cloud.get<ProjectOverview>(`/orgs/${orgId}/projects/${projectId}/overview`);
  const already = po?.repos.some((r) => r.gitRemote === remote);
  if (!already) {
    await cloud.post(`/orgs/${orgId}/projects/${projectId}/repos`, { gitRemote: remote });
  }

  console.log(`✓ connected ${remote}`);
  console.log(`  → project "${projectName}"  (org ${orgId.slice(0, 8)})`);
  console.log(`\nOpen this repo in Claude Code — Lockstep registers the session automatically.`);
  console.log(`Invite a teammate:  lockstep invite <github-handle>  (or via the dashboard)`);
}

/** Invite a teammate by GitHub handle to this repo's project. */
export async function runInvite(handle: string): Promise<void> {
  const remote = gitRemote(process.cwd());
  if (!remote) {
    console.error("Run this inside a connected repo.");
    process.exit(1);
  }
  const me = await cloud.get<Me>("/me");
  const orgId = me.memberships[0]?.orgId;
  if (!orgId) {
    console.error("No workspace yet — run `lockstep connect` first.");
    process.exit(1);
  }
  const projectName = remote.split("/").pop() ?? "default";
  const overview = await cloud.get<Overview>(`/orgs/${orgId}/overview`);
  const projectId = overview?.projects.find((p) => p.name === projectName)?.id;
  if (!projectId) {
    console.error("This repo isn't connected yet — run `lockstep connect` first.");
    process.exit(1);
  }
  await cloud.post(`/orgs/${orgId}/projects/${projectId}/invite`, { githubLogin: handle.replace(/^@/, "") });
  console.log(`✓ invited @${handle.replace(/^@/, "")} to "${projectName}" — they'll be activated on their next login.`);
}
