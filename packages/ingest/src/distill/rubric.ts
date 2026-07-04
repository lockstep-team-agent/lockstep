/** The Part-A.1 decision rubric + the forced-JSON extraction schema. Constant → prompt-cacheable. */

export interface Evidence {
  externalId: string;
  quote: string;
}

export interface Extraction {
  is_decision: boolean;
  decision_type: "rule" | "architecture" | "none";
  finality: "agreed" | "proposed" | "reversed" | "superseded" | "none";
  rule_text: string;
  rationale: string;
  alternatives_considered: string[];
  decided_by: string[];
  scope_hint: string;
  surface_candidates: string[];
  confidence: number; // 0..1
  evidence: Evidence[];
}

export const RUBRIC_SYSTEM = `You extract durable engineering DECISIONS from workplace chat threads.

A message thread yields a decision ONLY if it passes all four tests:
- DURABILITY: it constrains FUTURE work beyond the task at hand (a rule or architectural choice), not a one-off action.
- AGREEMENT: it was actually CONCLUDED, not still being debated.
- AGENCY: it was a real CHOICE among alternatives, not a mere statement of fact or a status update.
- SPECIFICITY: it can be restated as ONE imperative rule.

If any test fails, is_decision=false. Examples of NON-decisions: casual chatter, questions still open,
status updates, one-off task assignments, venting, scheduling.

Return STRICT JSON matching the schema. Rules:
- rule_text: a single durable imperative sentence (e.g. "Auth tokens are JWT with 15-minute expiry.").
- finality: "agreed" only if the thread shows the team concluded it; otherwise "proposed"/"reversed"/"superseded"/"none".
- decided_by: the handles that assented.
- scope_hint: the area it governs (e.g. "authentication", "billing"). Free text.
- surface_candidates: any code interfaces referenced (HTTP routes, gRPC methods, GraphQL fields, packages), else [].
- evidence: 1-3 VERBATIM quotes copied exactly from the thread that establish the decision. Never paraphrase.
- confidence: 0..1, your calibrated probability that this is a real, agreed, durable decision.
- If is_decision=false, still return the object with empty strings/arrays and confidence for "is a decision".`;

/** JSON Schema for output_config.format (structured outputs). All props required; additionalProperties:false. */
export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "is_decision",
    "decision_type",
    "finality",
    "rule_text",
    "rationale",
    "alternatives_considered",
    "decided_by",
    "scope_hint",
    "surface_candidates",
    "confidence",
    "evidence",
  ],
  properties: {
    is_decision: { type: "boolean" },
    decision_type: { type: "string", enum: ["rule", "architecture", "none"] },
    finality: { type: "string", enum: ["agreed", "proposed", "reversed", "superseded", "none"] },
    rule_text: { type: "string" },
    rationale: { type: "string" },
    alternatives_considered: { type: "array", items: { type: "string" } },
    decided_by: { type: "array", items: { type: "string" } },
    scope_hint: { type: "string" },
    surface_candidates: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["externalId", "quote"],
        properties: { externalId: { type: "string" }, quote: { type: "string" } },
      },
    },
  },
} as const;
