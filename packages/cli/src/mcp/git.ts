import { execFileSync } from "node:child_process";

/** Canonicalize a git remote URL to `host/org/repo` — the session match key (PRD §8). */
export function normalizeRemote(url: string): string {
  let u = url.trim();
  u = u.replace(/^git@([^:]+):/, "$1/"); // git@github.com:org/repo(.git) → github.com/org/repo
  u = u.replace(/^[a-z]+:\/\//, ""); // strip scheme
  u = u.replace(/^[^@/]+@/, ""); // strip user@ (https with creds)
  u = u.replace(/\.git$/, "");
  return u;
}

export function gitRemote(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8" });
    return normalizeRemote(out);
  } catch {
    return null;
  }
}
