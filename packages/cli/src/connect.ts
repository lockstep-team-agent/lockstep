import { cloud } from "./cloud.js";
import { gitRemote } from "./mcp/git.js";

interface Me {
  principal: { githubLogin: string };
  memberships: Array<{ orgId: string }>;
}
interface Overview {
  projects: Array<{ id: string; name: string; repos?: Array<{ gitRemote: string }> }>;
}
interface ConnectResult {
  orgId: string;
  projectId: string;
  projectName: string;
  status: "already-connected" | "joined" | "created";
  createdOrg?: boolean;
}

/**
 * Connect the current repo. The server resolves the remote and either:
 *  - joins you (if you have GitHub access to an already-connected repo — no approval needed),
 *  - opens it (if you're already a member), or
 *  - creates the project and connects it.
 */
export async function runConnect(opts: { org?: string; project?: string }): Promise<void> {
  const remote = gitRemote(process.cwd());
  if (!remote) {
    console.error("No git 'origin' remote here — Lockstep identifies a repo by its remote.");
    process.exit(1);
  }

  const r = await cloud.post<ConnectResult>("/connect", { gitRemote: remote, project: opts.project });
  const verb =
    r.status === "created" ? "created and connected" : r.status === "joined" ? "joined" : "already connected to";
  console.log(`✓ ${verb} project "${r.projectName}"  (${remote})`);

  if (r.createdOrg) {
    // The repo landed in a brand-new workspace — likely NOT what you want if a teammate already has
    // this project. Cross-service teammates join via an invite, not by naming the same project.
    console.log(`\n⚠ This created a NEW workspace "${r.projectName}".`);
    console.log(`  If you meant to join a teammate's project, ask them to run`);
    console.log(`  \`lockstep invite ${process.env.USER ?? "<your-github-handle>"}\` first, then re-run \`lockstep connect\`.`);
  }
  console.log(`\nOpen this repo in Claude Code — Lockstep registers the session automatically.`);
  if (r.status === "created") {
    console.log(`Invite teammates with \`lockstep invite <github-handle>\`.`);
  }
}

/** Invite a teammate by GitHub handle to the project THIS repo is connected to. */
export async function runInvite(handle: string): Promise<void> {
  const remote = gitRemote(process.cwd());
  if (!remote) {
    console.error("Run this inside a connected repo.");
    process.exit(1);
  }
  const me = await cloud.get<Me>("/me");
  const orgIds = [...new Set(me.memberships.map((m) => m.orgId))];
  if (orgIds.length === 0) {
    console.error("No workspace yet — run `lockstep connect` first.");
    process.exit(1);
  }
  // Resolve the project by which one this repo's remote is actually connected to — not by guessing
  // the name from the remote (which breaks when `connect --project` used a custom name).
  for (const orgId of orgIds) {
    const overview = await cloud.get<Overview>(`/orgs/${orgId}/overview`);
    const project = overview?.projects.find((p) => (p.repos ?? []).some((r) => r.gitRemote === remote));
    if (project) {
      await cloud.post(`/orgs/${orgId}/projects/${project.id}/invite`, { githubLogin: handle.replace(/^@/, "") });
      console.log(
        `✓ invited @${handle.replace(/^@/, "")} to "${project.name}" — they'll be activated on their next login.`,
      );
      return;
    }
  }
  console.error("This repo isn't connected yet — run `lockstep connect` first.");
  process.exit(1);
}
