/**
 * The API's confidence contract. These values are rendered as `Math.round(c * 100)%`, so a 0..100
 * column served unscaled renders as "10000%" — the bug this pins shut.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { confidenceFraction } from "./confidence.js";

test("a 0..100 stored column becomes the 0..1 fraction the dashboard renders", () => {
  assert.equal(confidenceFraction(100), 1);
  assert.equal(confidenceFraction(95), 0.95);
  assert.equal(confidenceFraction(0), 0);
  // What the UI would print. 10000% is the reported defect.
  assert.equal(Math.round(confidenceFraction(100)! * 100), 100);
  assert.equal(Math.round(confidenceFraction(67)! * 100), 67);
});

test("absent or unusable values stay null rather than rendering as 0%", () => {
  assert.equal(confidenceFraction(null), null);
  assert.equal(confidenceFraction(undefined), null);
  assert.equal(confidenceFraction(Number.NaN), null);
  assert.equal(confidenceFraction(Number.POSITIVE_INFINITY), null);
});
