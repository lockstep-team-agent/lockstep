/**
 * Tier-2 enforcement gate. On a PR:
 *   1. compute changed files (base...head)
 *   2. classify contract surfaces (same heuristic as Tier-1 capture)
 *   3. register a session for this repo, call /reconcile
 *   4. fail the check if any changed contract surface has no binding decision;
 *      comment stale dependents.
 *
 * Auth: a Lockstep CI token (input `token`). Production also supports GitHub OIDC exchange.
 * Relies on branch protection / required PRs to be airtight (a direct push skips CI).
 */
import { execFileSync } from "node:child_process";

const API = process.env.INPUT_API_URL || process.env.LOCKSTEP_API_URL;
const TOKEN = process.env.INPUT_TOKEN || process.env.LOCKSTEP_CI_TOKEN;
const BASE = process.env.GITHUB_BASE_REF || "main";

function sh(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" });
  } catch {
    return "";
  }
}
function isContractSurface(path) {
  if (/(openapi|swagger)/i.test(path) && /\.(ya?ml|json)$/i.test(path)) return true;
  if (/\.(proto|graphql|gql)$/i.test(path)) return true;
  if (/(^|\/)(routes?|controllers?|api|handlers?|endpoints?|contracts?)(\/|\.)/i.test(path)) return true;
  return false;
}
function normalizeRemote(url) {
  return url
    .trim()
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/\.git$/, "");
}
async function api(method, path, session, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      ...(session ? { "x-lockstep-session": session } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  if (!API || !TOKEN) {
    console.error("missing api-url / token");
    process.exit(1);
  }
  sh(["fetch", "origin", BASE, "--depth", "1"]);
  const files = sh(["diff", `origin/${BASE}...HEAD`, "--name-only"])
    .split("\n")
    .filter(Boolean);
  const surfaces = files.filter(isContractSurface);
  if (surfaces.length === 0) {
    console.log("Lockstep: no contract surfaces changed — pass.");
    return;
  }
  const remote = normalizeRemote(sh(["remote", "get-url", "origin"]));
  const session = (await api("POST", "/sessions/register", undefined, { gitRemote: remote })).sessionId;
  const result = await api("POST", "/reconcile", session, { contractSurfaces: surfaces });

  for (const s of result.staleDependents ?? []) {
    console.log(`⚠ ${s.surface} is consumed by ${s.consumers.length} repo(s) — ensure they're updated.`);
  }
  if (!result.ok) {
    console.error(
      `❌ Lockstep: contract surface(s) changed without a binding decision: ${result.violations.join(", ")}`,
    );
    console.error("   Propose + ack a decision (e.g. via your agent's propose_decision) before merging.");
    process.exit(1);
  }
  console.log("✅ Lockstep: all changed contract surfaces have binding decisions.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
