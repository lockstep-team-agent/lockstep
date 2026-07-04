import type { Extraction } from "./rubric.js";
import type { DocExtraction } from "./rubric-doc.js";

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

export const DOC_CONFIDENCE_FLOOR = 0.7;
export const DOC_CANDIDATE_FLOOR = 0.5;

export type DocGateAction = "propose" | "propose_low" | "discard";

/**
 * Stage 5 for PRD constraints — no "question" band (a PRD sentence is binding or it isn't; there is no
 * finality to wait on). Instead a low-confidence band: candidates in [0.5, 0.7) are still proposed but
 * flagged lowConfidence so review surfaces them under a collapsed divider. Ratification stays human.
 */
export function gateDoc(x: DocExtraction): DocGateAction {
  if (!x.is_constraint || x.constraint_kind === "none" || x.confidence < DOC_CANDIDATE_FLOOR) return "discard";
  if (!x.rule_text.trim() || x.evidence.length === 0) return "discard";
  return x.confidence >= DOC_CONFIDENCE_FLOOR ? "propose" : "propose_low";
}
