import { test } from "node:test";
import assert from "node:assert/strict";
import { isContractSurface, riskTierFor } from "./classify.js";

test("detects various OpenAPI file extensions", () => {
  assert.ok(isContractSurface("api/openapi.yml"));
  assert.ok(isContractSurface("swagger.json"));
  assert.ok(isContractSurface("docs/swagger.yaml"));
});

test("detects handler paths", () => {
  assert.ok(isContractSurface("src/handlers/order-handler.ts"));
  assert.ok(isContractSurface("src/endpoints/v2/users.ts"));
});

test("detects contract files", () => {
  assert.ok(isContractSurface("contracts/order-api.ts"));
});

test("does not flag test files without contract markers", () => {
  assert.ok(!isContractSurface("src/utils/test-helper.ts", "function internal() {}"));
  assert.ok(!isContractSurface("src/utils/math.ts", "const x = 1;"));
});

test("a bare exported interface/type in a non-route file is NOT a contract surface (noise fix)", () => {
  assert.ok(!isContractSurface("src/types.ts", "export interface OrderPayload { id: string; }"));
  assert.ok(!isContractSurface("src/types.ts", "export type OrderId = string;"));
});

test("a bare exported class/function in a non-route file is NOT a contract surface (noise fix)", () => {
  assert.ok(!isContractSurface("src/service.ts", "export class OrderService {}"));
  assert.ok(!isContractSurface("src/orders.ts", "export async function fetchOrders() {}"));
});

test("contract path still counts even without extractable content", () => {
  assert.ok(isContractSurface("contracts/order-api.ts"));
  assert.ok(isContractSurface("src/handlers/order-handler.ts"));
});

test("non-TS files without path markers are not contract surfaces", () => {
  assert.ok(!isContractSurface("README.md", "# Readme"));
  assert.ok(!isContractSurface("package.json"));
  assert.ok(!isContractSurface(".gitignore"));
});

test("riskTier: various combinations", () => {
  assert.equal(riskTierFor({ anyContractSurface: true, allOwnedByMe: false }), "shared");
  assert.equal(riskTierFor({ anyContractSurface: true, allOwnedByMe: true }), "shared");
  assert.equal(riskTierFor({ anyContractSurface: false, allOwnedByMe: false }), "shared");
  assert.equal(riskTierFor({ anyContractSurface: false, allOwnedByMe: true }), "owned");
});
