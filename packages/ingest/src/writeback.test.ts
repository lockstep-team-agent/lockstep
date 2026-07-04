import { test } from "node:test";
import assert from "node:assert/strict";
import { drainWritebacks } from "./writeback.js";
import { StubConnector } from "./connectors/StubConnector.js";
import type { PendingWriteback } from "./client.js";

function conflictRow(over: Partial<PendingWriteback> = {}): PendingWriteback {
  return {
    id: "wb-1",
    orgId: "org-1",
    tool: "notion",
    kind: "conflict_comment",
    targetRef: "prd-142",
    payload: { conflictId: "conf-1", anchorBlockId: "block-7", body: "⚠ This constraint may conflict…" },
    connection: { entity: "proj-1", connectedAccountId: "acct-1", tool: "notion" },
    ...over,
  };
}

function digestRow(over: Partial<PendingWriteback> = {}): PendingWriteback {
  return {
    id: "wb-2",
    orgId: "org-1",
    tool: "slack",
    kind: "slack_digest",
    targetRef: "U123",
    payload: {
      orgId: "org-1",
      documentId: "doc-1",
      docTitle: "Guest Checkout PRD",
      docUrl: "https://notion.example.com/prd-142",
      docState: "active",
      candidates: [],
    },
    connection: null,
    ...over,
  };
}

/** Records markWritebackDone calls — the drain's only side channel back to core. */
class FakeClient {
  readonly done: Array<{ id: string; ok: boolean; resultRef?: string }> = [];
  constructor(
    private readonly rows: PendingWriteback[],
    private readonly failDone = false,
  ) {}
  async getPendingWritebacks(): Promise<PendingWriteback[]> {
    return this.rows;
  }
  async markWritebackDone(id: string, ok: boolean, resultRef?: string): Promise<void> {
    if (this.failDone) throw new Error("core unreachable");
    this.done.push({ id, ok, resultRef });
  }
}

test("drainWritebacks: conflict_comment posts via the connector and acks with the comment ref", async () => {
  const client = new FakeClient([conflictRow()]);
  const stub = new StubConnector();
  const res = await drainWritebacks(client, { connectorFor: () => stub });
  assert.deepEqual(res, { posted: 1, failed: 0 });
  assert.deepEqual(stub.comments, [{ pageId: "prd-142", body: "⚠ This constraint may conflict…", anchorBlockId: "block-7" }]);
  assert.deepEqual(client.done, [{ id: "wb-1", ok: true, resultRef: "stub-comment-1" }]);
});

test("drainWritebacks: missing connector reports failure without throwing", async () => {
  const client = new FakeClient([conflictRow()]);
  const logs: string[] = [];
  const res = await drainWritebacks(client, { connectorFor: () => null, log: (m) => logs.push(m) });
  assert.deepEqual(res, { posted: 0, failed: 1 });
  assert.deepEqual(client.done, [{ id: "wb-1", ok: false, resultRef: undefined }]);
  assert.ok(logs.some((m) => m.includes("no connector")));
});

test("drainWritebacks: slack_digest composes blocks and acks with the message ts", async () => {
  const client = new FakeClient([digestRow()]);
  const sent: Array<{ token: string; user: string; blocks: unknown[]; text: string }> = [];
  const res = await drainWritebacks(client, {
    connectorFor: () => null,
    slackBotToken: "xoxb-test",
    sendDigestFn: async (token, user, blocks, text) => {
      sent.push({ token, user, blocks, text });
      return { ok: true, ts: "1699.42" };
    },
  });
  assert.deepEqual(res, { posted: 1, failed: 0 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.token, "xoxb-test");
  assert.equal(sent[0]!.user, "U123");
  assert.equal(sent[0]!.text, "Guest Checkout PRD: 0 constraint(s) await your ratification");
  assert.ok(sent[0]!.blocks.length >= 1, "composed Block Kit blocks are passed through");
  assert.deepEqual(client.done, [{ id: "wb-2", ok: true, resultRef: "1699.42" }]);
});

test("drainWritebacks: a not-ok send is acked as failed so core retries", async () => {
  const client = new FakeClient([digestRow()]);
  const res = await drainWritebacks(client, {
    connectorFor: () => null,
    slackBotToken: "xoxb-test",
    sendDigestFn: async () => ({ ok: false }),
  });
  assert.deepEqual(res, { posted: 0, failed: 1 });
  assert.deepEqual(client.done, [{ id: "wb-2", ok: false, resultRef: undefined }]);
});

test("drainWritebacks: slack_digest without a bot token never calls send", async () => {
  const client = new FakeClient([digestRow()]);
  let called = false;
  const res = await drainWritebacks(client, {
    connectorFor: () => null,
    sendDigestFn: async () => {
      called = true;
      return { ok: true };
    },
  });
  assert.deepEqual(res, { posted: 0, failed: 1 });
  assert.equal(called, false);
  assert.deepEqual(client.done, [{ id: "wb-2", ok: false, resultRef: undefined }]);
});

test("drainWritebacks: a thrown row is acked failed and the drain continues", async () => {
  const client = new FakeClient([conflictRow(), digestRow()]);
  const throwing = new StubConnector();
  throwing.writeComment = async () => {
    throw new Error("notion 503");
  };
  const res = await drainWritebacks(client, {
    connectorFor: () => throwing,
    slackBotToken: "xoxb-test",
    sendDigestFn: async () => ({ ok: true, ts: "1.0" }),
  });
  assert.deepEqual(res, { posted: 1, failed: 1 });
  assert.deepEqual(client.done, [
    { id: "wb-1", ok: false, resultRef: undefined },
    { id: "wb-2", ok: true, resultRef: "1.0" },
  ]);
});

test("drainWritebacks: even the failure ack failing doesn't abort the drain", async () => {
  const client = new FakeClient([conflictRow(), conflictRow({ id: "wb-9" })], true);
  const logs: string[] = [];
  const throwing = new StubConnector();
  throwing.writeComment = async () => {
    throw new Error("notion 503");
  };
  const res = await drainWritebacks(client, { connectorFor: () => throwing, log: (m) => logs.push(m) });
  assert.deepEqual(res, { posted: 0, failed: 2 });
  assert.equal(logs.filter((m) => m.includes("failed: notion 503")).length, 2);
});
