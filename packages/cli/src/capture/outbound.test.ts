import { test } from "node:test";
import assert from "node:assert/strict";
import { extractOutbound } from "./outbound.js";

const surfaces = (path: string, content: string): string[] =>
  extractOutbound(path, content)
    .map((o) => o.surface)
    .filter((s): s is string => Boolean(s))
    .sort();

const hints = (path: string, content: string): string[] =>
  extractOutbound(path, content)
    .map((o) => o.hint)
    .filter((h): h is string => Boolean(h))
    .sort();

test("detects fetch() calls as canonical http surfaces (default GET)", () => {
  assert.deepEqual(surfaces("src/client.ts", `const r = await fetch("/orders/123")`), ["http:GET /orders/123"]);
});

test("reads the method from a fetch options object", () => {
  const s = surfaces("src/client.ts", `fetch("/auth/session", { method: "POST", body })`);
  assert.deepEqual(s, ["http:POST /auth/session"]);
});

test("strips scheme+host and querystring from absolute URLs", () => {
  assert.deepEqual(surfaces("src/pay.ts", `fetch("https://api.stripe.com/v1/charges?x=1")`), ["http:GET /v1/charges"]);
});

test("normalizes template-literal interpolation to a path param", () => {
  const s = surfaces("src/client.ts", "axios.get(`/orders/${id}/items`)");
  assert.deepEqual(s, ["http:GET /orders/:param/items"]);
});

test("detects axios verb, bare, and config-object calls", () => {
  const content = `
    axios.post("/a/b", body);
    axios("/c/d");
    axios({ url: "/e/f", method: "put" });
  `;
  assert.deepEqual(surfaces("src/api.ts", content), ["http:POST /a/b", "http:GET /c/d", "http:PUT /e/f"].sort());
});

test("drops wholly-dynamic and root-only URLs (no phantom surfaces)", () => {
  assert.deepEqual(surfaces("src/client.ts", "fetch(`${base}`); fetch(url); fetch(`/`)"), []);
});

test("gRPC client stub → service hint", () => {
  assert.deepEqual(hints("src/rpc.ts", "const c = new BillingServiceClient(addr)"), ["billing"]);
});

test("org-scoped / generated-client imports → package hints; noise imports ignored", () => {
  const content = `
    import { Client } from "@acme/inventory-client";
    import fs from "node:fs";
    import { x } from "./local";
    import z from "lodash";
  `;
  assert.deepEqual(hints("src/deps.ts", content), ["inventory"]);
});

test("dedupes repeated calls and ignores non-source files", () => {
  assert.deepEqual(surfaces("src/a.ts", `fetch("/x/y"); fetch("/x/y")`), ["http:GET /x/y"]);
  assert.deepEqual(extractOutbound("README.md", `fetch("/x/y")`), []);
});
