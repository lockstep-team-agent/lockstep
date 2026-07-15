/**
 * Language-composed extraction — the single entry point scan/capture use. Each language module
 * stays pure and self-gated by extension; this file just unions their results. `surface.ts` is
 * deliberately untouched (it is vendored to the GitHub Action's `surface.mjs`).
 */
import { extractSurfaces } from "./surface.js";
import { extractOutbound, type OutboundRef } from "./outbound.js";
import { extractPythonOutbound, extractPythonSurfaces } from "./python.js";

/** Every canonical surface ID a file defines (produces), across all supported languages. */
export function extractAllSurfaces(path: string, content?: string): string[] {
  return [...new Set([...extractSurfaces(path, content), ...extractPythonSurfaces(path, content)])];
}

/** Every outbound-call candidate a file makes (consumes), across all supported languages. */
export function extractAllOutbound(path: string, content?: string): OutboundRef[] {
  return [...extractOutbound(path, content), ...extractPythonOutbound(path, content)];
}
