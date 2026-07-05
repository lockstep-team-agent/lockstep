import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runDocFunnel } from "./docFunnel.js";
import { slug } from "./connectors/GDocsConnector.js";
import type { DocumentConnector, DocMeta, DocSection } from "./connectors/SourceConnector.js";
import type { DocExtraction } from "./distill/rubric-doc.js";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

function docx(over: Partial<DocExtraction>): DocExtraction {
  return {
    is_constraint: true,
    constraint_kind: "behavioral",
    rule_text: "Guests must be able to complete checkout without creating an account.",
    rationale: "core of the guest experience",
    scope_hint: "guest checkout",
    surface_candidates: [],
    expires_hint: "",
    anchor_key: "blk-c1",
    confidence: 0.9,
    evidence: [{ externalId: "e", quote: "Guests must be able to complete checkout" }],
    ...over,
  };
}

class FakeDocConnector implements DocumentConnector {
  constructor(private readonly sections: DocSection[]) {}
  async listDocuments(): Promise<DocMeta[]> {
    return [];
  }
  async fetchDocumentSections(): Promise<DocSection[]> {
    return this.sections;
  }
  async writeComment(): Promise<{ commentRef: string }> {
    return { commentRef: "fake" };
  }
}

const section = (anchorKey: string, headingPath: string[], text: string): DocSection => ({
  anchorKey,
  headingPath,
  text,
  snippet: text.replace(/\s+/g, " ").slice(0, 120),
});

const doc = { externalId: "prd-142", title: "PRD-142 · Guest Checkout", url: "https://notion.example.com/prd-142" };

test("runDocFunnel: propose path builds an item with section externalId, hash, and anchor", async () => {
  const s = section("blk-c2", ["Requirements", "C-2 No pre-payment OTP"], "The guest flow must not present an OTP before payment.");
  const res = await runDocFunnel({
    connector: new FakeDocConnector([s]),
    doc,
    recallFn: async () => true,
    extractFn: async (anchorKey) => docx({ anchor_key: anchorKey, surface_candidates: ["POST /payments/init"] }),
  });
  assert.equal(res.items.length, 1);
  const item = res.items[0]!;
  assert.equal(item.externalId, "prd-142#blk-c2");
  assert.equal(item.scopeKind, "surface");
  assert.equal(item.scopeRef, "http:POST /payments/init");
  assert.equal(item.contentHash, sha256(s.text));
  assert.equal(item.confidence, 90);
  assert.equal(item.lowConfidence, false);
  assert.deepEqual(item.anchor, {
    type: "notion_block",
    pageId: "prd-142",
    blockId: "blk-c2",
    headingPath: ["Requirements", "C-2 No pre-payment OTP"],
    snippet: s.snippet,
  });
  assert.equal(item.evidence[0]!.externalId, "prd-142#blk-c2", "evidence re-keyed to the section externalId");
  assert.deepEqual(res.stats, { sections: 1, skipped: 0, recalled: 1, proposed: 1, lowConfidence: 0, discarded: 0 });
  assert.equal(res.docContentHash, sha256(sha256(s.text)));
});

test("runDocFunnel: low-confidence band is flagged and counted; non-constraints discarded", async () => {
  const sections = [
    section("blk-a", ["Requirements", "A"], "The flow must do a."),
    section("blk-b", ["Requirements", "B"], "The flow must do b."),
  ];
  const map: Record<string, DocExtraction> = {
    "blk-a": docx({ anchor_key: "blk-a", confidence: 0.6 }), // → propose_low
    "blk-b": docx({ anchor_key: "blk-b", is_constraint: false, constraint_kind: "none", confidence: 0.2 }), // → discard
  };
  const res = await runDocFunnel({
    connector: new FakeDocConnector(sections),
    doc,
    recallFn: async () => true,
    extractFn: async (k) => map[k]!,
  });
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0]!.lowConfidence, true);
  assert.equal(res.stats.lowConfidence, 1);
  assert.equal(res.stats.proposed, 0);
  assert.equal(res.stats.discarded, 1);
});

test("runDocFunnel: never-extract headings skip BEFORE recall; the preamble is never heading-skipped", async () => {
  const recallCalls: string[] = [];
  const sections = [
    section("blk-bg", ["Background"], "abandonment is 61% and we must fix it"),
    section("blk-oq", ["Requirements", "Open questions"], "must we dedupe guest orders?"),
    section("prd-142", [], "Preamble: the doc summary says checkout must be fast."),
    section("blk-c1", ["Requirements", "C-1"], "Guests must be able to check out without an account."),
  ];
  const res = await runDocFunnel({
    connector: new FakeDocConnector(sections),
    doc,
    recallFn: async (t) => {
      recallCalls.push(t);
      return true;
    },
    extractFn: async (k) => docx({ anchor_key: k }),
  });
  assert.equal(recallCalls.length, 2, "only the preamble and C-1 reach recall");
  assert.ok(recallCalls.every((t) => !t.includes("61%") && !t.includes("dedupe")));
  assert.equal(res.items.length, 2);
  assert.equal(res.stats.discarded, 2);
});

test("runDocFunnel: unchanged sections (knownSectionHashes) skip before any LLM call, still hashed into the doc", async () => {
  const s = section("blk-c1", ["Requirements", "C-1"], "Guests must be able to check out without an account.");
  let recallCalls = 0;
  const res = await runDocFunnel({
    connector: new FakeDocConnector([s]),
    doc,
    knownSectionHashes: [sha256(s.text)],
    recallFn: async () => {
      recallCalls++;
      return true;
    },
    extractFn: async (k) => docx({ anchor_key: k }),
  });
  assert.equal(recallCalls, 0, "no recall (and so no extraction) for the unchanged section");
  assert.equal(res.items.length, 0);
  assert.deepEqual(res.stats, { sections: 1, skipped: 1, recalled: 0, proposed: 0, lowConfidence: 0, discarded: 0 });
  assert.equal(res.docContentHash, sha256(sha256(s.text)), "skipped sections still count toward the doc hash");
});

test("runDocFunnel: no canonical surface → capability from the doc title (never topic:)", async () => {
  const s = section("blk-c1", ["Requirements", "C-1"], "Guests must be able to check out without an account.");
  const res = await runDocFunnel({
    connector: new FakeDocConnector([s]),
    doc,
    recallFn: async () => true,
    extractFn: async (k) => docx({ anchor_key: k, surface_candidates: ["not a surface"] }),
  });
  assert.equal(res.items[0]!.scopeKind, "capability");
  assert.equal(res.items[0]!.scopeRef, "feature:guest-checkout", "PRD-142 · key prefix stripped from the slug");
  assert.ok(!res.items[0]!.scopeRef.startsWith("topic:"));

  const override = await runDocFunnel({
    connector: new FakeDocConnector([s]),
    doc,
    capabilityRef: "feature:custom-ref",
    recallFn: async () => true,
    extractFn: async (k) => docx({ anchor_key: k }),
  });
  assert.equal(override.items[0]!.scopeRef, "feature:custom-ref");
});

test("runDocFunnel: expiry wiring — now-relative hints resolve, event-relative stay null (hint preserved)", async () => {
  const now = new Date("2026-07-04T00:00:00.000Z");
  const s = section("blk-c4", ["Launch criteria"], "Conversion must be at least 92% of baseline.");
  const run = (hint: string) =>
    runDocFunnel({
      connector: new FakeDocConnector([s]),
      doc,
      now,
      recallFn: async () => true,
      extractFn: async (k) => docx({ anchor_key: k, constraint_kind: "launch_gate", expires_hint: hint }),
    });
  const relative = await run("30 days");
  assert.equal(relative.items[0]!.expiresAt, "2026-08-03T00:00:00.000Z");
  assert.equal(relative.items[0]!.expiresHint, "30 days");
  const event = await run("30 days post-launch");
  assert.equal(event.items[0]!.expiresAt, null);
  assert.equal(event.items[0]!.expiresHint, "30 days post-launch", "verbatim hint kept for the expiry job later");
});

test("runDocFunnel: batch mode uses the injected batch extractor; missing results are discarded", async () => {
  const sections = [
    section("blk-c1", ["Requirements", "C-1"], "Guests must check out without an account."),
    section("blk-c2", ["Requirements", "C-2"], "The flow must not present an OTP."),
  ];
  let batched = false;
  const res = await runDocFunnel({
    connector: new FakeDocConnector(sections),
    doc,
    batch: true,
    recallFn: async () => true,
    batchExtractFn: async (items) => {
      batched = true;
      // Only the first survivor gets an extraction — the second must be counted discarded.
      return new Map([[items[0]!.anchorKey, docx({ anchor_key: items[0]!.anchorKey })]]);
    },
  });
  assert.equal(batched, true);
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0]!.externalId, "prd-142#blk-c1");
  assert.equal(res.stats.discarded, 1);
});

test("runDocFunnel: anchorType defaults to notion_block; gdoc_fuzzy stamps the emitted anchor", async () => {
  const s = section("checkout>c-1", ["Checkout", "C-1"], "Guests must check out without an account.");
  const dflt = await runDocFunnel({
    connector: new FakeDocConnector([s]),
    doc,
    recallFn: async () => true,
    extractFn: async (k) => docx({ anchor_key: k }),
  });
  assert.equal(dflt.items[0]!.anchor.type, "notion_block", "unset anchorType ⇒ notion_block");

  const gdoc = await runDocFunnel({
    connector: new FakeDocConnector([s]),
    doc,
    anchorType: "gdoc_fuzzy",
    recallFn: async () => true,
    extractFn: async (k) => docx({ anchor_key: k }),
  });
  assert.equal(gdoc.items[0]!.anchor.type, "gdoc_fuzzy");
  assert.equal(gdoc.items[0]!.anchor.pageId, "prd-142", "pageId stays the doc externalId");
  assert.equal(gdoc.items[0]!.anchor.blockId, "checkout>c-1", "blockId stays the section anchorKey");
});

test("runDocFunnel: currentSections returns EVERY section seen (incl. hash-skipped) for anchor relocation", async () => {
  const kept = section("checkout>c-1", ["Checkout", "C-1"], "Guests must check out without an account.");
  const skipped = section("checkout>c-2", ["Checkout", "C-2"], "The flow must not present an OTP.");
  const res = await runDocFunnel({
    connector: new FakeDocConnector([kept, skipped]),
    doc,
    anchorType: "gdoc_fuzzy",
    knownSectionHashes: [sha256(skipped.text)], // c-2 is unchanged → hash-skipped, never extracted
    recallFn: async () => true,
    extractFn: async (k) => docx({ anchor_key: k }),
  });
  assert.equal(res.items.length, 1, "only the changed section yields a candidate");
  assert.equal(res.stats.skipped, 1);
  // …but currentSections must still carry the skipped section so core can relocate its anchor.
  assert.deepEqual(res.currentSections.map((s) => s.anchorKey).sort(), ["checkout>c-1", "checkout>c-2"]);
  const skippedCur = res.currentSections.find((s) => s.anchorKey === "checkout>c-2")!;
  assert.deepEqual(skippedCur.headingPath, ["Checkout", "C-2"]);
  assert.equal(skippedCur.snippet, skipped.snippet);
});

test("slug: heading path → a stable lowercase alnum key (same path ⇒ same key)", () => {
  assert.equal(
    slug("Requirements>Guest flow>C-1 Account-free checkout"),
    "requirements-guest-flow-c-1-account-free-checkout",
  );
  assert.equal(slug("  Launch Criteria!!  "), "launch-criteria", "trims leading/trailing separators");
  assert.equal(slug(""), "");
  assert.equal(slug("A>B"), slug("A>B"), "deterministic — the anchor stability guarantee");
});
