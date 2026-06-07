/**
 * CODEOWNERS parsing + path→owner resolution (pragmatic gitignore-style globs).
 * Pure functions — no DB, fully unit-testable.
 *
 * Semantics covered:
 *   - leading "/" anchors to repo root; an interior "/" also anchors
 *   - trailing "/" = directory (matches the dir and its whole subtree)
 *   - "*" matches within a path segment; "**" crosses segments
 *   - a pattern with no slash (e.g. "*.ts") matches at any depth
 *   - LAST matching rule wins (CODEOWNERS precedence)
 */
export interface CodeownersRule {
  pattern: string;
  regex: string;
  owners: string[]; // github logins/teams, leading "@" stripped
  precedence: number; // line order; higher wins on tie
}

export function globToRegex(pattern: string): string {
  let p = pattern.trim();
  const dirMatch = p.endsWith("/");
  if (dirMatch) p = p.slice(0, -1);
  const interiorSlash = p.replace(/^\//, "").includes("/");
  const anchored = pattern.startsWith("/") || interiorSlash;
  if (p.startsWith("/")) p = p.slice(1);

  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*") {
      if (p[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c; // literal, including "/"
    }
  }
  const prefix = anchored ? "^" : "(^|.*/)";
  return prefix + re + "(/.*)?$";
}

export function parseCodeowners(content: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  let precedence = 0;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const pattern = parts[0]!;
    const owners = parts.slice(1).map((o) => o.replace(/^@/, ""));
    if (owners.length === 0) continue;
    rules.push({ pattern, regex: globToRegex(pattern), owners, precedence: precedence++ });
  }
  return rules;
}

/** Resolve a repo-relative path to its owners (last matching rule wins). */
export function resolveOwners(rules: CodeownersRule[], path: string): string[] {
  let matched: CodeownersRule | null = null;
  for (const r of rules) {
    if (new RegExp(r.regex).test(path)) matched = r;
  }
  return matched ? matched.owners : [];
}
