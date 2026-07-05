import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeDigestBlocks,
  composeDriftBlocks,
  composeWeeklyBlocks,
  digestFallbackText,
  driftFallbackText,
  weeklyFallbackText,
  type DigestCandidate,
  type DriftAlertPayload,
  type SlackDigestPayload,
  type WeeklyDigestPayload,
} from "./digest.js";

function candidate(over: Partial<DigestCandidate> = {}): DigestCandidate {
  return {
    decisionId: "dec-1",
    ruleText: "Guest checkout must not require account creation.",
    scopeRef: "capability:guest-checkout",
    constraintKind: null,
    confidencePct: 85,
    anchorUrl: "https://notion.example.com/prd-142#block-7",
    conflict: null,
    ...over,
  };
}

function payload(over: Partial<SlackDigestPayload> = {}): SlackDigestPayload {
  return {
    orgId: "org-1",
    documentId: "doc-1",
    docTitle: "Guest Checkout PRD",
    docUrl: "https://notion.example.com/prd-142",
    docState: "active",
    candidates: [candidate()],
    ...over,
  };
}

// Blocks are `unknown[]` by design — a loose shape for assertions.
type Block = { type: string; text?: { text: string }; elements?: Array<Record<string, unknown>> };

test("composeDigestBlocks: header links the doc and renders active as Approved", () => {
  const blocks = composeDigestBlocks(payload()) as Block[];
  const header = blocks[0]!;
  assert.equal(header.type, "section");
  assert.match(header.text!.text, /^📋 <https:\/\/notion\.example\.com\/prd-142\|Guest Checkout PRD> is \*Approved\*/);
  assert.match(header.text!.text, /1 constraint\(s\) await your ratification/);
});

test("composeDigestBlocks: non-active states and missing title/url render plainly", () => {
  const blocks = composeDigestBlocks(payload({ docTitle: null, docUrl: null, docState: "review" })) as Block[];
  assert.match(blocks[0]!.text!.text, /^📋 Untitled PRD is \*review\*/);
  assert.doesNotMatch(blocks[0]!.text!.text, /</);
});

test("composeDigestBlocks: per-candidate section, context line, and buttons", () => {
  const blocks = composeDigestBlocks(payload()) as Block[];
  const [, rule, ctx, actions] = blocks;
  assert.equal(rule!.text!.text, '1️⃣ "Guest checkout must not require account creation."');
  assert.equal(
    (ctx!.elements![0] as { text: string }).text,
    "scope capability:guest-checkout · confidence 85% · <https://notion.example.com/prd-142#block-7|view in PRD ↗>",
  );
  assert.equal(actions!.type, "actions");
  const btns = actions!.elements as Array<{ action_id: string; style?: string; value: string; text: { text: string } }>;
  assert.deepEqual(btns.map((b) => b.action_id), ["ratify", "edit", "reject"]);
  assert.equal(btns[0]!.style, "primary");
  assert.equal(btns[1]!.style, undefined);
  assert.equal(btns[2]!.style, "danger");
  // All three buttons carry the same routing value, and it round-trips through JSON.
  for (const b of btns) {
    assert.deepEqual(JSON.parse(b.value), { orgId: "org-1", decisionId: "dec-1" });
  }
});

test("composeDigestBlocks: constraintKind appends to the context line; no anchor drops the link", () => {
  const blocks = composeDigestBlocks(
    payload({ candidates: [candidate({ constraintKind: "policy", anchorUrl: null })] }),
  ) as Block[];
  const ctx = blocks[2]!;
  assert.equal((ctx.elements![0] as { text: string }).text, "scope capability:guest-checkout · confidence 85% · policy");
});

test("composeDigestBlocks: conflict warning appears only when a conflict is attached", () => {
  const withConflict = composeDigestBlocks(
    payload({
      candidates: [candidate({ conflict: { engDecisionId: "eng-1", engRuleText: "JWT only", surface: "http:POST /checkout" } })],
    }),
  ) as Block[];
  const warning = withConflict.find(
    (b) => (b as Block).type === "context" && ((b as Block).elements![0] as { text: string }).text.startsWith("⚠"),
  ) as Block | undefined;
  assert.ok(warning);
  assert.equal(
    (warning.elements![0] as { text: string }).text,
    "⚠ may conflict with a binding decision on http:POST /checkout — review both",
  );
  const without = composeDigestBlocks(payload()) as Block[];
  assert.ok(!without.some((b) => b.type === "context" && (b.elements![0] as { text: string }).text.startsWith("⚠")));
});

test("composeDigestBlocks: divider between candidates, numbering advances, ten+ falls back to digits", () => {
  const candidates = Array.from({ length: 10 }, (_, i) => candidate({ decisionId: `dec-${i}` }));
  const blocks = composeDigestBlocks(payload({ candidates })) as Block[];
  assert.equal(blocks.filter((b) => b.type === "divider").length, 9);
  const rules = blocks.filter((b) => b.type === "section" && b.text!.text.includes('"')).map((b) => b.text!.text);
  assert.match(rules[0]!, /^1️⃣ /);
  assert.match(rules[1]!, /^2️⃣ /);
  assert.match(rules[9]!, /^10\. /);
});

test("digestFallbackText: title + count, with a placeholder for untitled docs", () => {
  assert.equal(digestFallbackText(payload()), "Guest Checkout PRD: 1 constraint(s) await your ratification");
  assert.equal(
    digestFallbackText(payload({ docTitle: null, candidates: [] })),
    "A PRD: 0 constraint(s) await your ratification",
  );
});

function driftPayload(over: Partial<DriftAlertPayload> = {}): DriftAlertPayload {
  return {
    conflictId: "conf-1",
    surface: "http:POST /checkout",
    constraint: {
      ruleText: "Guest checkout must not require account creation.",
      docTitle: "Guest Checkout PRD",
      docUrl: "https://notion.example.com/prd-142",
    },
    eng: { ruleText: "Checkout requires a signed-in JWT.", author: "Dana" },
    ...over,
  };
}

test("composeDriftBlocks: surface header + both rule texts, with the doc link and author", () => {
  const blocks = composeDriftBlocks(driftPayload()) as Block[];
  assert.equal(blocks[0]!.text!.text, "⚠ Drift on `http:POST /checkout`");
  assert.equal(
    blocks[1]!.text!.text,
    '*Constraint:* "Guest checkout must not require account creation." <https://notion.example.com/prd-142|Guest Checkout PRD ↗>',
  );
  assert.equal(blocks[2]!.text!.text, '*Engineering:* "Checkout requires a signed-in JWT." — Dana');
  assert.equal((blocks[3]!.elements![0] as { text: string }).text, "may conflict — review both");
});

test("composeDriftBlocks: emits no action buttons", () => {
  const blocks = composeDriftBlocks(driftPayload()) as Block[];
  assert.ok(!blocks.some((b) => b.type === "actions"), "drift alerts are informational — no actions block");
});

test("composeDriftBlocks: missing docUrl drops the link; docTitle placeholder never surfaces", () => {
  const blocks = composeDriftBlocks(
    driftPayload({ constraint: { ruleText: "No account required.", docTitle: null, docUrl: null } }),
  ) as Block[];
  assert.equal(blocks[1]!.text!.text, '*Constraint:* "No account required."');
  assert.doesNotMatch(blocks[1]!.text!.text, /</);
});

test("composeDriftBlocks: a docUrl without a title labels the link with a placeholder", () => {
  const blocks = composeDriftBlocks(
    driftPayload({
      constraint: { ruleText: "No account required.", docTitle: null, docUrl: "https://notion.example.com/x" },
    }),
  ) as Block[];
  assert.equal(blocks[1]!.text!.text, '*Constraint:* "No account required." <https://notion.example.com/x|source doc ↗>');
});

test("composeDriftBlocks: a null author drops the trailing attribution", () => {
  const blocks = composeDriftBlocks(
    driftPayload({ eng: { ruleText: "Checkout requires a signed-in JWT.", author: null } }),
  ) as Block[];
  assert.equal(blocks[2]!.text!.text, '*Engineering:* "Checkout requires a signed-in JWT."');
});

test("composeDriftBlocks: resolve line links the web url when set, else plain text", () => {
  const prev = process.env.LOCKSTEP_WEB_URL;
  try {
    process.env.LOCKSTEP_WEB_URL = "https://app.lockstep.dev/conflicts/conf-1";
    const linked = composeDriftBlocks(driftPayload()) as Block[];
    assert.equal(
      (linked[4]!.elements![0] as { text: string }).text,
      "<https://app.lockstep.dev/conflicts/conf-1|Review & resolve in Lockstep>",
    );
    delete process.env.LOCKSTEP_WEB_URL;
    const plain = composeDriftBlocks(driftPayload()) as Block[];
    assert.equal((plain[4]!.elements![0] as { text: string }).text, "Review & resolve in the Lockstep dashboard");
  } finally {
    if (prev === undefined) delete process.env.LOCKSTEP_WEB_URL;
    else process.env.LOCKSTEP_WEB_URL = prev;
  }
});

test("driftFallbackText: names the surface and the conflict", () => {
  assert.equal(
    driftFallbackText(driftPayload()),
    "Drift on http:POST /checkout: a constraint and an engineering decision may conflict — review both",
  );
});

function weeklyPayload(over: Partial<WeeklyDigestPayload> = {}): WeeklyDigestPayload {
  return {
    projectName: "acme",
    expired: [{ scopeRef: "http:POST /payments/init" }],
    reverifyDocs: [{ title: "Guest Checkout PRD" }],
    openConflicts: 2,
    ...over,
  };
}

test("composeWeeklyBlocks: header, a line per active signal, and a dashboard link — no buttons", () => {
  const prev = process.env.LOCKSTEP_WEB_URL;
  process.env.LOCKSTEP_WEB_URL = "https://app.lockstep.dev";
  try {
    const blocks = composeWeeklyBlocks(weeklyPayload()) as Block[];
    assert.equal(blocks.length, 3);
    assert.ok((blocks[0]!.text as { text: string }).text.includes("Lockstep weekly — acme"));
    const body = (blocks[1]!.text as { text: string }).text;
    assert.ok(body.includes("*1* constraint(s) expired: `http:POST /payments/init`"));
    assert.ok(body.includes("*1* doc(s) with anchors needing reverify: Guest Checkout PRD"));
    assert.ok(body.includes("*2* open conflict(s) awaiting resolution"));
    assert.equal((blocks[2]!.elements![0] as { text: string }).text, "<https://app.lockstep.dev|Open Lockstep>");
    assert.ok(!blocks.some((b) => b.type === "actions"), "weekly digest carries no action buttons");
  } finally {
    if (prev === undefined) delete process.env.LOCKSTEP_WEB_URL;
    else process.env.LOCKSTEP_WEB_URL = prev;
  }
});

test("composeWeeklyBlocks: an all-quiet week reads the celebratory line; untitled docs get a placeholder; no web url falls back", () => {
  const prev = process.env.LOCKSTEP_WEB_URL;
  delete process.env.LOCKSTEP_WEB_URL;
  try {
    const quiet = composeWeeklyBlocks(weeklyPayload({ expired: [], reverifyDocs: [], openConflicts: 0 })) as Block[];
    assert.equal((quiet[1]!.text as { text: string }).text, "Nothing needs attention this week. 🎉");
    assert.equal((quiet[2]!.elements![0] as { text: string }).text, "Open the Lockstep dashboard");

    const untitled = composeWeeklyBlocks(weeklyPayload({ expired: [], openConflicts: 0, reverifyDocs: [{ title: null }] })) as Block[];
    assert.ok((untitled[1]!.text as { text: string }).text.includes("untitled"));
  } finally {
    if (prev === undefined) delete process.env.LOCKSTEP_WEB_URL;
    else process.env.LOCKSTEP_WEB_URL = prev;
  }
});

test("weeklyFallbackText: names the project and the three counts", () => {
  assert.equal(
    weeklyFallbackText(weeklyPayload()),
    "Lockstep weekly — acme: 1 expired, 1 reverify, 2 open conflicts",
  );
});
