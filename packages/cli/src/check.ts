import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { call } from "./mcp/api.js";
import { registerSession, type Session } from "./mcp/session.js";
import { readLocalState, saveLocalState } from "./local-state.js";
import { extractAllSurfaces } from "./capture/extract.js";

export interface CheckResult { id?: string; status: "completed" | "partial" | "skipped" | "unavailable"; checked: number; total: number; partial?: boolean; findings: Array<{ decisionId: string; version: number; file: string; line: number; reason: string }>; rules?: Array<{ id: string; ruleText: string }>; cached?: boolean }

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
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd, encoding: "utf8" }).trim();
  const surfaces = new Set<string>();
  for (const file of new Set(result.hunks.map((h) => h.file))) {
    try { for (const s of extractAllSurfaces(file, readFileSync(join(cwd, file), "utf8"))) surfaces.add(s); } catch { /* partial tracked diff is still checkable */ }
  }
  return { ...result, partial: result.partial || Boolean(untracked), surfaces: [...surfaces].slice(0, 100), base: revision };
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
    const result = await call<CheckResult>("POST", "/checks", session.sessionId, { ...input, featureRef }, opts.automatic ? 6000 : 15000);
    saveLocalState({ lastCheck: { fingerprint, result } });
    return result;
  } catch {
    return { status: "unavailable", checked: 0, total: 0, findings: [] };
  }
}

export function formatCheck(result: CheckResult): string {
  const lines = [`Lockstep check: ${result.status} · ${result.checked}/${result.total} rules checked${result.cached ? " (unchanged input)" : ""}.`];
  for (const f of result.findings) lines.push(`  Possible concern at ${f.file}:${f.line}: ${result.rules?.find((r) => r.id === f.decisionId)?.ruleText ?? f.decisionId}\n  ${f.reason}`);
  if (result.partial) lines.push("Some code or rules were outside this check. Untracked files are not uploaded; stage them to include them.");
  if (result.status === "completed" && result.findings.length === 0) lines.push("No possible contradictions found in the checked scope. This does not establish feature completeness.");
  if (result.status === "unavailable" || result.status === "skipped") lines.push("No compliance conclusion is available. Check consent, provider configuration and connection status.");
  return lines.join("\n");
}
