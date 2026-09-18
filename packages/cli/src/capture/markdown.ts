import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface DocSection { anchorKey: string; headingPath: string[]; text: string }
export interface DocFile { path: string; sections: DocSection[] }

export function sectionize(markdown: string): DocSection[] {
  const clean = markdown.replace(/<!-- lockstep:start -->[\s\S]*?<!-- lockstep:end -->/g, "");
  const sections: DocSection[] = [];
  let headings: string[] = [];
  let lines: string[] = [];
  let fence: string | null = null;
  const used = new Map<string, number>();
  const flush = () => {
    const text = lines.join("\n").trim();
    if (text.length >= 40) {
      const slug = headings.join("/").toLowerCase().replace(/[^a-z0-9/]+/g, "-") || "preamble";
      const ordinal = (used.get(slug) ?? 0) + 1; used.set(slug, ordinal);
      sections.push({ anchorKey: `${slug}:${ordinal}`, headingPath: [...headings], text });
    }
    lines = [];
  };
  for (const line of clean.split(/\r?\n/)) {
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (f) { if (!fence) fence = f[1]![0]!; else if (f[1]![0] === fence) fence = null; lines.push(line); continue; }
    const h = !fence ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (h) { flush(); headings = [...headings.slice(0, h[1]!.length - 1), h[2]!]; }
    else lines.push(line);
  }
  flush(); return sections;
}

export function previewDocs(cwd: string, broad = false): { files: DocFile[]; skipped: string[]; truncated: string[] } {
  const root = realpathSync(cwd);
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd, encoding: "utf8" }).split("\0").filter(Boolean);
  const priority = ["CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md", "README.md", ".claude/CLAUDE.md"];
  const candidates = tracked.filter((p) => priority.includes(p) || /(?:^|\/)(?:adrs?|decisions)\/.*\.md$/i.test(p) || (broad && /^docs\/.*\.md$/i.test(p)))
    .filter((p) => !/(?:^|\/)(?:node_modules|\.git|lockstep-decisions)\//.test(p))
    .sort((a, b) => (priority.indexOf(a) < 0 ? 99 : priority.indexOf(a)) - (priority.indexOf(b) < 0 ? 99 : priority.indexOf(b)) || a.localeCompare(b));
  const files: DocFile[] = []; const skipped: string[] = []; const truncated: string[] = [];
  let count = 0;
  for (const path of candidates) {
    if (files.length >= 40 || count >= 60) { skipped.push(`${path}: input cap`); continue; }
    try {
      const full = realpathSync(join(cwd, path));
      if (relative(root, full).startsWith("..") || statSync(full).size > 200_000) { skipped.push(`${path}: outside repo or over 200 KB`); continue; }
      const source = readFileSync(full, "utf8");
      if (/^\s*(?:\*\*)?status(?:\*\*)?\s*:\s*(?:draft|proposed|superseded|rejected|deprecated)/im.test(source)) { skipped.push(`${path}: not an accepted current document`); continue; }
      const all = sectionize(source);
      const selected = all.slice(0, 60 - count);
      if (selected.length < all.length) truncated.push(`${path}: section cap`);
      const sections = selected.map((s) => {
        if (Buffer.byteLength(s.text) <= 4000) return s;
        truncated.push(`${path}#${s.anchorKey}: 4 KB cap`);
        return { ...s, text: Buffer.from(s.text).subarray(0, 4000).toString("utf8").replace(/\uFFFD$/, "") };
      });
      if (sections.length) { files.push({ path, sections }); count += sections.length; }
    } catch { skipped.push(`${path}: unreadable`); }
  }
  return { files, skipped, truncated };
}
