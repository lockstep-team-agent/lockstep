import { anthropic, MODELS } from "./llm.js";
import { RUBRIC_SYSTEM, EXTRACTION_SCHEMA, type Extraction } from "./rubric.js";

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

/** Request params for one extraction — shared by the sync call and the Batch API path. */
function buildParams(model: string, externalId: string, text: string): Record<string, unknown> {
  return {
    model,
    max_tokens: 1024,
    system: [{ type: "text", text: RUBRIC_SYSTEM, cache_control: { type: "ephemeral" } }],
    output_config: { format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
    messages: [{ role: "user", content: `Thread externalId: ${externalId}\n\n${text.slice(0, 12000)}` }],
  };
}

function parseExtraction(content: Array<{ type: string; text?: string }>): Extraction {
  const block = content.find((b) => b.type === "text");
  if (!block?.text) return EMPTY;
  try {
    return { ...EMPTY, ...(JSON.parse(block.text) as Extraction) };
  } catch {
    return EMPTY;
  }
}

async function callModel(model: string, externalId: string, text: string): Promise<Extraction> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await anthropic().messages.create(buildParams(model, externalId, text) as any);
  return parseExtraction(res.content);
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
 * Stage 2 (batch) — the 50%-cost path for scheduled sweeps. Submits all survivors as one Message
 * Batch, polls to completion, and returns extractions keyed by externalId. No Opus re-check in batch
 * mode (a follow-up sync pass can re-check borderline items if desired).
 */
export async function extractBatch(
  items: Array<{ externalId: string; text: string }>,
  opts: { pollMs?: number; maxWaitMs?: number } = {},
): Promise<Map<string, Extraction>> {
  const out = new Map<string, Extraction>();
  if (items.length === 0) return out;
  const client = anthropic();
  const idToExternal = new Map<string, string>();
  const requests = items.map((it, i) => {
    const custom_id = `u${i}`;
    idToExternal.set(custom_id, it.externalId);
    return { custom_id, params: buildParams(MODELS.extract, it.externalId, it.text) };
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
    out.set(ext, r.result?.type === "succeeded" ? parseExtraction(r.result.message.content) : EMPTY);
  }
  return out;
}
