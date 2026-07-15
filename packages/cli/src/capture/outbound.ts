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
  via: "fetch" | "axios" | "grpc-client" | "import" | "python-http";
  ref: string; // raw evidence, for the human-facing report (e.g. the URL literal or import specifier)
  surface?: string; // canonical http surface ID when we could build one (for exact catalog match)
  hint?: string; // service/package name (for catalog service-level match) when there's no exact surface
}

/** Build a canonical `http:METHOD /path` from a URL literal, or null if it's too dynamic/generic to name. */
export function httpSurface(rawUrl: string, method?: string): string | null {
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

// Wrapped-client resolution (IMPROVEMENTS #1): same-file `const` bindings only — an imported client
// or base URL is never followed. First binding wins; `let`/reassignment is deliberately ignored.
const AXIOS_CREATE = /\bconst\s+(\w+)\s*=\s*axios\.create\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
const CONST_STR = /\bconst\s+(\w+)\s*=\s*(['"`])([^'"`\n]*)\2/g;
const FETCH_CONCAT = /\bfetch\s*\(\s*(\w+)\s*\+\s*(['"`])([^'"`]*?)\2\s*(?:,\s*\{([\s\S]*?)\})?/g;
// A verb call on an unresolved-but-client-looking instance (`api.get("/x")` where `api` is imported).
const CLIENTISH_VERB = /\b(\w*(?:api|client|http|sdk)\w*)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])([^'"`]*?)\3/gi;
const HTTP_VERBS_RE = /^(get|post|put|patch|delete|head|options)$/i;

const methodOf = (opts: string | undefined): string | undefined => opts?.match(/method\s*:\s*['"]([a-zA-Z]+)['"]/)?.[1];
const urlOf = (config: string): string | undefined => config.match(/\burl\s*:\s*['"`]([^'"`]+)['"`]/)?.[1];
const joinUrl = (base: string, p: string): string => base.replace(/\/+$/, "") + (p.startsWith("/") ? p : "/" + p);

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

  // Pre-pass: same-file string consts + axios.create instances (from the ORIGINAL content), then
  // substitute known `${NAME}` interpolations so the literal matchers below see resolved paths.
  const constStr = new Map<string, string>();
  for (const m of content.matchAll(CONST_STR)) {
    if (!m[3]!.includes("${") && !constStr.has(m[1]!)) constStr.set(m[1]!, m[3]!);
  }
  const clientBase = new Map<string, string>();
  for (const m of content.matchAll(AXIOS_CREATE)) {
    const base = m[2]!.match(/\bbaseURL\s*:\s*['"`]([^'"`]+)['"`]/)?.[1];
    if (base && !clientBase.has(m[1]!)) clientBase.set(m[1]!, base);
  }
  let src = content;
  for (const [name, val] of constStr) src = src.split("${" + name + "}").join(val);

  for (const m of src.matchAll(FETCH)) {
    add({ via: "fetch", ref: m[2]!, surface: httpSurface(m[2]!, methodOf(m[3])) ?? undefined });
  }
  // `fetch(BASE + "/x")` — string-concat form the literal matcher can't see.
  for (const m of src.matchAll(FETCH_CONCAT)) {
    const base = constStr.get(m[1]!);
    if (base) add({ via: "fetch", ref: `${m[1]!} + ${m[3]!}`, surface: httpSurface(joinUrl(base, m[3]!), methodOf(m[4])) ?? undefined });
  }
  for (const m of src.matchAll(AXIOS_VERB)) {
    add({ via: "axios", ref: m[3]!, surface: httpSurface(m[3]!, m[1]) ?? undefined });
  }
  for (const m of src.matchAll(AXIOS_CONFIG)) {
    const url = urlOf(m[1]!);
    if (url) add({ via: "axios", ref: url, surface: httpSurface(url, methodOf(m[1])) ?? undefined });
  }
  for (const m of src.matchAll(AXIOS_BARE)) {
    add({ via: "axios", ref: m[2]!, surface: httpSurface(m[2]!) ?? undefined });
  }
  // Resolved axios.create instances: verb calls compose baseURL + path.
  if (clientBase.size > 0) {
    const instRe = new RegExp(
      `\\b(${[...clientBase.keys()].join("|")})\\s*\\.\\s*(get|post|put|patch|delete|head|options)\\s*\\(\\s*(['"\`])([^'"\`]*?)\\3`,
      "gi",
    );
    for (const m of src.matchAll(instRe)) {
      const base = clientBase.get(m[1]!);
      if (base) add({ via: "axios", ref: `${m[1]!}.${m[2]!} ${m[4]!}`, surface: httpSurface(joinUrl(base, m[4]!), m[2]) ?? undefined });
    }
  }
  // Unresolvable client-looking instances: literal /-paths still make exact candidates; anything
  // else degrades to a service hint so classify() routes it to the review tier.
  for (const m of src.matchAll(CLIENTISH_VERB)) {
    const name = m[1]!;
    if (name.toLowerCase() === "axios" || clientBase.has(name) || HTTP_VERBS_RE.test(name)) continue;
    if (m[4]!.startsWith("/")) {
      add({ via: "axios", ref: `${name}.${m[2]!} ${m[4]!}`, surface: httpSurface(m[4]!, m[2]) ?? undefined });
    } else {
      const hint = name.replace(/[-_.]?(api|client|http|sdk)$/i, "").toLowerCase();
      if (hint) add({ via: "axios", ref: `${name}.${m[2]!}(…)`, hint });
    }
  }
  for (const m of src.matchAll(GRPC_CLIENT)) {
    const svc = m[1]!.replace(/Service$/, "");
    if (svc) add({ via: "grpc-client", ref: `${m[1]!}Client`, hint: svc.toLowerCase() });
  }
  for (const m of src.matchAll(IMPORT)) {
    const spec = m[2]!;
    // Only client-ish or org-scoped specifiers are worth a dependency hint; relative/plain deps are noise.
    if (/^\.|^node:/.test(spec)) continue;
    if (!(spec.startsWith("@") || /[-_.](client|sdk|grpc|proto|rpc)$|grpc|proto/i.test(spec))) continue;
    const hint = pkgHint(spec);
    if (hint) add({ via: "import", ref: spec, hint });
  }

  return out;
}
