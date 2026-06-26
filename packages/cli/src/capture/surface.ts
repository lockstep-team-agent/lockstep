/**
 * Canonical surface identity — the shared vocabulary that lets a producer and a consumer name the
 * same logical interface as the SAME string, without sharing source. This is the keystone of
 * routing/impact: a change to `http:POST /auth/session` matches a dependency on `http:POST /auth/session`.
 *
 * Format: `<kind>:<normalized-id>`
 *   http   →  http:POST /auth/session          (method + normalized path)
 *   proto  →  proto:auth.v1.AuthService/Login   (package.Service/Method)
 *   gql    →  gql:Mutation.login
 *   pkg    →  pkg:@scope/name#exportName        (published-package export)
 *
 * Pure + testable. HTTP is first-class; proto is parsed; gql/openapi/pkg are light stubs we can
 * deepen later behind this same interface.
 */
export type SurfaceId = string;

const HTTP_VERBS = "get|post|put|patch|delete|options|head|all";

/** Normalize a route path: ensure a leading slash, `{id}`→`:id`, strip querystring/trailing slash. */
function normalizePath(p: string): string {
  let s = p.split("?")[0]!.trim();
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\{([^}]+)\}/g, ":$1"); // OpenAPI/Express-style {id} → :id
  if (s.length > 1) s = s.replace(/\/+$/, ""); // drop trailing slash (keep root "/")
  return s;
}

const httpId = (method: string, path: string): SurfaceId =>
  `http:${method.toUpperCase() === "ALL" ? "ANY" : method.toUpperCase()} ${normalizePath(path)}`;

/** Express/Fastify-style: `app.get("/x")`, `router.post('/y', ...)`, `fastify.delete(\`/z\`)`. */
function extractExpressRoutes(content: string): SurfaceId[] {
  const re = new RegExp(`\\.(${HTTP_VERBS})\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]`, "gi");
  const out: SurfaceId[] = [];
  for (const m of content.matchAll(re)) out.push(httpId(m[1]!, m[2]!));
  return out;
}

/** Next.js app-router: `app/auth/session/route.ts` + `export async function POST` → http:POST /auth/session. */
function extractNextRoutes(path: string, content: string): SurfaceId[] {
  const m = path.match(/(?:^|\/)app\/(.*)\/route\.(?:ts|tsx|js|mjs)$/i);
  if (!m) return [];
  const segments = m[1]!
    .split("/")
    .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")"))) // route groups don't affect the URL
    .map((seg) => seg.replace(/^\[(?:\.\.\.)?([^\]]+)\]$/, ":$1")); // [id] / [...slug] → :id
  const routePath = "/" + segments.join("/");
  const out: SurfaceId[] = [];
  for (const v of content.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g)) {
    out.push(httpId(v[1]!, routePath));
  }
  return out;
}

/** Protobuf: `package auth.v1;` + `service AuthService { rpc Login (...) ... }` → proto:auth.v1.AuthService/Login. */
function extractProto(content: string): SurfaceId[] {
  const pkg = content.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1] ?? "";
  const out: SurfaceId[] = [];
  const svcRe = /service\s+(\w+)\s*\{([\s\S]*?)\}/g;
  for (const svc of content.matchAll(svcRe)) {
    const service = svc[1]!;
    for (const rpc of svc[2]!.matchAll(/rpc\s+(\w+)\s*\(/g)) {
      out.push(`proto:${pkg ? pkg + "." : ""}${service}/${rpc[1]!}`);
    }
  }
  return out;
}

/** GraphQL (light stub): top-level Query/Mutation/Subscription fields → gql:Mutation.login. */
function extractGraphql(content: string): SurfaceId[] {
  const out: SurfaceId[] = [];
  const blockRe = /\b(type|extend\s+type)\s+(Query|Mutation|Subscription)\s*\{([\s\S]*?)\}/g;
  for (const block of content.matchAll(blockRe)) {
    const root = block[2]!;
    for (const field of block[3]!.matchAll(/^\s*(\w+)\s*[(:]/gm)) out.push(`gql:${root}.${field[1]!}`);
  }
  return out;
}

const isHttpRoutey = (path: string): boolean =>
  /(^|\/)(routes?|controllers?|api|handlers?|endpoints?)(\/|\.)/i.test(path);

/**
 * Extract every canonical surface ID a changed file *defines* (i.e. produces). Returns [] for files
 * that expose no public interface — which is most files. This narrowness is intentional: it's what
 * keeps the ledger quiet (a bare `export` is NOT a contract surface).
 */
export function extractSurfaces(path: string, content?: string): SurfaceId[] {
  const out = new Set<SurfaceId>();

  if (/\.proto$/i.test(path) && content) extractProto(content).forEach((s) => out.add(s));
  if (/\.(graphql|gql)$/i.test(path) && content) extractGraphql(content).forEach((s) => out.add(s));

  if (/\.(ts|tsx|js|mjs|cjs)$/i.test(path) && content) {
    extractNextRoutes(path, content).forEach((s) => out.add(s));
    // Express/Fastify route literals — only trust them in files that look like route/handler code,
    // so an incidental `.get("...")` on some object elsewhere doesn't mint a phantom endpoint.
    if (isHttpRoutey(path) || /\b(express|fastify|router|app)\b/.test(content)) {
      extractExpressRoutes(content).forEach((s) => out.add(s));
    }
  }

  return [...out];
}
