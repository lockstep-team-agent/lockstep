/**
 * Managed org skills for one checkout (Claude Code: `.claude/skills/lockstep-org-<slug>-<id>/`).
 *
 * Safety contract (PRD A7, A17, A19):
 *  - one sync at a time per checkout (a lock file); each run stages into its own directory;
 *  - every downloaded file is verified against its sha256, and the manifest against the package hash;
 *  - a folder is replaced by a directory swap whose old copy is parked in a per-run trash, so an
 *    interrupted swap is rolled back on the next run; the replacement is fully staged first;
 *  - the state file is written after the tree is consistent, and a folder that already matches the
 *    desired package is adopted instead of being called a conflict;
 *  - Lockstep only removes or replaces folders it recorded as managed, never one edited locally
 *    (unless the user asks to restore it) and never one tracked by git;
 *  - receipts the server hasn't acknowledged are re-sent, so a lost request can't leave adoption wrong;
 *  - nothing is executed and files are written 0644.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

export interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
  mode: number;
}
export interface DesiredSkill {
  slug: string;
  itemId: string;
  versionId: string;
  name: string;
  version: number;
  level: "required" | "recommended";
  packageHash: string;
  files: ManifestFile[];
}
export interface SyncPayload {
  generation: string;
  desired: DesiredSkill[];
  offered: Array<{ slug: string; itemId: string; name: string; version: number }>;
  declined: Array<{ slug: string; itemId: string; name: string; level: string }>;
  blocked: Array<{ itemId: string; name: string; versions: number[] }>;
  unavailable?: Array<{ itemId: string; name: string }>;
}
export interface Receipt {
  kind: "synced" | "installed" | "removed" | "failed" | "conflict" | "declined" | "session_available";
  itemId?: string;
  versionId?: string;
  packageHash?: string;
  detail?: Record<string, unknown>;
}
/** The server, as the engine needs it. */
export interface SyncApi {
  sync(): Promise<SyncPayload>;
  blob(sha256: string): Promise<Uint8Array>;
  receipts(generation: string, results: Receipt[]): Promise<{ current: boolean }>;
  preference(itemId: string, choice: "accept" | "decline" | "reset"): Promise<void>;
}

export interface ManagedSkill {
  itemId: string;
  slug: string;
  folder: string;
  versionId: string;
  version: number;
  name: string;
  packageHash: string;
  files: Record<string, string>; // path → sha256 as installed
}
interface State {
  version: 2;
  generation: string | null;
  syncedAt: string | null;
  /** Keyed by catalog item id — the stable identity (slugs can change or collide). */
  skills: Record<string, ManagedSkill>;
  /** Last outcome the server acknowledged, per item (or `folder:<name>`): re-sent until it matches. */
  reported: Record<string, string>;
  /** Removed skills whose removal the server hasn't acknowledged yet (re-sent every sync). */
  tombstones: Record<string, { versionId: string; slug: string }>;
}

export type FailureCode = "network" | "integrity" | "invalid_package" | "install_error";
export interface SyncResult {
  generation: string;
  current: boolean;
  installed: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
  conflicts: Array<{ slug: string; folder: string; reason: string }>;
  failed: Array<{ slug: string; error: string; code: FailureCode }>;
  offered: SyncPayload["offered"];
  declined: SyncPayload["declined"];
  blocked: SyncPayload["blocked"];
  /** Skills present and intact when this sync started — what an already-starting session can use. */
  presentAtStart: Array<{ itemId: string; slug: string; name: string; version: number; versionId: string; packageHash: string }>;
}

export class SyncBusy extends Error {
  constructor() {
    super("another Lockstep sync is running in this checkout");
  }
}

export const PREFIX = "lockstep-org-";
const STATE = ".lockstep-managed.json";
const STAGING = ".lockstep-staging";
const TRASH = ".lockstep-trash";
const LOCK = ".lockstep-sync.lock";

export const skillsRoot = (cwd: string) => join(cwd, ".claude", "skills");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const safeSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "skill";
/** Folder identity includes the item id, so two items can never share a folder. */
export const folderFor = (slug: string, itemId: string) => `${PREFIX}${safeSlug(slug)}-${sha256(itemId).slice(0, 10)}`;

/** Same canonical form as core's packageHashOf. */
export function packageHashOf(files: ManifestFile[]): string {
  return sha256(
    [...files]
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map((f) => `${f.path}\u0000${f.sha256}\u0000${f.size}\u0000${f.mode}`)
      .join("\n"),
  );
}

export function readState(cwd: string): State {
  try {
    const raw = JSON.parse(readFileSync(join(skillsRoot(cwd), STATE), "utf8")) as {
      version: number;
      generation?: string | null;
      syncedAt?: string | null;
      skills?: Record<string, Omit<ManagedSkill, "slug" | "folder"> & Partial<ManagedSkill>>;
      reported?: Record<string, string>;
    };
    if (raw.version === 2 && raw.skills) return { ...(raw as State), tombstones: (raw as Partial<State>).tombstones ?? {} };
    if (raw.version === 1 && raw.skills) {
      // v1 keyed by slug with folder `lockstep-org-<slug>`: keep those folders where they are.
      const skills: Record<string, ManagedSkill> = {};
      for (const [slug, m] of Object.entries(raw.skills)) skills[m.itemId] = { ...m, slug, folder: `${PREFIX}${slug}` } as ManagedSkill;
      return { version: 2, generation: raw.generation ?? null, syncedAt: raw.syncedAt ?? null, skills, reported: {}, tombstones: {} };
    }
  } catch {
    /* none yet */
  }
  return { version: 2, generation: null, syncedAt: null, skills: {}, reported: {}, tombstones: {} };
}

async function writeState(cwd: string, s: State): Promise<void> {
  const p = join(skillsRoot(cwd), STATE);
  const tmp = `${p}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o644 });
  await rename(tmp, p);
}

/** Every regular file under dir → sha256, keyed by forward-slash relative path. */
async function hashTree(dir: string): Promise<Record<string, string> | null> {
  if (!existsSync(dir)) return null;
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out[relative(dir, p).split(sep).join("/")] = sha256(await readFile(p));
      else out[relative(dir, p).split(sep).join("/")] = "not-a-regular-file"; // symlinks etc. count as edits
    }
  };
  await walk(dir);
  return out;
}

const sameTree = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};
const manifestTree = (files: ManifestFile[]) => Object.fromEntries(files.map((f) => [f.path, f.sha256]));

/** Path inside the skill folder, refusing anything that could escape it. */
function inside(root: string, rel: string): string {
  if (!rel || rel.startsWith("/") || rel.includes("\\") || rel.split("/").some((p) => p === ".." || p === "." || p === ""))
    throw Object.assign(new Error(`unsafe path in package: ${rel}`), { code: "invalid_package" });
  return join(root, ...rel.split("/"));
}

/** Top-level folders under .claude/skills that contain files tracked by git (never touched). */
function trackedFolders(cwd: string): Set<string> {
  try {
    const out = execFileSync("git", ["-C", cwd, "ls-files", "-z", "--", ".claude/skills"], { encoding: "utf8" });
    return new Set(out.split("\0").filter(Boolean).map((p) => p.replace(/^\.claude\/skills\//, "").split("/")[0]!));
  } catch {
    return new Set(); // not a git checkout
  }
}

/** Keep managed skill folders out of git without touching any tracked file (.git/info/exclude). */
export async function ensureGitExclude(cwd: string): Promise<void> {
  let excludePath: string;
  let prefix: string;
  try {
    excludePath = execFileSync("git", ["-C", cwd, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" }).trim();
    prefix = execFileSync("git", ["-C", cwd, "rev-parse", "--show-prefix"], { encoding: "utf8" }).trim();
  } catch {
    return; // not a git checkout: nothing to exclude from
  }
  const abs = excludePath.startsWith("/") ? excludePath : join(cwd, excludePath);
  const begin = "# >>> lockstep managed skills (do not edit)";
  const end = "# <<< lockstep managed skills";
  const block = [begin, `/${prefix}.claude/skills/${PREFIX}*/`, `/${prefix}.claude/skills/.lockstep-*`, end].join("\n");
  const cur = existsSync(abs) ? readFileSync(abs, "utf8") : "";
  const re = new RegExp(`${begin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end}`);
  const next = re.test(cur) ? cur.replace(re, block) : `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}${block}\n`;
  if (next === cur) return;
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(`${abs}.tmp-${process.pid}`, next);
  await rename(`${abs}.tmp-${process.pid}`, abs);
}

/** Exclusive per-checkout lock; a lock left by a dead process (or older than 10 min) is taken over. */
async function acquireLock(root: string): Promise<() => Promise<void>> {
  const p = join(root, LOCK);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(p, "wx");
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await fh.close();
      return () => unlink(p).catch(() => {});
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let stale = true;
      try {
        const { pid, at } = JSON.parse(await readFile(p, "utf8")) as { pid: number; at: number };
        let alive = false;
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
        stale = !alive || Date.now() - at > 600_000;
      } catch {
        stale = Date.now() - (await stat(p).then((s) => s.mtimeMs, () => 0)) > 600_000;
      }
      if (!stale) throw new SyncBusy();
      await unlink(p).catch(() => {});
    }
  }
  throw new SyncBusy();
}

/** Roll back any swap a previous run didn't finish, then clear its staging/trash (we hold the lock). */
async function recover(root: string): Promise<void> {
  const trash = join(root, TRASH);
  if (existsSync(trash))
    for (const run of await readdir(trash))
      for (const folder of await readdir(join(trash, run)).catch(() => [] as string[]))
        if (!existsSync(join(root, folder))) await rename(join(trash, run, folder), join(root, folder));
  await rm(trash, { recursive: true, force: true });
  await rm(join(root, STAGING), { recursive: true, force: true });
}

const codeOf = (e: unknown): FailureCode => {
  const c = (e as { code?: string }).code;
  if (c === "integrity" || c === "invalid_package") return c;
  const m = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /abort|timeout|fetch|network|ECONN|ENOTFOUND|download failed|deadline/i.test(m) ? "network" : "install_error";
};

/** Find a managed skill by what a person would type: its slug, folder or item id. */
function findManaged(state: State, ref: string): ManagedSkill | undefined {
  return Object.values(state.skills).find((m) => m.itemId === ref || m.slug === ref || m.folder === ref || m.folder === `${PREFIX}${ref}`);
}

/**
 * One sync pass. `restore` discards local edits to one MANAGED skill (reinstalled from the org
 * copy; nothing is removed until the replacement is staged). `keepPersonal` moves a managed copy
 * out of management to `<slug>-personal`; a recommended skill is then declined, a required one is
 * reinstalled and stays outstanding until it is.
 */
export async function syncSkills(cwd: string, api: SyncApi, opts: { restore?: string; keepPersonal?: string } = {}): Promise<SyncResult> {
  const root = skillsRoot(cwd);
  await mkdir(root, { recursive: true });
  const release = await acquireLock(root);
  try {
    await recover(root);
    const state = readState(cwd);
    const run = randomBytes(4).toString("hex");
    const stagingRoot = join(root, STAGING, run);
    const trashRoot = join(root, TRASH, run);
    const tracked = trackedFolders(cwd);
    const receipts: Array<Receipt & { key: string; mark: string }> = [];
    const report = (key: string, mark: string, r: Receipt) => {
      if (state.reported[key] !== mark) receipts.push({ ...r, key, mark });
    };

    const presentAtStart: SyncResult["presentAtStart"] = [];
    for (const m of Object.values(state.skills)) {
      const t = await hashTree(join(root, m.folder));
      if (t && sameTree(t, m.files)) presentAtStart.push({ itemId: m.itemId, slug: m.slug, name: m.name, version: m.version, versionId: m.versionId, packageHash: m.packageHash });
    }

    // Network first: if the server is unreachable nothing on disk has been touched.
    const p = await api.sync();
    const desiredById = new Map(p.desired.map((d) => [d.itemId, d]));

    const restore = opts.restore ? findManaged(state, opts.restore) : undefined;
    if (opts.restore && !restore) throw new Error(`${opts.restore} isn't a skill Lockstep manages here — nothing was changed`);
    if (restore && tracked.has(restore.folder)) throw new Error(`${restore.folder} is tracked by git — Lockstep won't modify it`);

    if (opts.keepPersonal) {
      const m = findManaged(state, opts.keepPersonal);
      if (!m) throw new Error(`${opts.keepPersonal} isn't a skill Lockstep manages here`);
      if (tracked.has(m.folder)) throw new Error(`${m.folder} is tracked by git — Lockstep won't move it`);
      let dest = join(root, `${safeSlug(m.slug)}-personal`);
      for (let i = 2; existsSync(dest); i++) dest = join(root, `${safeSlug(m.slug)}-personal-${i}`);
      if (existsSync(join(root, m.folder))) await rename(join(root, m.folder), dest);
      delete state.skills[m.itemId];
      delete state.reported[m.itemId];
      await writeState(cwd, state);
      if (desiredById.get(m.itemId)?.level !== "required") {
        await api.preference(m.itemId, "decline");
        receipts.push({ kind: "declined", itemId: m.itemId, versionId: m.versionId, detail: { reason: "kept_personal_copy" }, key: m.itemId, mark: "declined" });
      } // a required skill is simply reinstalled below and reported as outstanding until it is
    }

    const res: SyncResult = {
      generation: p.generation,
      current: false,
      installed: [],
      updated: [],
      unchanged: [],
      removed: [],
      conflicts: [],
      failed: [],
      offered: p.offered,
      declined: p.declined,
      blocked: p.blocked,
      presentAtStart,
    };
    const conflict = (slug: string, folder: string, reason: string, key: string, d?: { itemId: string; versionId: string }) => {
      res.conflicts.push({ slug, folder, reason });
      report(key, `conflict:${reason}:${d?.versionId ?? ""}`, { kind: "conflict", itemId: d?.itemId, versionId: d?.versionId, detail: { code: reason } });
    };

    const folders = new Map<string, string>();
    for (const d of p.desired) {
      const prior = state.skills[d.itemId];
      const folder = prior?.folder ?? folderFor(d.slug, d.itemId);
      const clash = folders.get(folder);
      folders.set(folder, d.itemId);
      const dir = join(root, folder);
      const record = () => (delete state.tombstones[d.itemId], (state.skills[d.itemId] = { itemId: d.itemId, slug: d.slug, folder, versionId: d.versionId, version: d.version, name: d.name, packageHash: d.packageHash, files: manifestTree(d.files) }));
      const installedMark = `installed:${d.versionId}`;
      const ok = { kind: "installed" as const, itemId: d.itemId, versionId: d.versionId, packageHash: d.packageHash };
      try {
        if (clash) throw Object.assign(new Error(`folder ${folder} is claimed by two skills`), { code: "invalid_package" });
        if (tracked.has(folder)) {
          conflict(d.slug, folder, "tracked_by_git", d.itemId, d);
          continue;
        }
        if (packageHashOf(d.files) !== d.packageHash) throw Object.assign(new Error("manifest doesn't match its package hash"), { code: "integrity" });
        const onDisk = await hashTree(dir);
        if (onDisk && sameTree(onDisk, manifestTree(d.files))) {
          // Already exactly this package (normal case, or a crash between swap and state write).
          const same = prior?.versionId === d.versionId && prior.packageHash === d.packageHash;
          record();
          (same ? res.unchanged : prior ? res.updated : res.installed).push(d.slug);
          report(d.itemId, installedMark, ok); // re-sent if a previous report was lost or was a conflict
          continue;
        }
        if (onDisk && !prior) {
          conflict(d.slug, folder, "unmanaged_folder", d.itemId, d); // a folder we didn't create — never overwrite it
          continue;
        }
        if (onDisk && prior && !sameTree(onDisk, prior.files) && restore?.itemId !== d.itemId) {
          conflict(d.slug, folder, "local_edits", d.itemId, d);
          continue;
        }
        // Stage and verify completely before touching the current copy.
        const stage = join(stagingRoot, folder);
        await mkdir(stage, { recursive: true });
        for (const f of d.files) {
          const bytes = await api.blob(f.sha256);
          if (sha256(bytes) !== f.sha256 || bytes.byteLength !== f.size) throw Object.assign(new Error(`integrity check failed for ${f.path}`), { code: "integrity" });
          const target = inside(stage, f.path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, bytes, { mode: 0o644 });
        }
        if (onDisk) {
          await mkdir(trashRoot, { recursive: true });
          await rename(dir, join(trashRoot, folder)); // interrupted here → the next run restores it
        }
        await rename(stage, dir);
        await rm(join(trashRoot, folder), { recursive: true, force: true });
        record();
        (prior ? res.updated : res.installed).push(d.slug);
        report(d.itemId, installedMark, ok);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        const code = codeOf(e);
        res.failed.push({ slug: d.slug, error, code });
        report(d.itemId, `failed:${code}:${d.versionId}`, { kind: "failed", itemId: d.itemId, versionId: d.versionId, detail: { code, error: error.slice(0, 300) } });
      }
    }

    // Remove only what we manage and no longer want — never over local edits or git-tracked files.
    for (const m of Object.values(state.skills)) {
      if (desiredById.has(m.itemId)) continue;
      const dir = join(root, m.folder);
      if (tracked.has(m.folder)) {
        conflict(m.slug, m.folder, "tracked_by_git", m.itemId, m);
        continue;
      }
      const onDisk = await hashTree(dir);
      if (onDisk && !sameTree(onDisk, m.files) && restore?.itemId !== m.itemId) {
        conflict(m.slug, m.folder, "local_edits_on_removal", m.itemId, m);
        continue;
      }
      if (onDisk) {
        await mkdir(trashRoot, { recursive: true });
        await rename(dir, join(trashRoot, m.folder));
        await rm(join(trashRoot, m.folder), { recursive: true, force: true });
      }
      delete state.skills[m.itemId];
      state.tombstones[m.itemId] = { versionId: m.versionId, slug: m.slug }; // durable until acknowledged
      res.removed.push(m.slug);
    }

    for (const [itemId, t] of Object.entries(state.tombstones))
      report(itemId, `removed:${t.versionId}`, { kind: "removed", itemId, versionId: t.versionId });
    state.generation = p.generation;
    state.syncedAt = new Date().toISOString();
    await writeState(cwd, state); // the tree on disk is already consistent with it
    await rm(stagingRoot, { recursive: true, force: true });
    await rm(trashRoot, { recursive: true, force: true });
    await ensureGitExclude(cwd);

    const batch: Receipt[] = [
      ...receipts.map(({ key: _k, mark: _m, ...r }) => r),
      { kind: "synced", detail: { installed: res.installed.length, updated: res.updated.length, removed: res.removed.length, conflicts: res.conflicts.length, failed: res.failed.length } },
    ];
    res.current = (await api.receipts(p.generation, batch)).current;
    // Acknowledged: stop re-sending. (If the request failed, the next sync sends them again.)
    for (const r of receipts) {
      if (r.mark.startsWith("removed:")) {
        delete state.tombstones[r.key]; // the server knows: nothing left to remember
        delete state.reported[r.key];
      } else state.reported[r.key] = r.mark;
    }
    await writeState(cwd, state);
    return res;
  } finally {
    await release();
  }
}

/** Human summary, shared by the command, the hook and the MCP tool. */
export function formatSync(r: SyncResult, when: "session" | "command"): string {
  const lines: string[] = [];
  const changed = [...r.installed, ...r.updated];
  if (changed.length)
    lines.push(
      `🧩 Org skills ${when === "session" ? "updated — available from your next session" : "installed/updated (new sessions pick them up)"}: ${changed.join(", ")}`,
    );
  if (r.removed.length) lines.push(`🧩 Removed (no longer assigned): ${r.removed.join(", ")}`);
  for (const c of r.conflicts)
    lines.push(
      c.reason === "unmanaged_folder"
        ? `⚠️ .claude/skills/${c.folder} exists but isn't managed by Lockstep — left untouched. Rename or remove it, then run \`lockstep skills sync\`.`
        : c.reason === "tracked_by_git"
          ? `⚠️ .claude/skills/${c.folder} is tracked by git — Lockstep won't change it. Untrack it (git rm --cached) to let Lockstep manage it.`
          : `⚠️ ${c.slug} was edited locally — left untouched. Run \`lockstep skills restore ${c.slug}\` to take the org version, or \`lockstep skills keep ${c.slug}\` to keep yours as a personal copy.`,
    );
  for (const f of r.failed) lines.push(`⚠️ ${f.slug} couldn't be installed (${f.error}); your existing files were kept.`);
  for (const b of r.blocked) lines.push(`⚠️ ${b.name} is assigned at v${b.versions.join(" and v")} here — nothing installed until an admin resolves the overlap.`);
  if (r.offered.length) lines.push(`💡 Recommended for you: ${r.offered.map((o) => o.slug).join(", ")} — \`lockstep skills accept <slug>\` to install.`);
  if (!r.current) lines.push("The org's assignments changed during this sync; it will catch up next time.");
  return lines.join("\n");
}
