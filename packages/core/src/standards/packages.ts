/**
 * Skill packages: validated, size-limited, content-addressed snapshots of a skill's files.
 * Nothing in a package is ever executed — scripts are only flagged so reviewers can see them.
 */
import { and, eq } from "drizzle-orm";
import { withOrg, type Tx } from "../db/rls.js";
import { skillPackages, type PackageFile } from "../db/schema.js";
import { blobStore, sha256Hex } from "../storage/blob.js";

export const PACKAGE_LIMITS = { files: 200, fileBytes: 1_000_000, totalBytes: 5_000_000 };

export class PackageError extends Error {
  readonly statusCode = 400;
}

const SCRIPT_EXT = /\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|php|ps1|psm1|bat|cmd|exe|bin)$/i;
// Files that look like credentials never belong in a shared package.
const SECRET_LIKE = /(^|\/)(\.env(\..*)?|\.npmrc|\.pypirc|id_[a-z0-9]+|credentials(\.json)?|.*\.(pem|key|p12|pfx|keystore))$/i;

export interface PackageInput {
  path: string;
  bytes: Uint8Array;
  mode?: number;
}

/** Normalized, relative, traversal-free path — or a PackageError. */
export function cleanPath(p: string): string {
  const s = p.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!s || s.startsWith("/") || /^[a-z]:/i.test(s)) throw new PackageError(`absolute path not allowed: ${p}`);
  const parts = s.split("/");
  if (parts.some((x) => x === ".." || x === "." || x === "")) throw new PackageError(`invalid path: ${p}`);
  if (s.length > 300) throw new PackageError(`path too long: ${p}`);
  return s;
}

export const isScript = (path: string, mode = 0o644): boolean => SCRIPT_EXT.test(path) || (mode & 0o111) !== 0;

/** Canonical manifest hash: sorted by path, over path/sha/size/mode only. */
export function packageHashOf(manifest: PackageFile[]): string {
  const canon = [...manifest]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map((f) => `${f.path}\u0000${f.sha256}\u0000${f.size}\u0000${f.mode}`)
    .join("\n");
  return sha256Hex(canon);
}

/** Validate + hash files (pure; no storage). */
export function planPackage(files: PackageInput[]): { manifest: PackageFile[]; totalBytes: number; packageHash: string } {
  if (files.length === 0) throw new PackageError("a skill package needs at least SKILL.md");
  if (files.length > PACKAGE_LIMITS.files) throw new PackageError(`at most ${PACKAGE_LIMITS.files} files per package`);
  const seen = new Set<string>();
  let total = 0;
  const manifest: PackageFile[] = files.map((f) => {
    const path = cleanPath(f.path);
    if (seen.has(path)) throw new PackageError(`duplicate path: ${path}`);
    seen.add(path);
    if (SECRET_LIKE.test(path)) throw new PackageError(`refusing credential-like file: ${path}`);
    if (f.bytes.byteLength > PACKAGE_LIMITS.fileBytes) throw new PackageError(`file too large (max 1 MB): ${path}`);
    total += f.bytes.byteLength;
    const mode = f.mode ?? 0o644;
    return { path, sha256: sha256Hex(f.bytes), size: f.bytes.byteLength, mode, isScript: isScript(path, mode) };
  });
  if (total > PACKAGE_LIMITS.totalBytes) throw new PackageError("package too large (max 5 MB)");
  if (!seen.has("SKILL.md")) throw new PackageError("a skill package must contain SKILL.md at its root");
  manifest.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { manifest, totalBytes: total, packageHash: packageHashOf(manifest) };
}

/** Store blobs, then record the package (deduplicated per org by its hash). */
export async function storePackage(
  orgId: string,
  files: PackageInput[],
  declared: Record<string, unknown> | null,
): Promise<{ id: string; packageHash: string }> {
  const plan = planPackage(files);
  const store = blobStore();
  for (const f of files) await store.put(orgId, sha256Hex(f.bytes), f.bytes);
  return withOrg(orgId, async (tx) => {
    const [p] = await tx
      .insert(skillPackages)
      .values({ orgId, manifest: plan.manifest, totalBytes: plan.totalBytes, packageHash: plan.packageHash, declared })
      .onConflictDoNothing()
      .returning({ id: skillPackages.id });
    if (p) return { id: p.id, packageHash: plan.packageHash };
    const existing = await packageByHashTx(tx, orgId, plan.packageHash);
    return { id: existing!.id, packageHash: plan.packageHash };
  });
}

export async function packageByHashTx(tx: Tx, orgId: string, hash: string) {
  return (
    await tx
      .select()
      .from(skillPackages)
      .where(and(eq(skillPackages.orgId, orgId), eq(skillPackages.packageHash, hash)))
      .limit(1)
  )[0];
}

/**
 * Minimal SKILL.md frontmatter reader (`---` block of `key: value`, inline `[a, b]` or `- item`
 * lists). Deliberately not a YAML engine: unknown shapes are kept as raw strings.
 */
export function parseFrontmatter(text: string): { data: Record<string, string | string[]>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const raw of m[1]!.split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(raw);
    if (item && listKey) {
      const cur = data[listKey];
      data[listKey] = [...(Array.isArray(cur) ? cur : []), unquote(item[1]!)];
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const [, k, v] = kv as unknown as [string, string, string];
    listKey = null;
    if (v === "") {
      listKey = k;
      data[k] = [];
    } else if (/^\[.*\]$/.test(v)) {
      data[k] = v
        .slice(1, -1)
        .split(",")
        .map((x) => unquote(x.trim()))
        .filter(Boolean);
    } else data[k] = unquote(v);
  }
  return { data, body: text.slice(m[0].length) };
}

const unquote = (s: string) => s.replace(/^(['"])(.*)\1$/, "$2");
