/**
 * Pure unit tests for the briefing token budget (PRD §14): constraints are capped at 15% of the
 * briefing budget, truncating lowest-impact-first, with an overflow count. No DB.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { capConstraints, constraintLine, estimateTokens, type ScopedConstraint } from "./ledger-service.js";

function mk(id: number, impact: number, ruleText = "x".repeat(80)): ScopedConstraint {
  return {
    id: `d${id}`,
    scopeKind: "surface",
    scopeRef: `http:POST /s${id}`,
    ruleText,
    constraintKind: "behavioral",
    status: "binding",
    impact,
    expiresAt: null,
    docId: "doc1",
    docTitle: "PRD-142",
    docUrl: "https://notion.so/x",
    docState: "active",
    anchorUrl: "https://notion.so/x#b",
    conflictOpen: false,
  };
}

test("estimateTokens: chars/4 ceiling", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
});

test("constraintLine: ratified prefix, impact, conflict suffix", () => {
  const c = mk(1, 3);
  assert.match(constraintLine(c), /^⚠ \[ratified · PRD-142\] .* \(impact 3\)$/);
  assert.match(constraintLine({ ...c, conflictOpen: true }), / · conflict open$/);
});

test("capConstraints: keeps highest-impact, truncates the rest, reports overflow", () => {
  // 40 constraints, each line ~ (24 prefix + 80 rule + tail) ≈ 120 chars ≈ 30 tokens. 15% of 2000 = 300
  // tokens ⇒ ~10 fit. They must be the highest-impact ones.
  const many = Array.from({ length: 40 }, (_, i) => mk(i, i)); // impact 0..39
  const sorted = [...many].sort((a, b) => b.impact - a.impact); // impact-desc (as constraintsInScope returns)
  const { shown, overflow } = capConstraints(sorted);
  assert.ok(shown.length > 0 && shown.length < 40, `expected a partial set, got ${shown.length}`);
  assert.equal(overflow, 40 - shown.length);
  // Highest impact survives; lowest is dropped.
  assert.equal(shown[0]!.impact, 39);
  assert.ok(shown.every((c) => c.impact >= sorted[shown.length - 1]!.impact));
});

test("capConstraints: always shows at least one even if it exceeds budget alone", () => {
  const huge = mk(1, 9, "y".repeat(5000));
  const { shown, overflow } = capConstraints([huge]);
  assert.equal(shown.length, 1);
  assert.equal(overflow, 0);
});

test("capConstraints: empty in, empty out", () => {
  const { shown, overflow } = capConstraints([]);
  assert.deepEqual(shown, []);
  assert.equal(overflow, 0);
});
