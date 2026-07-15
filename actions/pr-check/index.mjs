/**
 * Tier-2 enforcement gate. On a PR:
 *   1. compute changed files (base...head)
 *   2. canonicalize each changed contract file to the ledger's surface refs (vendored surface.mjs)
 *   3. register a session for this repo, call /reconcile
 *   4. FAIL if a changed contract surface has no binding decision (existing rule);
 *      WARN (default) or FAIL (block-on-conflict) if a changed surface has an OPEN product-constraint
 *      conflict; surface everything as GitHub annotations, and optionally a PR comment.
 *
 * Auth: a Lockstep CI token (input `token`). An optional `github-token` enables a PR comment.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extractSurfaces, isContractSurface } from "./surface.mjs";
import { buildComment, COMMENT_MARKER } from "./comment.mjs";

const API = process.env.INPUT_API_URL || process.env.LOCKSTEP_API_URL;
const TOKEN = process.env.INPUT_TOKEN || process.env.LOCKSTEP_CI_TOKEN;
const BASE = process.env.GITHUB_BASE_REF || "main";
const BLOCK_ON_CONFLICT = /^(true|1|yes)$/i.test(process.env.INPUT_BLOCK_ON_CONFLICT || "");
const GH_TOKEN = process.env.INPUT_GITHUB_TOKEN || "";

function sh(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" });
  } catch {
    return "";
  }
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

/** GitHub Actions workflow-command annotations (no token/permission needed). */
const annotate = (level, msg) => console.log(`::${level}::${msg.replace(/\n/g, "%0A")}`);

/**
 * Best-effort PR comment (only when a github-token is supplied + we're on a pull_request event).
 * UPSERTS by the marker: finds our previous comment and PATCHes it, else POSTs — one living
 * comment per PR instead of a new one per push.
 */
async function postPrComment(body) {
  if (!GH_TOKEN) return;
  const repo = process.env.GITHUB_REPOSITORY;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!repo || !eventPath) return;
  let prNumber;
  try {
    const ev = JSON.parse(readFileSync(eventPath, "utf8"));
    prNumber = ev.pull_request?.number ?? ev.number;
  } catch {
    return;
  }
  if (!prNumber) return;
  const gh = (path, init) =>
    fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${GH_TOKEN}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  try {
    const existing = await gh(`/repos/${repo}/issues/${prNumber}/comments?per_page=100`).then((r) =>
      r.ok ? r.json() : [],
    );
    const mine = Array.isArray(existing) ? existing.find((c) => c.body?.startsWith(COMMENT_MARKER)) : undefined;
    if (mine) {
      await gh(`/repos/${repo}/issues/comments/${mine.id}`, { method: "PATCH", body: JSON.stringify({ body }) });
    } else {
      await gh(`/repos/${repo}/issues/${prNumber}/comments`, { method: "POST", body: JSON.stringify({ body }) });
    }
  } catch {
    /* best-effort */
  }
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

  // Canonicalize changed contract files → the ledger's surface refs.
  const surfaceSet = new Set();
  for (const f of files.filter(isContractSurface)) {
    let content = "";
    try {
      content = readFileSync(f, "utf8");
    } catch {
      continue; // deleted/renamed away — nothing to read on this side
    }
    for (const s of extractSurfaces(f, content)) surfaceSet.add(s);
  }
  const surfaces = [...surfaceSet];
  if (surfaces.length === 0) {
    console.log("Lockstep: no contract surfaces changed — pass.");
    return;
  }

  const remote = normalizeRemote(sh(["remote", "get-url", "origin"]));
  const session = (await api("POST", "/sessions/register", undefined, { gitRemote: remote })).sessionId;
  const result = await api("POST", "/reconcile", session, { contractSurfaces: surfaces });

  for (const s of result.staleDependents ?? []) {
    annotate("warning", `${s.surface} is consumed by ${s.consumers.length} repo(s) — ensure they're updated.`);
  }
  for (const e of result.confirmedGovernsEdges ?? []) {
    console.log(`✓ Lockstep: linked ${e.surface} → ${e.capabilityRef}`);
  }

  // Product-constraint conflicts on the changed surfaces (v3 drift/pre-approval).
  const openConflicts = result.openConflicts ?? [];
  const commentLines = [];
  for (const c of openConflicts) {
    const doc = c.docTitle ? ` (${c.docTitle}${c.docUrl ? ` — ${c.docUrl}` : ""})` : "";
    const msg = `Product constraint conflict on ${c.surface}: "${c.constraintRuleText}"${doc} vs this change's "${c.engRuleText}". Review conflict ${c.conflictId}.`;
    annotate(BLOCK_ON_CONFLICT ? "error" : "warning", `⚠ Lockstep: ${msg}`);
    commentLines.push(`- **${c.surface}** — constraint "${c.constraintRuleText}"${doc} vs "${c.engRuleText}" (conflict \`${c.conflictId}\`)`);
  }

  // Missing-binding-decision violations (the existing hard gate).
  let failed = false;
  const violations = result.ok ? [] : (result.violations ?? []);
  if (!result.ok) {
    annotate("error", `❌ Lockstep: contract surface(s) changed without a binding decision: ${violations.join(", ")}. Propose + ack a decision before merging.`);
    failed = true;
  }
  if (openConflicts.length > 0 && BLOCK_ON_CONFLICT) failed = true;

  // One upserted comment: backfill suggestions per violating surface (templated, no LLM — the
  // developer's own agent drafts the decision locally) + the conflict section.
  const comment = buildComment({ violations, conflictLines: commentLines });
  if (comment) await postPrComment(comment);

  if (failed) process.exit(1);
  console.log(
    openConflicts.length > 0
      ? `⚠ Lockstep: ${openConflicts.length} product-constraint conflict(s) on changed surfaces (warning; set block-on-conflict to enforce).`
      : "✅ Lockstep: all changed contract surfaces have binding decisions and no open conflicts.",
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
