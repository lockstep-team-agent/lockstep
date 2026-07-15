/**
 * Server-side connection OAuth (Phase 1). Proves initiate persists the connectedAccountId + returns the
 * redirect URL, checkConnection finalizes once Composio reports active, and listConnectionSources returns
 * the picker list. Composio is injected (no network). Runs against a real Postgres (DATABASE_URL).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withSystem } from "../db/rls.js";
import { orgs, principals, members, projects } from "../db/schema.js";
import {
  createConnection,
  initiateConnection,
  checkConnection,
  listConnectionSources,
  listConnections,
} from "./ingest-service.js";
import type * as Composio from "./composio.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now();
const uid = (): number => ++seq;

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(
      await tx
        .insert(orgs)
        .values({ name: `OAuth-${n}` })
        .returning(),
    );
    const p = one(
      await tx
        .insert(principals)
        .values({ githubUserId: uid(), githubLogin: `u-${n}` })
        .returning(),
    );
    const m = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `u-${n}` })
        .returning(),
    );
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "oauth", createdBy: m.id }).returning());
    return { orgId: org.id, projectId: proj.id, memberId: m.id };
  });
}

const fake: Pick<typeof Composio, "link" | "isActive" | "listSources"> = {
  link: async (_tool, _entity, _callbackUrl) => ({
    redirectUrl: "https://connect.composio.dev/link/lk_x",
    connectedAccountId: "ca_test",
  }),
  isActive: async (id) => id === "ca_test",
  listSources: async (_tool, _entity) => [{ id: "C0ABC", name: "general" }],
};

test("initiate → persists connectedAccountId + returns redirectUrl", async () => {
  const s = await setup();
  const { connectionId } = await createConnection(s.orgId, {
    tool: "slack",
    createdBy: s.memberId,
  });
  const r = await initiateConnection(s.orgId, connectionId, "https://web/cb", fake);
  assert.match(r.redirectUrl, /connect\.composio\.dev/);
  const conns = await listConnections(s.orgId);
  assert.equal(conns[0]!.connectedAccountId, "ca_test");
  assert.equal(conns[0]!.status, "pending");
});

test("checkConnection finalizes to active once Composio reports active", async () => {
  const s = await setup();
  const { connectionId } = await createConnection(s.orgId, {
    tool: "slack",
    createdBy: s.memberId,
  });
  await initiateConnection(s.orgId, connectionId, "https://web/cb", fake);
  const chk = await checkConnection(s.orgId, connectionId, fake);
  assert.equal(chk.status, "active");
  assert.equal((await listConnections(s.orgId))[0]!.status, "active");
});

test("listConnectionSources returns picker list only when active", async () => {
  const s = await setup();
  const { connectionId } = await createConnection(s.orgId, {
    tool: "slack",
    createdBy: s.memberId,
  });
  assert.deepEqual(await listConnectionSources(s.orgId, connectionId, fake), [], "empty until active");
  await initiateConnection(s.orgId, connectionId, "https://web/cb", fake);
  await checkConnection(s.orgId, connectionId, fake);
  assert.deepEqual(await listConnectionSources(s.orgId, connectionId, fake), [{ id: "C0ABC", name: "general" }]);
});
