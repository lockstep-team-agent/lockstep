/**
 * The Slack users slug drifts across Composio versions and once broke member auto-linking silently
 * (E2E 2026-07-08). listSlackUsers now tries a fallback chain — first slug that executes wins and is
 * cached for pagination. Live verification of the winning slug is still required per Composio
 * upgrade; this test only pins the chain mechanics (order, caching, env override, exhaustion).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ComposioConnector } from "./ComposioConnector.js";

type ExecFn = (slug: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;

function connectorWithExec(fake: ExecFn): { conn: ComposioConnector; calls: string[] } {
  const conn = new ComposioConnector("k", "entity-1", "slack");
  const calls: string[] = [];
  (conn as unknown as { exec: ExecFn }).exec = async (slug, input) => {
    calls.push(slug);
    return fake(slug, input);
  };
  return { conn, calls };
}

const page = (members: unknown[], next?: string): Record<string, unknown> => ({
  members,
  ...(next ? { response_metadata: { next_cursor: next } } : {}),
});

test("slug chain: first slug failing falls through; winner is cached for pagination", async () => {
  const { conn, calls } = connectorWithExec(async (slug, input) => {
    if (slug === "SLACK_LIST_ALL_SLACK_TEAM_USERS_WITH_PAGINATION") throw new Error("unknown tool slug");
    if (slug === "SLACK_LIST_ALL_USERS") {
      return input.cursor ? page([{ id: "U2", profile: { email: "b@x.io" } }]) : page([{ id: "U1", profile: { email: "a@x.io" } }], "c1");
    }
    throw new Error("unexpected slug");
  });
  const users = await conn.listSlackUsers();
  assert.deepEqual(users, [
    { slackUserId: "U1", email: "a@x.io" },
    { slackUserId: "U2", email: "b@x.io" },
  ]);
  // Fallback tried once; the second page reuses the cached winner (no re-probe of the dead slug).
  assert.deepEqual(calls, [
    "SLACK_LIST_ALL_SLACK_TEAM_USERS_WITH_PAGINATION",
    "SLACK_LIST_ALL_USERS",
    "SLACK_LIST_ALL_USERS",
  ]);
});

test("slug chain: the current-generation slug winning first is the happy path", async () => {
  const { conn, calls } = connectorWithExec(async () => page([{ id: "U9", profile: {} }]));
  const users = await conn.listSlackUsers();
  assert.deepEqual(users, [{ slackUserId: "U9", email: null }]);
  assert.deepEqual(calls, ["SLACK_LIST_ALL_SLACK_TEAM_USERS_WITH_PAGINATION"]);
});

test("slug chain: COMPOSIO_SLACK_USERS_SLUG overrides the chain outright", async () => {
  process.env.COMPOSIO_SLACK_USERS_SLUG = "SLACK_CUSTOM_SLUG";
  try {
    const { conn, calls } = connectorWithExec(async (slug) => {
      if (slug !== "SLACK_CUSTOM_SLUG") throw new Error("chain must not be consulted");
      return page([]);
    });
    await conn.listSlackUsers();
    assert.deepEqual(calls, ["SLACK_CUSTOM_SLUG"]);
  } finally {
    delete process.env.COMPOSIO_SLACK_USERS_SLUG;
  }
});

test("slug chain: every slug failing surfaces the last error", async () => {
  const { conn } = connectorWithExec(async () => {
    throw new Error("nope");
  });
  await assert.rejects(conn.listSlackUsers(), /nope/);
});

test("listSlackUsers is empty for non-Slack tools", async () => {
  const conn = new ComposioConnector("k", "e", "notion");
  assert.deepEqual(await conn.listSlackUsers(), []);
});
