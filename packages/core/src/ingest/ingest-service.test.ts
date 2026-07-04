/** Unit tests for the ingest service (connections / allowlist / watermarks / work). Real Postgres. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withSystem } from "../db/rls.js";
import { orgs, principals, members, projects } from "../db/schema.js";
import {
  createConnection,
  listConnections,
  finalizeConnection,
  addAllowlist,
  listAllowlist,
  setWatermark,
  listWork,
} from "./ingest-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 800_000_000;
const uid = (): number => ++seq;

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `SvcCo-${n}` }).returning());
    const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `u-${n}` }).returning());
    const m = one(
      await tx.insert(members).values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `u-${n}` }).returning(),
    );
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "svc", createdBy: m.id }).returning());
    return { orgId: org.id, projectId: proj.id, memberId: m.id };
  });
}

test("createConnection is idempotent per (project, tool)", async () => {
  const s = await setup();
  const a = await createConnection(s.orgId, { projectId: s.projectId, tool: "slack", entity: s.projectId, createdBy: s.memberId });
  const b = await createConnection(s.orgId, { projectId: s.projectId, tool: "slack", entity: s.projectId, createdBy: s.memberId });
  assert.equal(a.connectionId, b.connectionId);
  const conns = await listConnections(s.orgId, s.projectId);
  assert.equal(conns.filter((c) => c.tool === "slack").length, 1);
  assert.equal(conns[0]!.status, "pending");
});

test("allowlist add is an upsert that re-enables", async () => {
  const s = await setup();
  const { connectionId } = await createConnection(s.orgId, { projectId: s.projectId, tool: "slack", entity: s.projectId, createdBy: s.memberId });
  const first = await addAllowlist(s.orgId, { projectId: s.projectId, connectionId, sourceKind: "channel", sourceRef: "C1", sourceName: "#eng" });
  const again = await addAllowlist(s.orgId, { projectId: s.projectId, connectionId, sourceKind: "channel", sourceRef: "C1" });
  assert.equal(first.id, again.id, "same source ref → same row");
  const list = await listAllowlist(s.orgId, s.projectId);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.enabled, true);
});

test("setWatermark inserts then updates the cursor", async () => {
  const s = await setup();
  const { connectionId } = await createConnection(s.orgId, { projectId: s.projectId, tool: "slack", entity: s.projectId, createdBy: s.memberId });
  await setWatermark(s.orgId, connectionId, "C1", "100.0");
  await setWatermark(s.orgId, connectionId, "C1", "200.0");
  await finalizeConnection(connectionId, "acct-123");
  await addAllowlist(s.orgId, { projectId: s.projectId, connectionId, sourceKind: "channel", sourceRef: "C1", sourceName: "#eng" });
  const work = (await listWork()).find((w) => w.connectionId === connectionId);
  assert.ok(work, "active connection with an enabled source appears in work");
  assert.equal(work!.connectedAccountId, "acct-123");
  assert.equal(work!.sources.find((x) => x.sourceRef === "C1")!.cursor, "200.0", "latest watermark");
});

test("listWork excludes connections with no enabled allowlisted source", async () => {
  const s = await setup();
  const { connectionId } = await createConnection(s.orgId, { projectId: s.projectId, tool: "jira", entity: s.projectId, createdBy: s.memberId });
  await finalizeConnection(connectionId, "acct-x"); // active but no allowlist
  const work = (await listWork()).find((w) => w.connectionId === connectionId);
  assert.equal(work, undefined);
});

test("listWork excludes pending (not-yet-connected) connections", async () => {
  const s = await setup();
  const { connectionId } = await createConnection(s.orgId, { projectId: s.projectId, tool: "notion", entity: s.projectId, createdBy: s.memberId });
  await addAllowlist(s.orgId, { projectId: s.projectId, connectionId, sourceKind: "database", sourceRef: "db1" });
  const work = (await listWork()).find((w) => w.connectionId === connectionId);
  assert.equal(work, undefined, "pending connection is not swept");
});
