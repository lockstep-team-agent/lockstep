/**
 * Canonicalize a git remote to `host/org/repo` — the key every repo lookup matches on.
 *
 * The CLI already normalizes before it sends, but core trusted whatever string arrived and matched
 * on exact equality, so any other client (the dashboard's manual connect, a curl, the GitHub App,
 * an older CLI) could register `https://github.com/acme/api.git` beside an existing
 * `github.com/acme/api` and silently split one repo into two — duplicate rows, a split usage graph
 * and inflated blast radius. Normalizing at the trust boundary makes the spelling the client
 * happens to use irrelevant. Mirrors packages/cli/src/mcp/git.ts.
 */
export function normalizeRemote(url: string): string {
  let u = url.trim();
  u = u.replace(/^git@([^:]+):/, "$1/"); // git@github.com:org/repo(.git) → github.com/org/repo
  u = u.replace(/^[a-z]+:\/\//, ""); // strip scheme
  u = u.replace(/^[^@/]+@/, ""); // strip user@ (https with credentials)
  u = u.replace(/\/+$/, ""); // trailing slash BEFORE .git, else "repo.git/" keeps its suffix
  u = u.replace(/\.git$/, "");
  return u;
}
