/**
 * Stage 3 — scope resolution. Try to canonicalize a referenced code surface into the same grammar the
 * v1 usage graph uses (http:/proto:/gql:), so an ingested decision can inherit real blast-radius impact.
 * No code surface → land on a topic scope, impact 0 ("unscoped", honest) until the org-graph ships.
 * Mirrors the canonical forms produced by packages/cli/src/capture/surface.ts.
 */

export interface Scope {
  scopeKind: "surface" | "topic";
  scopeRef: string;
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ANY"];

function normalizePath(p: string): string {
  return p
    .replace(/\{(\w+)\}/g, ":$1") // {id} → :id
    .replace(/\/\((\w+)\)/g, "") // strip route groups /(auth)
    .replace(/\/+$/, "") || "/";
}

/** Turn one free-text surface candidate into a canonical surface id, or null if it isn't one. */
export function canonicalizeSurface(candidate: string): string | null {
  const c = candidate.trim();
  // proto: pkg.Service/Rpc
  if (/^[\w.]+\/[A-Za-z]\w*$/.test(c) && c.includes(".")) return `proto:${c}`;
  // gql: Root.field
  if (/^(Query|Mutation|Subscription)\.[A-Za-z]\w*$/.test(c)) return `gql:${c}`;
  // http: METHOD /path
  const m = c.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)\s+(\/\S*)$/i);
  if (m) {
    const method = m[1]!.toUpperCase();
    if (HTTP_METHODS.includes(method)) return `http:${method} ${normalizePath(m[2]!)}`;
  }
  // bare path with no method → assume ANY
  if (/^\/\S+$/.test(c)) return `http:ANY ${normalizePath(c)}`;
  return null;
}

export function resolveScope(surfaceCandidates: string[], scopeHint: string): Scope {
  for (const cand of surfaceCandidates) {
    const canon = canonicalizeSurface(cand);
    if (canon) return { scopeKind: "surface", scopeRef: canon };
  }
  const topic = (scopeHint || "general").toLowerCase().trim().replace(/\s+/g, "-");
  return { scopeKind: "topic", scopeRef: `topic:${topic}` };
}
