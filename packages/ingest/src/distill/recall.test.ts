import { test } from "node:test";
import assert from "node:assert/strict";
import { keywordPrefilter, recall, keywordPrefilterDoc, recallDoc } from "./recall.js";

test("keywordPrefilter: decision-language markers pass", () => {
  assert.equal(keywordPrefilter("ok let's lock it: JWT 15 min"), true);
  assert.equal(keywordPrefilter("going forward every write needs a key"), true);
  assert.equal(keywordPrefilter("we decided to use Postgres"), true);
});

test("keywordPrefilter: chatter is dropped", () => {
  assert.equal(keywordPrefilter("anyone want lunch? the line is huge"), false);
  assert.equal(keywordPrefilter("deployed the hotfix, watching metrics"), false);
});

test("recall: prefilter miss short-circuits before any LLM call (no Haiku)", async () => {
  // If this called Haiku it would throw (no ANTHROPIC_API_KEY in unit tests) — it must not.
  assert.equal(await recall("just grabbing coffee", true), false);
});

test("recall: useHaiku=false returns the prefilter result", async () => {
  assert.equal(await recall("we decided on quarterly billing", false), true);
});

test("keywordPrefilterDoc: obligation language passes, aspiration/narrative drops", () => {
  assert.equal(keywordPrefilterDoc("Guests must be able to complete checkout"), true);
  assert.equal(keywordPrefilterDoc("conversion must be at least 92% of baseline"), true);
  assert.equal(keywordPrefilterDoc("we should ideally support social login later"), false);
  assert.equal(keywordPrefilterDoc("cart abandonment sits at 61% on mobile"), false);
});

test("recallDoc: prefilter miss short-circuits (no Haiku); useHaiku=false returns the prefilter", async () => {
  // If this called Haiku it would throw (no ANTHROPIC_API_KEY in unit tests) — it must not.
  assert.equal(await recallDoc("competitor shipped it in Q1", true), false);
  assert.equal(await recallDoc("the flow may not block payment on OTP", false), true);
});
