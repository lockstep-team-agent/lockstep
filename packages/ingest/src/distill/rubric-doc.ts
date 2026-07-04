/** The v3 product-constraint rubric + forced-JSON schema for PRD sections. Constant → prompt-cacheable. */

import type { Evidence } from "./rubric.js";

export interface DocExtraction {
  is_constraint: boolean;
  constraint_kind: "behavioral" | "launch_gate" | "scope_exclusion" | "none";
  rule_text: string;
  rationale: string;
  scope_hint: string;
  surface_candidates: string[];
  expires_hint: string; // verbatim from the text; empty if none
  anchor_key: string; // echoed from the input, unchanged
  confidence: number; // 0..1
  evidence: Evidence[];
}

export const DOC_RUBRIC_SYSTEM = `You extract binding PRODUCT CONSTRAINTS from PRD (product requirements document) sections.

A section yields a constraint ONLY if it passes all four tests:
- BINDING: it uses obligation/prohibition language ("must", "must not", "never", "required", "we will not"),
  NOT aspiration ("should ideally", "we hope", "later", "nice to have", "explore").
- FALSIFIABLE: an engineer or agent could point at an implementation and say it satisfies or violates this.
- DURABLE: it governs the build beyond this document's narrative — the product must keep obeying it.
- SELF-CONTAINED: it can be restated as ONE imperative sentence without the surrounding prose.

NEVER extract from: personas, user quotes, competitor analysis, mock/screenshot captions, open questions,
timelines or roadmap tables. Background metrics and research findings are context, not constraints.

Return STRICT JSON matching the schema. Rules:
- constraint_kind: "behavioral" (how the product must behave), "launch_gate" (a measurable bar that gates
  launch), "scope_exclusion" (something the product will NOT do), or "none".
- rule_text: a single imperative sentence (e.g. "Guests must be able to complete checkout without creating an account.").
- scope_hint: the feature area it governs (e.g. "guest checkout"). Free text.
- surface_candidates: any code interfaces referenced (HTTP routes, gRPC methods, GraphQL fields, packages), else [].
- expires_hint: when the constraint stops applying, VERBATIM from the text (e.g. "30 days post-launch", "2026-08-01");
  empty string if it never expires.
- anchor_key: echo the anchor key given in the input, unchanged.
- evidence: 1-3 VERBATIM quotes copied exactly from the section — they become anchor snippets. Never paraphrase.
- confidence: 0..1, your calibrated probability that this is a real, binding, durable product constraint.
- If is_constraint=false, still return the object with constraint_kind "none", empty strings/arrays, and
  confidence for "is a constraint".`;

/** JSON Schema for output_config.format (structured outputs). All props required; additionalProperties:false. */
export const DOC_EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "is_constraint",
    "constraint_kind",
    "rule_text",
    "rationale",
    "scope_hint",
    "surface_candidates",
    "expires_hint",
    "anchor_key",
    "confidence",
    "evidence",
  ],
  properties: {
    is_constraint: { type: "boolean" },
    constraint_kind: { type: "string", enum: ["behavioral", "launch_gate", "scope_exclusion", "none"] },
    rule_text: { type: "string" },
    rationale: { type: "string" },
    scope_hint: { type: "string" },
    surface_candidates: { type: "array", items: { type: "string" } },
    expires_hint: { type: "string" },
    anchor_key: { type: "string" },
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
