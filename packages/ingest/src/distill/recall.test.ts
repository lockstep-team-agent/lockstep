import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { recall, recallDoc, jevRecall, JEV_RECALL_FLOOR, keywordPrefilter } from "./recall.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.TYPESAFE_API_KEY;
});

function jevReturning(noul: number): void {
  process.env.TYPESAFE_API_KEY = "k";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ answers: { d: { type: "noul", noul } } }), { status: 200 })) as typeof fetch;
}

test("jevRecall: floor is recall-tuned (0.3), and null without a key", async () => {
  assert.equal(JEV_RECALL_FLOOR, 0.3);
  jevReturning(0.31);
  assert.equal(await jevRecall("anything"), true);
  jevReturning(0.29);
  assert.equal(await jevRecall("anything"), false);
  delete process.env.TYPESAFE_API_KEY;
  assert.equal(await jevRecall("anything"), null);
});

test("recall: with Jev, a decision carrying NO marker words survives (the keyword ceiling is gone)", async () => {
  const noMarkers =
    "@dev: new fields on the Order response are additive only, nobody removes a field without a v2 path.\n@priya: yep.";
  assert.equal(keywordPrefilter(noMarkers), false, "sanity: the old prefilter would drop this");
  jevReturning(0.9);
  assert.equal(await recall(noMarkers, false), true);
});

test("recall: without Jev, the keyword path runs unchanged (useHaiku=false ⇒ prefilter only)", async () => {
  delete process.env.TYPESAFE_API_KEY;
  assert.equal(await recall("we decided: JWT", false), true);
  assert.equal(await recall("lunch?", false), false);
});

test("recall: a Jev outage falls back to the keyword path, never throws", async () => {
  process.env.TYPESAFE_API_KEY = "k";
  globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
  assert.equal(await recall("we decided: JWT", false), true);
  assert.equal(await recall("lunch?", false), false);
});

test("recallDoc: Jev-first with the same floor and fallback", async () => {
  jevReturning(0.8);
  assert.equal(await recallDoc("Guests can pay as guests.", false), true);
  delete process.env.TYPESAFE_API_KEY;
  assert.equal(await recallDoc("Guests must be able to check out.", false), true);
  assert.equal(await recallDoc("Persona: Riya, 28.", false), false);
});
