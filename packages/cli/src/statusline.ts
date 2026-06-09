import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { getToken } from "./auth/token-store.js";
import { resolveApiUrl } from "./config.js";

interface PeekResp {
  unread: number;
  questions: number;
  tasks: number;
  changes: number;
  decisions: number;
}

interface StdinData {
  cwd?: string;
  workspace?: { current_dir?: string; project_dir?: string };
}

const CACHE_PATH = join(tmpdir(), "lockstep-statusline-cache.json");
const CACHE_TTL_MS = 30_000; // 30 seconds

interface Cache {
  ts: number;
  remote: string;
  data: PeekResp;
}

function readCache(remote: string): PeekResp | null {
  try {
    const c = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Cache;
    if (c.remote === remote && Date.now() - c.ts < CACHE_TTL_MS) return c.data;
  } catch {
    /* no cache */
  }
  return null;
}

function writeCache(remote: string, data: PeekResp): void {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify({ ts: Date.now(), remote, data }));
  } catch {
    /* ignore */
  }
}

function gitRemote(cwd: string): string | null {
  try {
    const url = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    return url
      .replace(/^(https?:\/\/|git@|ssh:\/\/)/, "")
      .replace(/\.git$/, "")
      .replace(":", "/");
  } catch {
    return null;
  }
}

/**
 * Status line entry point. Reads Claude Code session JSON from stdin,
 * resolves the git remote, peeks at the inbox, and prints a one-liner.
 * Caches results for 30s to avoid hammering the API.
 */
export async function runStatusLine(): Promise<void> {
  try {
    // Read stdin (Claude Code sends session JSON)
    let input = "";
    try {
      input = readFileSync(0, "utf8");
    } catch {
      /* no stdin */
    }

    let cwd = process.cwd();
    try {
      const data = JSON.parse(input) as StdinData;
      cwd = data.cwd ?? data.workspace?.current_dir ?? data.workspace?.project_dir ?? cwd;
    } catch {
      /* use process.cwd */
    }

    const remote = gitRemote(cwd);
    if (!remote) return; // not a git repo — print nothing

    // Check cache first
    const cached = readCache(remote);
    if (cached) {
      printStatus(cached);
      return;
    }

    const token = await getToken();
    if (!token) return; // not logged in — print nothing

    const api = resolveApiUrl();
    const res = await fetch(`${api}/inbox/peek/me?remote=${encodeURIComponent(remote)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return; // API error — print nothing

    const data = (await res.json()) as PeekResp;
    writeCache(remote, data);
    printStatus(data);
  } catch {
    // Never break the status line
  }
}

function printStatus(data: PeekResp): void {
  if (data.unread === 0) {
    process.stdout.write("\x1b[2m\u{1f4ed} lockstep\x1b[0m");
    return;
  }

  const parts: string[] = [];
  if (data.questions) parts.push(`${data.questions}\u{2753}`);
  if (data.tasks) parts.push(`${data.tasks}\u{1f4cb}`);
  if (data.decisions) parts.push(`${data.decisions}\u{2696}\u{fe0f}`);
  if (data.changes) parts.push(`${data.changes}\u{1f4e5}`);

  const detail = parts.length ? ` (${parts.join(" ")})` : "";
  process.stdout.write(`\x1b[1m\u{1f4ec} ${data.unread} new${detail}\x1b[0m \x1b[2m\u{00b7} lockstep\x1b[0m`);
}
