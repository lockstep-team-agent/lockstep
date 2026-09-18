import { anthropic, MODELS } from "./llm.js";
import { systemOne } from "./jev.js";
import { RUBRIC_SYSTEM, EXTRACTION_SCHEMA, type Extraction } from "./rubric.js";
import { DOC_RUBRIC_SYSTEM, DOC_EXTRACTION_SCHEMA, type DocExtraction } from "./rubric-doc.js";

const EMPTY: Extraction = {
  is_decision: false,
  decision_type: "none",
  finality: "none",
  rule_text: "",
  rationale: "",
  alternatives_considered: [],
  decided_by: [],
  scope_hint: "",
  surface_candidates: [],
  review_hint: "",
  confidence: 0,
  evidence: [],
};

const EMPTY_DOC: DocExtraction = {
  is_constraint: false,
  constraint_kind: "none",
  rule_text: "",
  rationale: "",
  scope_hint: "",
  surface_candidates: [],
  expires_hint: "",
  anchor_key: "",
  confidence: 0,
  evidence: [],
};

/**
 * Request params for one extraction — shared by the sync calls and the Batch API path. Defaults are the
 * conversation rubric; the doc paths pass the DOC_* system/schema and a "Section anchorKey" label.
 */
function buildParams(
  model: string,
  externalId: string,
  text: string,
  system: string = RUBRIC_SYSTEM,
  schema: unknown = EXTRACTION_SCHEMA,
  idLabel = "Thread externalId",
): Record<string, unknown> {
  return {
    model,
    max_tokens: 1024,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    output_config: { format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: `${idLabel}: ${externalId}\n\n${text.slice(0, 12000)}` }],
  };
}

function parseJson<T>(content: Array<{ type: string; text?: string }>, empty: T): T {
  const block = content.find((b) => b.type === "text");
  if (!block?.text) return empty;
  try {
    return { ...empty, ...(JSON.parse(block.text) as T) };
  } catch {
    return empty;
  }
}

async function callModel(model: string, externalId: string, text: string): Promise<Extraction> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await anthropic().messages.create(buildParams(model, externalId, text) as any);
  return parseJson(res.content, EMPTY);
}

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
        instructions:
          "Was the matter actually CONCLUDED by the team, rather than still being debated, deferred, or reverted within the thread?",
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

/**
 * Stage 2 for PRD sections — structured constraint extraction (Sonnet). No Opus re-check: the doc gate
 * keeps a [0.5, 0.7) propose_low band for humans instead of a second model pass. anchor_key is echoed
 * from the input deterministically, whatever the model returned.
 */
export async function extractDoc(anchorKey: string, text: string): Promise<DocExtraction> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await anthropic().messages.create(
    buildParams(MODELS.extract, anchorKey, text, DOC_RUBRIC_SYSTEM, DOC_EXTRACTION_SCHEMA, "Section anchorKey") as any,
  );
  return { ...parseJson(res.content, EMPTY_DOC), anchor_key: anchorKey };
}

/**
 * Batch plumbing shared by the conversation and doc paths — submits one Message Batch, polls to
 * completion, returns parsed results keyed by the caller's externalId.
 */
async function runBatch<T>(
  requestsIn: Array<{ externalId: string; params: Record<string, unknown> }>,
  empty: T,
  opts: { pollMs?: number; maxWaitMs?: number },
): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  if (requestsIn.length === 0) return out;
  const client = anthropic();
  const idToExternal = new Map<string, string>();
  const requests = requestsIn.map((it, i) => {
    const custom_id = `u${i}`;
    idToExternal.set(custom_id, it.externalId);
    return { custom_id, params: it.params };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const batch: any = await (client.messages.batches as any).create({ requests });
  const pollMs = opts.pollMs ?? 5000;
  const deadline = Date.now() + (opts.maxWaitMs ?? 60 * 60 * 1000);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = await (client.messages.batches as any).retrieve(batch.id);
    if (b.processing_status === "ended") break;
    if (Date.now() > deadline) throw new Error(`batch ${batch.id} did not finish before deadline`);
    await new Promise((r) => setTimeout(r, pollMs));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for await (const r of await (client.messages.batches as any).results(batch.id)) {
    const ext = idToExternal.get(r.custom_id);
    if (!ext) continue;
    out.set(ext, r.result?.type === "succeeded" ? parseJson(r.result.message.content, empty) : empty);
  }
  return out;
}

/**
 * Stage 2 (batch) — the 50%-cost path for scheduled sweeps. No Opus re-check in batch mode (a follow-up
 * sync pass can re-check borderline items if desired).
 */
export async function extractBatch(
  items: Array<{ externalId: string; text: string }>,
  opts: { pollMs?: number; maxWaitMs?: number } = {},
): Promise<Map<string, Extraction>> {
  return runBatch(
    items.map((it) => ({ externalId: it.externalId, params: buildParams(MODELS.extract, it.externalId, it.text) })),
    EMPTY,
    opts,
  );
}

/** Stage 2 for PRD sections (batch) — same plumbing, doc rubric/schema, keyed by anchorKey. */
export async function extractDocBatch(
  items: Array<{ anchorKey: string; text: string }>,
  opts: { pollMs?: number; maxWaitMs?: number } = {},
): Promise<Map<string, DocExtraction>> {
  const res = await runBatch(
    items.map((it) => ({
      externalId: it.anchorKey,
      params: buildParams(MODELS.extract, it.anchorKey, it.text, DOC_RUBRIC_SYSTEM, DOC_EXTRACTION_SCHEMA, "Section anchorKey"),
    })),
    EMPTY_DOC,
    opts,
  );
  for (const [k, v] of res) res.set(k, { ...v, anchor_key: k });
  return res;
}
