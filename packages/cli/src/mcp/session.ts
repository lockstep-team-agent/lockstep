import { gitRemote } from "./git.js";
import { call } from "./api.js";

export interface Session {
  sessionId: string;
  orgId: string;
  projectId: string;
  repoId: string;
  memberId: string;
}

/** Register this agent session: cwd + git remote → (user, repo, project). */
export async function registerSession(vendor: string): Promise<Session> {
  const cwd = process.cwd();
  const remote = gitRemote(cwd);
  if (!remote) {
    throw new Error("no git 'origin' remote found — Lockstep identifies the repo by its remote");
  }
  return call<Session>("POST", "/sessions/register", undefined, { gitRemote: remote, cwd, vendor });
}
