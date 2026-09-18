/**
 * Jev (Typesafe System One) for the fusion/supersession scan — core's second AI seam next to
 * Voyage. One request per incoming decision, one `choice` question per live scope-mate:
 * same_rule / replaces / unrelated, each with a calibrated confidence.
 *
 * Failure posture (as embeddings.ts): NEVER throws; null ⇒ the caller uses cosine/Jaccard wholesale.
 * A verdict below JEV_RELATION_MIN_CONF is treated as an abstention for that mate.
 * Tx safety: gather in a read tx, HTTP outside, no writes.
 */
import { env } from "../env.js";
import { gatherScopeMates } from "./embeddings.js";

const URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const TIMEOUT_MS = 10_000;

export type Relation = "same_rule" | "replaces" | "unrelated";
export interface RelationVerdict {
  relation: Relation;
  confidence: number;
}
export type ScopeJudge = (
  newRule: string,
  mates: Array<{ id: string; ruleText: string }>,
) => Promise<Map<string, RelationVerdict> | null>;

/** STARTING POINT from the 2026-09-18 eval: every correct Choice verdict had confidence ≥ 0.83. */
export const JEV_RELATION_MIN_CONF = 0.8;

const RELATION_CRITERIA: Record<Relation, string> = {
  same_rule: "They express the same rule, possibly reworded; the new one should be merged into the existing one",
  replaces:
    "They govern the same thing but the new one changes or contradicts the existing rule; the new one supersedes it",
  unrelated: "They govern different things and can both stand",
};

/** The real judge: one Jev request, one choice per mate (question key = mate id). */
export const judgeWithJev: ScopeJudge = async (newRule, mates) => {
  if (!env.TYPESAFE_API_KEY || mates.length === 0) return null;
  const existing: Record<string, string> = {};
  const questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }> = {};
  for (const m of mates) {
    existing[m.id] = m.ruleText;
    questions[m.id] = {
      type: "choice",
      instructions: `How does new_decision relate to existing_decisions["${m.id}"]?`,
      criteria: RELATION_CRITERIA,
    };
  }
  const state = {
    new_decision: newRule,
    existing_decisions: existing,
    note: "All decisions are scoped to the same area of the system.",
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.TYPESAFE_API_KEY}` },
        body: JSON.stringify({ state, model: MODEL, questions }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 429 || res.status === 529) continue;
      if (!res.ok) return null;
      const data = (await res.json()) as {
        answers?: Record<string, { type: string; choice?: string; confidence?: number }>;
      };
      if (!data.answers) return null;
      const out = new Map<string, RelationVerdict>();
      for (const m of mates) {
        const a = data.answers[m.id];
        if (!a || a.type !== "choice" || typeof a.confidence !== "number") continue;
        if (a.choice !== "same_rule" && a.choice !== "replaces" && a.choice !== "unrelated") continue;
        out.set(m.id, { relation: a.choice, confidence: a.confidence });
      }
      return out;
    } catch {
      return null;
    }
  }
  return null;
};

/**
 * Pre-pass for fileProposedDecision: relation verdicts for every live scope-mate. Null ⇒ no key,
 * deduped unit, outage, or no mates — caller runs cosine/Jaccard for everything.
 */
export async function judgeScopeRelations(
  orgId: string,
  input: {
    projectId: string;
    scopeRef: string;
    ruleText: string;
    dedupe?: { connectionId: string; externalId: string; contentHash: string };
  },
  judge: ScopeJudge = judgeWithJev,
): Promise<Map<string, RelationVerdict> | null> {
  if (!env.TYPESAFE_API_KEY && judge === judgeWithJev) return null; // cheap out — no key, no reads
  const gathered = await gatherScopeMates(orgId, input);
  if (gathered === null || gathered.mates.length === 0) return null;
  return judge(
    input.ruleText,
    gathered.mates.map((m) => ({ id: m.id, ruleText: m.ruleText })),
  );
}
