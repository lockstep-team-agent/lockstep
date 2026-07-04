/**
 * Slack interactivity: signature verification (pure, always runs) and the webhook route via
 * inject(). Full-flow assertions run only when LOCKSTEP_SLACK_SIGNING_SECRET is set (the coverage
 * script sets it; plain `test` covers the 503 branch) — the same conditional pattern as the worker
 * endpoints in ingest.api.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { env } from "../../env.js";
import { verifySlackSignature } from "../../auth/slack-verify.js";
import { withSystem, withOrg } from "../../db/rls.js";
import {
  orgs,
  principals,
  members,
  projects,
  projectMembers,
  decisions,
} from "../../db/schema.js";
import { registerDocument, setDocumentState, fileDocCandidates, listDocuments } from "../../documents/document-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 800_000_000;
const uid = (): number => ++seq;

const SECRET = "test-slack-secret";

function sign(body: string, secret = SECRET, ts = Math.floor(Date.now() / 1000).toString()) {
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
  return { "x-slack-request-timestamp": ts, "x-slack-signature": signature, "content-type": "application/x-www-form-urlencoded" };
}

test("verifySlackSignature: valid, tampered, stale, malformed", () => {
  const body = "payload=%7B%7D";
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sig, rawBody: body }), true);
  assert.equal(
    verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sig, rawBody: body + "x" }),
    false,
    "tampered body fails",
  );
  assert.equal(
    verifySlackSignature({ signingSecret: "other", timestamp: ts, signature: sig, rawBody: body }),
    false,
    "wrong secret fails",
  );
  const staleTs = (Math.floor(Date.now() / 1000) - 600).toString();
  const staleSig = `v0=${createHmac("sha256", SECRET).update(`v0:${staleTs}:${body}`).digest("hex")}`;
  assert.equal(
    verifySlackSignature({ signingSecret: SECRET, timestamp: staleTs, signature: staleSig, rawBody: body }),
    false,
    ">5 min skew is replay-rejected",
  );
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: undefined, signature: sig, rawBody: body }), false);
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: "not-a-number", signature: sig, rawBody: body }), false);
  assert.equal(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: "v0=short", rawBody: body }), false);
});

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `SlackCo-${n}` }).returning());
    const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `priya-${n}` }).returning());
    const priya = one(
      await tx
        .insert(members)
        .values({
          orgId: org.id,
          principalId: p.id,
          githubUserId: p.githubUserId,
          githubLogin: `priya-${n}`,
          slackUserId: `U${n}`,
        })
        .returning(),
    );
    const proj = one(
      await tx
        .insert(projects)
        .values({ orgId: org.id, name: "slack-proj", settings: { productLayer: { enabled: true } } })
        .returning(),
    );
    await tx.insert(projectMembers).values({
      orgId: org.id,
      projectId: proj.id,
      memberId: priya.id,
      invitedGithubLogin: priya.githubLogin,
      role: "pm",
      status: "active",
    });
    return { orgId: org.id, projectId: proj.id, priya: priya.id, slackUserId: `U${n}` };
  });
}

/** A ratifiable constraint on an active native doc, filed through the real pipeline. */
async function seedConstraint(s: Awaited<ReturnType<typeof setup>>): Promise<string> {
  const h = uid().toString(16).padStart(12, "0");
  const pageId = `00000000-0000-4000-8000-${h}`;
  const scopeRef = `feature:guest-checkout-${h}`;
  const reg = await registerDocument(s.orgId, {
    projectId: s.projectId,
    memberId: s.priya,
    url: `https://notion.so/prd-${pageId}`,
  });
  await fileDocCandidates(reg.documentId, [
    {
      scopeKind: "capability",
      scopeRef,
      ruleText: "Guests must be able to complete checkout without creating an account.",
      constraintKind: "behavioral",
      expiresAt: null,
      expiresHint: "",
      lowConfidence: false,
      confidence: 90,
      externalId: `${pageId}#blk-1`,
      contentHash: `h-${h}`,
      anchor: { type: "notion_block", pageId, blockId: "blk-1", headingPath: ["Requirements"], snippet: "checkout without an account" },
      evidence: [{ externalId: `${pageId}#blk-1`, quote: "Guests must be able to complete checkout without creating an account." }],
      rationale: "",
    },
  ]);
  await setDocumentState(s.orgId, reg.documentId, s.priya, "active");
  const d = await withOrg(s.orgId, (tx) =>
    tx
      .select()
      .from(decisions)
      .where(and(eq(decisions.projectId, s.projectId), eq(decisions.scopeRef, scopeRef))),
  );
  return one(d).id;
}

function actionBody(orgId: string, decisionId: string, slackUserId: string, actionId = "ratify") {
  const payload = {
    type: "block_actions",
    user: { id: slackUserId },
    actions: [{ action_id: actionId, value: JSON.stringify({ orgId, decisionId }) }],
    // point response_url at nowhere routable-fast; replies are fire-and-forget
    response_url: "http://127.0.0.1:1/slack-response",
  };
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

test("slack actions route: signature gate, unmapped user, ratify + edit-submission flows", async (t) => {
  const app: FastifyInstance = buildApp();
  t.after(() => app.close());

  if (!env.LOCKSTEP_SLACK_SIGNING_SECRET) {
    const res = await app.inject({ method: "POST", url: "/webhooks/slack/actions", payload: "payload=%7B%7D", headers: { "content-type": "application/x-www-form-urlencoded" } });
    assert.equal(res.statusCode, 503, "unconfigured interactivity is a clean 503");
    return;
  }
  assert.equal(env.LOCKSTEP_SLACK_SIGNING_SECRET, SECRET, "test secret expected");

  const s = await setup();
  const decisionId = await seedConstraint(s);

  // Bad signature → 401, nothing mutated.
  const body = actionBody(s.orgId, decisionId, s.slackUserId);
  const bad = await app.inject({
    method: "POST",
    url: "/webhooks/slack/actions",
    payload: body,
    headers: { ...sign(body, "wrong-secret") },
  });
  assert.equal(bad.statusCode, 401);

  // Unmapped Slack user → 200 (link-account reply via response_url), no mutation.
  const unmappedBody = actionBody(s.orgId, decisionId, "U_NOBODY");
  const unmapped = await app.inject({
    method: "POST",
    url: "/webhooks/slack/actions",
    payload: unmappedBody,
    headers: sign(unmappedBody),
  });
  assert.equal(unmapped.statusCode, 200);
  let d = await withOrg(s.orgId, (tx) => tx.select().from(decisions).where(eq(decisions.id, decisionId)));
  assert.equal(d[0]!.status, "proposed", "unmapped user cannot mutate");

  // Mapped PM taps Ratify → binding.
  const ok = await app.inject({ method: "POST", url: "/webhooks/slack/actions", payload: body, headers: sign(body) });
  assert.equal(ok.statusCode, 200);
  d = await withOrg(s.orgId, (tx) => tx.select().from(decisions).where(eq(decisions.id, decisionId)));
  assert.equal(d[0]!.status, "binding", "Slack ratify is the same mutation as the dashboard");

  // Edit-modal submission ratifies a second constraint with edited text.
  const decision2 = await seedConstraint(s);
  const submission = {
    type: "view_submission",
    user: { id: s.slackUserId },
    view: {
      callback_id: "lockstep_ratify_edit",
      private_metadata: JSON.stringify({ orgId: s.orgId, decisionId: decision2 }),
      state: { values: { rule: { rule_text: { value: "Guests can check out without an account (edited via Slack)." } } } },
    },
  };
  const subBody = `payload=${encodeURIComponent(JSON.stringify(submission))}`;
  const sub = await app.inject({ method: "POST", url: "/webhooks/slack/actions", payload: subBody, headers: sign(subBody) });
  assert.equal(sub.statusCode, 200);
  assert.equal(sub.json().response_action, "clear");
  const d2 = await withOrg(s.orgId, (tx) => tx.select().from(decisions).where(eq(decisions.id, decision2)));
  assert.equal(d2[0]!.status, "binding");
  assert.equal(d2[0]!.currentVersion, 2, "edited ratification appended a CAS version");

  // Reject via button on a third constraint.
  const decision3 = await seedConstraint(s);
  const rejBody = actionBody(s.orgId, decision3, s.slackUserId, "reject");
  const rej = await app.inject({ method: "POST", url: "/webhooks/slack/actions", payload: rejBody, headers: sign(rejBody) });
  assert.equal(rej.statusCode, 200);
  const d3 = await withOrg(s.orgId, (tx) => tx.select().from(decisions).where(eq(decisions.id, decision3)));
  assert.equal(d3[0]!.status, "rejected");

  // Edit button → views.open modal with the current rule text (fetch stubbed — no Slack in tests).
  const realFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; body: string }> = [];
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    fetchCalls.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  try {
    const decision4 = await seedConstraint(s);
    const editBody = actionBody(s.orgId, decision4, s.slackUserId, "edit");
    const edit = await app.inject({ method: "POST", url: "/webhooks/slack/actions", payload: editBody, headers: sign(editBody) });
    assert.equal(edit.statusCode, 200);
    if (env.SLACK_BOT_TOKEN) {
      const modal = fetchCalls.find((c) => c.url.includes("views.open"));
      assert.ok(modal, "edit opens the Slack modal");
      assert.ok(modal!.body.includes("lockstep_ratify_edit"));
      assert.ok(modal!.body.includes("without creating an account"), "modal is pre-filled with the current rule text");
    }

    // A failing mutation replies via response_url instead of crashing the webhook.
    const again = actionBody(s.orgId, decision3, s.slackUserId, "ratify"); // decision3 is already rejected
    const err = await app.inject({ method: "POST", url: "/webhooks/slack/actions", payload: again, headers: sign(again) });
    assert.equal(err.statusCode, 200);
    await new Promise((r) => setTimeout(r, 20)); // let the fire-and-forget reply flush
    const replied = fetchCalls.find((c) => c.url.includes("slack-response") && c.body.includes("Could not complete"));
    assert.ok(replied, "error is reported back to the user via response_url");
  } finally {
    globalThis.fetch = realFetch;
  }
});
