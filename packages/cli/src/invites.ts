/**
 * Turn `lockstep scan`'s leftovers into a concrete ask: the outbound calls that hit a surface no
 * connected repo produces are, by definition, repos that aren't on Lockstep yet — and git already
 * knows who works on the files that make those calls. Pure except for `gitAuthors`, so the mapping
 * is unit-testable without a repo.
 */
import { execFileSync } from "node:child_process";

export interface UnmatchedRef {
  ref: string;
  via: string;
  file?: string;
}
export interface InviteSuggestion {
  ref: string;
  via: string;
  file: string;
  handles: string[];
}

/** `12345+octocat@users.noreply.github.com` → `octocat`. The only email shape that yields a real handle. */
const NOREPLY = /^(?:\d+\+)?([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)@users\.noreply\.github\.com$/i;

const MAX_SURFACES = 5;
const MAX_HANDLES_PER_SURFACE = 2;

/** Recent authors of one file, newest first, as `name\temail` pairs. Never throws. */
export function gitAuthors(cwd: string, file: string): string[] {
  try {
    return execFileSync("git", ["-C", cwd, "log", "-n", "30", "--format=%an\t%ae", "--", file], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    return []; // no history, unreadable path, or not a git repo — suggest nothing rather than guess
  }
}

/**
 * Map unmatched outbound calls → the people who most recently touched the calling file.
 * `exclude` holds identifiers already accounted for (you, and anyone already in the project),
 * compared case-insensitively against handle, name and email alike.
 */
export function suggestInvites(
  cwd: string,
  unmatched: UnmatchedRef[],
  exclude: Iterable<string> = [],
  authors: (cwd: string, file: string) => string[] = gitAuthors,
): InviteSuggestion[] {
  const skip = new Set([...exclude].filter(Boolean).map((v) => v.toLowerCase()));
  const out: InviteSuggestion[] = [];
  const seenFiles = new Set<string>();
  for (const item of unmatched) {
    if (out.length >= MAX_SURFACES) break;
    if (!item.file || seenFiles.has(`${item.file}\0${item.ref}`)) continue;
    seenFiles.add(`${item.file}\0${item.ref}`);
    const handles: string[] = [];
    for (const line of authors(cwd, item.file)) {
      const [name = "", email = ""] = line.split("\t");
      const handle = NOREPLY.exec(email.trim())?.[1] ?? name.trim();
      if (!handle) continue;
      if (skip.has(handle.toLowerCase()) || skip.has(email.trim().toLowerCase()) || skip.has(name.trim().toLowerCase())) continue;
      if (handles.some((h) => h.toLowerCase() === handle.toLowerCase())) continue;
      handles.push(handle);
      if (handles.length >= MAX_HANDLES_PER_SURFACE) break;
    }
    if (handles.length > 0) out.push({ ref: item.ref, via: item.via, file: item.file, handles });
  }
  return out;
}

/** The onboard/scan footer. Empty string when there's nothing worth asking for. */
export function renderInvites(suggestions: InviteSuggestion[], unmatchedCount: number): string {
  if (suggestions.length === 0) return "";
  const width = Math.max(...suggestions.map((s) => s.ref.length));
  const lines = [
    `Your repo depends on ${unmatchedCount} surface${unmatchedCount === 1 ? "" : "s"} nobody has declared yet.`,
    `They probably live in repos owned by people you already know:`,
    ...suggestions.map((s) => `  ${s.ref.padEnd(width)}  ${s.file}  ${s.handles.map((h) => `@${h}`).join(", ")}`),
  ];
  // A git author is not proof of a GitHub handle, so this is a prompt to run — never an auto-invite.
  const handles = [...new Set(suggestions.flatMap((s) => s.handles))];
  lines.push("", `  lockstep invite ${handles.join(" ")}`);
  return lines.join("\n");
}

/** `user.name` / `user.email` from git config — the one identity we can always exclude. */
export function gitIdentity(cwd: string): string[] {
  const out: string[] = [];
  for (const key of ["user.name", "user.email"]) {
    try {
      out.push(execFileSync("git", ["-C", cwd, "config", "--get", key], { encoding: "utf8" }).trim());
    } catch {
      /* unset — nothing to exclude from this key */
    }
  }
  return out.filter(Boolean);
}
