import { test } from "node:test";
import assert from "node:assert/strict";
import { StubConnector } from "./StubConnector.js";

test("StubConnector: lists a channel and returns its canned units", async () => {
  const c = new StubConnector();
  const chans = await c.listChannels();
  assert.equal(chans.length, 1);
  assert.equal(chans[0]!.id, "C_STUB");

  const units = await c.listUnitsSince("C_STUB", null);
  assert.ok(units.length >= 2);
  assert.ok(units.every((u) => u.sourceRef === "C_STUB"));
  assert.ok(units.some((u) => u.text.includes("JWT")), "includes the decision thread");
});

test("StubConnector: unknown source yields no units; custom units are respected", async () => {
  assert.deepEqual(await new StubConnector().listUnitsSince("nope", null), []);
  const custom = new StubConnector([
    { externalId: "X/1", sourceRef: "X", ts: "1.0", text: "hi", authors: [] },
  ]);
  const units = await custom.listUnitsSince("X", null);
  assert.equal(units.length, 1);
  assert.equal(units[0]!.externalId, "X/1");
});
