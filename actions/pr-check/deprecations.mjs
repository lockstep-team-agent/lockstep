/**
 * Retired-identifier matcher — pure. Scans the ADDED lines of a zero-context unified diff
 * (`git diff base...head -U0`) for each binding deprecation's `retired` string. Warn-only.
 */

// Dependency trees, vendored code and lockfiles: a hit there isn't something the author wrote.
const SKIP_DIR = /(^|\/)(node_modules|vendor|vendored|third_party|third-party)\//;
const LOCKFILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Gemfile\.lock|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|go\.sum|[^/]+\.lock)$/;

export function isSkippedPath(file) {
  return SKIP_DIR.test(file) || LOCKFILE.test(file);
}

/** [{ file, line, text }] for every `+` line, with its line number in the new file. */
export function parseAddedLines(diff) {
  const out = [];
  let file = null;
  let line = 0;
  let prev = "";
  for (const raw of diff.split("\n")) {
    const afterMinusHeader = prev.startsWith("--- ");
    prev = raw;
    // `+++ ` is a file header only right after `--- ` (an added line can itself start with "++ ").
    if (raw.startsWith("+++ ") && afterMinusHeader) {
      const p = raw.slice(4).trim();
      file = p === "/dev/null" ? null : p.replace(/^b\//, "");
    } else if (raw.startsWith("@@")) {
      const m = /\+(\d+)/.exec(raw);
      line = m ? Number(m[1]) : 0;
    } else if (raw.startsWith("+") && file) {
      out.push({ file, line, text: raw.slice(1) });
      line++;
    }
  }
  return out;
}

/** Literal match with identifier boundaries, so `axios` doesn't hit `axiosMock` or `myaxios`. */
function retiredRegex(retired) {
  const esc = retired.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w$])${esc}(?![\\w$])`);
}

/**
 * hits: [{ file, line, retired, replacement, decisionId }] — one per (added line, deprecation).
 * deprecations: [{ decisionId, retired, replacement }] from /reconcile.
 */
export function findRetiredUses(diff, deprecations = []) {
  const matchers = deprecations.filter((d) => d.retired?.trim()).map((d) => ({ ...d, re: retiredRegex(d.retired.trim()) }));
  if (matchers.length === 0) return [];
  const hits = [];
  for (const a of parseAddedLines(diff)) {
    if (isSkippedPath(a.file)) continue;
    for (const d of matchers) {
      if (d.re.test(a.text))
        hits.push({ file: a.file, line: a.line, retired: d.retired, replacement: d.replacement, decisionId: d.decisionId });
    }
  }
  return hits;
}

/** The annotation / comment text for one hit. */
export function hitMessage(h) {
  return `Uses retired ${h.retired} — use ${h.replacement} (decision #${h.decisionId.slice(0, 8)})`;
}
