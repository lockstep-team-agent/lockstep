/**
 * Outbound-call detection — the *consumer* side of the graph. Where `surface.ts` finds what a file
 * SERVES (produces), this finds what it CALLS (consumes): `fetch`/`axios` requests, gRPC client stubs,
 * and generated-client imports. It is deliberately best-effort and never authoritative on its own —
 * a detected call is a *candidate*. `lockstep scan` resolves each candidate against the project's
 * produced-surface catalog (closed-world matching): a candidate that matches a sibling repo's produce
 * is a real intra-org dependency; one that doesn't is treated as external. The human always approves.
 *
 * Kept in its own module (not folded into surface.ts) so the served-side extractor — which is vendored
 * to the GitHub Action's `surface.mjs` — stays untouched. Pure + testable.
 */
import { normalizePath } from "./surface.js";

export interface OutboundRef {
  via: "fetch" | "axios" | "grpc-client" | "import";
  ref: string; // raw evidence, for the human-facing report (e.g. the URL literal or import specifier)
  surface?: string; // canonical http surface ID when we could build one (for exact catalog match)
  hint?: string; // service/package name (for catalog service-level match) when there's no exact surface
}

/** Build a canonical `http:METHOD /path` from a URL literal, or null if it's too dynamic/generic to name. */
function httpSurface(rawUrl: string, method?: string): string | null {
  let url = rawUrl.trim();
  url = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, ""); // drop scheme://host (keep the path)
  url = url.replace(/\$\{[^}]*\}/g, ":param"); // template-literal interpolation → path param
  url = url.split("?")[0]!.split("#")[0]!;
  if (!url || url === ":param") return null; // wholly dynamic — can't name it
  const path = normalizePath(url);
  if (path === "/") return null; // too generic to be a useful surface
  return `http:${(method ?? "GET").toUpperCase()} ${path}`;
}

/** Strip a leading org scope and common client suffixes → a bare service hint (e.g. `@acme/billing-client` → `billing`). */
function pkgHint(specifier: string): string {
  const base = specifier.replace(/^@[^/]+\//, "").split("/")[0]!;
  return base.replace(/[-_.](client|sdk|api|grpc|proto|rpc)$/i, "").toLowerCase();
}

const FETCH = /\bfetch\s*\(\s*(['"`])([^'"`]*?)\1\s*(?:,\s*\{([\s\S]*?)\})?/g;
const AXIOS_VERB = /\baxios\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])([^'"`]*?)\2/gi;
const AXIOS_CONFIG = /\baxios(?:\s*\.\s*request)?\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
const AXIOS_BARE = /\baxios\s*\(\s*(['"`])([^'"`]*?)\1/g;
const GRPC_CLIENT = /new\s+(\w+?)Client\s*\(/g;
const IMPORT = /(?:import\b[^'"]*?from\s*|\brequire\s*\(\s*)(['"])([^'"]+)\1/g;

const methodOf = (opts: string | undefined): string | undefined => opts?.match(/method\s*:\s*['"]([a-zA-Z]+)['"]/)?.[1];
const urlOf = (config: string): string | undefined => config.match(/\burl\s*:\s*['"`]([^'"`]+)['"`]/)?.[1];

/** Extract every outbound-call candidate a file makes. `[]` for files with no detectable client calls. */
export function extractOutbound(path: string, content?: string): OutboundRef[] {
  if (!content || !/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(path)) return [];
  const out: OutboundRef[] = [];
  const seen = new Set<string>();
  const add = (r: OutboundRef): void => {
    const key = `${r.via} ${r.surface ?? r.hint ?? r.ref}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  };

  for (const m of content.matchAll(FETCH)) {
    add({ via: "fetch", ref: m[2]!, surface: httpSurface(m[2]!, methodOf(m[3])) ?? undefined });
  }
  for (const m of content.matchAll(AXIOS_VERB)) {
    add({ via: "axios", ref: m[3]!, surface: httpSurface(m[3]!, m[1]) ?? undefined });
  }
  for (const m of content.matchAll(AXIOS_CONFIG)) {
    const url = urlOf(m[1]!);
    if (url) add({ via: "axios", ref: url, surface: httpSurface(url, methodOf(m[1])) ?? undefined });
  }
  for (const m of content.matchAll(AXIOS_BARE)) {
    add({ via: "axios", ref: m[2]!, surface: httpSurface(m[2]!) ?? undefined });
  }
  for (const m of content.matchAll(GRPC_CLIENT)) {
    const svc = m[1]!.replace(/Service$/, "");
    if (svc) add({ via: "grpc-client", ref: `${m[1]!}Client`, hint: svc.toLowerCase() });
  }
  for (const m of content.matchAll(IMPORT)) {
    const spec = m[2]!;
    // Only client-ish or org-scoped specifiers are worth a dependency hint; relative/plain deps are noise.
    if (/^\.|^node:/.test(spec)) continue;
    if (!(spec.startsWith("@") || /[-_.](client|sdk|grpc|proto|rpc)$|grpc|proto/i.test(spec))) continue;
    const hint = pkgHint(spec);
    if (hint) add({ via: "import", ref: spec, hint });
  }

  return out;
}
