import { test } from "node:test";
import assert from "node:assert/strict";
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
    confidence: 0.9,
    evidence: [{ externalId: "x", quote: "JWT it is" }],
    ...over,
  };
}

test("gate: agreed, confident, with evidence → propose", () => {
  assert.equal(gate(ex({})), "propose");
});

test("gate: not a decision or low confidence → discard", () => {
  assert.equal(gate(ex({ is_decision: false })), "discard");
  assert.equal(gate(ex({ confidence: 0.3 })), "discard");
});

test("gate: decision but not agreed → question", () => {
  assert.equal(gate(ex({ finality: "proposed" })), "question");
  assert.equal(gate(ex({ finality: "reversed" })), "question");
});

test("gate: agreed but no rule text or no evidence → discard", () => {
  assert.equal(gate(ex({ rule_text: "  " })), "discard");
  assert.equal(gate(ex({ evidence: [] })), "discard");
});
