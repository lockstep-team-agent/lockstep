import { test } from "node:test";
import assert from "node:assert/strict";
import { conceptKey, surfaceKind } from "./derive.js";

const cases: Array<[string, string | null, string | null, string, string?]> = [
  // http: only LEADING prefixes/versions/params/self-aliases are skipped
  ["http:GET /api/v1/users/me/cards", null, null, "http:users"],
  ["http:GET /v2/me/orders", null, null, "http:orders"],
  ["http:POST /rest/{tenant}/invoices", null, null, "http:invoices"],
  ["http:GET /health", null, null, "http:health"],
  ["http:GET /users/v1/x", null, null, "http:users"],
  ["POST /orders", null, null, "http:orders"], // legacy un-prefixed http
  // gql: return type only when it is a resolved object/interface and not a payload wrapper
  ["gql:Query.orders", "[Order!]!", "object", "gql:Order"],
  ["gql:Query.status", "Status", "enum", "gql:Query.status"],
  ["gql:Query.status", "Status", "unknown", "gql:Query.status"],
  ["gql:Mutation.createCard", "CreateCardPayload", "object", "gql:Mutation.createCard"],
  ["gql:Query.user", null, null, "gql:Query.user"],
  ["gql:Query.health", "Boolean", "scalar", "gql:Query.health"],
  // proto / event / ws / unknown
  ["proto:billing.v1.InvoiceService/Get", null, null, "proto:billing.v1.InvoiceService", "Invoice"],
  ["event:order.created", null, null, "event:order"],
  ["ws:/api/v1/chat/room", null, null, "ws:chat"],
  ["ws:/v2/notifications", null, null, "ws:notifications"],
  ["sns:foo/bar", null, null, "sns:foo/bar"],
];

test("conceptKey normalization table", () => {
  for (const [surface, rt, rtk, key, label] of cases) {
    const got = conceptKey(surface, rt, rtk);
    assert.equal(got.key, key, surface);
    if (label) assert.equal(got.label, label, surface);
  }
});

test("per-project http skip rules replace the defaults", () => {
  assert.equal(conceptKey("http:GET /internal/billing/x", null, null, { skip: ["internal"] }).key, "http:billing");
  assert.equal(conceptKey("http:GET /api/users", null, null, { skip: [] }).key, "http:api");
});

test("surfaceKind", () => {
  assert.equal(surfaceKind("http:GET /x"), "http");
  assert.equal(surfaceKind("GET /x"), "http");
  assert.equal(surfaceKind("gql:Query.x"), "gql");
  assert.equal(surfaceKind("weird"), "unknown");
});
