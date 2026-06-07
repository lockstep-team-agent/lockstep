/**
 * Contract-surface detection (PRD open-Q1, a safety gate). Pragmatic heuristic:
 * does a changed file expose a public interface others code against? Bias to "shared"
 * when in doubt — a false-negative in the cross-org wedge is a confidentiality leak.
 * Pure + testable.
 */
export function isContractSurface(path: string, content?: string): boolean {
  if (/(openapi|swagger)/i.test(path) && /\.(ya?ml|json)$/i.test(path)) return true;
  if (/\.(proto|graphql|gql)$/i.test(path)) return true;
  if (/(^|\/)(routes?|controllers?|api|handlers?|endpoints?|contracts?)(\/|\.)/i.test(path)) return true;
  if (content && /\.(ts|tsx|js|mjs)$/i.test(path)) {
    if (/\bexport\s+(async\s+)?(function|const|class|interface|type)\b/.test(content)) return true;
  }
  return false;
}

/** owned (only you own all changed paths, none are contract surfaces) vs shared. */
export function riskTierFor(opts: { anyContractSurface: boolean; allOwnedByMe: boolean }): "owned" | "shared" {
  if (opts.anyContractSurface) return "shared";
  return opts.allOwnedByMe ? "owned" : "shared";
}
