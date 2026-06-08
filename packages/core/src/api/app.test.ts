import { test, before, after } from "node:test";
import assert from "node:assert/strict";

/**
 * Lightweight smoke tests for the Fastify app routes that don't need a DB.
 * We build the app but never call listen(), so no port is bound.
 * Health/readyz require DB — we test only /healthz (no db call) and
 * verify unauthenticated routes return the right status codes.
 */

// buildApp() imports env.ts which parses process.env. Set the minimum required.
process.env.DATABASE_URL = "postgres://fake:fake@localhost:5432/fake";
process.env.NODE_ENV = "test";

const { buildApp } = await import("./app.js");

let app: ReturnType<typeof buildApp>;

before(() => {
  app = buildApp();
});

after(async () => {
  await app.close();
});

test("GET /healthz returns 200 with service name", async () => {
  const res = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body) as { ok: boolean; service: string };
  assert.equal(body.ok, true);
  assert.equal(body.service, "lockstep-core");
});

test("GET /me without auth returns 401", async () => {
  const res = await app.inject({ method: "GET", url: "/me" });
  assert.equal(res.statusCode, 401);
});

test("POST /orgs without auth returns 401", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/orgs",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "test-org" }),
  });
  assert.equal(res.statusCode, 401);
});

test("POST /connect without auth returns 401", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/connect",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gitRemote: "https://github.com/a/b.git" }),
  });
  assert.equal(res.statusCode, 401);
});

test("POST /decisions without session header returns 400 or 401", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/decisions",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scopeKind: "api", scopeRef: "test", ruleText: "test", baseVersion: 0 }),
  });
  // No auth token → 401 (auth hook doesn't set principal)
  assert.ok([400, 401].includes(res.statusCode));
});

test("GET /decisions without session header returns 400 or 401", async () => {
  const res = await app.inject({ method: "GET", url: "/decisions" });
  assert.ok([400, 401].includes(res.statusCode));
});

test("unknown route returns 404", async () => {
  const res = await app.inject({ method: "GET", url: "/nonexistent" });
  assert.equal(res.statusCode, 404);
});
