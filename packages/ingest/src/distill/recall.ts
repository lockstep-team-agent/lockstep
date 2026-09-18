import { anthropic, MODELS } from "./llm.js";
import { systemOne } from "./jev.js";

/**
 * Jev recall floor — a STARTING POINT from the 2026-09-18 eval: true decisions scored ≥ 0.67,
 * non-decisions ≤ 0.25 except two soft cases at 0.45 / 0.63. Tuned for RECALL: junk passing to the
 * extractor is cheap, a missed decision is not.
 */
export const JEV_RECALL_FLOOR = 0.3;

const JEV_STATE_CHARS = 12_000;

/** Jev binary recall. True/false when Jev answered; null when Jev is unavailable (caller falls back). */
export async function jevRecall(text: string): Promise<boolean | null> {
  const a = await systemOne(
    { thread: text.slice(0, JEV_STATE_CHARS) },
    {
      d: {
        type: "noul",
        instructions:
          "Does this chat thread contain a durable, agreed engineering decision (a rule or architectural choice that constrains future work, actually concluded by the team)?",
        criteria: {
          true: "The team concluded a rule or architectural choice that shapes future work",
          false:
            "Chatter, status update, one-off task, open debate, scheduling, a question answered with a fact, or a joke",
        },
      },
    },
  );
  const d = a?.d;
  if (!d || d.type !== "noul") return null;
  return d.noul >= JEV_RECALL_FLOOR;
}

/** Jev binary recall for PRD sections. Same contract as jevRecall. */
export async function jevRecallDoc(text: string): Promise<boolean | null> {
  const a = await systemOne(
    { prd_section: text.slice(0, JEV_STATE_CHARS) },
    {
      d: {
        type: "noul",
        instructions:
          "Does this PRD section state a binding product constraint: an obligation, prohibition, launch gate, or explicit scope exclusion that an engineer could verify an implementation against?",
        criteria: {
          true: "Obligation/prohibition language that constrains what gets built",
          false: "Background, research, personas, competitor notes, open questions, timelines, or aspiration",
        },
      },
    },
  );
  const d = a?.d;
  if (!d || d.type !== "noul") return null;
  return d.noul >= JEV_RECALL_FLOOR;
}

/**
 * Stage 1 — cheap recall filter. Free keyword prefilter first; survivors get a Haiku binary check.
 * Tuned for RECALL: better to pass a non-decision to the expensive extractor than to miss a real one.
 */

const MARKERS = [
  "let's go with",
  "lets go with",
  "we decided",
  "we've decided",
  "decision:",
  "final call",
  "agreed",
  "going forward",
  "from now on",
  "the plan is",
  "we'll use",
  "we will use",
  "let's use",
  "approved",
  "sign off",
  "signed off",
  "locking",
  "let's lock",
  "lock it",
  "standard",
  "convention",
  "rfc",
  "adr",
  "proposal",
  "must",
  "should always",
  "no longer",
  "instead of",
];

/** Free prefilter: does the text contain any decision-shaped language? */
export function keywordPrefilter(text: string): boolean {
  const t = text.toLowerCase();
  return MARKERS.some((m) => t.includes(m));
}

/** Haiku binary "could this thread contain a durable, agreed decision?" — cheap, high-recall. */
export async function haikuRecall(text: string): Promise<boolean> {
  const res = await anthropic().messages.create({
    model: MODELS.recall,
    max_tokens: 5,
    system:
      "You are a fast filter. Answer ONLY 'yes' or 'no'. Say 'yes' if this chat thread MIGHT contain a durable, agreed engineering decision (a rule or architectural choice that shapes future work). When unsure, say 'yes'.",
    messages: [{ role: "user", content: text.slice(0, 6000) }],
  });
  const block = res.content.find((b) => b.type === "text");
  const answer = block && block.type === "text" ? block.text.toLowerCase() : "";
  return answer.includes("yes");
}

/**
 * Stage 1 combined. Jev first (no keyword prefilter — the marker list was the recall ceiling); when
 * Jev is unavailable, the pre-Jev path: prefilter → Haiku. `useHaiku=false` skips only the Anthropic
 * call; Jev is the cheap tier and runs whenever configured.
 */
export async function recall(text: string, useHaiku = true): Promise<boolean> {
  const jev = await jevRecall(text);
  if (jev !== null) return jev;
  if (!keywordPrefilter(text)) return false;
  if (!useHaiku) return true;
  return haikuRecall(text);
}

/* ── PRD sections (v3 product layer) — same shape, obligation/prohibition markers ── */

export const DOC_MARKERS = [
  "must",
  "must not",
  "never",
  "launch gate",
  "we will not",
  "required",
  "at least",
  "at most",
  "no more than",
  "no later than",
  "shall",
  "may not",
  "only if",
  "exactly",
  "minimum",
  "maximum",
  "prohibited",
  "not allowed",
];

/** Free prefilter: does the PRD section contain any obligation/prohibition-shaped language? */
export function keywordPrefilterDoc(text: string): boolean {
  const t = text.toLowerCase();
  return DOC_MARKERS.some((m) => t.includes(m));
}

/** Haiku binary "MIGHT this PRD section contain a binding product constraint?" — cheap, high-recall. */
export async function haikuRecallDoc(text: string): Promise<boolean> {
  const res = await anthropic().messages.create({
    model: MODELS.recall,
    max_tokens: 5,
    system:
      "You are a fast filter. Answer ONLY 'yes' or 'no'. Say 'yes' if this PRD section MIGHT contain a binding product constraint (an obligation, prohibition, or launch gate that shapes what gets built). When unsure, say 'yes'.",
    messages: [{ role: "user", content: text.slice(0, 6000) }],
  });
  const block = res.content.find((b) => b.type === "text");
  const answer = block && block.type === "text" ? block.text.toLowerCase() : "";
  return answer.includes("yes");
}

/** Stage 1 combined for docs — same Jev-first shape as recall(). */
export async function recallDoc(text: string, useHaiku = true): Promise<boolean> {
  const jev = await jevRecallDoc(text);
  if (jev !== null) return jev;
  if (!keywordPrefilterDoc(text)) return false;
  if (!useHaiku) return true;
  return haikuRecallDoc(text);
}
