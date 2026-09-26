import { createInterface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { runInit } from "./init.js";
import { ensureLoggedIn } from "./login.js";
import { runConnect } from "./connect.js";
import { runPack } from "./pack.js";
import { runScan, type ScanProposal } from "./scan.js";
import { gitIdentity, renderInvites, suggestInvites } from "./invites.js";
import { previewDocs, type DocFile } from "./capture/markdown.js";
import { call } from "./mcp/api.js";
import { registerSession } from "./mcp/session.js";
import { cloud } from "./cloud.js";
import { dashboardUrl, resolveApiUrl, setApiUrl } from "./config.js";
import { readLocalState, saveLocalState } from "./local-state.js";
import { gitRemote } from "./mcp/git.js";
import type { Scope } from "./adapters/types.js";

export interface OnboardOptions { vendor?: string; scope?: Scope; dryRun?: boolean; noDocs?: boolean; broadDocs?: boolean; yes?: boolean; uploadDocs?: boolean; enableChecks?: boolean; disableChecks?: boolean; api?: string; project?: string; projectId?: string; feature?: string; docs?: string[]; manualDecision?: string }
interface Proposal { decisionId: string; ruleText: string; evidence?: string; anchorKey?: string; deduped?: boolean }

/** Exported orchestration seam: failed optional steps never suppress pack or the honest summary. */
export async function runOptionalSteps(steps: Array<{ name: string; run: () => Promise<unknown> }>, report: (message: string) => void = console.error) {
  for (const step of steps) {
    try { await step.run(); } catch { report(`${step.name} incomplete; retry onboarding or use the individual command.`); }
  }
}

export async function runOnboard(opts: OnboardOptions): Promise<void> {
  if (opts.vendor && opts.vendor !== "claude" && opts.vendor !== "all") throw new Error("This onboarding release supports Claude Code only.");
  if (opts.enableChecks && opts.disableChecks) throw new Error("Choose either --enable-checks or --disable-checks.");
  const cwd = process.cwd();
  if (!gitRemote(cwd)) throw new Error("Run inside a git repository with an origin remote.");
  // dry-run previews an override without saving global config.
  if (opts.api && !opts.dryRun) setApiUrl(opts.api);
  const preview = opts.noDocs ? { files: [], skipped: [], truncated: [] } : previewDocs(cwd, opts.broadDocs);
  let files = opts.docs ? preview.files.filter((f) => opts.docs!.includes(f.path)) : preview.files;
  console.log(`Lockstep — decisions for your next Claude session\nAPI: ${opts.api ?? resolveApiUrl()}\nRepo: ${gitRemote(cwd)}`);
  console.log("\nLocal preview — no document or code content has been uploaded:");
  files.forEach((f, i) => console.log(`  ${i + 1}. ${f.path} (${f.sections.length} sections)`));
  for (const skipped of [...preview.skipped, ...preview.truncated]) console.log(`  Skipped/truncated: ${skipped}`);
  await runInit({ vendor: "claude", scope: opts.scope ?? "project", dryRun: true });
  if (opts.dryRun) return;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive && !opts.yes) {
    console.log("\nPreview only. Re-run in a terminal, or use --yes to install. Uploads additionally require --upload-docs or --enable-checks.");
    return;
  }
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (question: string) => (await rl?.question(question) ?? "").trim();
  const yes = (answer: string) => /^(y|yes)$/i.test(answer);
  let confirmed = 0;
  try {
    if (!opts.yes && !yes(await ask("Install the previewed Claude integration and connect this repo? [y/N] "))) return;
    await ensureLoggedIn();
    await runConnect({ project: opts.project, projectId: opts.projectId, pilot: true });
    const session = await registerSession("onboard");
    console.log(`Destination: project ${session.projectId} in workspace ${session.orgId}`);
    await runInit({ vendor: "claude", scope: opts.scope ?? "project", dryRun: false });
    saveLocalState({ configured: true, connected: true, projectId: session.projectId, ...(opts.feature ? { featureRef: opts.feature } : {}) });
    if (opts.enableChecks) saveLocalState({ automaticChecks: true });
    else if (opts.disableChecks) saveLocalState({ automaticChecks: false });
    else if (rl && readLocalState().automaticChecks === undefined) {
      console.log("Hosted code checks send bounded tracked-code diff hunks to this API and its configured judgment provider. Raw diffs are not stored by Lockstep. You can revoke this with `lockstep checks off`.");
      saveLocalState({ automaticChecks: yes(await ask("Enable advisory checks when Claude finishes a task? [y/N] ")) });
    }
    const review = async (proposals: Proposal[]) => {
      if (!rl) { console.log(`${proposals.length} proposal(s) available for review.`); return; }
      const current = await call<{ decisions: Array<{ id: string; status: string }> }>("GET", "/decisions", session.sessionId);
      const pending = proposals.filter((p) => current.decisions.some((d) => d.id === p.decisionId && d.status === "proposed"));
      for (const p of pending.slice(0, 5)) {
        console.log(`\n${p.ruleText}${p.anchorKey ? `\nSource: ${p.anchorKey}` : ""}${p.evidence ? `\nEvidence: ${p.evidence}` : ""}`);
        const action = (await ask("[y] confirm [n] reject [e] edit [s] review later: ")).toLowerCase();
        if (!action || action === "s") break;
        let ruleText: string | undefined;
        if (action === "e") { ruleText = await ask("Accepted rule: "); if (!ruleText) continue; }
        if (!["y", "n", "e"].includes(action)) continue;
        await cloud.post(`/orgs/${session.orgId}/projects/${session.projectId}/review/${p.decisionId}`, { action: action === "n" ? "reject" : "confirm", ruleText });
        if (action !== "n") confirmed++;
      }
    };
    const distill = async () => {
      if (!files.length) return;
      let upload = opts.uploadDocs === true;
      if (rl && !upload) {
        for (;;) {
          const choice = await ask("Documents: enter numbers to select, 'v' to view source, 'all', or Enter to skip: ");
          if (choice === "v") { printSources(files); continue; }
          if (!choice) { files = []; return; }
          if (choice !== "all") {
            const indexes = choice.split(/[ ,]+/).map(Number);
            files = files.filter((_, i) => indexes.includes(i + 1));
          }
          upload = files.length > 0 && yes(await ask(`Send ${files.length} selected document(s) to ${resolveApiUrl()} and its extraction provider? [y/N] `));
          break;
        }
      }
      if (!upload || !files.length) return;
      const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const result = await call<{ status: string; proposals: Proposal[] }>("POST", "/repo/distill", session.sessionId, { commit, files }, 45_000);
      if (result.status === "unavailable") console.log("Extraction unavailable. Add a decision manually or retry later.");
      else await review(result.proposals);
    };
    // Held in an object so the optional-step closure can fill it without tripping narrowing.
    const scanned: { proposal?: ScanProposal } = {};
    await runOptionalSteps([
      { name: "Repository scan", run: async () => { scanned.proposal = await runScan({ apply: true, session }); } },
      { name: "Documentation import", run: distill },
      { name: "Manual decision", run: async () => {
        const text = opts.manualDecision ?? (rl ? await ask("Add a decision in your own words (Enter to skip): ") : "");
        if (!text) return;
        const proposal = await call<{ decisionId: string }>("POST", "/repo/decisions", session.sessionId, { ruleText: text });
        await review([{ decisionId: proposal.decisionId, ruleText: text }]);
      } },
      { name: "Decision pack", run: () => runPack({}) },
    ]);
    const all = await call<{ decisions: Array<{ status: string }> }>("GET", "/decisions", session.sessionId);
    const accepted = all.decisions.filter((d) => d.status === "binding").length;
    const state = readLocalState();
    const p = scanned.proposal;
    const surfaces = p
      ? `${p.produces.length ? "✓" : "○"} Surfaces: ${p.produces.length} produced · ${p.consumes.length} consumed · ${p.unmatched.length} undeclared`
      : "○ Surfaces: scan incomplete — run `lockstep scan --apply`";
    console.log(`\n✓ Configured · ✓ Connected\n${surfaces}\n${accepted ? "✓" : "○"} Decisions ready: ${accepted} accepted (${confirmed} confirmed now)\n${state.verifiedAt ? "✓" : "○"} Agent verified: ${state.verifiedAt ?? "pending a real Claude session"}\nHosted checks: ${state.automaticChecks ? "enabled" : "off"}\nDashboard: ${dashboardUrl()}/project/${session.orgId}/${session.projectId}\nReview: ${dashboardUrl()}/project/${session.orgId}/${session.projectId}/review-queue`);
    const invites = await inviteFooter(cwd, p);
    if (invites) console.log(`\n${invites}`);
    // Org skills are opt-in per checkout (A8): offer, never enroll implicitly.
    if (!readLocalState().environmentId) {
      const { standardsOn } = await import("./standards/client.js");
      if (await standardsOn()) console.log("\nYour organization can send approved skills to this checkout. To opt in: lockstep enroll");
    }
    console.log("\nOpen Claude Code in this repo. Approve the project MCP server when prompted; then run lockstep status to inspect verification.");
  } finally { rl?.close(); }
}

/**
 * Who to ask for next. Best-effort throughout: a failed `/me` still excludes the local git identity,
 * and no suggestions simply prints nothing.
 * ponytail: excludes you, not existing project members — `lockstep invite` is idempotent, so a
 * redundant suggestion costs a wasted command, not a wrong one.
 */
async function inviteFooter(cwd: string, proposal: ScanProposal | undefined): Promise<string> {
  const unmatched = proposal?.unmatched ?? [];
  if (unmatched.length === 0) return "";
  const exclude = gitIdentity(cwd);
  try {
    const me = await cloud.get<{ principal: { githubLogin: string } }>("/me");
    exclude.push(me.principal.githubLogin);
  } catch {
    /* offline — the local git identity is still excluded */
  }
  return renderInvites(suggestInvites(cwd, unmatched, exclude), unmatched.length);
}

function printSources(files: DocFile[]) {
  for (const f of files) for (const s of f.sections) console.log(`\n--- ${f.path} › ${s.headingPath.join(" › ") || "preamble"} ---\n${s.text}`);
}
