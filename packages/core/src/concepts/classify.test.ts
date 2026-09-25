import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { classifyChoice, retryAfterMs } from "./classify.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const input = { subject: { name: "users" }, instructions: "Which domain?", options: { a: "Identity", b: "Payments" } };

function stub(handler: (url: string) => Response): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    return handler(String(url));
  }) as typeof fetch;
  return calls;
}
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });
const jevOk = (choice: string, confidence: number) =>
  json({ answers: { pick: { type: "choice", choice, confidence } } });
const claudeOk = (choice: string, confidence: number) =>
  json({ content: [{ type: "tool_use", input: { choice, confidence } }] });

test("no keys → no_provider without any network call", async () => {
  const calls = stub(() => json({}));
  assert.deepEqual(await classifyChoice(input, {}), { ok: false, reason: "no_provider" });
  assert.equal(calls.length, 0);
});

test("Jev above the floor wins; Claude is not called", async () => {
  const calls = stub(() => jevOk("b", 0.9));
  const r = await classifyChoice(input, { jev: "j", claude: "c" });
  assert.deepEqual(r, { ok: true, choice: "b", confidence: 0.9, classifier: "jev" });
  assert.equal(calls.length, 1);
});

test("Jev below the floor → Claude decides", async () => {
  stub((u) => (u.includes("typesafe") ? jevOk("a", 0.2) : claudeOk("b", 0.7)));
  const r = await classifyChoice(input, { jev: "j", claude: "c" });
  assert.deepEqual(r, { ok: true, choice: "b", confidence: 0.7, classifier: "claude" });
});

test("Jev fails → Claude decides", async () => {
  stub((u) => (u.includes("typesafe") ? json({}, 503) : claudeOk("a", 0.8)));
  const r = await classifyChoice(input, { jev: "j", claude: "c" });
  assert.equal(r.ok && r.classifier, "claude");
});

test("both fail → transient, carrying the longest Retry-After", async () => {
  stub((u) =>
    u.includes("typesafe") ? json({}, 429, { "retry-after": "30" }) : json({}, 529, { "retry-after": "90" }),
  );
  const r = await classifyChoice(input, { jev: "j", claude: "c" });
  assert.deepEqual(r, { ok: false, reason: "transient", error: "claude 529", retryAfterMs: 90_000 });
});

test("malformed / unknown choice is a failure, not a placement", async () => {
  stub(() => jevOk("zzz", 0.99));
  const r = await classifyChoice(input, { jev: "j" });
  assert.equal(r.ok, false);
});

test("retryAfterMs parses seconds and HTTP dates", () => {
  assert.equal(retryAfterMs("5"), 5000);
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000);
  assert.equal(retryAfterMs(null), undefined);
});
