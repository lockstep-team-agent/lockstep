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
    const proj2 = one(await tx.insert(projects).values({ orgId: org.id, name: "svc2", createdBy: m.id }).returning());
    return { orgId: org.id, projectId: proj.id, projectId2: proj2.id, memberId: m.id };
  });
}

test("createConnection is org-level: idempotent per (org, tool) across projects, entity = orgId (#10)", async () => {
  const s = await setup();
  const a = await createConnection(s.orgId, { tool: "slack", createdBy: s.memberId });
  const b = await createConnection(s.orgId, { tool: "slack", createdBy: s.memberId });
  assert.equal(a.connectionId, b.connectionId, "second connect from anywhere reuses the org connection");
  assert.equal(a.entity, s.orgId, "new connections OAuth under the org id");
  const conns = await listConnections(s.orgId);
  assert.equal(conns.filter((c) => c.tool === "slack").length, 1);
  assert.equal(conns[0]!.status, "pending");
});

test("allowlist add is an upsert that re-enables; a cross-project steal is a 409 (#10)", async () => {
  const s = await setup();
  const { connectionId } = await createConnection(s.orgId, { tool: "slack", createdBy: s.memberId });
  const first = await addAllowlist(s.orgId, { projectId: s.projectId, connectionId, sourceKind: "channel", sourceRef: "C1", sourceName: "#eng" });
  const again = await addAllowlist(s.orgId, { projectId: s.projectId, connectionId, sourceKind: "channel", sourceRef: "C1" });
  assert.equal(first.id, again.id, "same source ref, same project → same row");
  const list = await listAllowlist(s.orgId, s.projectId);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.enabled, true);
  // One channel routes to exactly one project — re-adding under another project must not steal it.
  await assert.rejects(
    addAllowlist(s.orgId, { projectId: s.projectId2, connectionId, sourceKind: "channel", sourceRef: "C1" }),
    /already routed to another project/,
  );
});

test("setWatermark inserts then updates the cursor; work sources carry their allowlist row's project", async () => {
  const s = await setup();
  const { connectionId } = await createConnection(s.orgId, { tool: "slack", createdBy: s.memberId });
  await setWatermark(s.orgId, connectionId, "C1", "100.0");
  await setWatermark(s.orgId, connectionId, "C1", "200.0");
  await finalizeConnection(connectionId, "acct-123");
  await addAllowlist(s.orgId, { projectId: s.projectId, connectionId, sourceKind: "channel", sourceRef: "C1", sourceName: "#eng" });
  const work = (await listWork()).find((w) => w.connectionId === connectionId);
  assert.ok(work, "active connection with an enabled source appears in work");
  assert.equal(work!.connectedAccountId, "acct-123");
  const src = work!.sources.find((x) => x.sourceRef === "C1")!;
  assert.equal(src.cursor, "200.0", "latest watermark");
  assert.equal(src.projectId, s.projectId, "routing lives on the source, from its allowlist row");
});

test("one org connection feeds two projects — each source routes to its own project (#10)", async () => {
  const s = await setup();
  const { connectionId } = await createConnection(s.orgId, { tool: "slack", createdBy: s.memberId });
  await finalizeConnection(connectionId, "acct-multi");
  await addAllowlist(s.orgId, { projectId: s.projectId, connectionId, sourceKind: "channel", sourceRef: "C-a", sourceName: "#a" });
  await addAllowlist(s.orgId, { projectId: s.projectId2, connectionId, sourceKind: "channel", sourceRef: "C-b", sourceName: "#b" });
  const work = (await listWork()).find((w) => w.connectionId === connectionId);
  assert.ok(work);
  assert.equal(work!.sources.length, 2);
  assert.equal(work!.sources.find((x) => x.sourceRef === "C-a")!.projectId, s.projectId);
  assert.equal(work!.sources.find((x) => x.sourceRef === "C-b")!.projectId, s.projectId2);
});

test("legacy connection shape (project_id NULLed by 0006, old entity) still sweeps", async () => {
  const s = await setup();
  const { connectionId, entity } = await createConnection(s.orgId, { tool: "jira", createdBy: s.memberId });
  await finalizeConnection(connectionId, "acct-legacy");
  await addAllowlist(s.orgId, { projectId: s.projectId, connectionId, sourceKind: "project", sourceRef: "PROJ" });
  const work = (await listWork()).find((w) => w.connectionId === connectionId);
  assert.ok(work, "connection with a NULL project_id is org-level and sweepable");
  assert.equal(work!.entity, entity, "whatever entity the OAuth account was linked under is passed through");
});

test("listWork excludes connections with no enabled allowlisted source", async () => {
  const s = await setup();
  const { connectionId } = await createConnection(s.orgId, { tool: "confluence", createdBy: s.memberId });
  await finalizeConnection(connectionId, "acct-x"); // active but no allowlist
  const work = (await listWork()).find((w) => w.connectionId === connectionId);
  assert.equal(work, undefined);
});

test("listWork excludes pending (not-yet-connected) connections", async () => {
  const s = await setup();
  const { connectionId } = await createConnection(s.orgId, { tool: "notion", createdBy: s.memberId });
  await addAllowlist(s.orgId, { projectId: s.projectId, connectionId, sourceKind: "database", sourceRef: "db1" });
  const work = (await listWork()).find((w) => w.connectionId === connectionId);
  assert.equal(work, undefined, "pending connection is not swept");
});
