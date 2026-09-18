import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { systemOne, jevEnabled } from "./jev.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.TYPESAFE_API_KEY;
});

test("systemOne: null without a key, and no HTTP", async () => {
  delete process.env.TYPESAFE_API_KEY;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  assert.equal(jevEnabled(), false);
  assert.equal(await systemOne("x", { q: { type: "noul", instructions: "?" } }), null);
  assert.equal(called, false);
});

test("systemOne: posts state+questions with bearer auth and returns answers", async () => {
  process.env.TYPESAFE_API_KEY = "k";
  let seen: { url: string; auth: string; body: unknown } | undefined;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen = {
      url: String(url),
      auth: String((init?.headers as Record<string, string>).authorization),
      body: JSON.parse(String(init?.body)),
    };
    return new Response(
      JSON.stringify({
        model: "jev-latest",
        answers: { d: { type: "noul", noul: 0.91 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const out = await systemOne({ thread: ["hi"] }, { d: { type: "noul", instructions: "decision?" } });
  assert.equal(jevEnabled(), true);
  assert.equal(seen!.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(seen!.auth, "Bearer k");
  assert.deepEqual((seen!.body as { state: unknown }).state, { thread: ["hi"] });
  assert.equal((seen!.body as { model: string }).model, "jev-latest");
  assert.deepEqual(out, { d: { type: "noul", noul: 0.91 } });
});

test("systemOne: null on non-2xx and on malformed body; retries once on 429", async () => {
  process.env.TYPESAFE_API_KEY = "k";
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("{}", { status: calls === 1 ? 429 : 500 });
  }) as typeof fetch;
  assert.equal(await systemOne("x", { q: { type: "noul", instructions: "?" } }), null);
  assert.equal(calls, 2, "one retry after 429, then gave up on 500");

  globalThis.fetch = (async () => new Response(JSON.stringify({ nope: true }), { status: 200 })) as typeof fetch;
  assert.equal(await systemOne("x", { q: { type: "noul", instructions: "?" } }), null);
});
