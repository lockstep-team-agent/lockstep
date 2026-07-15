/** The comment builder is pure — assert structure without any GitHub API. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildComment, backfillSuggestion, COMMENT_MARKER } from "./comment.mjs";

test("nothing to say → null (no comment posted)", () => {
  assert.equal(buildComment({ violations: [], conflictLines: [] }), null);
  assert.equal(buildComment({}), null);
});

test("violations render the marker, the surface, and a copy-paste propose_decision suggestion", () => {
  const body = buildComment({ violations: ["http:POST /payments/init"] });
  assert.ok(body.startsWith(COMMENT_MARKER), "marker first — the upsert key");
  assert.match(body, /missing binding decision\b/);
  assert.ok(body.includes("**`http:POST /payments/init`**"));
  assert.ok(body.includes('propose_decision with scopeKind "surface"'), "templated agent instruction");
  assert.ok(body.includes('scopeRef "http:POST /payments/init"'));
  assert.match(body, /rationale/, "the suggestion asks for the why (Phase J deliberation fields)");
  assert.ok(!body.includes("conflict"), "no conflict section when there are none");
});

test("conflicts render their own section; both sections coexist in one comment", () => {
  const body = buildComment({
    violations: ["http:GET /a"],
    conflictLines: ['- **http:GET /a** — constraint "x" vs "y" (conflict `c1`)'],
  });
  assert.match(body, /missing binding decision/);
  assert.match(body, /product-constraint conflict\b/);
  assert.ok(body.includes("Resolve in the Lockstep dashboard"));
  assert.ok(body.indexOf("missing binding decision") < body.indexOf("product-constraint conflict"));
});

test("plural headings for multiple items", () => {
  const body = buildComment({ violations: ["http:GET /a", "http:GET /b"] });
  assert.match(body, /missing binding decisions/);
});

test("backfillSuggestion names the surface twice (scopeRef + prose)", () => {
  const s = backfillSuggestion("proto:auth.v1.Auth/Login");
  assert.equal((s.match(/proto:auth\.v1\.Auth\/Login/g) ?? []).length, 2);
});
