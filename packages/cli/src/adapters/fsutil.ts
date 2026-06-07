import { mkdir, readFile, writeFile, rename, access } from "node:fs/promises";
import { dirname } from "node:path";

export async function readIfExists(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read → transform → atomic write (temp + rename), backing up the original once.
 * Returns a human-readable status line. No-op (and reports "unchanged") if the
 * transform produces identical content — this is what makes init idempotent.
 */
export async function applyFile(
  p: string,
  transform: (cur: string | null) => string,
  dryRun: boolean,
): Promise<string> {
  const cur = await readIfExists(p);
  const next = transform(cur);
  if (cur === next) return `unchanged  ${p}`;
  if (dryRun) return `would write ${p}`;
  await mkdir(dirname(p), { recursive: true });
  if (cur !== null && !(await exists(`${p}.lockstep.bak`))) {
    await writeFile(`${p}.lockstep.bak`, cur);
  }
  const tmp = `${p}.tmp-${process.pid}`;
  await writeFile(tmp, next);
  await rename(tmp, p);
  return `wrote      ${p}`;
}
