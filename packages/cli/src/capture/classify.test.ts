import { test } from "node:test";
import assert from "node:assert/strict";
import { isContractSurface, riskTierFor } from "./classify.js";

test("detects OpenAPI / schema files as contract surfaces", () => {
  assert.ok(isContractSurface("api/openapi.yaml"));
  assert.ok(isContractSurface("schema.graphql"));
  assert.ok(isContractSurface("proto/orders.proto"));
});

test("detects route/controller paths", () => {
  assert.ok(isContractSurface("src/routes/orders.ts"));
  assert.ok(isContractSurface("app/controllers/cart.rb"));
});

test("a bare export is NOT a contract surface (noise fix)", () => {
  // The old heuristic flagged any `export` as shared, flooding the ledger. A plain exported helper
  // in a non-route file is no longer a contract surface.
  assert.ok(!isContractSurface("src/orders.ts", "export function createOrder() {}"));
  assert.ok(!isContractSurface("src/util.ts", "function localHelper() {}"));
});

test("detects an actual HTTP route by content", () => {
  assert.ok(isContractSurface("src/routes/orders.ts", "router.post('/orders', handler)"));
});

test("plain internal file is not a contract surface", () => {
  assert.ok(!isContractSurface("src/internal/helpers.go", "func helper() {}"));
});

test("riskTier biases to shared on contract surfaces", () => {
  assert.equal(riskTierFor({ anyContractSurface: true, allOwnedByMe: true }), "shared");
  assert.equal(riskTierFor({ anyContractSurface: false, allOwnedByMe: true }), "owned");
  assert.equal(riskTierFor({ anyContractSurface: false, allOwnedByMe: false }), "shared");
});
