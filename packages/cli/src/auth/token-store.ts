import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";

/**
 * Stores the Lockstep session token. Prefers the OS keychain (keytar) but falls back to a
 * 0600 file under ~/.lockstep whenever keytar is missing OR throws (e.g. headless/no keychain).
 * Never stores the GitHub token.
 */
const SERVICE = "lockstep";
const ACCOUNT = "session-token";
const fileDir = join(homedir(), ".lockstep");
const filePath = join(fileDir, "credentials.json");

interface Keychain {
  getPassword: (s: string, a: string) => Promise<string | null>;
  setPassword: (s: string, a: string, p: string) => Promise<void>;
  deletePassword: (s: string, a: string) => Promise<boolean>;
}

async function keychain(): Promise<Keychain | null> {
  try {
    const mod = await import("keytar");
    return (mod.default ?? mod) as unknown as Keychain;
  } catch {
    return null;
  }
}

async function fileSet(token: string): Promise<void> {
  await mkdir(fileDir, { recursive: true });
  await writeFile(filePath, JSON.stringify({ token }), { mode: 0o600 });
  await chmod(filePath, 0o600);
}
async function fileGet(): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(filePath, "utf8")) as { token?: string }).token ?? null;
  } catch {
    return null;
  }
}

export async function setToken(token: string): Promise<void> {
  const kc = await keychain();
  if (kc) {
    try {
      await kc.setPassword(SERVICE, ACCOUNT, token);
      return;
    } catch {
      /* keychain unavailable → file fallback */
    }
  }
  await fileSet(token);
}

export async function getToken(): Promise<string | null> {
  const kc = await keychain();
  if (kc) {
    try {
      const v = await kc.getPassword(SERVICE, ACCOUNT);
      if (v) return v;
    } catch {
      /* fall through to file */
    }
  }
  return fileGet();
}

export async function clearToken(): Promise<void> {
  const kc = await keychain();
  if (kc) {
    try {
      await kc.deletePassword(SERVICE, ACCOUNT);
    } catch {
      /* ignore */
    }
  }
  await rm(filePath, { force: true });
}
