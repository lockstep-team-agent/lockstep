import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

/** Persisted CLI config (~/.lockstep/config.json) so users set the API once, not every shell. */
const dir = join(homedir(), ".lockstep");
const path = join(dir, "config.json");

interface Config {
  apiUrl?: string;
}

export function getConfig(): Config {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Config;
  } catch {
    return {};
  }
}

export function setApiUrl(apiUrl: string): void {
  mkdirSync(dir, { recursive: true });
  const c = getConfig();
  c.apiUrl = apiUrl.replace(/\/+$/, "");
  writeFileSync(path, JSON.stringify(c, null, 2), { mode: 0o600 });
}

/** Resolution order: env var → saved config → default. Trailing slash stripped. */
export function resolveApiUrl(): string {
  const raw = process.env.LOCKSTEP_API_URL || getConfig().apiUrl || "http://localhost:8080";
  return raw.replace(/\/+$/, "");
}
