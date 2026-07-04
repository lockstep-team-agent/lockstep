import { anthropic, MODELS } from "./llm.js";

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

/** Stage 1 combined: prefilter → Haiku. Returns whether to send the unit to extraction. */
export async function recall(text: string, useHaiku = true): Promise<boolean> {
  if (!keywordPrefilter(text)) return false;
  if (!useHaiku) return true;
  return haikuRecall(text);
}
