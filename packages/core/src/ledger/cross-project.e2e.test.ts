/**
 * Cross-project dependency edges (#4), service-layer against real Postgres (DATABASE_URL).
 * Resolution: same-project first, then org-wide among SHARED projects; walled projects are fully
 * invisible to resolution and catalog. Impact counts consumers org-wide; fan-out stays project-local.
 * The cross-project payload is surface + repo + project name only — never rule text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { withSystem, withOrg } from "../db/rls.js";
import { orgs, principals, members, projects, projectMembers, repos, dependencyEdges, inboxItems, inboxes } from "../db/schema.js";
import {
  syncProducedSurfaces,
  registerDependency,
  listProjectSurfaces,
  listConsumers,
  proposeDecision,
} from "./ledger-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 900_000_000;
const uid = (): number => ++seq;

/** One org, P1 (producer project) + P2 (consumer project), each with a repo + a member. */
async function setup(p1Settings: object = {}) {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `XP-${n}` }).returning());
    const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: `u-${n}` }).returning());
    const m = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: `u-${n}` })
        .returning(),
    );
    const p1 = one(await tx.insert(projects).values({ orgId: org.id, name: "producer-proj", createdBy: m.id, settings: p1Settings }).returning());
    const p2 = one(await tx.insert(projects).values({ orgId: org.id, name: "consumer-proj", createdBy: m.id }).returning());
    const r1 = one(await tx.insert(repos).values({ orgId: org.id, projectId: p1.id, gitRemote: `github.com/xp/producer-${n}` }).returning());
    const r2 = one(await tx.insert(repos).values({ orgId: org.id, projectId: p2.id, gitRemote: `github.com/xp/consumer-${n}` }).returning());
    await tx.insert(projectMembers).values({ orgId: org.id, projectId: p1.id, memberId: m.id, invitedGithubLogin: m.githubLogin, role: "owner", status: "active" });
    return { orgId: org.id, p1: p1.id, p2: p2.id, r1: r1.id, r2: r2.id, memberId: m.id, producerRemote: r1.gitRemote };
  });
}

const SURFACE = "http:GET /inventory/:sku";

test("cross-project resolution: P2's dependency resolves P1's shared producer; catalog carries the project name", async () => {
  const s = await setup();
  await syncProducedSurfaces(s.orgId, { projectId: s.p1, repoId: s.r1, surfaces: [SURFACE] });

  // P2's catalog sees P1's surface, attributed — surface/repo/name only.
  const catalog = await listProjectSurfaces(s.orgId, s.p2);
  const entry = catalog.find((e) => e.surface === SURFACE);
  assert.ok(entry, "shared sibling project's surface is in the catalog");
  assert.equal(entry!.crossProject, true);
  assert.equal(entry!.projectName, "producer-proj");
  assert.equal(entry!.gitRemote, s.producerRemote);

  // registerDependency from P2 resolves the producer repo across the project boundary.
  const { edgeId } = await registerDependency(s.orgId, {
    projectId: s.p2,
    memberId: s.memberId,
    consumerRepoId: s.r2,
    producedSurface: SURFACE,
  });
  const edge = one(await withOrg(s.orgId, (tx) => tx.select().from(dependencyEdges).where(eq(dependencyEdges.id, edgeId))));
  assert.equal(edge.producedRepoId, s.r1, "cross-project producer resolved");
  assert.equal(edge.projectId, s.p2, "the edge belongs to the consumer's project");
});

test("walled producer project is invisible: no catalog entry, no resolution", async () => {
  const s = await setup({ visibility: "walled" });
  await syncProducedSurfaces(s.orgId, { projectId: s.p1, repoId: s.r1, surfaces: [SURFACE] });

  const catalog = await listProjectSurfaces(s.orgId, s.p2);
  assert.equal(catalog.find((e) => e.surface === SURFACE), undefined, "walled project contributes nothing");

  const { edgeId } = await registerDependency(s.orgId, {
    projectId: s.p2,
    memberId: s.memberId,
    consumerRepoId: s.r2,
    producedSurface: SURFACE,
  });
  const edge = one(await withOrg(s.orgId, (tx) => tx.select().from(dependencyEdges).where(eq(dependencyEdges.id, edgeId))));
  assert.equal(edge.producedRepoId, null, "walled producer never resolves");
});

test("same-project producer wins over a cross-project one for the same surface", async () => {
  const s = await setup();
  // A repo in P2 also produces the surface.
  const local = await withSystem(async (tx) =>
    one(await tx.insert(repos).values({ orgId: s.orgId, projectId: s.p2, gitRemote: `github.com/xp/local-${uid()}` }).returning()),
  );
  await syncProducedSurfaces(s.orgId, { projectId: s.p1, repoId: s.r1, surfaces: [SURFACE] });
  await syncProducedSurfaces(s.orgId, { projectId: s.p2, repoId: local.id, surfaces: [SURFACE] });

  const { edgeId } = await registerDependency(s.orgId, {
    projectId: s.p2,
    memberId: s.memberId,
    consumerRepoId: s.r2,
    producedSurface: SURFACE,
  });
  const edge = one(await withOrg(s.orgId, (tx) => tx.select().from(dependencyEdges).where(eq(dependencyEdges.id, edgeId))));
  assert.equal(edge.producedRepoId, local.id, "same-project match beats cross-project");
});

test("impact counts org-wide consumers: a P1 decision on the surface needs an ack; fan-out stays within P1", async () => {
  const s = await setup();
  await syncProducedSurfaces(s.orgId, { projectId: s.p1, repoId: s.r1, surfaces: [SURFACE] });
  await registerDependency(s.orgId, {
    projectId: s.p2,
    memberId: s.memberId,
    consumerRepoId: s.r2,
    producedSurface: SURFACE,
  });

  const r = await proposeDecision(s.orgId, {
    projectId: s.p1,
    memberId: s.memberId,
    scopeKind: "surface",
    scopeRef: SURFACE,
    ruleText: "Inventory lookups are cached for one minute.",
    baseVersion: 0,
  });
  assert.ok(r.impact >= 1, "the other project's consumer counts toward blast radius");
  assert.equal(r.status, "open", "cross-cutting (via a cross-project consumer) needs an ack, not bind-on-assertion");

  // Deliberate deferral: notification fan-out stays project-local — nothing lands in P2 inboxes.
  const p2Items = await withOrg(s.orgId, (tx) =>
    tx
      .select({ id: inboxItems.id })
      .from(inboxItems)
      .innerJoin(inboxes, eq(inboxItems.inboxId, inboxes.id))
      .where(and(eq(inboxes.projectId, s.p2), eq(inboxItems.refId, r.decisionId))),
  );
  assert.equal(p2Items.length, 0, "cross-project consumers are counted, not notified (explicit deferral)");
});

test("listConsumers: org-wide count; walled consumers appear in the count but never by name", async () => {
  const s = await setup();
  await syncProducedSurfaces(s.orgId, { projectId: s.p1, repoId: s.r1, surfaces: [SURFACE] });
  await registerDependency(s.orgId, {
    projectId: s.p2,
    memberId: s.memberId,
    consumerRepoId: s.r2,
    producedSurface: SURFACE,
  });

  let res = await listConsumers(s.orgId, s.p1, SURFACE);
  assert.equal(res.count, 1);
  assert.equal(res.consumers[0]!.projectName, "consumer-proj", "shared consumer named with its project");

  // Wall P2 → the consumer stays in the count, vanishes from the detail.
  await withOrg(s.orgId, (tx) => tx.update(projects).set({ settings: { visibility: "walled" } }).where(eq(projects.id, s.p2)));
  res = await listConsumers(s.orgId, s.p1, SURFACE);
  assert.equal(res.count, 1, "the count never lies");
  assert.equal(res.consumers.length, 0, "no identity leak for walled consumers");
});
