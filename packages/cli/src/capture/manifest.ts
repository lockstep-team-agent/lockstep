import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyFile } from "../adapters/fsutil.js";

export interface Manifest {
  produces: string[];
  consumes: string[];
}

/**
 * Read `lockstep.yaml` from the repo root. This is the deterministic source of truth for the usage
 * graph: `consumes:` declares the canonical surface IDs this repo depends on (so it gets warned when
 * they change), `produces:` optionally declares/overrides what it exposes. We parse a minimal YAML
 * subset (two top-level keys, each a `- item` list) to stay dependency-free and predictable.
 *
 * Example:
 *   produces:
 *     - http:POST /auth/session
 *   consumes:
 *     - http:GET /orders/:id
 */
export function readManifest(cwd: string): Manifest {
  let raw: string;
  try {
    raw = readFileSync(join(cwd, "lockstep.yaml"), "utf8");
  } catch {
    return { produces: [], consumes: [] };
  }
  const out: Manifest = { produces: [], consumes: [] };
  let key: keyof Manifest | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    const top = line.match(/^(produces|consumes)\s*:\s*$/);
    if (top) {
      key = top[1] as keyof Manifest;
      continue;
    }
    const item = line.match(/^\s*-\s*(.+?)\s*$/);
    if (item && key) {
      out[key].push(item[1]!.replace(/^["']|["']$/g, ""));
    } else if (/^\S/.test(line)) {
      key = null; // a new unindented non-list key ends the current list
    }
  }
  return out;
}

const DEFAULT_HEADER = `# Lockstep manifest — the deterministic source of truth for the usage graph.
# Managed by the \`/lockstep-setup\` skill (the only sanctioned writer; the capture hook is read-only).
# Surface IDs are canonical: http:METHOD /path · proto:pkg.Service/Rpc · gql:Root.field
`;

/** Preserve the file's existing top-of-file comment block (so human notes survive a rewrite). */
function leadingComment(raw: string | null): string | null {
  if (!raw) return null;
  const head: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === "") head.push(line);
    else break;
  }
  const block = head.join("\n").trimEnd();
  return block ? block + "\n" : null;
}

const union = (a: string[], b: string[]): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of [...a, ...b]) if (x && !seen.has(x)) (seen.add(x), out.push(x));
  return out;
};

function serialize(m: Manifest, header: string): string {
  const list = (items: string[]): string => items.map((i) => `  - ${i}`).join("\n");
  const block = (key: string, items: string[]): string => (items.length ? `${key}:\n${list(items)}\n` : `${key}:\n`);
  return `${header}\n${block("produces", m.produces)}\n${block("consumes", m.consumes)}`;
}

/**
 * Write `lockstep.yaml`, MERGE-preserving what's already there — existing human entries are unioned
 * with the proposed ones (never dropped), and the file's leading comment block is kept. Atomic write
 * with a one-time `.lockstep.bak` and idempotent no-op, via the shared `applyFile`. This is the single
 * sanctioned writer of the manifest — the capture hook never touches it (see IMPROVEMENTS #11).
 */
export async function writeManifest(cwd: string, manifest: Manifest, opts: { dryRun?: boolean } = {}): Promise<string> {
  const path = join(cwd, "lockstep.yaml");
  let raw: string | null;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    raw = null;
  }
  const existing = readManifest(cwd);
  const merged: Manifest = {
    produces: union(existing.produces, manifest.produces),
    consumes: union(existing.consumes, manifest.consumes),
  };
  const header = leadingComment(raw) ?? DEFAULT_HEADER;
  return applyFile(path, () => serialize(merged, header), opts.dryRun ?? false);
}
