import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

/**
 * Session feature-context cache — mirrors statusline.ts's tmpdir cache, but keyed by git remote.
 * `set_feature_context` writes here so the (separate-process) capture hook can attach the
 * capabilityRef to change events. Accepted limitation (B-DB2): concurrent sessions on one
 * checkout share one context, same as the statusline cache.
 */
const TTL_MS = 8 * 3600_000; // 8 hours

interface Ctx {
  ref: string;
  ts: number;
}

function pathFor(remote: string): string {
  const key = createHash("sha1").update(remote).digest("hex").slice(0, 12);
  return join(tmpdir(), `lockstep-feature-${key}.json`);
}

export function writeFeatureContext(remote: string, ref: string): void {
  try {
    writeFileSync(pathFor(remote), JSON.stringify({ ref, ts: Date.now() } satisfies Ctx));
  } catch {
    /* ignore */
  }
}

export function readFeatureContext(remote: string): string | null {
  try {
    const c = JSON.parse(readFileSync(pathFor(remote), "utf8")) as Ctx;
    if (Date.now() - c.ts < TTL_MS) return c.ref;
  } catch {
    /* no context */
  }
  return null;
}

export function clearFeatureContext(remote: string): void {
  try {
    unlinkSync(pathFor(remote));
  } catch {
    /* ignore */
  }
}
