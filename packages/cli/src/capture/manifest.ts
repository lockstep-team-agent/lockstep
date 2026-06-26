import { readFileSync } from "node:fs";
import { join } from "node:path";

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
