import { test } from "node:test";
import assert from "node:assert/strict";
import { runFunnel, redactSecrets } from "./funnel.js";
import type { SourceConnector, Unit, Channel } from "./connectors/SourceConnector.js";
import type { Extraction } from "./distill/rubric.js";

function extraction(over: Partial<Extraction>): Extraction {
  return {
    is_decision: true,
    decision_type: "rule",
    finality: "agreed",
    rule_text: "Auth tokens are JWT with 15-minute expiry.",
    rationale: "stateless",
    alternatives_considered: [],
    decided_by: ["@alice"],
    scope_hint: "authentication",
    surface_candidates: [],
    confidence: 0.9,
    evidence: [{ externalId: "e", quote: "lock it: JWT" }],
    ...over,
  };
}

class FakeConnector implements SourceConnector {
  constructor(private readonly units: Unit[]) {}
  async listChannels(): Promise<Channel[]> {
    return [{ id: "C1", name: "eng" }];
  }
  async listUnitsSince(sourceRef: string): Promise<Unit[]> {
    return this.units.filter((u) => u.sourceRef === sourceRef);
  }
}

const unit = (id: string, ts: string, text: string): Unit => ({
  externalId: id,
  sourceRef: "C1",
  ts,
  text,
  authors: ["@alice"],
  permalink: "https://slack/x",
});

test("redactSecrets strips emails, tokens, and long hashes", () => {
  const out = redactSecrets("mail me at a@b.com token xoxb-123456789012 hash deadbeefdeadbeefdeadbeefdeadbeef");
  assert.match(out, /\[email\]/);
  assert.match(out, /\[token\]/);
  assert.match(out, /\[hash\]/);
  assert.doesNotMatch(out, /a@b\.com/);
});

test("runFunnel: propose path builds an item, advances the cursor, records stats", async () => {
  const connector = new FakeConnector([unit("C1/2", "2.0", "we decided: JWT"), unit("C1/1", "1.0", "chatter")]);
  const res = await runFunnel({
    connector,
    orgId: "o",
    projectId: "p",
    connectionId: "conn",
    sources: [{ sourceRef: "C1", cursor: null }],
    tool: "slack",
    recallFn: async (t) => t.includes("decided"),
    extractFn: async () => extraction({}),
  });
  assert.equal(res.items.length, 1);
  assert.equal(res.stats.seen, 2);
  assert.equal(res.stats.recalled, 1);
  assert.equal(res.stats.proposed, 1);
  assert.equal(res.cursors.C1, "2.0", "cursor advanced to max ts seen (even across discarded units)");
  const item = res.items[0]!;
  assert.equal(item.scopeRef, "topic:authentication");
  assert.equal(item.provenance && (item.provenance as { source: string }).source, "slack");
  assert.equal(item.confidence, 90);
});

test("runFunnel: question and discard outcomes are counted, not filed", async () => {
  const connector = new FakeConnector([
    unit("C1/1", "1.0", "decided a"),
    unit("C1/2", "2.0", "decided b"),
    unit("C1/3", "3.0", "decided c"),
  ]);
  const map: Record<string, Extraction> = {
    "C1/1": extraction({ finality: "proposed" }), // → question
    "C1/2": extraction({ is_decision: false, confidence: 0.1 }), // → discard
    "C1/3": extraction({}), // → propose
  };
  const res = await runFunnel({
    connector,
    orgId: "o",
    projectId: "p",
    connectionId: "conn",
    sources: [{ sourceRef: "C1", cursor: null }],
    recallFn: async () => true,
    extractFn: async (id) => map[id]!,
  });
  assert.equal(res.stats.questions, 1);
  assert.equal(res.stats.proposed, 1);
  assert.ok(res.stats.discarded >= 1);
  assert.equal(res.items.length, 1);
});

test("runFunnel: batch mode uses the injected batch extractor", async () => {
  const connector = new FakeConnector([unit("C1/9", "9.0", "we decided: ship it")]);
  let batched = false;
  const res = await runFunnel({
    connector,
    orgId: "o",
    projectId: "p",
    connectionId: "conn",
    sources: [{ sourceRef: "C1", cursor: null }],
    batch: true,
    recallFn: async () => true,
    batchExtractFn: async (items) => {
      batched = true;
      return new Map(items.map((i) => [i.externalId, extraction({ surface_candidates: ["POST /ship"] })]));
    },
  });
  assert.equal(batched, true);
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0]!.scopeKind, "surface");
  assert.equal(res.items[0]!.scopeRef, "http:POST /ship");
});
