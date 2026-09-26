/**
 * Import one skill from a PUBLIC GitHub repository as an immutable snapshot. The ref is resolved to
 * an exact commit, only the selected directory is captured, every file is verified against its git
 * blob sha, and nothing is executed or installed. Upstream changes never reach anyone on their own:
 * "check for update" shows a candidate diff and opens a new draft only on request.
 */
import { createHash } from "node:crypto";
import { env } from "../env.js";
import { OrgError } from "./org-authority.js";
import { parseFrontmatter, isScript, PACKAGE_LIMITS, type PackageInput } from "./packages.js";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const TIMEOUT_MS = 15_000;

export interface GithubSource {
  owner: string;
  repo: string;
  ref: string | null;
  path: string;
}

/** github.com/o/r[/tree|blob/<ref>/<path>] → parts. Only public github.com URLs are accepted. */
export function parseGithubUrl(input: string): GithubSource {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new OrgError(400, "not a URL");
  }
  if (u.hostname !== "github.com" && u.hostname !== "www.github.com")
    throw new OrgError(400, "only github.com repositories are supported");
  const [owner, repoRaw, kind, ref, ...rest] = u.pathname.replace(/^\/+|\/+$/g, "").split("/");
  const repo = repoRaw?.replace(/\.git$/, "");
  if (!owner || !repo) throw new OrgError(400, "URL must name an owner and repository");
  if (kind && kind !== "tree" && kind !== "blob") throw new OrgError(400, "unsupported GitHub URL");
  let path = rest.join("/");
  if (kind === "blob" && /(^|\/)SKILL\.md$/.test(path)) path = path.replace(/\/?SKILL\.md$/, "");
  return { owner, repo, ref: ref ?? null, path };
}

async function gh<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(env.GITHUB_IMPORT_TOKEN ? { authorization: `Bearer ${env.GITHUB_IMPORT_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404)
    throw new OrgError(404, "repository, ref or path not found (private repositories aren't supported yet)");
  if (res.status === 403 || res.status === 429)
    throw new OrgError(409, "GitHub rate limit reached — try again shortly");
  if (!res.ok) throw new OrgError(409, `GitHub responded ${res.status}`);
  return (await res.json()) as T;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export async function resolveCommit(src: GithubSource): Promise<{ sha: string; ref: string }> {
  const ref = src.ref ?? (await gh<{ default_branch: string }>(`/repos/${src.owner}/${src.repo}`)).default_branch;
  const c = await gh<{ sha: string }>(`/repos/${src.owner}/${src.repo}/commits/${encodeURIComponent(ref)}`);
  return { sha: c.sha, ref };
}

async function tree(src: GithubSource, sha: string): Promise<TreeEntry[]> {
  const t = await gh<{ tree: TreeEntry[]; truncated: boolean }>(
    `/repos/${src.owner}/${src.repo}/git/trees/${sha}?recursive=1`,
  );
  if (t.truncated)
    throw new OrgError(409, "repository tree is too large to scan — link directly to the skill's directory");
  return t.tree;
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const under = (dir: string, p: string) => (dir === "" ? true : p === dir || p.startsWith(`${dir}/`));

async function raw(src: GithubSource, sha: string, path: string): Promise<Uint8Array> {
  const res = await fetch(
    `${RAW}/${src.owner}/${src.repo}/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`,
    {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new OrgError(409, `couldn't fetch ${path} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Git's blob id: sha1("blob <len>\0" + content) — proves we captured exactly the committed file. */
export const gitBlobSha = (bytes: Uint8Array): string =>
  createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");

export interface SkillCandidate {
  dir: string;
  name: string;
  description: string;
}

/** Candidate skill directories (those holding a SKILL.md) under the URL's path, at one commit. */
export async function discoverSkills(
  url: string,
): Promise<{ source: GithubSource; commit: string; ref: string; candidates: SkillCandidate[] }> {
  const src = parseGithubUrl(url);
  const { sha, ref } = await resolveCommit(src);
  const entries = await tree(src, sha);
  const dirs = entries
    .filter((e) => e.type === "blob" && /(^|\/)SKILL\.md$/.test(e.path) && under(src.path, e.path))
    .map((e) => dirOf(e.path))
    .slice(0, 50);
  const candidates: SkillCandidate[] = [];
  for (const dir of dirs) {
    let fm: Record<string, string | string[]> = {};
    try {
      fm = parseFrontmatter(new TextDecoder().decode(await raw(src, sha, dir ? `${dir}/SKILL.md` : "SKILL.md"))).data;
    } catch {
      /* listed without metadata */
    }
    candidates.push({
      dir,
      name: typeof fm.name === "string" ? fm.name : dir.split("/").pop() || src.repo,
      description: typeof fm.description === "string" ? fm.description : "",
    });
  }
  return { source: src, commit: sha, ref, candidates };
}

export interface CapturedSkill {
  files: PackageInput[];
  skipped: Array<{ path: string; reason: string }>;
  frontmatter: Record<string, string | string[]>;
  license: string | null;
  scripts: string[];
  declared: { tools: string[]; dependencies: string[]; compatibility: "unknown" | "known-limits"; notes: string[] };
  provenance: {
    source: "github";
    owner: string;
    repo: string;
    ref: string;
    commit: string;
    path: string;
    license: string | null;
    url: string;
    capturedAt: string;
  };
}

/** Capture exactly one skill directory at an exact commit. */
export async function captureSkill(
  src: GithubSource,
  commit: string,
  ref: string,
  dir: string,
): Promise<CapturedSkill> {
  const entries = await tree(src, commit);
  const inDir = entries.filter((e) => under(dir, e.path) && e.path !== dir);
  if (!inDir.some((e) => e.path === (dir ? `${dir}/SKILL.md` : "SKILL.md")))
    throw new OrgError(404, "no SKILL.md in that directory");
  const skipped: CapturedSkill["skipped"] = [];
  const blobs = inDir.filter((e) => {
    if (e.type === "tree") return false;
    if (e.type === "commit") return skipped.push({ path: e.path, reason: "submodule (not captured)" }) && false;
    if (e.mode === "120000") return skipped.push({ path: e.path, reason: "symlink (not captured)" }) && false;
    return true;
  });
  if (blobs.length > PACKAGE_LIMITS.files)
    throw new OrgError(400, `skill has ${blobs.length} files (max ${PACKAGE_LIMITS.files})`);
  const files: PackageInput[] = [];
  for (const b of blobs) {
    if ((b.size ?? 0) > PACKAGE_LIMITS.fileBytes) throw new OrgError(400, `file too large (max 1 MB): ${b.path}`);
    const bytes = await raw(src, commit, b.path);
    if (gitBlobSha(bytes) !== b.sha) throw new OrgError(409, `integrity check failed for ${b.path}`);
    const rel = dir ? b.path.slice(dir.length + 1) : b.path;
    files.push({ path: rel, bytes, mode: b.mode === "100755" ? 0o755 : 0o644 });
  }
  const skill = files.find((f) => f.path === "SKILL.md")!;
  const fm = parseFrontmatter(new TextDecoder().decode(skill.bytes)).data;
  const licenseEntry =
    inDir.find((e) => /(^|\/)LICEN[CS]E(\.[a-z]+)?$/i.test(e.path)) ??
    entries.find((e) => /^LICEN[CS]E(\.[a-z]+)?$/i.test(e.path));
  let license: string | null = null;
  if (licenseEntry) {
    const text = new TextDecoder().decode(await raw(src, commit, licenseEntry.path)).slice(0, 400);
    license = /MIT License/i.test(text)
      ? "MIT"
      : /Apache License/i.test(text)
        ? "Apache-2.0"
        : /BSD/i.test(text)
          ? "BSD"
          : /GNU GENERAL PUBLIC/i.test(text)
            ? "GPL"
            : licenseEntry.path;
  }
  const scripts = files.filter((f) => isScript(f.path, f.mode)).map((f) => f.path);
  const tools = ([] as string[])
    .concat(fm["allowed-tools"] ?? [], fm.tools ?? [])
    .flatMap((t) => String(t).split(/[,\s]+/))
    .filter(Boolean);
  const dependencies = files
    .filter((f) => /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|Gemfile|go\.mod|Cargo\.toml)$/.test(f.path))
    .map((f) => f.path);
  const notes: string[] = [];
  if (scripts.length)
    notes.push(`${scripts.length} script file(s) — Lockstep never runs them; the host agent's approval rules apply.`);
  if (dependencies.length) notes.push("Declares external dependencies that a commit can't freeze.");
  if (skipped.length)
    notes.push(`${skipped.length} entr${skipped.length === 1 ? "y" : "ies"} skipped (symlinks/submodules).`);
  return {
    files,
    skipped,
    frontmatter: fm,
    license,
    scripts,
    declared: {
      tools,
      dependencies,
      compatibility: scripts.length || dependencies.length ? "known-limits" : "unknown",
      notes,
    },
    provenance: {
      source: "github",
      owner: src.owner,
      repo: src.repo,
      ref,
      commit,
      path: dir,
      license,
      url: `https://github.com/${src.owner}/${src.repo}/tree/${commit}/${dir}`,
      capturedAt: new Date().toISOString(),
    },
  };
}
