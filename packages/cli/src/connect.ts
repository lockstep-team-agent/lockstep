import { cloud } from "./cloud.js";
import { gitRemote } from "./mcp/git.js";

interface Me {
  principal: { githubLogin: string };
  memberships: Array<{ orgId: string }>;
}
interface Overview {
  projects: Array<{ id: string; name: string }>;
}
interface ConnectResult {
  orgId: string;
  projectId: string;
  projectName: string;
  status: "already-connected" | "joined" | "created";
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
  console.log(`\nOpen this repo in Claude Code — Lockstep registers the session automatically.`);
  if (r.status === "created") {
    console.log(`Teammates with GitHub access can join by running \`lockstep connect\` in their clone.`);
  }
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
