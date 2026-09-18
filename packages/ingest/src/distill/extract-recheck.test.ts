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
