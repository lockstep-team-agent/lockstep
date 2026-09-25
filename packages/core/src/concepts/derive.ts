/**
 * Concept keys: a surface's stable, kind-namespaced grouping key plus a display label.
 * Pure and deterministic — the same surface always yields the same key under the same rules, so a
 * surface's concept placement never needs a model. Keys of different kinds never collide
 * (`http:orders` and `gql:Order` stay separate until a human merges them).
 */

export const RULE_VERSION = 1;

export interface HttpRules {
  /** Leading segments to skip: a literal (`api`) or a `/regex/` (`/^v\d+$/`). Params always skip. */
  skip?: string[];
}

export const DEFAULT_HTTP_SKIP = ["api", "rest", "/^v\\d+$/", "me", "self"];

const GQL_WRAPPER = /(Payload|Result|Response|Connection|Edge)$/;

export interface ConceptKey {
  key: string;
  label: string;
}

/** The kind of a canonical surface ID (`http:GET /x`, `gql:Query.x`, …); legacy `POST /x` is http. */
export function surfaceKind(surface: string): string {
  const m = /^([a-z][a-z0-9_-]*):/.exec(surface);
  if (m) return m[1]!;
  if (/^[A-Z]+ \//.test(surface)) return "http";
  return "unknown";
}

function skipMatchers(rules?: HttpRules): Array<(seg: string) => boolean> {
  return (rules?.skip ?? DEFAULT_HTTP_SKIP).map((s) => {
    const re = /^\/(.+)\/([a-z]*)$/.exec(s);
    if (re) {
      const rx = new RegExp(re[1]!, re[2]!.includes("i") ? "i" : "");
      return (seg: string) => rx.test(seg);
    }
    const lit = s.toLowerCase();
    return (seg: string) => seg.toLowerCase() === lit;
  });
}

const isParam = (seg: string): boolean => seg.startsWith(":") || (seg.startsWith("{") && seg.endsWith("}"));

/** First resource segment of a path after skipping LEADING prefixes, versions, params and self-aliases. */
function firstResource(path: string, rules?: HttpRules): string | null {
  const segs = path.split("?")[0]!.split("/").filter(Boolean);
  const skips = skipMatchers(rules);
  for (const seg of segs) {
    if (isParam(seg) || skips.some((f) => f(seg))) continue;
    return seg.toLowerCase();
  }
  return null;
}

export function conceptKey(
  surface: string,
  returnType?: string | null,
  returnTypeKind?: string | null,
  rules?: HttpRules,
): ConceptKey {
  const kind = surfaceKind(surface);
  const body = kind === "http" && !surface.startsWith("http:") ? surface : surface.slice(kind.length + 1);

  switch (kind) {
    case "http": {
      const path = body.replace(/^[A-Z]+\s+/, "");
      const seg = firstResource(path, rules);
      return seg ? { key: `http:${seg}`, label: seg } : { key: "http:/", label: "/" };
    }
    case "ws": {
      const seg = firstResource(body.startsWith("/") ? body : `/${body}`, rules);
      return seg ? { key: `ws:${seg}`, label: seg } : { key: "ws:/", label: "/" };
    }
    case "gql": {
      const type = returnType?.replace(/[[\]!\s]/g, "");
      if (type && (returnTypeKind === "object" || returnTypeKind === "interface") && !GQL_WRAPPER.test(type)) {
        return { key: `gql:${type}`, label: type };
      }
      const field = body.split(".").slice(1).join(".") || body;
      return { key: `gql:${body}`, label: field };
    }
    case "proto": {
      const service = body.split("/")[0]!;
      const name = service.split(".").pop() ?? service;
      return { key: `proto:${service}`, label: name.replace(/Service$/, "") || name };
    }
    case "event": {
      const head = body.split(".")[0]!;
      return { key: `event:${head}`, label: head };
    }
    default:
      return { key: surface, label: body || surface };
  }
}
