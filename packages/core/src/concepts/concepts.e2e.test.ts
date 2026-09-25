/**
 * Concept ledger against real Postgres: stable surfaces, deterministic placement, the queue's
 * correctness rules (dedupe, dirty re-runs, lease expiry, revision guard, retry/terminal failure,
 * no_provider recovery), field-scoped overrides, merge aliases, non-destructive rebuilds and RLS.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { withOrg, withSystem } from "../db/rls.js";
import {
  conceptPlacements,
  conceptRebuilds,
  conceptRefs,
  conceptTasks,
  concepts,
  decisions,
  domains,
  graphEdges,
  graphNodes,
  members,
  orgs,
  principals,
  projectMembers,
  projects,
  repos,
  surfaces,
} from "../db/schema.js";
import { proposeDecision, syncProducedSurfaces } from "../ledger/ledger-service.js";
import {
  enqueueTx,
  mergeConcepts,
  placeItem,
  renameConcept,
  requestRebuild,
  setConceptDomain,
} from "./concept-service.js";
import { drainConceptTasks, retryDelayMs, type Classifier } from "./queue.js";
import { getOutline, getOutlineGroup, getConceptContracts } from "./read.js";
import type { ChoiceInput } from "./classify.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 990_000_000;
const uid = (): number => ++seq;

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(
      await tx
        .insert(orgs)
        .values({ name: `Concepts-${n}` })
        .returning(),
    );
    const p = one(
      await tx
        .insert(principals)
        .values({ githubUserId: uid(), githubLogin: `pat-${n}` })
        .returning(),
    );
    const pat = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: p.githubLogin })
        .returning(),
    );
    const proj = one(
      await tx.insert(projects).values({ orgId: org.id, name: "concepts", createdBy: pat.id }).returning(),
    );
    await tx.insert(projectMembers).values({
      orgId: org.id,
      projectId: proj.id,
      memberId: pat.id,
      invitedGithubLogin: pat.githubLogin,
      role: "owner",
      status: "active",
    });
    const api = one(
      await tx
        .insert(repos)
        .values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/t/api-${n}` })
        .returning(),
    );
    return { orgId: org.id, projectId: proj.id, memberId: pat.id, repoId: api.id };
  });
}
type S = Awaited<ReturnType<typeof setup>>;

const sync = (s: S, list: unknown[]) =>
  syncProducedSurfaces(s.orgId, { projectId: s.projectId, repoId: s.repoId, memberId: s.memberId, surfaces: list });

/** A classifier that always picks the first option (or a chosen one) with fixed confidence. */
const pickFirst: Classifier = async (input) => ({
  ok: true,
  choice: Object.keys(input.options)[0]!,
  confidence: 0.9,
  classifier: "jev",
});
const pickWhere =
  (pred: (label: string) => boolean): Classifier =>
  async (input) => {
    const hit = Object.entries(input.options).find(([, l]) => pred(l)) ?? Object.entries(input.options)[0]!;
    return { ok: true, choice: hit[0], confidence: 0.9, classifier: "jev" };
  };

const makeDue = (s: S) =>
  withSystem((tx) =>
    tx.execute(
      sql`UPDATE concept_tasks SET next_attempt_at = now() WHERE project_id = ${s.projectId} AND state = 'queued'`,
    ),
  );

async function drainAll(s: S, classify: Classifier, rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await makeDue(s);
    const r = await drainConceptTasks({ classify, projectId: s.projectId, keys: {} });
    if (r.claimed === 0) return;
  }
}

const tasksOf = (s: S) =>
  withSystem((tx) => tx.select().from(conceptTasks).where(eq(conceptTasks.projectId, s.projectId)));
const conceptByKey = (s: S, key: string) =>
  withSystem(async (tx) =>
    one(
      await tx
        .select()
        .from(concepts)
        .where(and(eq(concepts.projectId, s.projectId), eq(concepts.key, key))),
    ),
  );
const placementOf = (s: S, itemId: string) =>
  withSystem(async (tx) => one(await tx.select().from(conceptPlacements).where(eq(conceptPlacements.itemId, itemId))));

test("sync: surfaces get a stable row, a concept and an auto-confirmed placement; domain is only suggested", async () => {
  const s = await setup();
  await sync(s, ["http:GET /api/v1/users/me/cards", "http:POST /api/v1/users", "http:GET /v2/orders/:id"]);
  const users = await conceptByKey(s, "http:users");
  assert.equal(users.domainState, "pending");
  const surf = await withSystem((tx) => tx.select().from(surfaces).where(eq(surfaces.projectId, s.projectId)));
  assert.equal(surf.length, 3);
  for (const x of surf) {
    const p = await placementOf(s, x.id);
    assert.equal(p.state, "confirmed");
    assert.equal(p.classifier, "rule");
  }
  await drainAll(
    s,
    pickWhere((l) => l.startsWith("Users")),
  );
  const after = await conceptByKey(s, "http:users");
  assert.equal(after.domainState, "suggested", "model output is never auto-confirmed");
  const d = await withSystem(async (tx) => one(await tx.select().from(domains).where(eq(domains.id, after.domainId!))));
  assert.equal(d.label, "Users & Accounts");

  const outline = await getOutline(s.orgId, s.projectId);
  const dom = outline.domains.find((x) => x.label === "Users & Accounts")!;
  assert.equal(dom.concepts[0]!.key, "http:users");
  assert.equal(dom.concepts[0]!.counts.surfaces, 2);
});

test("a double enqueue creates exactly one live task", async () => {
  const s = await setup();
  await sync(s, ["http:GET /a"]);
  const c = await conceptByKey(s, "http:a");
  await withOrg(s.orgId, async (tx) => {
    for (let i = 0; i < 3; i++) {
      await enqueueTx(tx, {
        orgId: s.orgId,
        projectId: s.projectId,
        kind: "place_concept",
        dedupeKey: `place_concept:${c.id}`,
        payload: { conceptId: c.id },
        requiredInputVersion: 1,
      });
    }
  });
  const live = (await tasksOf(s)).filter(
    (t) => t.dedupeKey === `place_concept:${c.id}` && (t.state === "queued" || t.state === "running"),
  );
  assert.equal(live.length, 1);
});

test("input changing during classification: stale result discarded, task re-runs on the latest input", async () => {
  const s = await setup();
  await sync(s, ["http:GET /billing/invoices", "http:GET /auth/login"]);
  const r1 = await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    scopeKind: "topic",
    scopeRef: "money",
    ruleText: "Invoices must be immutable once issued",
    baseVersion: 0,
  });
  const seen: string[] = [];
  let mutated = false;
  const classify: Classifier = async (input: ChoiceInput) => {
    if ("concept" in input.subject) return pickFirst(input);
    seen.push(String(input.subject.rule));
    if (!mutated) {
      mutated = true;
      // a new version lands while the model is thinking
      await proposeDecision(s.orgId, {
        projectId: s.projectId,
        memberId: s.memberId,
        scopeKind: "topic",
        scopeRef: "money",
        ruleText: "Login attempts must be rate limited",
        baseVersion: 1,
      });
      return pickWhere((l) => l.includes("billing"))(input);
    }
    return pickWhere((l) => l.includes("auth"))(input);
  };
  await drainAll(s, classify);
  assert.deepEqual(seen, ["Invoices must be immutable once issued", "Login attempts must be rate limited"]);
  const p = await placementOf(s, r1.decisionId);
  const auth = await conceptByKey(s, "http:auth");
  assert.equal(p.conceptId, auth.id, "the latest input's answer won; the stale one was discarded");
  assert.equal(p.state, "suggested");
});

test("an expired lease cannot commit even with the right token", async () => {
  const s = await setup();
  await sync(s, ["http:GET /widgets"]);
  const c = await conceptByKey(s, "http:widgets");
  const classify: Classifier = async (input) => {
    await withSystem((tx) =>
      tx.execute(
        sql`UPDATE concept_tasks SET locked_until = now() - interval '1 second' WHERE project_id = ${s.projectId}`,
      ),
    );
    return pickFirst(input);
  };
  await makeDue(s);
  const r = await drainConceptTasks({ classify, projectId: s.projectId, keys: {} });
  assert.equal(r.lease_lost, 1);
  assert.equal((await conceptByKey(s, "http:widgets")).domainId, null, "nothing written");
  assert.equal(c.domainState, "pending");
});

test("rename pins the label only: automatic domain placement continues", async () => {
  const s = await setup();
  await sync(s, ["http:GET /pay"]);
  await drainAll(
    s,
    pickWhere((l) => l.startsWith("Identity")),
  );
  const c = await conceptByKey(s, "http:pay");
  await renameConcept(s.orgId, s.projectId, c.id, "Payments", s.memberId);
  await drainAll(
    s,
    pickWhere((l) => l.startsWith("Payments")),
  );
  const after = await conceptByKey(s, "http:pay");
  assert.equal(after.label, "Payments");
  const d = await withSystem(async (tx) => one(await tx.select().from(domains).where(eq(domains.id, after.domainId!))));
  assert.equal(d.label, "Payments & Billing", "re-classified after rename");
  // …but a domain pin sticks
  await setConceptDomain(
    s.orgId,
    s.projectId,
    c.id,
    (
      await withSystem(async (tx) =>
        one(
          await tx
            .select()
            .from(domains)
            .where(and(eq(domains.projectId, s.projectId), eq(domains.key, "data"))),
        ),
      )
    ).id,
    s.memberId,
  );
  await renameConcept(s.orgId, s.projectId, c.id, "Pay", s.memberId);
  await drainAll(
    s,
    pickWhere((l) => l.startsWith("Payments")),
  );
  assert.equal((await conceptByKey(s, "http:pay")).domainState, "confirmed");
});

test("transient failures: 5 attempts then failed; an existing placement is kept", async () => {
  const s = await setup();
  await sync(s, ["http:GET /a", "http:GET /b"]);
  const r = await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    scopeKind: "topic",
    scopeRef: "t",
    ruleText: "A rule about a",
    baseVersion: 0,
  });
  await drainAll(
    s,
    pickWhere((l) => l.startsWith("a")),
  );
  const placed = await placementOf(s, r.decisionId);
  assert.equal(placed.location, "concept");
  // a new version → re-classification that keeps failing
  await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    scopeKind: "topic",
    scopeRef: "t",
    ruleText: "A rule about b",
    baseVersion: 1,
  });
  let calls = 0;
  const failing: Classifier = async (input) => {
    if ("concept" in input.subject) return pickFirst(input);
    calls++;
    return { ok: false, reason: "transient", error: "jev 503" };
  };
  await drainAll(s, failing);
  assert.equal(calls, 5);
  const task = (await tasksOf(s)).find(
    (t) => t.dedupeKey === `place_item:decision:${r.decisionId}` && t.state === "failed",
  )!;
  assert.equal(task.attempts, 5);
  const kept = await placementOf(s, r.decisionId);
  assert.equal(kept.conceptId, placed.conceptId, "failure never removes the placement");
  assert.equal(kept.lastError, "jev 503");
});

test("retry delays: 1m, 2m, 4m, 8m (+/-20%), Retry-After wins, capped at 2h", () => {
  const mid = () => 0.5;
  assert.deepEqual(
    [1, 2, 3, 4].map((n) => retryDelayMs(n, undefined, mid)),
    [60_000, 120_000, 240_000, 480_000],
  );
  assert.equal(
    retryDelayMs(1, undefined, () => 0),
    48_000,
  );
  assert.equal(
    retryDelayMs(1, undefined, () => 1),
    72_000,
  );
  assert.equal(retryDelayMs(1, 600_000, mid), 600_000);
  assert.equal(retryDelayMs(1, 10 * 3600_000, mid), 2 * 3600_000);
});

test("no_provider: fails immediately, then re-queues once a provider is configured", async () => {
  const s = await setup();
  await sync(s, ["http:GET /x"]);
  await makeDue(s);
  await drainConceptTasks({ projectId: s.projectId, keys: {} });
  const c = await conceptByKey(s, "http:x");
  assert.equal(c.domainState, "failed");
  const t = (await tasksOf(s)).find((x) => x.dedupeKey === `place_concept:${c.id}`)!;
  assert.equal(t.state, "failed");
  assert.equal(t.lastError, "no_provider");
  await drainAll(s, pickFirst); // pickFirst stands in for a configured provider…
  assert.equal((await conceptByKey(s, "http:x")).domainState, "failed", "…but no key → still no requeue");
  await drainConceptTasks({ projectId: s.projectId, keys: { jev: "k" }, classify: pickFirst });
  await drainAll(s, pickFirst);
  assert.equal((await conceptByKey(s, "http:x")).domainState, "suggested");
});

test("GraphQL metadata updates as a pair; string-only payloads keep it", async () => {
  const s = await setup();
  await sync(s, [{ surface: "gql:Query.orders", returnType: "[Order!]!", returnTypeKind: "object" }]);
  const row = () =>
    withSystem(async (tx) =>
      one(
        await tx
          .select()
          .from(surfaces)
          .where(and(eq(surfaces.projectId, s.projectId), eq(surfaces.surface, "gql:Query.orders"))),
      ),
    );
  assert.equal((await conceptByKey(s, "gql:Order")).label, "Order");
  await sync(s, ["gql:Query.orders"]); // older CLI
  assert.deepEqual([(await row()).returnType, (await row()).returnTypeKind], ["[Order!]!", "object"]);
  await sync(s, [{ surface: "gql:Query.orders", returnType: "OrderStatus" }]); // kind unresolved
  assert.deepEqual([(await row()).returnType, (await row()).returnTypeKind], ["OrderStatus", "unknown"]);
  const p = await placementOf(s, (await row()).id);
  assert.equal(p.conceptId, (await conceptByKey(s, "gql:Query.orders")).id, "unknown kind → exact field key");
});

test("merge writes an alias: a re-sync does not recreate the merged concept", async () => {
  const s = await setup();
  await sync(s, ["http:GET /cards", "http:GET /card-details"]);
  const a = await conceptByKey(s, "http:card-details");
  const b = await conceptByKey(s, "http:cards");
  await mergeConcepts(s.orgId, s.projectId, a.id, b.id, s.memberId);
  await sync(s, ["http:GET /card-details", "http:POST /card-details"]);
  const surf = await withSystem((tx) => tx.select().from(surfaces).where(eq(surfaces.projectId, s.projectId)));
  for (const x of surf) assert.equal((await placementOf(s, x.id)).conceptId, b.id);
  assert.ok((await conceptByKey(s, "http:card-details")).retiredAt, "merged concept stays retired");
});

test("a location pin survives a rebuild; project rules land in Project-wide", async () => {
  const s = await setup();
  await sync(s, ["http:GET /a", "http:GET /b"]);
  const surfA = await withSystem(async (tx) =>
    one(
      await tx
        .select()
        .from(surfaces)
        .where(and(eq(surfaces.projectId, s.projectId), eq(surfaces.surface, "http:GET /a"))),
    ),
  );
  const cb = await conceptByKey(s, "http:b");
  await placeItem(s.orgId, s.projectId, "surface", surfA.id, { conceptId: cb.id }, s.memberId);
  const pw = await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    scopeKind: "project",
    scopeRef: s.projectId,
    ruleText: "All services log JSON",
    baseVersion: 0,
  });
  await requestRebuild(s.orgId, s.projectId);
  await drainAll(s, pickFirst, 40);
  assert.equal((await placementOf(s, surfA.id)).conceptId, cb.id, "human pin kept");
  assert.equal((await placementOf(s, pw.decisionId)).location, "project_wide");
  const g = await getOutlineGroup(s.orgId, s.projectId, "project_wide");
  assert.equal(g.kind === "items" && g.items.some((i) => i.itemId === pw.decisionId), true);
});

test("rebuild meets an already-running classification: counted once, waits for it, then reconciles", async () => {
  const s = await setup();
  await sync(s, ["http:GET /one", "http:GET /two"]);
  // capability spanning two concepts → model placement + capability refs
  const n = await withOrg(s.orgId, async (tx) => {
    const cap = one(
      await tx
        .insert(graphNodes)
        .values({ orgId: s.orgId, projectId: s.projectId, kind: "capability", ref: "cap:x" })
        .returning(),
    );
    for (const ref of ["http:GET /one", "http:GET /two"]) {
      const sn = one(
        await tx
          .insert(graphNodes)
          .values({ orgId: s.orgId, projectId: s.projectId, kind: "surface", ref })
          .returning(),
      );
      await tx.insert(graphEdges).values({
        orgId: s.orgId,
        projectId: s.projectId,
        fromId: cap.id,
        toId: sn.id,
        kind: "governs",
        status: "confirmed",
      });
    }
    return cap;
  });
  assert.ok(n);
  const d = await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    scopeKind: "capability",
    scopeRef: "cap:x",
    ruleText: "Feature x is flagged",
    baseVersion: 0,
  });
  await drainAll(s, async (input) => ("concept" in input.subject ? pickFirst(input) : pickFirst(input)), 5);

  let rebuildRequested = false;
  let rebuildPhaseSeen: string | undefined;
  const classify: Classifier = async (input) => {
    if (!("concept" in input.subject) && !rebuildRequested) {
      rebuildRequested = true;
      // a rebuild starts while this decision's classification is running
      await requestRebuild(s.orgId, s.projectId);
      await makeDue(s);
      await drainConceptTasks({ projectId: s.projectId, keys: {}, classify: pickFirst }); // runs deriving
      const rb = await withSystem(async (tx) =>
        one(await tx.select().from(conceptRebuilds).where(eq(conceptRebuilds.projectId, s.projectId))),
      );
      rebuildPhaseSeen = rb.phase;
      const items = await withSystem((tx) =>
        tx.execute(
          sql`SELECT * FROM concept_rebuild_items WHERE rebuild_id = ${rb.id} AND dedupe_key = ${`place_item:decision:${d.decisionId}`}`,
        ),
      );
      assert.equal((items as unknown[]).length, 1, "counted once");
    }
    return pickFirst(input);
  };
  // re-run classification of the decision (new version) so it is running when the rebuild arrives
  await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    scopeKind: "capability",
    scopeRef: "cap:x",
    ruleText: "Feature x is flagged off by default",
    baseVersion: 1,
  });
  await drainAll(s, classify, 40);
  assert.equal(rebuildPhaseSeen, "classifying", "the rebuild waited for the running task");
  const rb = await withSystem(async (tx) =>
    one(await tx.select().from(conceptRebuilds).where(eq(conceptRebuilds.projectId, s.projectId))),
  );
  assert.equal(rb.phase, "done");
  const live = (await tasksOf(s)).filter(
    (t) => t.kind === "rebuild" && (t.state === "queued" || t.state === "running"),
  );
  assert.equal(live.length, 0, "singleton released only after reconciling");
  const refs = await withSystem((tx) => tx.select().from(conceptRefs).where(eq(conceptRefs.itemId, d.decisionId)));
  assert.equal(refs.length, 2, "capability refs re-derived and kept");
  assert.equal((await placementOf(s, d.decisionId)).state, "suggested");
});

test("RLS: another org cannot read concept rows", async () => {
  const a = await setup();
  const b = await setup();
  await sync(a, ["http:GET /secret"]);
  const seen = await withOrg(b.orgId, (tx) => tx.select().from(concepts).where(eq(concepts.projectId, a.projectId)));
  assert.equal(seen.length, 0);
  const own = await withOrg(a.orgId, (tx) => tx.select().from(concepts).where(eq(concepts.projectId, a.projectId)));
  assert.equal(own.length, 1);
});

test("concept contracts: consumers + governing decisions + history count per stable surface", async () => {
  const s = await setup();
  await sync(s, ["http:POST /auth/login"]);
  await proposeDecision(s.orgId, {
    projectId: s.projectId,
    memberId: s.memberId,
    scopeKind: "surface",
    scopeRef: "http:POST /auth/login",
    ruleText: "Login is rate limited",
    baseVersion: 0,
  });
  const c = await conceptByKey(s, "http:auth");
  const r = await getConceptContracts(s.orgId, s.projectId, c.id);
  assert.equal(r.contracts.length, 1);
  assert.equal(r.contracts[0]!.governing.length, 1);
  assert.equal(r.contracts[0]!.historyCount, 1);
  const dec = await withSystem((tx) => tx.select().from(decisions).where(eq(decisions.projectId, s.projectId)));
  assert.equal((await placementOf(s, dec[0]!.id)).conceptId, c.id, "surface-scoped decision placed deterministically");
});
