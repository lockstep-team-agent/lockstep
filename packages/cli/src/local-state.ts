import { join } from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { configDir, resolveApiUrl } from "./config.js";

export interface LocalState {
  automaticChecks?: boolean;
  configured?: boolean;
  connected?: boolean;
  projectId?: string;
  featureRef?: string;
  verifiedAt?: string;
  verifiedSession?: string;
  lastCheck?: { fingerprint: string; result: unknown };
}

function statePath(cwd: string): string {
  const key = createHash("sha256").update(`${resolveApiUrl()}\n${cwd}`).digest("hex").slice(0, 24);
  return join(configDir, "repos", `${key}.json`);
}
export function readLocalState(cwd = process.cwd()): LocalState {
  try { return JSON.parse(readFileSync(statePath(cwd), "utf8")) as LocalState; } catch { return {}; }
}
export function saveLocalState(patch: Partial<LocalState>, cwd = process.cwd()): void {
  const path = statePath(cwd);
  mkdirSync(join(configDir, "repos"), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ ...readLocalState(cwd), ...patch }, null, 2), { mode: 0o600 });
  renameSync(temp, path);
}
