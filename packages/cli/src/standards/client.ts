/** `lockstep enroll` / `lockstep skills …` and the SessionStart sync, over the core API. */
import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { realpathSync } from "node:fs";
import { call } from "../mcp/api.js";
import { registerSession, type Session } from "../mcp/session.js";
import { getToken } from "../auth/token-store.js";
import { resolveApiUrl } from "../config.js";
import { readLocalState, saveLocalState } from "../local-state.js";
import { CLI_VERSION } from "../adapters/templates.js";
import { formatSync, readState, SyncBusy, syncSkills, type SyncApi, type SyncPayload, type SyncResult } from "./sync.js";

/** Claude Code today: we install and can see what a session started with; skill use isn't observable. */
export const CLAUDE_CAPABILITIES = { install: true, sessionAvailability: true, invocation: "unobservable", checks: true } as const;

/** Stable per machine + checkout, and never the raw path or hostname. */
export function hostKey(cwd: string): string {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    /* keep cwd */
  }
  return createHash("sha256").update(`${hostname()}\n${userInfo().username}\n${real}`).digest("hex").slice(0, 32);
}

/** One absolute deadline for the whole sync: every request gets only what's left, then stops. */
export function httpApi(envId: string, sessionId: string, deadline = Date.now() + 120_000): SyncApi {
  const left = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw Object.assign(new Error("sync deadline reached"), { name: "TimeoutError" });
    return ms;
  };
  return {
    sync: () => call<SyncPayload>("GET", `/environments/${envId}/sync`, sessionId, undefined, left()),
    async blob(sha) {
      const token = await getToken();
      const res = await fetch(`${resolveApiUrl()}/environments/${envId}/blobs/${sha}`, {
        signal: AbortSignal.timeout(left()),
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "x-lockstep-session": sessionId },
      });
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    },
    receipts: (generation, results) =>
      call<{ current: boolean }>("POST", `/environments/${envId}/receipts`, sessionId, { generation, results }, left()),
    preference: async (itemId, choice) => {
      await call("POST", `/environments/${envId}/preferences`, sessionId, { itemId, choice }, left());
    },
  };
}

export async function standardsOn(): Promise<boolean> {
  const r = await call<{ standards?: boolean }>("GET", "/standards/capabilities", undefined).catch(() => null);
  return r?.standards === true;
}

function requireEnv(): string {
  const id = readLocalState().environmentId;
  if (!id) throw new Error("This checkout isn't enrolled for org skills. Run `lockstep enroll` first.");
  return id;
}

export async function runEnroll(opts: { yes?: boolean }): Promise<void> {
  const cwd = process.cwd();
  if (!(await standardsOn())) {
    console.log("Your Lockstep server doesn't have Standards & Skills turned on — nothing to enroll in.");
    return;
  }
  const session = await registerSession("claude");
  console.log(`Enroll this checkout for your organization's skills?

  • Managed skills are written to .claude/skills/lockstep-org-*/ and kept out of git
    (.git/info/exclude). No tracked file is ever changed, and nothing is executed.
  • They update at each session start, with \`lockstep skills sync\`, or via the sync_skills tool.
    A running session keeps what it started with; updates apply to the next session.
  • If you edit a managed skill, Lockstep stops and asks — it never overwrites your changes.
  • Reported to your org: adapter + version, a hashed machine/checkout id, which skill versions
    installed or failed, and which versions a session started with. Never prompts, code or paths.
`);
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      console.log("Re-run with --yes to enroll non-interactively.");
      return;
    }
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      if (!/^(y|yes)$/i.test((await rl.question("Enroll? [y/N] ")).trim())) return console.log("Not enrolled.");
    } finally {
      rl.close();
    }
  }
  const { environmentId } = await call<{ environmentId: string }>("POST", "/environments/enroll", session.sessionId, {
    adapter: "claude",
    adapterVersion: CLI_VERSION,
    hostKey: hostKey(cwd),
    capabilities: CLAUDE_CAPABILITIES,
  });
  saveLocalState({ environmentId, skillsBackoffUntil: undefined, skillsFailures: 0 });
  console.log("✓ Enrolled. Syncing org skills…");
  const r = await syncSkills(cwd, httpApi(environmentId, session.sessionId));
  console.log(formatSync(r, "command") || "No org skills are assigned to this checkout yet.");
}

/**
 * SessionStart: sync within a small budget, then report. Never throws — on failure the existing
 * files stay and we back off (30s doubling, capped at 30 min) so a flaky network can't slow every start.
 */
export async function sessionStartSync(session: Session): Promise<{ text: string; result: SyncResult | null }> {
  const st = readLocalState();
  if (!st.environmentId) return { text: "", result: null };
  if (st.skillsBackoffUntil && Date.parse(st.skillsBackoffUntil) > Date.now()) return { text: "", result: null };
  const api = httpApi(st.environmentId, session.sessionId, Date.now() + 8_000);
  const backoff = () => {
    const n = (readLocalState().skillsFailures ?? 0) + 1;
    saveLocalState({ skillsFailures: n, skillsBackoffUntil: new Date(Date.now() + Math.min(30_000 * 2 ** (n - 1), 1_800_000)).toISOString() });
  };
  try {
    const r = await syncSkills(process.cwd(), api);
    // What this session can actually use: skills intact before the sync began and still current.
    const now = readState(process.cwd()).skills;
    const avail = r.presentAtStart
      .filter((p) => now[p.itemId]?.versionId === p.versionId)
      .map((p) => ({ kind: "session_available" as const, itemId: p.itemId, versionId: p.versionId, packageHash: p.packageHash }));
    if (avail.length) await api.receipts(r.generation, avail).catch(() => {});
    // Per-item network failures are retryable: back off like a failed sync. Other outcomes
    // (local edits, integrity) need a person, not retries.
    if (r.failed.some((f) => f.code === "network")) backoff();
    else if (st.skillsFailures) saveLocalState({ skillsFailures: 0, skillsBackoffUntil: undefined });
    return { text: formatSync(r, "session"), result: r };
  } catch (e) {
    if (e instanceof SyncBusy) return { text: "🧩 Org skills are already syncing in another session.", result: null };
    backoff();
    const gone = e instanceof Error && / → 410:/.test(e.message);
    const revoked = e instanceof Error && / → 403:/.test(e.message);
    if (gone) saveLocalState({ environmentId: undefined });
    return {
      text: gone
        ? "🧩 This checkout was unenrolled from org skills; existing files were left in place."
        : revoked
          ? "🧩 Org skills can't sync: you no longer have access to this checkout's project (existing files were left in place)."
          : "🧩 Org skills couldn't sync (kept your existing files; will retry).",
      result: null,
    };
  }
}

export async function runSkills(argv: string[]): Promise<void> {
  const sub = argv[0] ?? "status";
  const cwd = process.cwd();
  if (sub === "status") {
    const s = readState(cwd);
    const st = readLocalState();
    if (!st.environmentId) return console.log("Not enrolled for org skills here. Run `lockstep enroll`.");
    const skills = Object.values(s.skills);
    console.log(skills.length ? skills.map((m) => `  ${m.slug}  v${m.version}  ${m.name}  (.claude/skills/${m.folder})`).join("\n") : "No org skills installed.");
    console.log(s.syncedAt ? `Last synced ${s.syncedAt}.` : "Never synced.");
    return;
  }
  const envId = requireEnv();
  const session = await registerSession("cli");
  const api = httpApi(envId, session.sessionId);
  const slug = argv[1];
  switch (sub) {
    case "sync":
      return print(await syncSkills(cwd, api));
    case "restore":
      if (!slug) throw new Error("usage: lockstep skills restore <slug>");
      return print(await syncSkills(cwd, api, { restore: slug }));
    case "keep":
      if (!slug) throw new Error("usage: lockstep skills keep <slug>");
      await syncSkills(cwd, api, { keepPersonal: slug }).then(print);
      return console.log(`Kept your copy as a personal skill under .claude/skills/ (…-personal). Recommended skills are declined for this checkout; a required skill is reinstalled and stays assigned.`);
    case "accept":
    case "decline": {
      if (!slug) throw new Error(`usage: lockstep skills ${sub} <slug>`);
      const p = await api.sync();
      const item = [...p.offered, ...p.desired, ...p.declined].find((x) => x.slug === slug || x.name === slug);
      if (!item) throw new Error(`no assigned skill called ${slug} here`);
      await api.preference(item.itemId, sub);
      return print(await syncSkills(cwd, api));
    }
    case "unenroll":
      await call("POST", `/environments/${envId}/unenroll`, session.sessionId);
      saveLocalState({ environmentId: undefined });
      return console.log("Unenrolled. Installed skills were left in place; delete .claude/skills/lockstep-org-*/ to remove them.");
    default:
      throw new Error("usage: lockstep skills [status|sync|restore <slug>|keep <slug>|accept <slug>|decline <slug>|unenroll]");
  }
}

function print(r: SyncResult): void {
  console.log(formatSync(r, "command") || `✓ Org skills are up to date (${r.unchanged.length} installed).`);
}
