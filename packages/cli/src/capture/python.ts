/**
 * Python extractors — the first non-JS/TS language (IMPROVEMENTS #1). Same philosophy as
 * `surface.ts`/`outbound.ts`: regex-based, best-effort, candidates not authority — `lockstep scan`
 * resolves them against the org catalog and a human approves.
 *
 * BOUNDARY (deliberate): all resolution is SAME-FILE only. A router/client defined in another
 * module is not followed; cross-file mounting/imports stay invisible. The PR-check gate
 * (`actions/pr-check/surface.mjs`, vendored from surface.ts) remains JS/TS-only — Python contract
 * surfaces do not trip the Tier-2 gate until that copy is extended.
 */
import { normalizePath } from "./surface.js";
import { httpSurface, type OutboundRef } from "./outbound.js";

const VERBS = "get|post|put|patch|delete|head|options";

/** Outbound URL literal: f-string `{expr}` is arbitrary interpolation → `:param` (matching is param-insensitive anyway). */
const pyPath = (raw: string): string => raw.replace(/\{[^}]*\}/g, ":param").replace(/<(?:\w+\s*:\s*)?(\w+)>/g, ":$1");

/** Served route template: keep the param NAME — `{card_id}` → `:card_id` (via normalizePath), `<int:id>` → `:id`. */
const httpId = (method: string, path: string): string =>
  `http:${method.toUpperCase()} ${normalizePath(path.replace(/<(?:\w+\s*:\s*)?(\w+)>/g, ":$1"))}`;

/* ── outbound (consumes) ── */

const REQUESTS_VERB = new RegExp(`\\brequests\\.(${VERBS})\\s*\\(\\s*[fF]?(['"])([^'"\\n]*)\\2`, "g");
const REQUESTS_REQUEST = /\brequests\.request\s*\(\s*['"](\w+)['"]\s*,\s*[fF]?(['"])([^'"\n]*)\2/g;
const HTTPX_VERB = new RegExp(`\\bhttpx\\.(${VERBS})\\s*\\(\\s*[fF]?(['"])([^'"\\n]*)\\2`, "g");
const HTTPX_CLIENT = /\b(\w+)\s*=\s*httpx\.(?:Async)?Client\s*\(([^)]*)\)/g;
const AIOHTTP_WITH = /\basync\s+with\s+aiohttp\.ClientSession\s*\([^)]*\)\s*as\s+(\w+)/g;
const AIOHTTP_ASSIGN = /\b(\w+)\s*=\s*aiohttp\.ClientSession\s*\(/g;
const BASE_URL = /\bbase_url\s*=\s*[fF]?['"]([^'"]+)['"]/;

const joinUrl = (base: string, p: string): string => base.replace(/\/+$/, "") + (p.startsWith("/") ? p : "/" + p);

/** Extract outbound HTTP candidates from a Python file (`requests`/`httpx`/`aiohttp`). */
export function extractPythonOutbound(path: string, content?: string): OutboundRef[] {
  if (!content || !/\.py$/i.test(path)) return [];
  const out: OutboundRef[] = [];
  const seen = new Set<string>();
  const add = (ref: string, surface: string | null): void => {
    if (!surface) return;
    const key = `python-http ${surface}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ via: "python-http", ref, surface });
    }
  };

  for (const m of content.matchAll(REQUESTS_VERB)) add(m[3]!, httpSurface(pyPath(m[3]!), m[1]));
  for (const m of content.matchAll(REQUESTS_REQUEST)) add(m[3]!, httpSurface(pyPath(m[3]!), m[1]));
  for (const m of content.matchAll(HTTPX_VERB)) add(m[3]!, httpSurface(pyPath(m[3]!), m[1]));

  // Same-file client instances: httpx.Client(base_url=…) verbs resolve base+path; aiohttp
  // sessions (no base) resolve the literal path. Conservative: only names bound in THIS file.
  const clientBase = new Map<string, string>(); // name → base_url ("" when none)
  for (const m of content.matchAll(HTTPX_CLIENT)) {
    if (!clientBase.has(m[1]!)) clientBase.set(m[1]!, m[2]!.match(BASE_URL)?.[1] ?? "");
  }
  for (const m of content.matchAll(AIOHTTP_WITH)) if (!clientBase.has(m[1]!)) clientBase.set(m[1]!, "");
  for (const m of content.matchAll(AIOHTTP_ASSIGN)) if (!clientBase.has(m[1]!)) clientBase.set(m[1]!, "");
  if (clientBase.size > 0) {
    const names = [...clientBase.keys()].join("|");
    const instRe = new RegExp(`\\b(${names})\\.(${VERBS})\\s*\\(\\s*[fF]?(['"])([^'"\\n]*)\\3`, "g");
    for (const m of content.matchAll(instRe)) {
      const base = clientBase.get(m[1]!)!;
      const raw = base ? joinUrl(base, pyPath(m[4]!)) : pyPath(m[4]!);
      add(`${m[1]!}.${m[2]!} ${m[4]!}`, httpSurface(raw, m[2]));
    }
  }

  return out;
}

/* ── produces (serves) ── */

const FASTAPI_APP = /\b(\w+)\s*=\s*FastAPI\s*\(/g;
const APIROUTER = /\b(\w+)\s*=\s*APIRouter\s*\(([^)]*)\)/g;
const INCLUDE_ROUTER = /\.include_router\s*\(\s*(\w+)([^)]*)\)/g;
const PREFIX = /\bprefix\s*=\s*[fF]?['"]([^'"]+)['"]/;
const FLASK_APP = /\b(\w+)\s*=\s*Flask\s*\(/g;
const BLUEPRINT = /\b(\w+)\s*=\s*Blueprint\s*\(([^)]*)\)/g;
const URL_PREFIX = /\burl_prefix\s*=\s*[fF]?['"]([^'"]+)['"]/;
const FLASK_ROUTE = /@(\w+)\.route\s*\(\s*[fF]?(['"])([^'"\n]*)\2([^)]*)\)/g;
const METHODS = /\bmethods\s*=\s*\[([^\]]*)\]/;

/** Extract served HTTP surfaces from a Python file (FastAPI/Flask). Same-file prefixes only. */
export function extractPythonSurfaces(path: string, content?: string): string[] {
  if (!content || !/\.py$/i.test(path)) return [];
  const out = new Set<string>();

  // Known handler owners: FastAPI apps + routers (with same-file prefix composition). "app"/"router"
  // are accepted as fallbacks — the overwhelmingly common names when the binding is off-screen.
  const prefixes = new Map<string, string>();
  for (const m of content.matchAll(FASTAPI_APP)) prefixes.set(m[1]!, "");
  for (const m of content.matchAll(APIROUTER)) prefixes.set(m[1]!, m[2]!.match(PREFIX)?.[1] ?? "");
  for (const m of content.matchAll(INCLUDE_ROUTER)) {
    const extra = m[2]!.match(PREFIX)?.[1];
    if (extra && prefixes.has(m[1]!)) prefixes.set(m[1]!, extra + (prefixes.get(m[1]!) ?? ""));
  }

  const decoRe = new RegExp(`@(\\w+)\\.(${VERBS})\\s*\\(\\s*[fF]?(['"])([^'"\\n]*)\\3`, "g");
  for (const m of content.matchAll(decoRe)) {
    const name = m[1]!;
    if (!prefixes.has(name) && name !== "app" && name !== "router") continue;
    const prefix = prefixes.get(name) ?? "";
    out.add(httpId(m[2]!, prefix + m[4]!));
  }

  // Flask: @app.route / @blueprint.route with methods=[…] (default GET) + Blueprint url_prefix.
  const flaskPrefixes = new Map<string, string>();
  for (const m of content.matchAll(FLASK_APP)) flaskPrefixes.set(m[1]!, "");
  for (const m of content.matchAll(BLUEPRINT)) flaskPrefixes.set(m[1]!, m[2]!.match(URL_PREFIX)?.[1] ?? "");
  for (const m of content.matchAll(FLASK_ROUTE)) {
    const name = m[1]!;
    if (!flaskPrefixes.has(name) && name !== "app" && name !== "bp") continue;
    const prefix = flaskPrefixes.get(name) ?? "";
    const methods = m[4]!.match(METHODS)?.[1];
    const verbs = methods
      ? methods.split(",").map((v) => v.trim().replace(/['"]/g, "")).filter(Boolean)
      : ["GET"];
    for (const v of verbs) out.add(httpId(v, prefix + m[3]!));
  }

  return [...out];
}
