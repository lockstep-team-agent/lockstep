import { test } from "node:test";
import assert from "node:assert/strict";
import { StubConnector } from "./StubConnector.js";
import { isDocumentConnector } from "./SourceConnector.js";
import { GOLDEN_PRD } from "../eval/golden-prd.js";

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

test("StubConnector: serves the guest-checkout PRD fixture as a DocumentConnector", async () => {
  const c = new StubConnector();
  assert.ok(isDocumentConnector(c));
  const docs = await c.listDocuments("db-x", "Status");
  assert.equal(docs.length, 1);
  assert.equal(docs[0]!.externalId, "prd-142");
  assert.equal(docs[0]!.rawStateValue, "In review", "default doc state");
  assert.equal(docs[0]!.containerRef, "db-x", "echoes the requested container");
  const sections = await c.fetchDocumentSections("prd-142");
  assert.equal(sections.length, GOLDEN_PRD.length);
  assert.ok(sections.some((s) => s.text.includes("must not present an OTP")), "includes C-2");
  assert.ok(sections.every((s) => s.snippet.length <= 120 && !s.snippet.includes("\n")));
});

test("StubConnector: doc state is configurable; writeComment records calls", async () => {
  const c = new StubConnector(StubConnector.sample(), { docStateValue: "Approved" });
  const docs = await c.listDocuments("db-x", null);
  assert.equal(docs[0]!.rawStateValue, "Approved");
  const r = await c.writeComment("prd-142", "may conflict with D-88 — review both", "blk-c2");
  assert.equal(r.commentRef, "stub-comment-1");
  assert.deepEqual(c.comments, [{ pageId: "prd-142", body: "may conflict with D-88 — review both", anchorBlockId: "blk-c2" }]);
});

test("isDocumentConnector: rejects objects without the three doc methods", () => {
  assert.equal(isDocumentConnector({ listChannels() {}, listUnitsSince() {} }), false);
  assert.equal(isDocumentConnector(null), false);
});
