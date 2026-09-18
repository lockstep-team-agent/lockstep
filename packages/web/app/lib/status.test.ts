import { test } from "node:test";
import assert from "node:assert/strict";
import { statusView } from "./status.js";

test("statusView maps API statuses to one word and one tone", () => {
  assert.deepEqual(statusView("open"), { word: "awaiting ack", tone: "warning", dot: true });
  assert.deepEqual(statusView("open_question"), { word: "open", tone: "warning", dot: true });
  assert.deepEqual(statusView("proposed"), { word: "proposed", tone: "warning", dot: true });
  assert.deepEqual(statusView("binding"), { word: "binding", tone: "primary", dot: true });
  assert.deepEqual(statusView("binding", { origin: "document" }), { word: "ratified", tone: "primary", dot: true });
  assert.deepEqual(statusView("answered"), { word: "answered", tone: "success", dot: true });
  assert.deepEqual(statusView("urgent"), { word: "urgent", tone: "destructive", dot: true });
  assert.deepEqual(statusView("superseded"), { word: "superseded", tone: "muted", dot: false });
  assert.deepEqual(statusView("something_new"), { word: "something new", tone: "muted", dot: false });
});
