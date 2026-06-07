import { claudeAdapter } from "./claude.js";
import type { VendorAdapter } from "./types.js";

// Codex + Gemini adapters slot in here later — same interface, zero core change.
const ALL: VendorAdapter[] = [claudeAdapter];

export async function getAdapters(vendor?: string): Promise<VendorAdapter[]> {
  if (vendor && vendor !== "all") {
    return ALL.filter((a) => a.id === vendor);
  }
  const detected: VendorAdapter[] = [];
  for (const a of ALL) {
    if (await a.detect()) detected.push(a);
  }
  // Project-committed config is harmless even if the CLI isn't detected locally,
  // so fall back to all known adapters when nothing is detected.
  return detected.length > 0 ? detected : ALL;
}
