/**
 * The produced-surface catalog + graph-resolved consumes (IMPROVEMENTS #11/#1). Proves:
 *   - syncProducedSurfaces registers a repo's produces into the catalog, idempotently
 *   - listProjectSurfaces returns the project-wide catalog with the producing repo
 *   - registerDependency auto-resolves the producer from the catalog (closed-world matching),
 *     and self-heals an edge created before the producer onboarded.
 *
 * Runs against a real Postgres (DATABASE_URL), service layer direct (no session/auth plumbing).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withSystem } from "../db/rls.js";
import { orgs, principals, members, projects, repos, dependencyEdges } from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { registerDependency, syncProducedSurfaces, listProjectSurfaces } from "./ledger-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}

let seq = Date.now();
const uid = (): number => ++seq;
const SURFACE = "http:GET /inventory/:sku";

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(
      await tx
        .insert(orgs)
        .values({ name: `Cat-${n}` })
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
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "cat", createdBy: m.id }).returning());
    const invRepo = one(
      await tx
        .insert(repos)
        .values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/c/inv-${n}` })
        .returning(),
    );
    const webRepo = one(
      await tx
        .insert(repos)
        .values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/c/web-${n}` })
        .returning(),
    );
    return {
      orgId: org.id,
      projectId: proj.id,
      memberId: m.id,
      invRepo: invRepo.id,
      webRepo: webRepo.id,
      remote: `github.com/c/inv-${n}`,
    };
  });
}

test("syncProducedSurfaces is idempotent and feeds listProjectSurfaces", async () => {
  const s = await setup();
  const first = await syncProducedSurfaces(s.orgId, {
    projectId: s.projectId,
    repoId: s.invRepo,
    memberId: s.memberId,
    surfaces: [SURFACE, "http:POST /inventory"],
  });
  assert.equal(first.added, 2);
  const second = await syncProducedSurfaces(s.orgId, {
    projectId: s.projectId,
    repoId: s.invRepo,
    surfaces: [SURFACE],
  });
  assert.equal(second.added, 0, "re-sync adds nothing");

  const catalog = await listProjectSurfaces(s.orgId, s.projectId);
  const entry = catalog.find((c) => c.surface === SURFACE);
  assert.ok(entry, "surface in catalog");
  assert.equal(entry!.repoId, s.invRepo);
  assert.equal(entry!.gitRemote, s.remote);
});

test("registerDependency resolves the producer from the catalog", async () => {
  const s = await setup();
  await syncProducedSurfaces(s.orgId, { projectId: s.projectId, repoId: s.invRepo, surfaces: [SURFACE] });

  // Web repo declares it consumes the surface — producer should be auto-filled from the catalog.
  const { edgeId } = await registerDependency(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    consumerRepoId: s.webRepo,
    producedSurface: SURFACE,
    source: "manifest",
  });
  const edge = await withSystem((tx) =>
    tx.select().from(dependencyEdges).where(eq(dependencyEdges.id, edgeId)).limit(1).then(one),
  );
  assert.equal(edge.producedRepoId, s.invRepo, "producer resolved by closed-world catalog match");
});

test("an edge created before the producer onboarded self-heals on re-sync", async () => {
  const s = await setup();
  // Consumer declares first — no producer in the catalog yet.
  const { edgeId } = await registerDependency(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    consumerRepoId: s.webRepo,
    producedSurface: SURFACE,
  });
  const before = await withSystem((tx) =>
    tx.select().from(dependencyEdges).where(eq(dependencyEdges.id, edgeId)).limit(1).then(one),
  );
  assert.equal(before.producedRepoId, null, "no producer known yet");

  // Producer onboards, then the consumer re-syncs (idempotent path) → producer backfilled.
  await syncProducedSurfaces(s.orgId, { projectId: s.projectId, repoId: s.invRepo, surfaces: [SURFACE] });
  await registerDependency(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    consumerRepoId: s.webRepo,
    producedSurface: SURFACE,
  });
  const after = await withSystem((tx) =>
    tx
      .select()
      .from(dependencyEdges)
      .where(and(eq(dependencyEdges.id, edgeId)))
      .limit(1)
      .then(one),
  );
  assert.equal(after.producedRepoId, s.invRepo, "producer backfilled on re-sync");
});
