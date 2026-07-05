/**
 * Canonical surface identity — VENDORED from packages/cli/src/capture/surface.ts so the PR check
 * names the SAME `http:POST /path` / `proto:…` / `gql:…` strings the ledger stores (decisions,
 * constraints, conflicts are all scoped to these). Without this the action would send raw file paths,
 * which never match the ledger's canonical refs.
 *
 * KEEP IN SYNC with packages/cli/src/capture/surface.ts (+ the isContractSurface heuristic in
 * capture/classify.ts). Follow-up: extract a shared module both consume instead of vendoring.
 */

const HTTP_VERBS = "get|post|put|patch|delete|options|head|all";

function normalizePath(p) {
  let s = p.split("?")[0].trim();
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\{([^}]+)\}/g, ":$1");
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s;
}

const httpId = (method, path) =>
  `http:${method.toUpperCase() === "ALL" ? "ANY" : method.toUpperCase()} ${normalizePath(path)}`;

function extractExpressRoutes(content) {
  const re = new RegExp(`\\.(${HTTP_VERBS})\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`, "gi");
  const out = [];
  for (const m of content.matchAll(re)) out.push(httpId(m[1], m[2]));
  return out;
}

function extractNextRoutes(path, content) {
  const m = path.match(/(?:^|\/)app\/(.*)\/route\.(?:ts|tsx|js|mjs)$/i);
  if (!m) return [];
  const segments = m[1]
    .split("/")
    .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")))
    .map((seg) => seg.replace(/^\[(?:\.\.\.)?([^\]]+)\]$/, ":$1"));
  const routePath = "/" + segments.join("/");
  const out = [];
  for (const v of content.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g)) {
    out.push(httpId(v[1], routePath));
  }
  return out;
}

function extractProto(content) {
  const pkg = content.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1] ?? "";
  const out = [];
  for (const svc of content.matchAll(/service\s+(\w+)\s*\{([\s\S]*?)\}/g)) {
    const service = svc[1];
    for (const rpc of svc[2].matchAll(/rpc\s+(\w+)\s*\(/g)) {
      out.push(`proto:${pkg ? pkg + "." : ""}${service}/${rpc[1]}`);
    }
  }
  return out;
}

function extractGraphql(content) {
  const out = [];
  const blockRe = /\b(type|extend\s+type)\s+(Query|Mutation|Subscription)\s*\{([\s\S]*?)\}/g;
  for (const block of content.matchAll(blockRe)) {
    const root = block[2];
    for (const field of block[3].matchAll(/^\s*(\w+)\s*[(:]/gm)) out.push(`gql:${root}.${field[1]}`);
  }
  return out;
}

const isHttpRoutey = (path) => /(^|\/)(routes?|controllers?|api|handlers?|endpoints?)(\/|\.)/i.test(path);

/** Every canonical surface id a changed file *defines*. [] for files with no public interface. */
export function extractSurfaces(path, content) {
  const out = new Set();
  if (/\.proto$/i.test(path) && content) extractProto(content).forEach((s) => out.add(s));
  if (/\.(graphql|gql)$/i.test(path) && content) extractGraphql(content).forEach((s) => out.add(s));
  if (/\.(ts|tsx|js|mjs|cjs)$/i.test(path) && content) {
    extractNextRoutes(path, content).forEach((s) => out.add(s));
    if (isHttpRoutey(path) || /\b(express|fastify|router|app)\b/.test(content)) {
      extractExpressRoutes(content).forEach((s) => out.add(s));
    }
  }
  return [...out];
}

/** Pre-filter: is this a file we should even read for surfaces? (mirrors capture/classify.ts) */
export function isContractSurface(path) {
  if (/(openapi|swagger)/i.test(path) && /\.(ya?ml|json)$/i.test(path)) return true;
  if (/\.(proto|graphql|gql)$/i.test(path)) return true;
  if (/(^|\/)(routes?|controllers?|api|handlers?|endpoints?|contracts?)(\/|\.)/i.test(path)) return true;
  return false;
}
