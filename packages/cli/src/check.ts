import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { call } from "./mcp/api.js";
import { registerSession, type Session } from "./mcp/session.js";
import { readLocalState, saveLocalState } from "./local-state.js";
import { extractAllSurfaces } from "./capture/extract.js";

export interface CheckResult { id?: string; status: "completed" | "partial" | "skipped" | "unavailable"; checked: number; total: number; partial?: boolean; findings: Array<{ decisionId: string; version: number; file: string; line: number; reason: string }>; rules?: Array<{ id: string; ruleText: string }>; cached?: boolean; standards?: Array<{ name: string | null; execution: string; findings: Array<{ verdict: string; criterion: string; evidence: Array<{ location: string }> }> }> | null; /** Local-only: untracked files that were never uploaded. Never sent to the API. */ untracked?: number }

export function parseDiff(diff: string): { hunks: Array<{ file: string; text: string }>; partial: boolean } {
  const hunks: Array<{ file: string; text: string }> = [];
  let file = ""; let lines: string[] = []; let partial = false;
  const flush = () => {
    if (!lines.length) return;
    if (!file || file === "/dev/null" || /^"/.test(file) || /(?:^|\/)(?:\.env(?:\.|$)|.*\.(?:pem|key)$)/.test(file)) { partial = true; lines = []; return; }
    if (hunks.length >= 20) { partial = true; lines = []; return; }
    const text = lines.join("\n");
    if (Buffer.byteLength(text) > 3000) partial = true;
    hunks.push({ file, text: Buffer.from(text).subarray(0, 3000).toString("utf8").replace(/\uFFFD$/, "") });
    lines = [];
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) { flush(); file = ""; }
    else if (line.startsWith("+++ ")) { file = line.slice(4).replace(/^b\//, ""); }
    else if (line.startsWith("@@ ")) { flush(); lines = [line]; }
    else if (lines.length) lines.push(line);
    else if (/^(Binary files|GIT binary patch|deleted file mode|rename from)/.test(line)) partial = true;
  }
  flush();
  return { hunks, partial };
}

export function collectDiff(cwd: string, base = "HEAD") {
  if (!base || base.startsWith("-") || /[\r\n]/.test(base)) throw new Error("invalid base revision");
  const revision = execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], { cwd, encoding: "utf8" }).trim();
  const diff = execFileSync("git", ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--unified=3", revision, "--"], { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const result = parseDiff(diff);
  // Untracked files are never uploaded — not their contents and not their names. They are counted
  // only so the local summary can say what was left out.
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd, encoding: "utf8" })
    .split("\n")
    .filter(Boolean).length;
  const surfaces = new Set<string>();
  for (const file of new Set(result.hunks.map((h) => h.file))) {
    try { for (const s of extractAllSurfaces(file, readFileSync(join(cwd, file), "utf8"))) surfaces.add(s); } catch { /* partial tracked diff is still checkable */ }
  }
  // `partial` means the check itself was truncated (hunk cap, size cap, binary/rename), NOT that the
  // repo happens to hold an untracked scratch file. Folding those together left every check reading
  // "partial" forever, which trained people to ignore the one word that should mean something.
  return { ...result, partial: result.partial, untracked, surfaces: [...surfaces].slice(0, 100), base: revision };
}

export async function performCheck(opts: { base?: string; session?: Session; automatic?: boolean; uploadApproved?: boolean; featureRef?: string } = {}): Promise<CheckResult> {
  const state = readLocalState();
  if (!state.automaticChecks && !opts.uploadApproved) return { status: "skipped", checked: 0, total: 0, findings: [] };
  try {
    const input = collectDiff(process.cwd(), opts.base);
    const session = opts.session ?? await registerSession("cli");
    const featureRef = opts.featureRef ?? state.featureRef;
    const fingerprint = createHash("sha256").update(JSON.stringify({ input, featureRef })).digest("hex");
    // Server dedupe also includes current decision versions, so local caching never masks ledger edits.
    const { untracked, ...upload } = input;
    const result = await call<CheckResult>("POST", "/checks", session.sessionId, { ...upload, featureRef }, opts.automatic ? 6000 : 15000);
    saveLocalState({ lastCheck: { fingerprint, result } });
    return { ...result, untracked };
  } catch {
    return { status: "unavailable", checked: 0, total: 0, findings: [] };
  }
}

export function formatCheck(result: CheckResult): string {
  const lines = [`Lockstep check: ${result.status} · ${result.checked}/${result.total} rules checked${result.cached ? " (unchanged input)" : ""}.`];
  for (const f of result.findings) lines.push(`  Possible concern at ${f.file}:${f.line}: ${result.rules?.find((r) => r.id === f.decisionId)?.ruleText ?? f.decisionId}\n  ${f.reason}`);
  if (result.partial) lines.push("This check was truncated: some changed code or some rules were outside it.");
  if (result.untracked) {
    const one = result.untracked === 1;
    lines.push(
      `${result.untracked} untracked file${one ? " was" : "s were"} not uploaded and not checked. ` +
        `Stage ${one ? "it" : "them"} to include ${one ? "it" : "them"}.`,
    );
  }
  if (result.status === "completed" && result.findings.length === 0) lines.push("No possible contradictions found in the checked scope. This does not establish feature completeness.");
  if (result.status === "unavailable" || result.status === "skipped") lines.push("No compliance conclusion is available. Check consent, provider configuration and connection status.");
  // Org standards, judged on the same consented diff. Advisory; execution reported apart from findings.
  for (const st of result.standards ?? []) {
    const issues = st.findings.filter((f) => f.verdict === "possible_violation");
    lines.push(`Standard ${st.name ?? "(org standard)"}: ${st.execution}${issues.length ? ` · ${issues.length} possible issue(s)` : ""}`);
    for (const f of issues) lines.push(`  ${f.evidence[0]?.location ?? ""} — ${f.criterion}`);
    if (st.execution === "unavailable" || st.execution === "skipped") lines.push("  Not assessed — this is not a pass.");
  }
  return lines.join("\n");
}
