# Jev Judgment Stages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Lockstep's yes/no and pick-one LLM judgments (recall filter, borderline recheck, fusion/supersession) with Typesafe's Jev model, keeping every existing path as the fallback when `TYPESAFE_API_KEY` is unset or the call fails.

**Architecture:** Jev is a calibrated classifier, not a generator: `POST /v1/systemone` takes a `state` blob plus typed questions (`noul` = yes/no probability, `choice` = option distribution) and returns probabilities. We add one tiny `fetch` client per package that calls it (ingest worker, core API), mirroring the existing Voyage client's "never throws, null means unavailable" posture. Sonnet keeps Stage 2 extraction because it writes `rule_text` and evidence quotes; Jev owns the judgments around it.

**Tech Stack:** TypeScript strict, Node ≥ 20 native `fetch`, `node:test` runner, Drizzle/Postgres (core), Anthropic SDK (unchanged, for extraction).

**Spec:** No separate spec doc. Requirements come from the 2026-09-18 evaluation (75 cases, 66 correct; recall 12/12 + 9/10 adversarial; fusion 8/8; deterministic across repeat calls; p50 ≈ 0.4 s, ≈ 400 tokens per call). Key findings that shape thresholds: non-decisions scored ≤ 0.25 except two at 0.45 and 0.63; true decisions scored ≥ 0.67; Choice answers that were correct all had confidence ≥ 0.83.

## Global Constraints

- Env var name is exactly `TYPESAFE_API_KEY`. Optional everywhere. Unset ⇒ behavior byte-identical to today.
- Endpoint `https://api.typesafe.ai/v1/systemone`, header `authorization: Bearer <key>`, body `{ state, model: "jev-latest", questions }`.
- Jev clients never throw. They return `null` on missing key, timeout (10 s), non-2xx after one retry on 429/529, or malformed body.
- No new npm dependencies.
- Constants live next to the code that reads them, with a one-line comment stating they are starting points tuned from the eval.
- Tests use `node:test` + `node:assert/strict`. HTTP is stubbed by replacing `globalThis.fetch` (existing pattern in `packages/core/src/api/routes/slack-actions.test.ts:221`). No mocking library.
- Commit messages follow the repo style: `feat(ingest): …`, `feat(core): …`, `docs: …`, ending with the `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` trailer.
- Never commit an API key. The key used in the evaluation was pasted in chat and must be rotated by the owner.

## Where Jev replaces what

| # | Today | File | Jev primitive | Fallback when null |
| --- | --- | --- | --- | --- |
| 1 | Keyword `MARKERS` prefilter → Haiku "yes/no" | `packages/ingest/src/distill/recall.ts` | one `noul` "contains an agreed durable decision?" over the whole unit, floor 0.3 | existing keyword → Haiku path |
| 2 | Same for PRD sections (`DOC_MARKERS` → Haiku) | same file | one `noul` "contains a binding product constraint?" floor 0.3 | existing keyword → Haiku path |
| 3 | Opus full re-extraction when Sonnet confidence ∈ [0.35, 0.6) | `packages/ingest/src/distill/extract.ts` | two `noul`s (is_decision, agreement); confidence := p(is_decision), finality := "proposed" if p(agreement) < 0.5 | Opus recheck as today |
| 4 | Jaccard 0.6/0.4 or Voyage cosine 0.85/0.6 to pick fuse / supersede / new | `packages/core/src/ledger/ledger-service.ts` scope scan | one request, one `choice` per scope-mate: `same_rule` / `replaces` / `unrelated`; acted on when confidence ≥ 0.8 | embedding then Jaccard, as today |

Deliberately **not** in this plan (each needs a product or plumbing decision first): contract-surface Noul in the CLI capture hook (runs on developer laptops, would need the key there and adds hook latency); scope resolution Choice over the produced-surface catalog (worker has no catalog access today); PRD `constraint_kind` pre-gate (Sonnet already emits it; gain is small); conflict-probability ranking in `reconcile-service.ts` (changes the "co-location only, never claim contradiction" doctrine and needs review-queue UI).

## File map

| File | Action | Responsibility |
| --- | --- | --- |
| `packages/ingest/src/distill/jev.ts` | create | Jev HTTP client for the worker: `systemOne()`, `jevEnabled()` |
| `packages/ingest/src/distill/jev.test.ts` | create | client contract: null without key, parses answers, null on error |
| `packages/ingest/src/distill/recall.ts` | modify | Jev-first `recall()` / `recallDoc()` with existing path as fallback |
| `packages/ingest/src/distill/recall.test.ts` | create | recall routing: Jev floor, fallback to keyword path |
| `packages/ingest/src/distill/extract.ts` | modify | `applyJevRecheck()` pure merge + Jev-first recheck in `extract()` |
| `packages/ingest/src/distill/extract-recheck.test.ts` | create | pure merge semantics |
| `packages/ingest/src/eval/golden.ts` | modify | add 8 hard recall cases from the eval |
| `packages/core/src/ledger/jev.ts` | create | Jev client for core + `judgeScopeRelations()` pre-pass |
| `packages/core/src/ledger/embeddings.ts` | modify | extract `gatherScopeMates()` so both pre-passes share one read |
| `packages/core/src/ledger/ledger-service.ts` | modify | scope scan consults Jev relations before cosine/Jaccard; `similarity.method` gains `"jev"` |
| `packages/core/src/ledger/fusion-jev.e2e.test.ts` | create | injected fake judge: fuse, supersede, unrelated, low-confidence fall-through, null ⇒ unchanged |
| `packages/core/src/env.ts` | modify | `TYPESAFE_API_KEY` optional |
| `.env.example`, `DEPLOY.md`, `CHANGELOG.md`, `packages/ingest/src/index.ts` (header comment) | modify | document the new env var |

---

### Task 1: Jev client for the ingest worker

**Files:**
- Create: `packages/ingest/src/distill/jev.ts`
- Test: `packages/ingest/src/distill/jev.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type JevQuestion =
    | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
    | { type: "choice"; instructions: string; criteria: Record<string, string> };
  export type JevAnswer =
    | { type: "noul"; noul: number }
    | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };
  export function jevEnabled(): boolean;
  export async function systemOne(state: unknown, questions: Record<string, JevQuestion>): Promise<Record<string, JevAnswer> | null>;
  ```

- [ ] **Step 1: Write the failing test**

`packages/ingest/src/distill/jev.test.ts`:
```ts
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { systemOne, jevEnabled } from "./jev.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.TYPESAFE_API_KEY;
});

test("systemOne: null without a key, and no HTTP", async () => {
  delete process.env.TYPESAFE_API_KEY;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  assert.equal(jevEnabled(), false);
  assert.equal(await systemOne("x", { q: { type: "noul", instructions: "?" } }), null);
  assert.equal(called, false);
});

test("systemOne: posts state+questions with bearer auth and returns answers", async () => {
  process.env.TYPESAFE_API_KEY = "k";
  let seen: { url: string; auth: string; body: unknown } | undefined;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen = {
      url: String(url),
      auth: String((init?.headers as Record<string, string>).authorization),
      body: JSON.parse(String(init?.body)),
    };
    return new Response(
      JSON.stringify({ model: "jev-latest", answers: { d: { type: "noul", noul: 0.91 } }, usage: { input_tokens: 1, output_tokens: 1 } }),
      { status: 200 },
    );
  }) as typeof fetch;
  const out = await systemOne({ thread: ["hi"] }, { d: { type: "noul", instructions: "decision?" } });
  assert.equal(jevEnabled(), true);
  assert.equal(seen!.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(seen!.auth, "Bearer k");
  assert.deepEqual((seen!.body as { state: unknown }).state, { thread: ["hi"] });
  assert.equal((seen!.body as { model: string }).model, "jev-latest");
  assert.deepEqual(out, { d: { type: "noul", noul: 0.91 } });
});

test("systemOne: null on non-2xx and on malformed body; retries once on 429", async () => {
  process.env.TYPESAFE_API_KEY = "k";
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("{}", { status: calls === 1 ? 429 : 500 });
  }) as typeof fetch;
  assert.equal(await systemOne("x", { q: { type: "noul", instructions: "?" } }), null);
  assert.equal(calls, 2, "one retry after 429, then gave up on 500");

  globalThis.fetch = (async () => new Response(JSON.stringify({ nope: true }), { status: 200 })) as typeof fetch;
  assert.equal(await systemOne("x", { q: { type: "noul", instructions: "?" } }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ingest && node --import tsx --test src/distill/jev.test.ts`
Expected: FAIL — `Cannot find module './jev.js'`

- [ ] **Step 3: Write the client**

`packages/ingest/src/distill/jev.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/ingest && node --import tsx --test src/distill/jev.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/ingest/src/distill/jev.ts packages/ingest/src/distill/jev.test.ts
git commit -m "feat(ingest): Jev (Typesafe System One) client — null-on-failure judgment calls

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Jev-first recall for threads and PRD sections

**Files:**
- Modify: `packages/ingest/src/distill/recall.ts`
- Test: `packages/ingest/src/distill/recall.test.ts`

**Interfaces:**
- Consumes: `systemOne`, `jevEnabled` from Task 1.
- Produces (signatures unchanged, so `funnel.ts`, `docFunnel.ts`, `events.ts`, `eval/run.ts` need no edits):
  ```ts
  export const JEV_RECALL_FLOOR = 0.3;
  export async function jevRecall(text: string): Promise<boolean | null>;
  export async function jevRecallDoc(text: string): Promise<boolean | null>;
  export async function recall(text: string, useHaiku = true): Promise<boolean>;
  export async function recallDoc(text: string, useHaiku = true): Promise<boolean>;
  ```

Design note: when Jev is available the keyword prefilter is **skipped**. The eval showed the marker list is the real recall ceiling (a decision with no marker words was found by Jev at 0.90). Every unit therefore costs one Jev call (~400 tokens, ~0.4 s), which is the intended trade. `useHaiku=false` (`--no-haiku`) still means "no Anthropic recall call"; Jev, being the cheap tier, is used whenever configured.

- [ ] **Step 1: Write the failing test**

`packages/ingest/src/distill/recall.test.ts`:
```ts
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { recall, recallDoc, jevRecall, JEV_RECALL_FLOOR, keywordPrefilter } from "./recall.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.TYPESAFE_API_KEY;
});

function jevReturning(noul: number): void {
  process.env.TYPESAFE_API_KEY = "k";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ answers: { d: { type: "noul", noul } } }), { status: 200 })) as typeof fetch;
}

test("jevRecall: floor is recall-tuned (0.3), and null without a key", async () => {
  assert.equal(JEV_RECALL_FLOOR, 0.3);
  jevReturning(0.31);
  assert.equal(await jevRecall("anything"), true);
  jevReturning(0.29);
  assert.equal(await jevRecall("anything"), false);
  delete process.env.TYPESAFE_API_KEY;
  assert.equal(await jevRecall("anything"), null);
});

test("recall: with Jev, a decision carrying NO marker words survives (the keyword ceiling is gone)", async () => {
  const noMarkers = "@dev: new fields on the Order response are additive only, nobody removes a field without a v2 path.\n@priya: yep.";
  assert.equal(keywordPrefilter(noMarkers), false, "sanity: the old prefilter would drop this");
  jevReturning(0.9);
  assert.equal(await recall(noMarkers, false), true);
});

test("recall: without Jev, the keyword path runs unchanged (useHaiku=false ⇒ prefilter only)", async () => {
  delete process.env.TYPESAFE_API_KEY;
  assert.equal(await recall("we decided: JWT", false), true);
  assert.equal(await recall("lunch?", false), false);
});

test("recall: a Jev outage falls back to the keyword path, never throws", async () => {
  process.env.TYPESAFE_API_KEY = "k";
  globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
  assert.equal(await recall("we decided: JWT", false), true);
  assert.equal(await recall("lunch?", false), false);
});

test("recallDoc: Jev-first with the same floor and fallback", async () => {
  jevReturning(0.8);
  assert.equal(await recallDoc("Guests can pay as guests.", false), true);
  delete process.env.TYPESAFE_API_KEY;
  assert.equal(await recallDoc("Guests must be able to check out.", false), true);
  assert.equal(await recallDoc("Persona: Riya, 28.", false), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ingest && node --import tsx --test src/distill/recall.test.ts`
Expected: FAIL — `jevRecall` / `JEV_RECALL_FLOOR` not exported

- [ ] **Step 3: Implement**

In `packages/ingest/src/distill/recall.ts`, add after the imports:
```ts
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
          false: "Chatter, status update, one-off task, open debate, scheduling, a question answered with a fact, or a joke",
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
```

Replace the existing `recall` function body:
```ts
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
```

Replace the existing `recallDoc` function body:
```ts
/** Stage 1 combined for docs — same Jev-first shape as recall(). */
export async function recallDoc(text: string, useHaiku = true): Promise<boolean> {
  const jev = await jevRecallDoc(text);
  if (jev !== null) return jev;
  if (!keywordPrefilterDoc(text)) return false;
  if (!useHaiku) return true;
  return haikuRecallDoc(text);
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/ingest && node --import tsx --test src/distill/recall.test.ts src/funnel.test.ts src/docFunnel.test.ts`
Expected: PASS. The funnel tests inject `recallFn`, so they are unaffected.

- [ ] **Step 5: Commit**

```bash
git add packages/ingest/src/distill/recall.ts packages/ingest/src/distill/recall.test.ts
git commit -m "feat(ingest): Jev-first recall for threads and PRD sections, keyword→Haiku fallback

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Jev recheck replaces the Opus second pass

**Files:**
- Modify: `packages/ingest/src/distill/extract.ts:70-81`
- Test: `packages/ingest/src/distill/extract-recheck.test.ts`

**Interfaces:**
- Consumes: `systemOne` from Task 1; `Extraction` from `./rubric.js`.
- Produces:
  ```ts
  export const RECHECK_LOW = 0.35;
  export const RECHECK_HIGH = 0.6;
  export function applyJevRecheck(first: Extraction, jev: { is_decision: number; agreement: number }): Extraction;
  export async function jevRecheck(text: string): Promise<{ is_decision: number; agreement: number } | null>;
  ```

Design note: the gate (`gate.ts`) reads only `is_decision`, `confidence ≥ 0.5`, `finality === "agreed"`, `rule_text`, `evidence`. So the merge is: `confidence := p(is_decision)`; if `p(agreement) < 0.5` set `finality = "proposed"` so the gate routes it to `question`; if `p(is_decision) < 0.5` set `is_decision = false`. Sonnet's `rule_text`, `evidence`, and the rest are kept verbatim.

- [ ] **Step 1: Write the failing test**

`packages/ingest/src/distill/extract-recheck.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyJevRecheck, RECHECK_LOW, RECHECK_HIGH } from "./extract.js";
import { gate } from "./gate.js";
import type { Extraction } from "./rubric.js";

function ex(over: Partial<Extraction>): Extraction {
  return {
    is_decision: true,
    decision_type: "rule",
    finality: "agreed",
    rule_text: "Auth tokens are JWT.",
    rationale: "",
    alternatives_considered: [],
    decided_by: [],
    scope_hint: "auth",
    surface_candidates: [],
    review_hint: "",
    confidence: 0.45,
    evidence: [{ externalId: "x", quote: "JWT it is" }],
    ...over,
  };
}

test("recheck band is unchanged from the Opus era", () => {
  assert.equal(RECHECK_LOW, 0.35);
  assert.equal(RECHECK_HIGH, 0.6);
});

test("applyJevRecheck: confident yes lifts a borderline Sonnet read to propose, keeping its text", () => {
  const out = applyJevRecheck(ex({ confidence: 0.45 }), { is_decision: 0.92, agreement: 0.95 });
  assert.equal(out.confidence, 0.92);
  assert.equal(out.rule_text, "Auth tokens are JWT.");
  assert.equal(out.finality, "agreed");
  assert.equal(gate(out), "propose");
});

test("applyJevRecheck: not agreed ⇒ finality proposed ⇒ gate routes to question", () => {
  const out = applyJevRecheck(ex({ confidence: 0.5 }), { is_decision: 0.8, agreement: 0.2 });
  assert.equal(out.finality, "proposed");
  assert.equal(gate(out), "question");
});

test("applyJevRecheck: confident no ⇒ is_decision false ⇒ discard", () => {
  const out = applyJevRecheck(ex({ confidence: 0.5 }), { is_decision: 0.1, agreement: 0.9 });
  assert.equal(out.is_decision, false);
  assert.equal(out.confidence, 0.1);
  assert.equal(gate(out), "discard");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ingest && node --import tsx --test src/distill/extract-recheck.test.ts`
Expected: FAIL — `applyJevRecheck` not exported

- [ ] **Step 3: Implement**

In `packages/ingest/src/distill/extract.ts`, add to the imports:
```ts
import { systemOne } from "./jev.js";
```

Replace the `extract` function and its doc comment (lines 70–81) with:
```ts
/** Borderline band that triggers a second opinion — unchanged from the Opus-recheck era. */
export const RECHECK_LOW = 0.35;
export const RECHECK_HIGH = 0.6;

/**
 * Jev second opinion on a borderline Sonnet extraction: two calibrated Nouls on the raw text.
 * Null when Jev is unavailable (caller falls back to the Opus re-extraction).
 */
export async function jevRecheck(text: string): Promise<{ is_decision: number; agreement: number } | null> {
  const a = await systemOne(
    { thread: text.slice(0, 12000) },
    {
      is_decision: {
        type: "noul",
        instructions:
          "Does this thread contain a durable engineering decision — a rule or architectural choice that constrains future work beyond the task at hand, chosen among alternatives, restatable as one imperative rule?",
      },
      agreement: {
        type: "noul",
        instructions: "Was the matter actually CONCLUDED by the team, rather than still being debated, deferred, or reverted within the thread?",
      },
    },
  );
  const d = a?.is_decision;
  const g = a?.agreement;
  if (!d || d.type !== "noul" || !g || g.type !== "noul") return null;
  return { is_decision: d.noul, agreement: g.noul };
}

/**
 * Merge Jev's calibrated read into Sonnet's extraction. Pure. Sonnet's rule_text/evidence are kept;
 * only the fields the gate branches on move: confidence ← p(is_decision); finality ← "proposed" when
 * not agreed (gate ⇒ question); is_decision ← false when p(is_decision) < 0.5 (gate ⇒ discard).
 */
export function applyJevRecheck(first: Extraction, jev: { is_decision: number; agreement: number }): Extraction {
  return {
    ...first,
    confidence: jev.is_decision,
    is_decision: jev.is_decision >= 0.5 ? first.is_decision : false,
    finality: jev.agreement < 0.5 ? "proposed" : first.finality,
  };
}

/**
 * Stage 2 (synchronous) — structured extraction (Sonnet). On borderline confidence, a Jev second
 * opinion (two Nouls, ~400 tokens); when Jev is unavailable, the Opus re-extraction as before.
 * The rubric system block is prompt-cached so repeated threads reuse it at ~0.1x.
 */
export async function extract(externalId: string, text: string): Promise<Extraction> {
  const first = await callModel(MODELS.extract, externalId, text);
  if (first.is_decision && first.confidence >= RECHECK_LOW && first.confidence < RECHECK_HIGH) {
    const jev = await jevRecheck(text);
    if (jev) return applyJevRecheck(first, jev);
    const second = await callModel(MODELS.recheck, externalId, text);
    return second.confidence >= first.confidence ? second : first;
  }
  return first;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd packages/ingest && node --import tsx --test src/distill/extract-recheck.test.ts && npm run typecheck`
Expected: PASS, no type errors

- [ ] **Step 5: Commit**

```bash
git add packages/ingest/src/distill/extract.ts packages/ingest/src/distill/extract-recheck.test.ts
git commit -m "feat(ingest): Jev second opinion replaces the Opus recheck on borderline extractions

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Grow the golden set with the eval's hard cases

**Files:**
- Modify: `packages/ingest/src/eval/golden.ts`

The eval harness `packages/ingest/src/eval/run.ts` already runs `recall → extract → gate` over `GOLDEN`. With `TYPESAFE_API_KEY` set it now exercises the Jev path automatically; unset, the old path. No harness change needed.

- [ ] **Step 1: Append cases**

Add before the closing `];` of `GOLDEN` in `packages/ingest/src/eval/golden.ts`:
```ts
  // ── 2026-09-18 Jev eval — cases the keyword prefilter or a token-matching filter gets wrong ──
  {
    id: "no-marker-words",
    label: "decision",
    text: "@dev: the mobile crashes were the enum. new fields on the Order response are additive only, nobody removes or renames a field without a v2 path.\n@priya: yep. that's how it is now.\n@arjun: ack, noting it in the api guide",
  },
  {
    id: "manager-decree",
    label: "decision",
    text: "@cto: Effective immediately all customer PII columns are encrypted at rest with the KMS key per tenant. No exceptions. Details in the security doc.\n@dev: 👀\n@arjun: 👍",
  },
  {
    id: "hinglish-final",
    label: "decision",
    text: "@priya: toh final: sab payment calls billing-service ke through hi jayenge, direct Stripe SDK kahin nahi. theek?\n@dev: haan done, agreed\n@arjun: ok, removing the direct calls from checkout",
  },
  {
    id: "sarcastic-locked-in",
    label: "not",
    text: "@dev: great, so we've 'locked in' that the build breaks every friday\n@arjun: it's a standard at this point\n@priya: 💀",
  },
  {
    id: "reverted-in-thread",
    label: "not",
    text: "@priya: let's go with Redis for the rate limiter, agreed?\n@dev: agreed\n@arjun: wait, infra says no new managed services this quarter\n@priya: ugh ok scrap that, back to the drawing board",
  },
  {
    id: "personal-not-team",
    label: "not",
    text: "@dev: I've decided I'm going to use vim for the rest of the sprint\n@arjun: bold\n@priya: report back",
  },
  {
    id: "standup-time",
    label: "not",
    text: "@priya: we decided to push standup to 10:30 tomorrow\n@dev: agreed, works for me\n@arjun: 👍",
  },
  {
    id: "fact-not-decision",
    label: "not",
    text: "@dev: what's our token expiry?\n@arjun: 15 min, it's in the auth ADR\n@dev: cool thanks",
  },
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/ingest && npm run typecheck`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add packages/ingest/src/eval/golden.ts
git commit -m "test(ingest): golden set — 8 hard recall cases from the Jev eval

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Share the scope-mate read between the Voyage and Jev pre-passes

**Files:**
- Modify: `packages/core/src/ledger/embeddings.ts:110-170` (`prepareScopeSimilarity`)
- Test: existing `packages/core/src/ledger/fusion-embed.e2e.test.ts` must still pass (needs Postgres: `docker compose up -d postgres` and `DATABASE_URL` as in `.env.example`)

**Interfaces:**
- Produces:
  ```ts
  export interface ScopeMate { id: string; version: number; ruleText: string; status: string; origin: string }
  export async function gatherScopeMates(
    orgId: string,
    input: { projectId: string; scopeRef: string; dedupe?: { connectionId: string; externalId: string; contentHash: string } },
  ): Promise<{ mates: ScopeMate[]; cached: (typeof decisionEmbeddings.$inferSelect)[] } | null>;
  ```
  `null` ⇒ the unit was already seen (dedupe short-circuit).

- [ ] **Step 1: Extract the read-only gather**

In `packages/core/src/ledger/embeddings.ts`, add above `prepareScopeSimilarity`:
```ts
export interface ScopeMate {
  id: string;
  version: number;
  ruleText: string;
  status: string;
  origin: string;
}

/**
 * Read-only gather shared by the similarity pre-passes (Voyage cosine, Jev relations): dedupe
 * short-circuit (null ⇒ re-seen unit, spend nothing), live scope-mates with their current ruleText,
 * and any cached embedding rows. Runs in its own read tx; callers do HTTP OUTSIDE it.
 */
export async function gatherScopeMates(
  orgId: string,
  input: {
    projectId: string;
    scopeRef: string;
    dedupe?: { connectionId: string; externalId: string; contentHash: string };
  },
): Promise<{ mates: ScopeMate[]; cached: (typeof decisionEmbeddings.$inferSelect)[] } | null> {
  return withOrg(orgId, async (tx) => {
    if (input.dedupe) {
      const seen = (
        await tx
          .select({ id: ingestArtifacts.id })
          .from(ingestArtifacts)
          .where(
            and(
              eq(ingestArtifacts.connectionId, input.dedupe.connectionId),
              eq(ingestArtifacts.externalId, input.dedupe.externalId),
              eq(ingestArtifacts.contentHash, input.dedupe.contentHash),
            ),
          )
          .limit(1)
      )[0];
      if (seen) return null;
    }
    const live = (
      await tx
        .select()
        .from(decisions)
        .where(and(eq(decisions.projectId, input.projectId), eq(decisions.scopeRef, input.scopeRef)))
    ).filter((m) => m.status !== "rejected" && m.status !== "superseded");
    if (live.length === 0) return { mates: [], cached: [] };
    const mates: ScopeMate[] = [];
    for (const m of live) {
      const v = (
        await tx
          .select({ ruleText: decisionVersions.ruleText })
          .from(decisionVersions)
          .where(and(eq(decisionVersions.decisionId, m.id), eq(decisionVersions.version, m.currentVersion)))
          .limit(1)
      )[0];
      mates.push({ id: m.id, version: m.currentVersion, ruleText: v?.ruleText ?? "", status: m.status, origin: m.origin });
    }
    const cached = await tx
      .select()
      .from(decisionEmbeddings)
      .where(
        inArray(
          decisionEmbeddings.decisionId,
          mates.map((r) => r.id),
        ),
      );
    return { mates, cached };
  });
}
```

Then in `prepareScopeSimilarity`, replace everything from `// 1) read-only:` through `if (gathered.mates.length === 0) return new Map();` with:
```ts
  // 1) read-only: dedupe short-circuit + scope-mates + their current ruleTexts + cached vectors.
  const gathered = await gatherScopeMates(orgId, input);
  if (gathered === null) return null; // deduped — no scoring needed
  if (gathered.mates.length === 0) return new Map();
```
The rest of the function is unchanged (it reads `gathered.mates[i].id/version/ruleText` and `gathered.cached`, which the new shape still provides).

- [ ] **Step 2: Typecheck and run the existing fusion tests**

Run: `cd packages/core && npm run typecheck && node --import tsx --test --test-concurrency=1 src/ledger/fusion-embed.e2e.test.ts`
Expected: PASS, behavior unchanged (pure refactor)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/ledger/embeddings.ts
git commit -m "refactor(core): gatherScopeMates — shared read-only pre-pass for scope similarity

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Jev relation judgment in the fusion/supersession scan

**Files:**
- Create: `packages/core/src/ledger/jev.ts`
- Modify: `packages/core/src/env.ts:36-38` (add key)
- Modify: `packages/core/src/ledger/ledger-service.ts:30` (import), `:667-673` (signature), `:721-748` (scan loop)
- Test: `packages/core/src/ledger/fusion-jev.e2e.test.ts`

**Interfaces:**
- Consumes: `gatherScopeMates` from Task 5.
- Produces:
  ```ts
  export type Relation = "same_rule" | "replaces" | "unrelated";
  export interface RelationVerdict { relation: Relation; confidence: number }
  export type ScopeJudge = (newRule: string, mates: Array<{ id: string; ruleText: string }>) => Promise<Map<string, RelationVerdict> | null>;
  export const JEV_RELATION_MIN_CONF = 0.8;
  export const judgeWithJev: ScopeJudge;
  export async function judgeScopeRelations(orgId, input, judge?: ScopeJudge): Promise<Map<string, RelationVerdict> | null>;
  ```
- `fileProposedDecision(orgId, input, embedder = embedTexts, judge: ScopeJudge = judgeWithJev)` — fourth optional parameter; both existing callers (`api/routes/ingest.ts:64`, `documents/document-service.ts:727`) pass nothing and are unchanged.

Design note: one Jev request per incoming decision carries one `choice` question per live scope-mate (question key = mate id; ≤ 10 mates in practice, the doc allows many parallel questions). A verdict is acted on only when `confidence ≥ 0.8` (eval: every correct Choice had ≥ 0.83). Below that, or when Jev is null, the mate falls through to the existing cosine/Jaccard comparison, so no behavior is lost.

- [ ] **Step 1: Write the failing e2e test**

`packages/core/src/ledger/fusion-jev.e2e.test.ts` (copy the `setup()` helper and imports from `fusion-embed.e2e.test.ts` lines 1–40 verbatim, then):
```ts
import { fileProposedDecision, confirmDecision } from "./ledger-service.js";
import { JEV_RELATION_MIN_CONF, judgeWithJev, type ScopeJudge } from "./jev.js";

/** Fake judge keyed on rule text — no network. */
const judge =
  (verdict: (mateText: string) => { relation: "same_rule" | "replaces" | "unrelated"; confidence: number }): ScopeJudge =>
  async (_newRule, mates) =>
    new Map(mates.map((m) => [m.id, verdict(m.ruleText)]));

const fileWith = (
  s: { orgId: string; projectId: string },
  ruleText: string,
  j: ScopeJudge | undefined,
) =>
  fileProposedDecision(
    s.orgId,
    {
      projectId: s.projectId,
      scopeKind: "surface",
      scopeRef: "http:POST /jev/auth",
      ruleText,
      provenance: { source: "slack", evidence: [{ externalId: "x", quote: "q" }] },
      connectionId: randomUUID(),
      externalId: randomUUID(),
      contentHash: randomUUID(),
      confidence: 80,
    },
    undefined,
    j,
  );

test("judgeWithJev returns null without a key (wholesale fall-through)", async () => {
  assert.equal(process.env.TYPESAFE_API_KEY, undefined, "test env must not carry a key");
  assert.equal(await judgeWithJev("a", [{ id: "1", ruleText: "b" }]), null);
});

test("same_rule at high confidence fuses a zero-overlap paraphrase; audit records method=jev", async () => {
  const s = await setup();
  const first = await fileWith(s, "Auth tokens are JWT with 15-minute expiry.", judge(() => ({ relation: "unrelated", confidence: 1 })));
  const second = await fileWith(s, "Use JSON Web Tokens that lapse after a quarter hour.", judge(() => ({ relation: "same_rule", confidence: 0.99 })));
  assert.equal(second.fused, true);
  assert.equal(second.decisionId, first.decisionId);
  const audit = await withOrg(s.orgId, (tx) =>
    tx
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, first.decisionId), eq(auditEvents.action, "decision.provenance_added"))),
  );
  const payload = one(audit).payload as { similarity?: { method: string; score: number } };
  assert.equal(payload.similarity?.method, "jev");
  assert.equal(payload.similarity?.score, 0.99);
});

test("replaces on a binding mate yields a supersedes hint even when Jaccard overlap is high", async () => {
  const s = await setup();
  const first = await fileWith(s, "Auth tokens are JWT with 15-minute expiry.", judge(() => ({ relation: "unrelated", confidence: 1 })));
  await confirmDecision(s.orgId, first.decisionId, s.memberId); // impact 0 → binding
  // Jaccard between these two is well above 0.4 (shared: auth, tokens, expiry), so the old path would
  // NOT hint supersession. Jev sees the flip.
  const second = await fileWith(s, "Auth tokens are opaque; JWT expiry rules no longer apply.", judge(() => ({ relation: "replaces", confidence: 0.97 })));
  assert.equal(second.fused, false);
  assert.equal(second.supersedes, first.decisionId);
});

test("unrelated at high confidence files a separate decision even when Jaccard would fuse", async () => {
  const s = await setup();
  const first = await fileWith(s, "Auth tokens are JWT with 15-minute expiry.", judge(() => ({ relation: "unrelated", confidence: 1 })));
  const second = await fileWith(s, "Auth refresh tokens are JWT with 15-day expiry.", judge(() => ({ relation: "unrelated", confidence: 0.95 })));
  assert.equal(second.fused, false);
  assert.notEqual(second.decisionId, first.decisionId);
});

test("a low-confidence verdict falls through to the lexical path (same rule text ⇒ Jaccard fuses)", async () => {
  assert.equal(JEV_RELATION_MIN_CONF, 0.8);
  const s = await setup();
  const first = await fileWith(s, "Auth tokens are JWT with 15-minute expiry.", judge(() => ({ relation: "unrelated", confidence: 1 })));
  const second = await fileWith(s, "Auth tokens are JWT with 15-minute expiry.", judge(() => ({ relation: "unrelated", confidence: 0.5 })));
  assert.equal(second.fused, true, "Jev abstained (conf < 0.8); Jaccard 1.0 fused it");
  assert.equal(second.decisionId, first.decisionId);
});

test("a null judge is byte-identical to the pre-Jev behavior", async () => {
  const s = await setup();
  const nullJudge: ScopeJudge = async () => null;
  const a = await fileWith(s, "Auth tokens are JWT with 15-minute expiry.", nullJudge);
  const b = await fileWith(s, "Use JSON Web Tokens that lapse after a quarter hour.", nullJudge);
  assert.equal(b.fused, false, "Jaccard cannot see the paraphrase");
  assert.notEqual(a.decisionId, b.decisionId);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && node --import tsx --test --test-concurrency=1 src/ledger/fusion-jev.e2e.test.ts`
Expected: FAIL — `Cannot find module './jev.js'`

- [ ] **Step 3: Add the env var**

In `packages/core/src/env.ts`, after the `VOYAGE_API_KEY` line:
```ts
  // Jev (Typesafe System One) — calibrated same_rule/replaces/unrelated verdicts in the fusion scan.
  // Optional — unset means the embedding/Jaccard path runs exactly as before.
  TYPESAFE_API_KEY: z.string().optional(),
```

- [ ] **Step 4: Write the core Jev module**

`packages/core/src/ledger/jev.ts`:
```ts
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
  replaces: "They govern the same thing but the new one changes or contradicts the existing rule; the new one supersedes it",
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
  const state = { new_decision: newRule, existing_decisions: existing, note: "All decisions are scoped to the same area of the system." };
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
```

- [ ] **Step 5: Wire it into the scan**

In `packages/core/src/ledger/ledger-service.ts`:

Add import after line 30:
```ts
import { judgeScopeRelations, judgeWithJev, JEV_RELATION_MIN_CONF, type ScopeJudge } from "./jev.js";
```

Change the signature at line 667–671:
```ts
export async function fileProposedDecision(
  orgId: string,
  input: FileProposedInput,
  embedder: Embedder = embedTexts,
  judge: ScopeJudge = judgeWithJev,
): Promise<{ decisionId: string; deduped: boolean; fused: boolean; supersedes?: string }> {
```

After the `embedScores` pre-pass (ends around line 685), add:
```ts
  // Jev pre-pass — same_rule/replaces/unrelated per mate, also OUTSIDE the tx. Null ⇒ the scan below
  // uses cosine/Jaccard for every mate, exactly as before.
  const relations = await judgeScopeRelations(
    orgId,
    {
      projectId: input.projectId,
      scopeRef: input.scopeRef,
      ruleText: input.ruleText,
      dedupe: { connectionId: input.connectionId, externalId: input.externalId, contentHash: input.contentHash },
    },
    judge,
  );
```

Replace the scan loop body (the block starting `let similarity: …` through the closing `}` of `for (const m of scopeMates)`) with:
```ts
    // Per-mate signal, in order of trust: a confident Jev relation verdict; else embedding cosine when
    // the pre-pass scored this mate; else Jaccard (no key, outage, or a mate created after the
    // pre-pass — race-safe). Method + score land in the audits so thresholds are tuned from data.
    let similarity: { method: "jev" | "embedding" | "jaccard"; score: number } | undefined;
    for (const m of scopeMates) {
      if (m.status === "rejected" || m.status === "superseded") continue;
      if (origin === "document" && m.origin !== "document") continue;

      const verdict = relations?.get(m.id);
      if (verdict && verdict.confidence >= JEV_RELATION_MIN_CONF) {
        if (verdict.relation === "same_rule") {
          fuseInto = m.id;
          similarity = { method: "jev", score: verdict.confidence };
          break;
        }
        if (verdict.relation === "replaces" && origin !== "document" && m.status === "binding") {
          supersedes = m.id;
          similarity = { method: "jev", score: verdict.confidence };
        }
        continue; // confident unrelated / replaces-on-non-binding: nothing more to compare
      }

      const v = (
        await tx
          .select()
          .from(decisionVersions)
          .where(and(eq(decisionVersions.decisionId, m.id), eq(decisionVersions.version, m.currentVersion)))
          .limit(1)
      )[0];
      const emb = embedScores?.get(m.id);
      const method: "embedding" | "jaccard" = emb !== undefined ? "embedding" : "jaccard";
      const score = emb !== undefined ? emb : similar(input.ruleText, v?.ruleText ?? "");
      if (score >= (method === "embedding" ? EMBED_FUSE_MIN : 0.6)) {
        fuseInto = m.id;
        similarity = { method, score };
        break;
      }
      if (origin !== "document" && m.status === "binding" && score < (method === "embedding" ? EMBED_SUPERSEDE_MAX : 0.4)) {
        supersedes = m.id; // different rule, same scope → likely supersession
        similarity = { method, score };
      }
    }
```

- [ ] **Step 6: Typecheck, run the new and the old fusion tests**

Run: `cd packages/core && npm run typecheck && node --import tsx --test --test-concurrency=1 src/ledger/fusion-jev.e2e.test.ts src/ledger/fusion-embed.e2e.test.ts`
Expected: PASS for both files. The embed tests pass because `judgeWithJev` returns null without a key, so the loop reaches the cosine branch unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/ledger/jev.ts packages/core/src/ledger/ledger-service.ts packages/core/src/env.ts packages/core/src/ledger/fusion-jev.e2e.test.ts
git commit -m "feat(core): Jev relation verdicts (same_rule/replaces/unrelated) lead the fusion scan

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Document the env var

**Files:**
- Modify: `.env.example` (after the `ANTHROPIC_API_KEY` block)
- Modify: `DEPLOY.md:58` and `:76` (env tables)
- Modify: `CHANGELOG.md` under `## [Unreleased]`
- Modify: `packages/ingest/src/index.ts:24-25` (header comment `Env:` line)

- [ ] **Step 1: `.env.example`**

After the `ANTHROPIC_API_KEY=` line add:
```
# Typesafe Jev key (optional, worker + core). Worker: replaces the Haiku recall filter and the Opus
# borderline recheck with calibrated probabilities. Core: same_rule/replaces/unrelated verdicts lead
# the fusion scan. Unset = the pre-Jev paths run exactly as before.
TYPESAFE_API_KEY=
```

- [ ] **Step 2: `DEPLOY.md`**

Add a row next to the `ANTHROPIC_API_KEY` row in each table it appears in (lines 58 and 76). In the descriptive table:
```
  | `TYPESAFE_API_KEY` | optional — Jev judgments for recall/recheck (worker) and fusion (core) |
```
In the matrix table, mirror the `VOYAGE_API_KEY` row's column marks but tick both the core and the worker columns.

- [ ] **Step 3: `CHANGELOG.md`**

Under `## [Unreleased]` add:
```
### Added

- **Jev judgment stages** (optional, `TYPESAFE_API_KEY`) — Typesafe's System One model now makes the
  funnel's yes/no and pick-one calls: Stage-1 recall for threads and PRD sections (replaces the keyword
  prefilter + Haiku), the borderline-confidence recheck (replaces the Opus re-extraction), and
  `same_rule` / `replaces` / `unrelated` verdicts that lead the fusion/supersession scan ahead of cosine
  and Jaccard (`similarity.method: "jev"` in audits). Sonnet still writes `rule_text` and evidence. Unset
  key ⇒ every prior path runs unchanged.
```

- [ ] **Step 4: `packages/ingest/src/index.ts` header**

Change the `Env:` comment lines to:
```
 * Env: LOCKSTEP_API_URL, LOCKSTEP_INGEST_TOKEN, COMPOSIO_API_KEY, ANTHROPIC_API_KEY,
 *      TYPESAFE_API_KEY (optional — Jev recall/recheck; unset = keyword→Haiku, Opus recheck),
 *      SLACK_BOT_TOKEN (ratification digests — optional; digests stay queued without it).
```

- [ ] **Step 5: Format check and commit**

Run: `npm run format:check` (fix with `npm run format` if needed)
```bash
git add .env.example DEPLOY.md CHANGELOG.md packages/ingest/src/index.ts
git commit -m "docs: TYPESAFE_API_KEY — Jev judgment stages, fallbacks, deploy matrix

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Verify end to end

- [ ] **Step 1: Full workspace checks**

Run from repo root: `npm run typecheck && npm run lint && npm test -w @lockstep/ingest`
Expected: clean. (`npm test -w @lockstep/core` needs Postgres; run it if `DATABASE_URL` is reachable.)

- [ ] **Step 2: Golden eval, both paths**

Run: `cd packages/ingest && npx tsx -e 'import("./src/eval/run.js").then(m => m.runEval())'` twice — once with `TYPESAFE_API_KEY` set (and `ANTHROPIC_API_KEY`, for Sonnet extraction), once with it unset.
Expected: with Jev, `recall ≥ 0.8` and no regression in precision versus the unset run; the eight new cases pass on the Jev run. Record both summary lines in the PR description.

- [ ] **Step 3: Rotate the key**

The key pasted in chat during the evaluation must be revoked in the Typesafe dashboard and a fresh one placed in the worker's and core's environment (Railway variables, or `.env` locally). Never commit it.

---

## Self-review

**Coverage.** Recall (threads, docs) → Task 2. Recheck → Task 3. Fusion/supersession → Tasks 5–6. Env/docs → Task 7. Eval evidence → Tasks 4 and 8. Deferred items are listed with reasons in the "Where Jev replaces what" section.

**Placeholders.** None: every code step carries the code.

**Type consistency.** `systemOne` / `JevAnswer` (Task 1) are consumed by Tasks 2–3 with the `type` discriminant checks shown. `gatherScopeMates` shape `{ mates: ScopeMate[]; cached }` (Task 5) is read by `prepareScopeSimilarity` fields `id/version/ruleText` and by `judgeScopeRelations` (Task 6). `ScopeJudge`, `RelationVerdict`, `JEV_RELATION_MIN_CONF`, `judgeWithJev` names match between `jev.ts`, `ledger-service.ts`, and the test. `similarity.method` union widened to include `"jev"` where it is declared.
