import { anthropic, MODELS } from "./llm.js";
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

/**
 * Stage 2 (synchronous) — structured extraction (Sonnet), Opus re-check on borderline confidence.
 * The rubric system block is prompt-cached so repeated threads reuse it at ~0.1x.
 */
export async function extract(externalId: string, text: string): Promise<Extraction> {
  const first = await callModel(MODELS.extract, externalId, text);
  if (first.is_decision && first.confidence >= 0.35 && first.confidence < 0.6) {
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
