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

test("detects exported TS API by content", () => {
  assert.ok(isContractSurface("src/orders.ts", "export function createOrder() {}"));
  assert.ok(!isContractSurface("src/util.ts", "function localHelper() {}"));
});

test("plain internal file is not a contract surface", () => {
  assert.ok(!isContractSurface("src/internal/helpers.go", "func helper() {}"));
});

test("riskTier biases to shared on contract surfaces", () => {
  assert.equal(riskTierFor({ anyContractSurface: true, allOwnedByMe: true }), "shared");
  assert.equal(riskTierFor({ anyContractSurface: false, allOwnedByMe: true }), "owned");
  assert.equal(riskTierFor({ anyContractSurface: false, allOwnedByMe: false }), "shared");
});
