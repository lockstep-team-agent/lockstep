import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExpiresHint } from "./expiry.js";

const now = new Date("2026-07-04T00:00:00.000Z");

test("parseExpiresHint: absolute dates", () => {
  assert.equal(parseExpiresHint("2026-08-01", now)?.toISOString(), "2026-08-01T00:00:00.000Z");
  const d = parseExpiresHint("August 1, 2026", now);
  assert.ok(d, "month-name dates parse");
  assert.equal(d!.getFullYear(), 2026);
  assert.equal(d!.getMonth(), 7);
  assert.equal(d!.getDate(), 1);
});

test("parseExpiresHint: now-relative forms", () => {
  assert.equal(parseExpiresHint("in 30 days", now)?.toISOString(), "2026-08-03T00:00:00.000Z");
  assert.equal(parseExpiresHint("30 days", now)?.toISOString(), "2026-08-03T00:00:00.000Z");
  assert.equal(parseExpiresHint("6 weeks", now)?.toISOString(), "2026-08-15T00:00:00.000Z");
  assert.equal(parseExpiresHint("3 months", now)?.toISOString(), "2026-10-04T00:00:00.000Z");
  assert.equal(parseExpiresHint("1 year", now)?.toISOString(), "2027-07-04T00:00:00.000Z");
});

test("parseExpiresHint: event-relative hints have no calendar anchor → null", () => {
  assert.equal(parseExpiresHint("30 days post-launch", now), null);
  assert.equal(parseExpiresHint("after GA", now), null);
  assert.equal(parseExpiresHint("until launch", now), null);
});

test("parseExpiresHint: empty and garbage → null", () => {
  assert.equal(parseExpiresHint("", now), null);
  assert.equal(parseExpiresHint("   ", now), null);
  assert.equal(parseExpiresHint("whenever it feels right", now), null);
});
