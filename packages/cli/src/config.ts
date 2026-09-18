import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

/** Persisted CLI config (~/.lockstep/config.json) so users set the API once, not every shell. */
export const configDir = process.env.LOCKSTEP_CONFIG_DIR || join(homedir(), ".lockstep");
const dir = configDir;
const path = join(dir, "config.json");

interface Config {
  apiUrl?: string;
  dashboardUrl?: string;
}

export const HOSTED_API = "https://lockstep-production.up.railway.app";
export const HOSTED_DASHBOARD = "https://lockstep-dashboard.up.railway.app";

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
  const raw = process.env.LOCKSTEP_API_URL || getConfig().apiUrl || HOSTED_API;
  return raw.replace(/\/+$/, "");
}

export function dashboardUrl(): string {
  return (process.env.LOCKSTEP_DASHBOARD_URL || getConfig().dashboardUrl || (resolveApiUrl() === HOSTED_API ? HOSTED_DASHBOARD : "http://localhost:3000")).replace(/\/+$/, "");
}
