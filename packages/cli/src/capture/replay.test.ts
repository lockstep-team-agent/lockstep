import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReplay, type BriefingResp } from "./index.js";

const decisions = {
  decisions: [
    { scopeRef: "http:POST /auth/session", status: "binding", ruleText: "Sessions expire in 24h", impact: 3 },
    { scopeRef: "svc:orders", status: "binding", ruleText: "Orders are append-only", impact: 1 },
    { scopeRef: "svc:draft", status: "proposed", ruleText: "not binding — ignored", impact: 9 },
  ],
};

// The server pre-renders `line`; formatReplay only prefixes "  • " and interleaves by impact.
const briefing: BriefingResp = {
  constraints: [
    { line: "⚠ [ratified · PRD-142] Guest flow must not present OTP before payment (impact 5)", impact: 5, conflictOpen: false },
    { line: "⚠ [ratified · PRD-142] Checkout must accept guest orders (impact 3) · conflict open", impact: 3, conflictOpen: true },
  ],
  overflow: 0,
};

test("null briefing → output is byte-identical to the pre-Phase-B format", () => {
  const out = formatReplay(null, decisions, null);
  const expected = [
    "Lockstep:",
    "📌 2 binding decision(s) in effect:",
    "  • [impact 3] [http:POST /auth/session] Sessions expire in 24h",
    "  • [impact 1] [svc:orders] Orders are append-only",
  ].join("\n");
  assert.equal(out, expected);
  // absent briefing arg behaves the same as explicit null
  assert.equal(formatReplay(null, decisions), expected);
});

test("constraints interleave into the binding section, impact-desc", () => {
  const out = formatReplay(null, decisions, briefing);
  const lines = out.split("\n");
  assert.equal(lines[0], "Lockstep:");
  assert.equal(lines[1], "📌 4 binding decision(s) in effect:"); // 2 decisions + 2 constraints
  assert.deepEqual(lines.slice(2), [
    "  • ⚠ [ratified · PRD-142] Guest flow must not present OTP before payment (impact 5)", // impact 5
    "  • ⚠ [ratified · PRD-142] Checkout must accept guest orders (impact 3) · conflict open", // impact 3, tie → constraint first
    "  • [impact 3] [http:POST /auth/session] Sessions expire in 24h", // impact 3 decision, after the constraint
    "  • [impact 1] [svc:orders] Orders are append-only",
  ]);
});

test("on an impact tie, the constraint leads the plain decision", () => {
  const tied = {
    decisions: [{ scopeRef: "svc:x", status: "binding", ruleText: "plain", impact: 3 }],
  };
  const b: BriefingResp = {
    constraints: [{ line: "⚠ [ratified · PRD-9] constraint", impact: 3, conflictOpen: false }],
    overflow: 0,
  };
  const lines = formatReplay(null, tied, b).split("\n");
  assert.equal(lines[2], "  • ⚠ [ratified · PRD-9] constraint");
  assert.equal(lines[3], "  • [impact 3] [svc:x] plain");
});

test("overflow line appears only when overflow > 0", () => {
  const withOverflow: BriefingResp = { constraints: briefing.constraints, overflow: 7 };
  const out = formatReplay(null, decisions, withOverflow);
  assert.match(out, /\n {2}• \(\+7 product constraints in scope — get_product_context\)$/);
  // no overflow → no line
  assert.doesNotMatch(formatReplay(null, decisions, briefing), /product constraints in scope/);
});

test("constraints render even when there are no binding decisions", () => {
  const out = formatReplay(null, { decisions: [] }, briefing);
  const lines = out.split("\n");
  assert.equal(lines[1], "📌 2 binding decision(s) in effect:");
  assert.ok(lines[2]?.startsWith("  • ⚠ [ratified · PRD-142]"));
});

test("empty briefing (no constraints, overflow 0) leaves prior behavior intact", () => {
  const empty: BriefingResp = { constraints: [], overflow: 0 };
  assert.equal(formatReplay(null, decisions, empty), formatReplay(null, decisions, null));
});
