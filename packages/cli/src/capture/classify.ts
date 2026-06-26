import { extractSurfaces } from "./surface.js";

/**
 * Contract-surface detection (a safety gate). A file is a contract surface if it exposes a public
 * interface others code against. We deliberately DROPPED the old "any file with an `export` is a
 * contract surface" heuristic — it flagged essentially all application code as `shared`, which both
 * destroyed the owned/shared signal and flooded the ledger. Now: real extractable surfaces (HTTP
 * routes, proto/graphql RPCs) or unambiguous interface files (.proto/.graphql, OpenAPI specs,
 * route/controller paths). Pure + testable.
 */
export function isContractSurface(path: string, content?: string): boolean {
  if (extractSurfaces(path, content).length > 0) return true;
  if (/(openapi|swagger)/i.test(path) && /\.(ya?ml|json)$/i.test(path)) return true;
  if (/\.(proto|graphql|gql)$/i.test(path)) return true;
  if (/(^|\/)(routes?|controllers?|api|handlers?|endpoints?|contracts?)(\/|\.)/i.test(path)) return true;
  return false;
}

/** owned (only you own all changed paths, none are contract surfaces) vs shared. */
export function riskTierFor(opts: { anyContractSurface: boolean; allOwnedByMe: boolean }): "owned" | "shared" {
  if (opts.anyContractSurface) return "shared";
  return opts.allOwnedByMe ? "owned" : "shared";
}
