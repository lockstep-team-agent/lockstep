import type { Extraction } from "./rubric.js";

export const CONFIDENCE_FLOOR = 0.5;

export type GateAction = "propose" | "question" | "discard";

/**
 * Stage 5 — gate. A real, agreed, confident decision → propose (into the review queue). A decision that
 * isn't yet agreed → question (Phase 2 files these as ledger Questions; for now logged + discarded).
 * Everything else → discard. Nothing here binds — confirmation is a human step (Stage 7).
 */
export function gate(x: Extraction): GateAction {
  if (!x.is_decision || x.confidence < CONFIDENCE_FLOOR) return "discard";
  if (x.finality !== "agreed") return "question";
  if (!x.rule_text.trim() || x.evidence.length === 0) return "discard";
  return "propose";
}
