/**
 * The PR comment builder — pure (no GitHub API, no LLM: the suggestion is templated from the
 * surface string; the developer's own coding agent drafts the actual decision locally). One
 * marker-keyed comment carries both sections so postPrComment can UPSERT instead of spamming a new
 * comment per push.
 */
export const COMMENT_MARKER = "<!-- lockstep-pr-check -->";

/** The copy-paste instruction for one violating surface (the backfill flywheel — IMPROVEMENTS Phase J deferral). */
export function backfillSuggestion(surface) {
  return [
    "Ask your coding agent:",
    `"Log the decision governing ${surface}: call propose_decision with scopeKind "surface",`,
    `scopeRef "${surface}", the rule this change establishes, a one-line rationale (and`,
    'alternatives if any were considered), then ack it to make it binding. Re-run the PR check."',
  ].join("\n");
}

/**
 * Build the full PR comment body, or null when there is nothing to say.
 * violations: string[] of surface ids missing a binding decision.
 * conflictLines: pre-rendered markdown bullets for open product-constraint conflicts.
 */
export function buildComment({ violations = [], conflictLines = [] }) {
  if (violations.length === 0 && conflictLines.length === 0) return null;
  const parts = [COMMENT_MARKER];

  if (violations.length > 0) {
    parts.push(
      `### ❌ Lockstep: missing binding decision${violations.length === 1 ? "" : "s"}`,
      "",
      "These changed contract surfaces have no binding decision — an undocumented decision was just discovered in review. Backfill it (no rewrite needed, just record what this change decides):",
      "",
    );
    for (const surface of violations) {
      parts.push(`- **\`${surface}\`**`, "", "```", backfillSuggestion(surface), "```", "");
    }
  }

  if (conflictLines.length > 0) {
    parts.push(
      `### ⚠ Lockstep: product-constraint conflict${conflictLines.length === 1 ? "" : "s"} on this PR`,
      "",
      ...conflictLines,
      "",
      "Resolve in the Lockstep dashboard (Review → Conflicts), or amend the PRD.",
    );
  }

  return parts.join("\n").trimEnd() + "\n";
}
