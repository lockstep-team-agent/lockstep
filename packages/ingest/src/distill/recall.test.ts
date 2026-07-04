import { test } from "node:test";
import assert from "node:assert/strict";
import { keywordPrefilter, recall } from "./recall.js";

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
