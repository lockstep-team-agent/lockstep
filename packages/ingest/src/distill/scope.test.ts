import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeSurface, resolveScope, resolveDocScope, capabilitySlug } from "./scope.js";

test("canonicalizeSurface: HTTP method + path → http: canonical", () => {
  assert.equal(canonicalizeSurface("POST /auth/session"), "http:POST /auth/session");
  assert.equal(canonicalizeSurface("get /orders"), "http:GET /orders");
});

test("canonicalizeSurface: path params and route groups normalized", () => {
  assert.equal(canonicalizeSurface("GET /users/{id}"), "http:GET /users/:id");
  assert.equal(canonicalizeSurface("GET /(auth)/me"), "http:GET /me");
  assert.equal(canonicalizeSurface("POST /orders/"), "http:POST /orders");
});

test("canonicalizeSurface: proto and gql", () => {
  assert.equal(canonicalizeSurface("billing.v1.Billing/Charge"), "proto:billing.v1.Billing/Charge");
  assert.equal(canonicalizeSurface("Mutation.login"), "gql:Mutation.login");
});

test("canonicalizeSurface: bare path assumes ANY; junk returns null", () => {
  assert.equal(canonicalizeSurface("/webhooks/stripe"), "http:ANY /webhooks/stripe");
  assert.equal(canonicalizeSurface("just some words"), null);
  assert.equal(canonicalizeSurface(""), null);
});

test("resolveScope: first canonicalizable surface wins", () => {
  const s = resolveScope(["not a surface", "POST /auth/session"], "authentication");
  assert.deepEqual(s, { scopeKind: "surface", scopeRef: "http:POST /auth/session" });
});

test("resolveScope: no surface → topic from hint (slugified)", () => {
  assert.deepEqual(resolveScope([], "Billing Process"), { scopeKind: "topic", scopeRef: "topic:billing-process" });
  assert.deepEqual(resolveScope([], ""), { scopeKind: "topic", scopeRef: "topic:general" });
});

test("capabilitySlug: kebab slug with feature: prefix; doc-key prefixes stripped", () => {
  assert.equal(capabilitySlug("Guest Checkout"), "feature:guest-checkout");
  assert.equal(capabilitySlug("PRD-142 · Guest Checkout"), "feature:guest-checkout");
  assert.equal(capabilitySlug("PRD-7: OTP  Flow!!"), "feature:otp-flow");
  assert.equal(capabilitySlug(""), "feature:untitled");
});

test("resolveDocScope: first canonicalizable surface wins", () => {
  const s = resolveDocScope(["some words", "POST /payments/init"], "feature:guest-checkout");
  assert.deepEqual(s, { scopeKind: "surface", scopeRef: "http:POST /payments/init" });
});

test("resolveDocScope: no surface → the capability ref, never topic:", () => {
  const s = resolveDocScope(["not a surface"], "feature:guest-checkout");
  assert.deepEqual(s, { scopeKind: "capability", scopeRef: "feature:guest-checkout" });
  assert.ok(!s.scopeRef.startsWith("topic:"));
});
