import { test } from "node:test";
import assert from "node:assert/strict";
import { compareInbox, inboxScore } from "./views.js";

const DAY = 86_400_000;
const now = Date.UTC(2026, 8, 25);

test("inboxScore: maxImpact 0 never divides by zero; age is a bounded contribution", () => {
  assert.equal(inboxScore(0, new Date(now), now, 0), 0);
  assert.equal(inboxScore(5, new Date(now - 14 * DAY), now, 0), 0.3);
  assert.equal(inboxScore(0, new Date(now - 90 * DAY), now, 10), 0.3, "age capped at 14 days");
  assert.ok(
    inboxScore(0, new Date(now - 7 * DAY), now, 10) > inboxScore(0, new Date(now - 1 * DAY), now, 10),
    "older rises",
  );
  assert.equal(inboxScore(10, new Date(now), now, 10), 0.7);
});

test("compareInbox: severity first, then score, then id — stable and total", () => {
  const items = [
    { id: "b", severity: 1, score: 0.9 },
    { id: "a", severity: 3, score: 0.1 },
    { id: "c", severity: 1, score: 0.9 },
    { id: "d", severity: 2, score: 0.5 },
  ];
  assert.deepEqual(
    [...items].sort(compareInbox).map((i) => i.id),
    ["a", "d", "b", "c"],
  );
  // an old, max-age low-severity item never outranks a fresh higher-severity one
  const old = { id: "x", severity: 1, score: inboxScore(0, new Date(now - 100 * DAY), now, 1) };
  const fresh = { id: "y", severity: 2, score: 0 };
  assert.ok(compareInbox(fresh, old) < 0);
});
