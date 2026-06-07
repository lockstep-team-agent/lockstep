import { execFileSync } from "node:child_process";

/** Changed files (tracked vs HEAD + untracked), read-only. Source never leaves the machine. */
export function changedFiles(cwd: string): string[] {
  try {
    const tracked = execFileSync("git", ["-C", cwd, "diff", "--name-only", "HEAD"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    const untracked = execFileSync("git", ["-C", cwd, "ls-files", "--others", "--exclude-standard"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    return [...new Set([...tracked, ...untracked])];
  } catch {
    return [];
  }
}
