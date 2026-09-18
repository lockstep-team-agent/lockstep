/**
 * Typesafe "Jev" (System One) client — calibrated yes/no and pick-one judgments for the funnel's
 * recall and recheck stages. Same failure posture as core's Voyage client: NEVER throws; null means
 * "Jev unavailable" and the caller runs the pre-Jev path (keyword → Haiku, or Opus recheck).
 * Unset TYPESAFE_API_KEY ⇒ always null ⇒ CI and self-hosts without a key are unaffected.
 */
const URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const TIMEOUT_MS = 10_000;

export type JevQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };

export function jevEnabled(): boolean {
  return Boolean(process.env.TYPESAFE_API_KEY);
}

/** One System One request; all questions are evaluated in parallel server-side. Null on any failure. */
export async function systemOne(
  state: unknown,
  questions: Record<string, JevQuestion>,
): Promise<Record<string, JevAnswer> | null> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ state, model: MODEL, questions }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 429 || res.status === 529) continue; // one retry, then give up
      if (!res.ok) return null;
      const data = (await res.json()) as { answers?: Record<string, JevAnswer> };
      if (!data.answers || typeof data.answers !== "object") return null;
      return data.answers;
    } catch {
      return null;
    }
  }
  return null;
}
