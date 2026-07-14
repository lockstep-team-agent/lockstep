import { test } from "node:test";
import assert from "node:assert/strict";
import { gate, gateDoc } from "./gate.js";
import type { Extraction } from "./rubric.js";
import type { DocExtraction } from "./rubric-doc.js";

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

function dx(over: Partial<DocExtraction>): DocExtraction {
  return {
    is_constraint: true,
    constraint_kind: "behavioral",
    rule_text: "Guests must be able to complete checkout without an account.",
    rationale: "",
    scope_hint: "guest checkout",
    surface_candidates: [],
    expires_hint: "",
    anchor_key: "blk-c1",
    confidence: 0.9,
    evidence: [{ externalId: "prd-142#blk-c1", quote: "Guests must be able" }],
    ...over,
  };
}

test("gateDoc: at/above the 0.7 floor → propose; the [0.5, 0.7) band → propose_low", () => {
  assert.equal(gateDoc(dx({})), "propose");
  assert.equal(gateDoc(dx({ confidence: 0.71 })), "propose");
  assert.equal(gateDoc(dx({ confidence: 0.7 })), "propose");
  assert.equal(gateDoc(dx({ confidence: 0.69 })), "propose_low");
  assert.equal(gateDoc(dx({ confidence: 0.5 })), "propose_low");
});

test("gateDoc: below the candidate floor, not a constraint, or kind none → discard", () => {
  assert.equal(gateDoc(dx({ confidence: 0.4 })), "discard");
  assert.equal(gateDoc(dx({ is_constraint: false })), "discard");
  assert.equal(gateDoc(dx({ constraint_kind: "none" })), "discard");
});

test("gateDoc: no rule text or no evidence → discard", () => {
  assert.equal(gateDoc(dx({ rule_text: "  " })), "discard");
  assert.equal(gateDoc(dx({ evidence: [] })), "discard");
});
