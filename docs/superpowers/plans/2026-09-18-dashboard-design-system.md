# Dashboard Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Lockstep dashboard on Tailwind 3.4 + shadcn/ui with one token layer, one row grammar, a fixed information architecture, a role-aware Home, and a Decision detail page, backed by two core read-model changes and two small web-auth write routes.

**Architecture:** Core gains an enriched `projectOverview` payload (actors, impact, answers, consumers, recent changes) and a `decisionDetail` read, plus member-authenticated ack/propose routes so the web can act without an MCP session. Web replaces the hand-rolled CSS class system with Tailwind + vendored shadcn primitives, a set of Lockstep composites, and rewrites every route to compose only those. A Playwright script seeds the local core and screenshots every route for review.

**Tech Stack:** Next 14.2 / React 18.3 (unchanged), Tailwind 3.4, shadcn/ui (v3 form, `new-york`, CSS variables), Radix UI, lucide-react, next/font (Inter, JetBrains Mono), Fastify + Drizzle (core), node:test, Playwright 1.52 (screenshots only).

**Spec:** `docs/superpowers/specs/2026-09-18-dashboard-design-system-design.md`

## Global Constraints

- No framework upgrades: Next stays 14.2.x, React 18.3.x, Tailwind is 3.4.x (never 4).
- Token names are the shadcn set (`--background`, `--card`, `--muted`, `--border`, `--foreground`, `--muted-foreground`, `--primary`, `--primary-foreground`, `--ring`, `--radius`) plus `--success`, `--warning`, `--destructive`, `--info`, each with `-soft` (12% alpha) and `-edge` (30% alpha) variants. Values per spec §3.2.
- `StatusBadge` is the only place a status string maps to a colour or a display word (spec §3.3).
- Inline `style={{}}` on JSX is a lint error in `packages/web` (via `no-restricted-syntax`, no new eslint plugin). React Flow node `style` objects are the one exemption, marked with `// eslint-disable-next-line no-restricted-syntax`.
- Button variants are rationed per spec §4.3: at most one `default` per view region.
- Every list uses `ListRow` with the grammar in spec §6.2. No third line except a truncated rationale on Decisions.
- Core: all new reads go through `withOrg`; member ids resolve to `githubLogin` server-side.
- Commit messages: `feat(web): …`, `feat(core): …`, `chore(web): …`, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Verification per task: `npm run typecheck` at root; core tasks also `node --import tsx --test --test-concurrency=1 --test-force-exit <file>` with `DATABASE_URL=postgres://lockstep:lockstep@localhost:5432/lockstep`; web tasks also `npm run build -w @lockstep/web` and a screenshot pass (Task 13 script) reviewed by eye.
- Local dev servers for visual checks: core `DATABASE_URL=… NODE_ENV=development LOCKSTEP_DEV_LOGIN=1 npx tsx src/server.ts` in `packages/core`; web `LOCKSTEP_API_URL=http://localhost:8080 npx next dev -p 3000` in `packages/web`. Seed with the Task 13 script.

## File map

| File | Action | Responsibility |
| --- | --- | --- |
| `packages/core/src/dashboard/dashboard-service.ts` | modify | enrich `projectOverview`; add `decisionDetail` |
| `packages/core/src/dashboard/dashboard.e2e.test.ts` | create | asserts enriched fields and detail read |
| `packages/core/src/api/routes/orgs.ts` | modify | `GET …/decisions/:id`, `POST …/decisions/:id/ack`, `POST …/decisions` (member-auth) |
| `packages/web/package.json` | modify | Tailwind, shadcn deps, playwright devDep, `e2e:shots` script |
| `packages/web/tailwind.config.ts`, `postcss.config.js`, `components.json` | create | Tailwind + shadcn config |
| `packages/web/app/globals.css` | rewrite | directives, tokens, base, React Flow overrides |
| `packages/web/app/layout.tsx` | modify | fonts, `<html class>` |
| `packages/web/app/lib/utils.ts` | create | `cn()` |
| `packages/web/app/lib/status.ts` (+ `.test.ts`) | create | status → word/tone mapping |
| `packages/web/app/lib/types.ts`, `app/lib/data.ts` | modify | enriched types, `getDecisionDetail`, `humanizeAudit` |
| `packages/web/app/components/ui/*.tsx` | create (vendored) | shadcn primitives |
| `packages/web/app/components/{PageHeader,ListRow,StatusBadge,RefChip,Who,When,StatGrid,EmptyState,Section,EvidenceQuote,Field}.tsx` | create | Lockstep composites |
| `packages/web/app/components/shell/{Sidebar,Nav,Topbar,UserMenu,Breadcrumb,MobileNav}.tsx` | create | app shell |
| `packages/web/app/project/[orgId]/[projectId]/layout.tsx` | rewrite | shell composition |
| `packages/web/app/project/[orgId]/[projectId]/page.tsx` | rewrite | Home |
| `packages/web/app/project/[orgId]/[projectId]/decisions/[id]/page.tsx` | create | Decision detail |
| `packages/web/app/project/[orgId]/[projectId]/decisions/[id]/ProposeVersionSheet.tsx` | create | client Sheet |
| `packages/web/app/actions.ts` | modify | `ackDecisionAction`, `proposeVersionAction` |
| every other `page.tsx` under `project/[orgId]/[projectId]` | rewrite | compose composites |
| `packages/web/app/project/[orgId]/[projectId]/{loading,error}.tsx` | create | streaming + error states |
| `packages/web/app/page.tsx` | rewrite | login + workspace picker |
| `packages/web/app/components/{ui.tsx,icons.tsx,review/Tabs.tsx,review/EvidenceBlock.tsx,review/ConflictWarning.tsx}` | delete | superseded |
| `eslint.config.js` | modify | forbid `style` JSX attr in web |
| `packages/web/e2e/{seed.mjs,shots.mjs}` | create | seed + screenshots |
| `CHANGELOG.md` | modify | Unreleased entry |

---

### Task 1: Enrich the project overview read model (core)

**Files:**
- Modify: `packages/core/src/dashboard/dashboard-service.ts:58-190`
- Create: `packages/core/src/dashboard/dashboard.e2e.test.ts`

**Interfaces:**
- Produces, on the `projectOverview` return value:
  ```ts
  audit: Array<{ action: string; entityKind: string | null; entityId: string | null; createdAt: Date; actor: string | null; summary: string | null }>
  decisions[]: + { impact: number; createdAt: Date; proposedBy: string | null }
  questions[]: + { askedBy: string | null; createdAt: Date; answer: { body: string; by: string | null; at: Date } | null }
  tasks[]: + { delegatedTo: string | null; delegatedBy: string | null; createdAt: Date }
  contracts[]: + { consumerCount: number }
  changes: Array<{ id: string; surface: string | null; summary: string; riskTier: string; impact: number; createdBy: string | null; createdAt: Date; repoId: string }>
  ```

- [ ] **Step 1: Write the failing test**

`packages/core/src/dashboard/dashboard.e2e.test.ts`:
```ts
/** Overview enrichment + decision detail read, against real Postgres (DATABASE_URL). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withSystem } from "../db/rls.js";
import { orgs, principals, members, projects, repos, projectMembers } from "../db/schema.js";
import { projectOverview, decisionDetail } from "./dashboard-service.js";
import { registerSession } from "../api/session-context.js";
import { proposeDecision, ackDecision, askQuestion, answerQuestion, createTask, recordChange, registerDependency, syncProducedSurfaces } from "../ledger/ledger-service.js";

function one<T>(rows: T[]): T {
  const r = rows[0];
  if (!r) throw new Error("expected a row");
  return r;
}
let seq = Date.now() + 970_000_000;
const uid = (): number => ++seq;

async function setup() {
  const n = uid();
  return withSystem(async (tx) => {
    const org = one(await tx.insert(orgs).values({ name: `Dash-${n}` }).returning());
    const mk = async (login: string) => {
      const p = one(await tx.insert(principals).values({ githubUserId: uid(), githubLogin: login }).returning());
      return one(await tx.insert(members).values({ orgId: org.id, principalId: p.id, githubUserId: p.githubUserId, githubLogin: login }).returning());
    };
    const alice = await mk(`alice-${n}`);
    const bob = await mk(`bob-${n}`);
    const proj = one(await tx.insert(projects).values({ orgId: org.id, name: "dash", createdBy: alice.id }).returning());
    for (const m of [alice, bob]) {
      await tx.insert(projectMembers).values({ orgId: org.id, projectId: proj.id, memberId: m.id, invitedGithubLogin: m.githubLogin, role: "member", status: "active" });
    }
    const api = one(await tx.insert(repos).values({ orgId: org.id, projectId: proj.id, gitRemote: `https://github.com/t/api-${n}` }).returning());
    const app = one(await tx.insert(repos).values({ orgId: org.id, projectId: proj.id, gitRemote: `https://github.com/t/app-${n}` }).returning());
    return { orgId: org.id, projectId: proj.id, alice, bob, api, app };
  });
}

test("projectOverview: actors, impact, answers, assignees, consumer counts, and changes are resolved", async () => {
  const s = await setup();
  const ctxA = { projectId: s.projectId, repoId: s.api.id, memberId: s.alice.id };
  const ctxB = { projectId: s.projectId, repoId: s.app.id, memberId: s.bob.id };
  await syncProducedSurfaces(s.orgId, { ...ctxA, surfaces: ["http:POST /x"] });
  await registerDependency(s.orgId, { projectId: s.projectId, memberId: s.bob.id, consumerRepoId: s.app.id, producedSurface: "http:POST /x", producedRepoId: null, source: "test" });
  const d = await proposeDecision(s.orgId, { ...ctxA, scopeKind: "surface", scopeRef: "http:POST /x", ruleText: "X is idempotent.", baseVersion: 0 });
  const q = await askQuestion(s.orgId, { projectId: s.projectId, memberId: s.alice.id, body: "Who calls X?", scopeRef: "http:POST /x" });
  await answerQuestion(s.orgId, q.questionId, s.bob.id, "The app does.");
  await createTask(s.orgId, { projectId: s.projectId, memberId: s.alice.id, title: "Migrate", to: s.bob.githubLogin });
  await recordChange(s.orgId, { ...ctxA, summary: "Renamed X", surface: "http:POST /x", riskTier: "shared" });

  const o = await projectOverview(s.orgId, s.projectId, s.alice.id);
  const dec = o.decisions.find((x) => x.id === d.decisionId)!;
  assert.equal(dec.proposedBy, s.alice.githubLogin);
  assert.ok(dec.impact >= 1, "one consumer ⇒ impact ≥ 1");
  assert.ok(dec.createdAt instanceof Date);
  const qq = o.questions.find((x) => x.id === q.questionId)!;
  assert.equal(qq.askedBy, s.alice.githubLogin);
  assert.equal(qq.answer?.body, "The app does.");
  assert.equal(qq.answer?.by, s.bob.githubLogin);
  const t = o.tasks[0]!;
  assert.equal(t.delegatedTo, s.bob.githubLogin);
  assert.equal(t.delegatedBy, s.alice.githubLogin);
  const c = o.contracts.find((x) => x.surface === "http:POST /x")!;
  assert.equal(c.consumerCount, 1);
  assert.equal(o.changes.length, 1);
  assert.equal(o.changes[0]!.createdBy, s.alice.githubLogin);
  assert.equal(o.changes[0]!.surface, "http:POST /x");
  const proposed = o.audit.find((a) => a.action === "decision.proposed")!;
  assert.equal(proposed.actor, s.alice.githubLogin);
  assert.equal(proposed.entityId, d.decisionId);
  assert.equal(proposed.summary, "X is idempotent.");
});

test("decisionDetail: versions, approvals, consumers, lineage", async () => {
  const s = await setup();
  const ctxA = { projectId: s.projectId, repoId: s.api.id, memberId: s.alice.id };
  await registerDependency(s.orgId, { projectId: s.projectId, memberId: s.bob.id, consumerRepoId: s.app.id, producedSurface: "http:POST /y", producedRepoId: null, source: "test" });
  const d = await proposeDecision(s.orgId, { ...ctxA, scopeKind: "surface", scopeRef: "http:POST /y", ruleText: "Y v1.", baseVersion: 0, rationale: "because" });
  await ackDecision(s.orgId, d.decisionId, d.version, s.bob.id, "ack");
  const detail = await decisionDetail(s.orgId, s.projectId, d.decisionId);
  assert.ok(detail);
  assert.equal(detail!.ruleText, "Y v1.");
  assert.equal(detail!.rationale, "because");
  assert.equal(detail!.versions.length, 1);
  assert.equal(detail!.versions[0]!.proposedBy, s.alice.githubLogin);
  assert.equal(detail!.approvals.length, 1);
  assert.equal(detail!.approvals[0]!.reviewer, s.bob.githubLogin);
  assert.equal(detail!.consumers.length, 1);
  assert.equal(detail!.consumers[0]!.repoId, s.app.id);
  assert.equal(await decisionDetail(s.orgId, s.projectId, "00000000-0000-0000-0000-000000000000"), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && DATABASE_URL=postgres://lockstep:lockstep@localhost:5432/lockstep node --import tsx --test --test-concurrency=1 --test-force-exit src/dashboard/dashboard.e2e.test.ts`
Expected: FAIL (`decisionDetail` not exported; `proposedBy` undefined). If `registerSession` import is unused, drop it.

- [ ] **Step 3: Implement the enrichment**

In `packages/core/src/dashboard/dashboard-service.ts`, inside `projectOverview` after `const ds = …`:

1. Move the `orgMembers` select to the top of the function and build `const loginById = new Map(orgMembers.map((m) => [m.id, m.githubLogin]))`; reuse it for `slackById`.
2. In the decision loop add to the pushed object: `impact: d.impact, createdAt: d.createdAt, proposedBy: v?.proposedBy ? (loginById.get(v.proposedBy) ?? null) : null`.
3. Questions: fetch `answers` for the project's question ids in one `inArray` select ordered by `createdAt desc`; keep the first per `questionId`. Map each question to include `askedBy: loginById.get(q.askedBy) ?? null, createdAt: q.createdAt, answer: a ? { body: a.body, by: loginById.get(a.answeredBy) ?? null, at: a.createdAt } : null`.
4. Tasks: `delegatedTo` and `delegatedBy` columns may hold a member id or a raw login (MCP passes a handle). Resolve with `const who = (v: string | null) => (v && loginById.get(v)) || v || null`. Add `createdAt`.
5. Contracts: compute `consumerCount` from the active `dependencyEdges` already selected (`deps`): `deps.filter((e) => e.producedSurface === c.surface).length`.
6. Changes: `changeFeedEntries` where `projectId`, `orderBy(desc(createdAt))`, `limit(20)` → `{ id, surface, summary, riskTier, impact, createdBy: who(createdBy), createdAt, repoId }`.
7. Audit: select `actorMemberId`, `entityId` too. Build `const summaryFor = (kind, id) =>` lookup: `decision` → decisionList ruleText, `question` → question body, `task` → task title, `change_feed_entry` → change summary, `dependency_edge` → producedSurface, else `null`. Map to `{ action, entityKind, entityId, createdAt, actor: a.actorMemberId ? loginById.get(a.actorMemberId) ?? null : null, summary: summaryFor(a.entityKind, a.entityId) }`.

Import `answers`, `changeFeedEntries` from `../db/schema.js`; `inArray`, `desc` already imported or add.

- [ ] **Step 4: Implement `decisionDetail`**

Append to `dashboard-service.ts`:
```ts
export async function decisionDetail(orgId: string, projectId: string, id: string) {
  return withOrg(orgId, async (tx) => {
    const d = (await tx.select().from(decisions).where(and(eq(decisions.id, id), eq(decisions.projectId, projectId))).limit(1))[0];
    if (!d) return null;
    const orgMembers = await tx.select().from(members).where(eq(members.orgId, orgId));
    const login = (mid: string | null | undefined) => (mid ? (orgMembers.find((m) => m.id === mid)?.githubLogin ?? null) : null);
    const versions = (await tx.select().from(decisionVersions).where(eq(decisionVersions.decisionId, id)).orderBy(desc(decisionVersions.version))).map((v) => ({
      version: v.version, baseVersion: v.baseVersion, ruleText: v.ruleText, rationale: v.rationale, alternatives: (v.alternatives as string[] | null) ?? null, status: v.status, proposedBy: login(v.proposedBy), createdAt: v.createdAt, provenance: v.provenance,
    }));
    const current = versions.find((v) => v.version === d.currentVersion) ?? versions[0];
    const approvals = (await tx.select().from(decisionApprovals).where(eq(decisionApprovals.decisionId, id)).orderBy(desc(decisionApprovals.createdAt))).map((a) => ({
      version: a.version, reviewer: login(a.reviewerId), verdict: a.verdict, comment: a.comment, createdAt: a.createdAt,
    }));
    const required = (await tx.select().from(decisionRequiredReviewers).where(eq(decisionRequiredReviewers.decisionId, id))).map((r) => ({ reviewer: login(r.reviewerMemberId), required: r.required }));
    const provenances = await tx.select().from(decisionProvenances).where(eq(decisionProvenances.decisionId, id));
    const repoRows = await tx.select().from(repos);
    const projRows = await tx.select().from(projects);
    const consumers = d.scopeKind === "surface"
      ? (await tx.select().from(dependencyEdges).where(and(eq(dependencyEdges.producedSurface, d.scopeRef), eq(dependencyEdges.active, true)))).map((e) => {
          const r = repoRows.find((x) => x.id === e.consumerRepoId);
          const p = r ? projRows.find((x) => x.id === r.projectId) : undefined;
          return { repoId: e.consumerRepoId, gitRemote: r?.gitRemote ?? null, project: p && p.id !== projectId ? { id: p.id, name: p.name } : null, source: e.source };
        })
      : [];
    const sameSurfaceBinding = d.scopeKind === "surface"
      ? (await tx.select().from(decisions).where(and(eq(decisions.projectId, projectId), eq(decisions.scopeRef, d.scopeRef), eq(decisions.status, "binding")))).filter((x) => x.id !== id).length
      : 0;
    const textOf = async (did: string | null) => {
      if (!did) return null;
      const x = (await tx.select().from(decisions).where(eq(decisions.id, did)).limit(1))[0];
      if (!x) return null;
      const v = (await tx.select({ ruleText: decisionVersions.ruleText }).from(decisionVersions).where(and(eq(decisionVersions.decisionId, did), eq(decisionVersions.version, x.currentVersion))).limit(1))[0];
      return { id: did, ruleText: v?.ruleText ?? "", status: x.status };
    };
    const supersededBy = await textOf(d.supersededById);
    const supersedes = [];
    for (const x of await tx.select().from(decisions).where(and(eq(decisions.projectId, projectId), eq(decisions.supersededById, id)))) {
      const t = await textOf(x.id);
      if (t) supersedes.push(t);
    }
    const conflictRows = (await tx.select().from(conflicts).where(eq(conflicts.projectId, projectId))).filter((c) => c.constraintDecisionId === id || c.engDecisionId === id);
    return {
      id: d.id, projectId: d.projectId, scopeKind: d.scopeKind, scopeRef: d.scopeRef, decisionType: d.decisionType, status: d.status, origin: d.origin, impact: d.impact, currentVersion: d.currentVersion, constraintKind: d.constraintKind, expiresAt: d.expiresAt, reviewAt: d.reviewAt, createdAt: d.createdAt,
      ruleText: current?.ruleText ?? "", rationale: current?.rationale ?? null, alternatives: current?.alternatives ?? null, proposedBy: current?.proposedBy ?? null,
      versions, approvals, requiredReviewers: required, provenances, consumers, sameSurfaceBinding, lineage: { supersedes, supersededBy },
      conflicts: conflictRows.map((c) => ({ id: c.id, kind: c.kind, status: c.status, surface: c.surface })),
    };
  });
}
```
Add imports for `decisionApprovals`, `decisionRequiredReviewers`, `decisionProvenances`, `dependencyEdges`, `conflicts` from the schema. Check the exact `conflicts` column names (`constraintDecisionId`, `engDecisionId`) in `schema.ts` and adjust if they differ.

- [ ] **Step 5: Run the test**

Run: same command as Step 2. Expected: PASS (2 tests). If `createTask` stores a handle rather than a member id for `delegatedTo`, the `who()` resolver in Step 3.4 handles both; adjust the assertion only if the stored form is neither.

- [ ] **Step 6: Typecheck and commit**

```bash
cd packages/core && npm run typecheck
git add packages/core/src/dashboard
git commit -m "feat(core): overview enrichment (actors, impact, answers, consumers, changes) + decisionDetail read

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Web-auth routes: decision detail, ack, propose

**Files:**
- Modify: `packages/core/src/api/routes/orgs.ts` (append three routes)
- Test: extend `packages/core/src/api/app.test.ts` only if it has a route-existence harness; otherwise rely on Task 7's manual check and the service-level test from Task 1.

**Interfaces:**
- `GET /orgs/:orgId/projects/:projectId/decisions/:id` → `decisionDetail` result or 404 `{ error: "not_found" }`.
- `POST /orgs/:orgId/projects/:projectId/decisions/:id/ack` body `{ version: number; verdict?: string }` → `ackDecision(orgId, id, version, memberId, verdict ?? "ack")`.
- `POST /orgs/:orgId/projects/:projectId/decisions` body `{ scopeKind, scopeRef, ruleText, baseVersion, decisionType?, rationale?, alternatives?, reviewAt?, supersedes? }` → `proposeDecision(orgId, { projectId, memberId, repoId: null, … })`. Confirm `proposeDecision` accepts a null/undefined `repoId`; if it requires one, pass the project's first repo id and note it in the route comment.

- [ ] **Step 1: Add the routes**

Append to `packages/core/src/api/routes/orgs.ts`, following the `ensureMember` + `requireProjectRole`/read pattern already used by the `/overview` route in the same file (copy its guard lines exactly):
```ts
  // Web-facing decision reads/writes — member auth, no MCP session (the dashboard has none).
  app.get("/orgs/:orgId/projects/:projectId/decisions/:id", async (req, reply) => {
    const { orgId, projectId, id } = req.params as { orgId: string; projectId: string; id: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    // same read guard as /overview
    const d = await decisionDetail(orgId, projectId, id);
    if (!d) return reply.code(404).send({ error: "not_found" });
    return d;
  });

  app.post("/orgs/:orgId/projects/:projectId/decisions/:id/ack", async (req, reply) => {
    const { orgId, projectId, id } = req.params as { orgId: string; projectId: string; id: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    const b = req.body as { version?: number; verdict?: string } | undefined;
    if (b?.version === undefined) return reply.code(400).send({ error: "version required" });
    const d = await decisionDetail(orgId, projectId, id);
    if (!d) return reply.code(404).send({ error: "not_found" });
    return ackDecision(orgId, id, b.version, memberId, b.verdict ?? "ack");
  });

  app.post("/orgs/:orgId/projects/:projectId/decisions", async (req, reply) => {
    const { orgId, projectId } = req.params as { orgId: string; projectId: string };
    const memberId = await ensureMember(req, reply, orgId);
    if (!memberId) return;
    const b = req.body as { scopeKind?: string; scopeRef?: string; ruleText?: string; baseVersion?: number; decisionType?: string; rationale?: string; alternatives?: string[]; reviewAt?: string; supersedes?: string } | undefined;
    if (!b?.scopeKind || !b?.scopeRef || !b?.ruleText || b.baseVersion === undefined) {
      return reply.code(400).send({ error: "scopeKind, scopeRef, ruleText, baseVersion required" });
    }
    const reviewAt = b.reviewAt ? new Date(b.reviewAt) : undefined;
    if (reviewAt && Number.isNaN(reviewAt.getTime())) return reply.code(400).send({ error: "reviewAt must be an ISO date" });
    return proposeDecision(orgId, {
      projectId, memberId, scopeKind: b.scopeKind, scopeRef: b.scopeRef, ruleText: b.ruleText, baseVersion: b.baseVersion,
      decisionType: b.decisionType, rationale: b.rationale, alternatives: b.alternatives, reviewAt,
      provenance: b.supersedes ? { source: "web", supersedes: b.supersedes } : { source: "web" },
    });
  });
```
Import `decisionDetail` from `../../dashboard/dashboard-service.js` and `ackDecision`, `proposeDecision` from `../../ledger/ledger-service.js`. Read `proposeDecision`'s input type first; if `repoId` is required, resolve the project's first repo inside the route and pass it.

- [ ] **Step 2: Smoke it against the running local core**

```bash
cd packages/core && npm run typecheck
# with local core running (see Global Constraints) and the Task 13 seed applied:
TOKEN=<alice token from seed output>; ORG=<orgId>; PROJ=<projectId>; DEC=<a decision id from GET overview>
curl -s -H "authorization: Bearer $TOKEN" localhost:8080/orgs/$ORG/projects/$PROJ/decisions/$DEC | head -c 400
```
Expected: JSON with `ruleText`, `versions`, `consumers`.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/api/routes/orgs.ts
git commit -m "feat(core): web-auth decision detail, ack, and propose routes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Tailwind + shadcn foundations (web)

**Files:**
- Modify: `packages/web/package.json`
- Create: `packages/web/tailwind.config.ts`, `packages/web/postcss.config.js`, `packages/web/components.json`, `packages/web/app/lib/utils.ts`
- Rewrite: `packages/web/app/globals.css`
- Modify: `packages/web/app/layout.tsx`
- Modify: `eslint.config.js`

- [ ] **Step 1: Install dependencies**

```bash
cd packages/web
npm i tailwindcss@3.4 postcss autoprefixer tailwindcss-animate class-variance-authority clsx tailwind-merge lucide-react @radix-ui/react-slot @radix-ui/react-tabs @radix-ui/react-select @radix-ui/react-label @radix-ui/react-separator @radix-ui/react-tooltip @radix-ui/react-dropdown-menu @radix-ui/react-dialog @radix-ui/react-avatar @radix-ui/react-scroll-area
```
(Run from the workspace root with `-w @lockstep/web` if npm complains about workspaces.)

- [ ] **Step 2: Config files**

`packages/web/postcss.config.js`:
```js
module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

`packages/web/tailwind.config.ts`:
```ts
import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

export default {
  darkMode: ["class"],
  content: ["./app/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "1.5rem", screens: { "2xl": "1200px" } },
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        card: { DEFAULT: "var(--card)", foreground: "var(--foreground)" },
        popover: { DEFAULT: "var(--card)", foreground: "var(--foreground)" },
        muted: { DEFAULT: "var(--muted)", foreground: "var(--muted-foreground)" },
        accent: { DEFAULT: "var(--muted)", foreground: "var(--foreground)" },
        secondary: { DEFAULT: "var(--muted)", foreground: "var(--foreground)" },
        border: "var(--border)",
        input: "var(--border)",
        ring: "var(--ring)",
        primary: { DEFAULT: "var(--primary)", foreground: "var(--primary-foreground)", soft: "var(--primary-soft)", edge: "var(--primary-edge)" },
        success: { DEFAULT: "var(--success)", soft: "var(--success-soft)", edge: "var(--success-edge)" },
        warning: { DEFAULT: "var(--warning)", soft: "var(--warning-soft)", edge: "var(--warning-edge)" },
        destructive: { DEFAULT: "var(--destructive)", foreground: "var(--foreground)", soft: "var(--destructive-soft)", edge: "var(--destructive-edge)" },
        info: { DEFAULT: "var(--info)", soft: "var(--info-soft)", edge: "var(--info-edge)" },
      },
      borderRadius: { lg: "var(--radius)", md: "calc(var(--radius) - 2px)", sm: "calc(var(--radius) - 4px)" },
      fontFamily: { sans: ["var(--font-sans)", "system-ui", "sans-serif"], mono: ["var(--font-mono)", "ui-monospace", "monospace"] },
      fontSize: {
        "2xs": ["11px", { lineHeight: "16px", letterSpacing: "0.06em" }],
        xs: ["12px", { lineHeight: "16px" }],
        sm: ["13px", { lineHeight: "20px" }],
        base: ["14px", { lineHeight: "20px" }],
        lg: ["16px", { lineHeight: "24px" }],
        xl: ["20px", { lineHeight: "28px" }],
      },
      keyframes: {
        "accordion-down": { from: { height: "0" }, to: { height: "var(--radix-accordion-content-height)" } },
        "accordion-up": { from: { height: "var(--radix-accordion-content-height)" }, to: { height: "0" } },
      },
      animation: { "accordion-down": "accordion-down 0.2s ease-out", "accordion-up": "accordion-up 0.2s ease-out" },
    },
  },
  plugins: [animate],
} satisfies Config;
```

`packages/web/components.json`:
```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": true,
  "tsx": true,
  "tailwind": { "config": "tailwind.config.ts", "css": "app/globals.css", "baseColor": "neutral", "cssVariables": true, "prefix": "" },
  "aliases": { "components": "@/components", "utils": "@/lib/utils", "ui": "@/components/ui", "lib": "@/lib", "hooks": "@/hooks" },
  "iconLibrary": "lucide"
}
```

`packages/web/app/lib/utils.ts`:
```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 3: Rewrite `globals.css`**

Replace the whole file with:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/* Lockstep tokens — dark is :root, light is .light on <html>. Components never use raw colours. */
:root {
  color-scheme: dark;
  --background: #0b0d12;
  --card: #12151c;
  --muted: #181c25;
  --border: #242a37;
  --foreground: #e6eaf2;
  --muted-foreground: #8b95a9;
  --primary: #8b7cf6;
  --primary-foreground: #0b0d12;
  --primary-soft: rgb(139 124 246 / 0.12);
  --primary-edge: rgb(139 124 246 / 0.3);
  --success: #3fb950;
  --success-soft: rgb(63 185 80 / 0.12);
  --success-edge: rgb(63 185 80 / 0.3);
  --warning: #e3b341;
  --warning-soft: rgb(227 179 65 / 0.12);
  --warning-edge: rgb(227 179 65 / 0.3);
  --destructive: #f8717a;
  --destructive-soft: rgb(248 113 122 / 0.12);
  --destructive-edge: rgb(248 113 122 / 0.3);
  --info: #5b9dff;
  --info-soft: rgb(91 157 255 / 0.12);
  --info-edge: rgb(91 157 255 / 0.3);
  --ring: #8b7cf6;
  --radius: 10px;
  --sidebar-w: 240px;
}
.light {
  color-scheme: light;
  --background: #fafafa;
  --card: #ffffff;
  --muted: #f1f3f7;
  --border: #e3e6ee;
  --foreground: #12151c;
  --muted-foreground: #5f6a7e;
  --primary: #6d5ce6;
  --primary-foreground: #ffffff;
  --ring: #6d5ce6;
}

@layer base {
  * { @apply border-border; }
  html { -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
  body { @apply bg-background text-foreground font-sans text-base; }
  ::selection { background: var(--primary-soft); }
  :focus-visible { @apply outline-none ring-2 ring-ring ring-offset-2 ring-offset-background rounded-sm; }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { border: 3px solid transparent; border-radius: 10px; box-shadow: inset 0 0 0 10px var(--border); }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }
}

/* React Flow — the one third-party surface we theme by override. */
.react-flow { --xy-background-color: var(--card); }
.react-flow__controls { @apply rounded-md border bg-card shadow-none; }
.react-flow__controls-button { @apply border-b bg-card text-foreground; }
.react-flow__controls-button:hover { @apply bg-muted; }
.react-flow__edge-path { stroke: var(--border); }

@media print {
  aside, header { display: none !important; }
  main { padding: 0 !important; }
}
```

- [ ] **Step 4: Fonts in `app/layout.tsx`**

```tsx
import "./globals.css";
import type { ReactNode } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";
import { cn } from "@/lib/utils";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata = { title: "Lockstep", description: "Keep your team's coding agents in lockstep." };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn(inter.variable, mono.variable)}>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
```

- [ ] **Step 5: Lint rule for inline styles**

In `eslint.config.js` add a block after the existing TS block:
```js
  {
    files: ["packages/web/**/*.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: 'JSXAttribute[name.name="style"]', message: "Inline styles are not allowed; compose Tailwind classes or a composite component." },
      ],
    },
  },
```
This will fail lint until Tasks 5–12 finish. That's expected; do not merge before it's green.

- [ ] **Step 6: Verify the build still passes with old pages (they still use the old classes, now unstyled)**

Run: `cd packages/web && npm run typecheck && npm run build 2>&1 | tail -5`
Expected: build succeeds (pages compile; styling is temporarily broken until Tasks 4–12).

- [ ] **Step 7: Commit**

```bash
git add packages/web eslint.config.js package-lock.json
git commit -m "chore(web): Tailwind 3.4 + shadcn foundations, tokens, fonts, inline-style lint rule

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: shadcn primitives + Lockstep composites

**Files:**
- Create: `packages/web/app/components/ui/{button,badge,card,tabs,input,select,textarea,label,separator,tooltip,dropdown-menu,dialog,sheet,skeleton,avatar,scroll-area}.tsx`
- Create: `packages/web/app/lib/status.ts`, `packages/web/app/lib/status.test.ts`
- Create: `packages/web/app/components/{PageHeader,ListRow,StatusBadge,RefChip,Who,When,StatGrid,EmptyState,Section,EvidenceQuote,Field}.tsx`
- Modify: `packages/web/package.json` (`"test": "node --import tsx --test app/lib/*.test.ts"`, add `tsx` devDep if absent)

**Interfaces (produced):**
```ts
// lib/status.ts
export type Tone = "primary" | "success" | "warning" | "destructive" | "muted";
export function statusView(status: string, ctx?: { origin?: string | null }): { word: string; tone: Tone; dot: boolean };

// components
PageHeader({ title, description?, actions?, tabs?, crumbs? }: { crumbs?: Array<{ label: string; href?: string }> })
ListRow({ href?, leading?, title, meta?, status?, action?, extra?, className? })
StatusBadge({ status, origin? })
RefChip({ children, kind?, href?, copy? = true })
Who({ login, role?, size? = "sm", href? })
When({ at })
StatGrid({ children }) / Stat({ n, label, href?, hint? })
EmptyState({ icon, title, children?, action? })
Section({ label, count?, href?, children, className? })
EvidenceQuote({ quote, source?, url?, confidence? })
Field({ label, hint?, error?, htmlFor?, children })
```

- [ ] **Step 1: Vendor the shadcn primitives**

Run `cd packages/web && npx shadcn@2.3.0 add button badge card tabs input select textarea label separator tooltip dropdown-menu dialog sheet skeleton avatar scroll-area -y`. If the CLI refuses (network, prompt, or version mismatch), write each file by hand from the shadcn v3 `new-york` templates; they are the standard `cva` + Radix wrappers. Then in `button.tsx` set variant classes so the ration reads correctly:
```ts
default: "bg-primary text-primary-foreground hover:bg-primary/90",
secondary: "border bg-card hover:bg-muted",
ghost: "hover:bg-muted text-muted-foreground hover:text-foreground",
destructive: "bg-destructive-soft text-destructive border border-destructive-edge hover:bg-destructive/20",
link: "text-primary underline-offset-4 hover:underline",
```
and sizes `default: "h-9 px-3"`, `sm: "h-8 px-2.5 text-sm"`, `icon: "h-8 w-8"`.

- [ ] **Step 2: Write the failing status test**

`app/lib/status.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { statusView } from "./status.js";

test("statusView maps API statuses to one word and one tone", () => {
  assert.deepEqual(statusView("open"), { word: "awaiting ack", tone: "warning", dot: true });
  assert.deepEqual(statusView("proposed"), { word: "proposed", tone: "warning", dot: true });
  assert.deepEqual(statusView("binding"), { word: "binding", tone: "primary", dot: true });
  assert.deepEqual(statusView("binding", { origin: "document" }), { word: "ratified", tone: "primary", dot: true });
  assert.deepEqual(statusView("answered"), { word: "answered", tone: "success", dot: true });
  assert.deepEqual(statusView("urgent"), { word: "urgent", tone: "destructive", dot: true });
  assert.deepEqual(statusView("superseded"), { word: "superseded", tone: "muted", dot: false });
  assert.deepEqual(statusView("something_new"), { word: "something new", tone: "muted", dot: false });
});
```
Run: `cd packages/web && node --import tsx --test app/lib/status.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `status.ts`**

```ts
export type Tone = "primary" | "success" | "warning" | "destructive" | "muted";
export interface StatusView { word: string; tone: Tone; dot: boolean }

const MAP: Record<string, StatusView> = {
  binding: { word: "binding", tone: "primary", dot: true },
  ratified: { word: "ratified", tone: "primary", dot: true },
  verified: { word: "verified", tone: "success", dot: true },
  answered: { word: "answered", tone: "success", dot: true },
  completed: { word: "completed", tone: "success", dot: true },
  done: { word: "completed", tone: "success", dot: true },
  active: { word: "active", tone: "success", dot: true },
  confirmed: { word: "confirmed", tone: "success", dot: true },
  enabled: { word: "enabled", tone: "success", dot: true },
  open: { word: "awaiting ack", tone: "warning", dot: true },
  proposed: { word: "proposed", tone: "warning", dot: true },
  queued: { word: "queued", tone: "warning", dot: true },
  running: { word: "running", tone: "warning", dot: true },
  pending: { word: "pending", tone: "warning", dot: true },
  review: { word: "in review", tone: "warning", dot: true },
  draft: { word: "draft", tone: "warning", dot: true },
  urgent: { word: "urgent", tone: "destructive", dot: true },
  conflict: { word: "conflict", tone: "destructive", dot: true },
  drift: { word: "drift", tone: "destructive", dot: true },
  due: { word: "due for review", tone: "destructive", dot: true },
  stale: { word: "stale", tone: "destructive", dot: true },
  expired: { word: "expired", tone: "destructive", dot: true },
  superseded: { word: "superseded", tone: "muted", dot: false },
  rejected: { word: "rejected", tone: "muted", dot: false },
  dismissed: { word: "dismissed", tone: "muted", dot: false },
  closed: { word: "closed", tone: "muted", dot: false },
  archived: { word: "archived", tone: "muted", dot: false },
  disabled: { word: "disabled", tone: "muted", dot: false },
  extracted: { word: "extracted", tone: "muted", dot: false },
  asserted: { word: "asserted", tone: "muted", dot: false },
  resolved_eng_revised: { word: "resolved · eng revised", tone: "success", dot: true },
  resolved_prd_amended: { word: "resolved · PRD amended", tone: "success", dot: true },
};

/** The only status→(word, tone) mapping in the app. Question status "open" is passed as "open_question". */
export function statusView(status: string, ctx?: { origin?: string | null }): StatusView {
  if (status === "binding" && ctx?.origin === "document") return MAP.ratified!;
  if (status === "open_question") return { word: "open", tone: "warning", dot: true };
  return MAP[status] ?? { word: status.replace(/_/g, " "), tone: "muted", dot: false };
}

export const toneClass: Record<Tone, string> = {
  primary: "bg-primary-soft text-primary border-primary-edge",
  success: "bg-success-soft text-success border-success-edge",
  warning: "bg-warning-soft text-warning border-warning-edge",
  destructive: "bg-destructive-soft text-destructive border-destructive-edge",
  muted: "bg-muted text-muted-foreground border-border",
};
```
Run the test → PASS.

- [ ] **Step 4: Composites**

`components/StatusBadge.tsx`:
```tsx
import { cn } from "@/lib/utils";
import { statusView, toneClass } from "@/lib/status";

export function StatusBadge({ status, origin, className }: { status: string; origin?: string | null; className?: string }) {
  const v = statusView(status, { origin });
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-xs font-medium", toneClass[v.tone], className)}>
      {v.dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
      {v.word}
    </span>
  );
}
```

`components/RefChip.tsx` (client, for copy):
```tsx
"use client";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export function RefChip({ children, kind, href, copy = true, className }: { children: string; kind?: string; href?: string; copy?: boolean; className?: string }) {
  const cls = cn("inline-flex h-6 max-w-full items-center truncate rounded-md border bg-muted px-1.5 font-mono text-xs text-muted-foreground", href && "hover:text-foreground", className);
  const inner = href ? <Link href={href} className={cls}>{children}</Link> : (
    <button type="button" className={cn(cls, copy && "cursor-copy hover:text-foreground")} onClick={() => copy && navigator.clipboard?.writeText(children)} aria-label={copy ? `Copy ${children}` : undefined}>{children}</button>
  );
  if (!kind) return inner;
  return (
    <TooltipProvider delayDuration={300}><Tooltip><TooltipTrigger asChild>{inner}</TooltipTrigger><TooltipContent>{kind}</TooltipContent></Tooltip></TooltipProvider>
  );
}
```

`components/Who.tsx`:
```tsx
import Link from "next/link";
import { cn } from "@/lib/utils";

export function Who({ login, role, size = "sm", href, className }: { login: string; role?: string; size?: "sm" | "md"; href?: string; className?: string }) {
  const initial = (login[0] ?? "?").toUpperCase();
  const body = (
    <span className={cn("inline-flex items-center gap-1.5 text-muted-foreground", className)}>
      <span className={cn("inline-flex items-center justify-center rounded-md bg-primary-soft font-semibold text-primary", size === "sm" ? "h-5 w-5 text-[10px]" : "h-7 w-7 text-xs")} aria-hidden>{initial}</span>
      <span className="truncate">@{login}</span>
      {role && <span className="text-xs">· {role}</span>}
    </span>
  );
  return href ? <Link href={href} className="hover:text-foreground">{body}</Link> : body;
}
```

`components/When.tsx` (client, for the absolute tooltip):
```tsx
"use client";
import { timeAgo } from "@/lib/data";
export function When({ at, className }: { at: string | Date; className?: string }) {
  const iso = typeof at === "string" ? at : at.toISOString();
  return <time dateTime={iso} title={new Date(iso).toLocaleString()} className={className}>{timeAgo(iso)}</time>;
}
```

`components/ListRow.tsx`:
```tsx
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function ListRow({ href, leading, title, meta, status, action, extra, className }: {
  href?: string; leading?: ReactNode; title: ReactNode; meta?: ReactNode; status?: ReactNode; action?: ReactNode; extra?: ReactNode; className?: string;
}) {
  const body = (
    <div className="min-w-0 flex-1">
      <div className="truncate text-base font-medium leading-6 text-foreground">{title}</div>
      {meta && <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground [&>*]:shrink-0">{meta}</div>}
      {extra && <div className="mt-1.5 text-sm text-muted-foreground">{extra}</div>}
    </div>
  );
  return (
    <div className={cn("group relative flex min-h-12 items-start gap-3 border-b px-4 py-3 last:border-b-0 hover:bg-muted/60", className)}>
      {leading && <div className="mt-0.5 shrink-0 text-muted-foreground">{leading}</div>}
      {href ? <Link href={href} className="min-w-0 flex-1 outline-none after:absolute after:inset-0 after:content-['']">{body}</Link> : body}
      {(status || action) && (
        <div className="relative z-10 flex shrink-0 items-center gap-2 self-center">
          {status}
          {action}
        </div>
      )}
    </div>
  );
}
```

`components/PageHeader.tsx`:
```tsx
import Link from "next/link";
import type { ReactNode } from "react";

export function PageHeader({ title, description, actions, tabs, crumbs }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; tabs?: ReactNode; crumbs?: Array<{ label: string; href?: string }> }) {
  return (
    <header className="mb-6">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span aria-hidden>›</span>}
              {c.href ? <Link href={c.href} className="hover:text-foreground">{c.label}</Link> : <span>{c.label}</span>}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold leading-7 text-foreground">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {tabs && <div className="mt-4">{tabs}</div>}
    </header>
  );
}
```

`components/Section.tsx`:
```tsx
import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function Section({ label, count, href, children, className }: { label: string; count?: number; href?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("mb-6", className)}>
      <div className="mb-2 flex items-center justify-between px-0.5">
        <h2 className="text-2xs font-semibold uppercase text-muted-foreground">{label}{typeof count === "number" && <span className="ml-1.5 font-mono normal-case tracking-normal">{count}</span>}</h2>
        {href && <Link href={href} className="text-xs text-muted-foreground hover:text-foreground">View all →</Link>}
      </div>
      <Card className="overflow-hidden shadow-none">{children}</Card>
    </section>
  );
}
```

`components/EmptyState.tsx`:
```tsx
import type { ReactNode } from "react";
export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed px-6 py-12 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground [&>svg]:h-5 [&>svg]:w-5">{icon}</div>
      <h3 className="text-base font-medium">{title}</h3>
      {children && <p className="mt-1 max-w-md text-sm text-muted-foreground">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
```

`components/StatGrid.tsx`:
```tsx
import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}
export function Stat({ n, label, href, hint }: { n: number | string; label: string; href?: string; hint?: string }) {
  const inner = (
    <Card className="h-full px-4 py-3 shadow-none transition-colors hover:bg-muted/60">
      <div className="text-xl font-semibold leading-7">{n}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {hint && <div className="mt-1 text-2xs text-muted-foreground">{hint}</div>}
    </Card>
  );
  return href ? <Link href={href} className="block rounded-lg outline-none">{inner}</Link> : inner;
}
```

`components/EvidenceQuote.tsx`:
```tsx
import { RefChip } from "@/components/RefChip";
export function EvidenceQuote({ quote, source, url, confidence }: { quote: string; source?: string | null; url?: string | null; confidence?: number | null }) {
  return (
    <figure className="my-2 border-l-2 border-primary-edge pl-3">
      <blockquote className="text-sm text-foreground/90">“{quote}”</blockquote>
      {(source || url || typeof confidence === "number") && (
        <figcaption className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {source && <span>via {source}</span>}
          {url && <a href={url} target="_blank" rel="noreferrer" className="hover:text-foreground">open ↗</a>}
          {typeof confidence === "number" && <RefChip copy={false}>{`confidence ${Math.round(confidence * 100)}%`}</RefChip>}
        </figcaption>
      )}
    </figure>
  );
}
```

`components/Field.tsx`:
```tsx
import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
export function Field({ label, hint, error, htmlFor, children }: { label: string; hint?: string; error?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
```

- [ ] **Step 5: Typecheck and commit**

```bash
cd packages/web && npm run typecheck && node --import tsx --test app/lib/status.test.ts
git add packages/web
git commit -m "feat(web): shadcn primitives + Lockstep composites (ListRow, StatusBadge, RefChip, Who, When…)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Web types, data helpers, and the app shell

**Files:**
- Modify: `packages/web/app/lib/types.ts`, `packages/web/app/lib/data.ts`
- Create: `packages/web/app/components/shell/{Sidebar,Nav,Topbar,UserMenu,Breadcrumb,MobileNav}.tsx`
- Rewrite: `packages/web/app/project/[orgId]/[projectId]/layout.tsx`
- Rewrite: `packages/web/app/project/[orgId]/[projectId]/notifications/page.tsx` → redirect
- Create: `packages/web/app/project/[orgId]/[projectId]/{loading,error}.tsx`

- [ ] **Step 1: Types**

In `types.ts` extend `ProjectOverview`:
```ts
decisions: Array<{ …existing; impact: number; createdAt: string; proposedBy: string | null }>;
questions: Array<{ id: string; body: string; status: string; scopeRef: string | null; urgent: boolean; askedBy: string | null; createdAt: string; answer: { body: string; by: string | null; at: string } | null }>;
tasks: Array<{ id: string; title: string; runState: string; status: string; delegatedTo: string | null; delegatedBy: string | null; createdAt: string }>;
contracts: Array<{ …existing; consumerCount: number }>;
audit: Array<{ action: string; entityKind: string | null; entityId: string | null; createdAt: string; actor: string | null; summary: string | null }>;
changes: Array<{ id: string; surface: string | null; summary: string; riskTier: string; impact: number; createdBy: string | null; createdAt: string; repoId: string }>;
```
Add:
```ts
export interface DecisionDetail {
  id: string; projectId: string; scopeKind: string; scopeRef: string; decisionType: string; status: string; origin: string; impact: number; currentVersion: number;
  constraintKind: string | null; expiresAt: string | null; reviewAt: string | null; createdAt: string;
  ruleText: string; rationale: string | null; alternatives: string[] | null; proposedBy: string | null;
  versions: Array<{ version: number; baseVersion: number | null; ruleText: string; rationale: string | null; alternatives: string[] | null; status: string; proposedBy: string | null; createdAt: string }>;
  approvals: Array<{ version: number; reviewer: string | null; verdict: string; comment: string | null; createdAt: string }>;
  requiredReviewers: Array<{ reviewer: string | null; required: boolean }>;
  provenances: Array<{ source: string; url: string | null; evidence: Array<{ quote: string }> | null; confidence: number | null }>;
  consumers: Array<{ repoId: string; gitRemote: string | null; project: { id: string; name: string } | null; source: string }>;
  sameSurfaceBinding: number;
  lineage: { supersedes: Array<{ id: string; ruleText: string; status: string }>; supersededBy: { id: string; ruleText: string; status: string } | null };
  conflicts: Array<{ id: string; kind: string; status: string; surface: string }>;
}
```

- [ ] **Step 2: Data helpers**

In `data.ts` add:
```ts
export const getDecisionDetail = (orgId: string, projectId: string, id: string) =>
  apiGet<DecisionDetail>(`/orgs/${orgId}/projects/${projectId}/decisions/${id}`);

const VERB: Record<string, string> = {
  "decision.proposed": "proposed", "decision.acked": "acknowledged", "decision.confirmed": "confirmed", "decision.superseded": "superseded",
  "decision.provenance_added": "added a source to", "decision.review_updated": "updated the review date of", "decision.expired": "expired",
  "constraint.ratified": "ratified", "constraint.staled": "staled", "question.asked": "asked", "question.answered": "answered",
  "task.delegated": "delegated", "task.completed": "completed", "change.published": "changed", "dependency.registered": "registered a dependency on",
  "conflict.opened": "opened a conflict on", "conflict.resolved": "resolved a conflict on", "member.role_changed": "changed a role",
  "member.slack_linked": "linked Slack for", "repo.disconnected": "disconnected", "document.registered": "registered", "document.unregistered": "unregistered",
  "document.resync_requested": "requested a re-sync of", "document.state_changed": "changed the state of", "edge.confirmed": "confirmed an edge for", "edge.rejected": "rejected an edge for",
};
/** "alice-chen proposed “Auth tokens are JWT…”" — actor and object when known, verb otherwise. */
export function humanizeAudit(a: { action: string; actor: string | null; summary: string | null }): { actor: string | null; verb: string; object: string | null } {
  return { actor: a.actor, verb: VERB[a.action] ?? a.action.replace(/[._]/g, " "), object: a.summary };
}
export const entityHref = (base: string, kind: string | null, id: string | null): string | undefined => {
  if (!id) return undefined;
  if (kind === "decision") return `${base}/decisions/${id}`;
  if (kind === "question") return `${base}/questions#${id}`;
  if (kind === "task") return `${base}/tasks#${id}`;
  if (kind === "change_feed_entry") return `${base}/contracts`;
  if (kind === "dependency_edge") return `${base}/dependencies`;
  return undefined;
};
```
Keep `timeAgo`; delete `humanizeAction` once no page imports it (Task 8).

- [ ] **Step 3: Shell components**

`components/shell/Nav.tsx` (client):
```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Inbox, CheckCircle2, HelpCircle, ListTodo, FileCode2, GitFork, FileText, Target, Waypoints, Plug, Users, History, Gauge } from "lucide-react";
import { cn } from "@/lib/utils";

export interface NavCounts { review?: number; decisions?: number; questions?: number; tasks?: number; contracts?: number; dependencies?: number; sources?: number; features?: number }

export function Nav({ base, counts }: { base: string; counts: NavCounts }) {
  const pathname = usePathname();
  const groups: Array<{ label?: string; items: Array<{ href: string; label: string; Icon: typeof Home; badge?: number }> }> = [
    { items: [{ href: "", label: "Home", Icon: Home }, { href: "/review-queue", label: "Review", Icon: Inbox, badge: counts.review }] },
    { label: "Ledger", items: [
      { href: "/decisions", label: "Decisions", Icon: CheckCircle2, badge: counts.decisions },
      { href: "/questions", label: "Questions", Icon: HelpCircle, badge: counts.questions },
      { href: "/tasks", label: "Tasks", Icon: ListTodo, badge: counts.tasks },
      { href: "/contracts", label: "Contracts", Icon: FileCode2, badge: counts.contracts },
      { href: "/dependencies", label: "Dependencies", Icon: GitFork, badge: counts.dependencies },
    ] },
    { label: "Product", items: [
      { href: "/sources", label: "Sources", Icon: FileText, badge: counts.sources },
      { href: "/features", label: "Features", Icon: Target, badge: counts.features },
      { href: "/graph", label: "Org graph", Icon: Waypoints },
    ] },
    { label: "Admin", items: [
      { href: "/connections", label: "Connections", Icon: Plug },
      { href: "/members", label: "Members & Repos", Icon: Users },
      { href: "/activity", label: "Activity", Icon: History },
      { href: "/insights", label: "Insights", Icon: Gauge },
    ] },
  ];
  return (
    <nav className="flex flex-col gap-4 px-3 py-2" aria-label="Project">
      {groups.map((g, gi) => (
        <div key={gi}>
          {g.label && <div className="mb-1 px-2 text-2xs font-semibold uppercase text-muted-foreground">{g.label}</div>}
          <ul className="flex flex-col gap-0.5">
            {g.items.map(({ href, label, Icon, badge }) => {
              const full = base + href;
              const active = href === "" ? pathname === base : pathname.startsWith(full);
              return (
                <li key={label}>
                  <Link href={full} aria-current={active ? "page" : undefined} className={cn("flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground", active && "bg-primary-soft text-foreground")}>
                    <Icon className={cn("h-4 w-4", active && "text-primary")} strokeWidth={1.75} />
                    <span className="flex-1 truncate">{label}</span>
                    {badge ? <span className="rounded-full bg-muted px-1.5 font-mono text-2xs tracking-normal text-muted-foreground">{badge}</span> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
```

`components/shell/Sidebar.tsx` (server):
```tsx
import { ScrollArea } from "@/components/ui/scroll-area";
import { ProjectSwitcher } from "@/components/ProjectSwitcher";
import { Nav, type NavCounts } from "./Nav";

export function Sidebar({ orgId, projectId, projects, base, counts }: { orgId: string; projectId: string; projects: Array<{ id: string; name: string }>; base: string; counts: NavCounts }) {
  return (
    <aside className="hidden w-[var(--sidebar-w)] shrink-0 flex-col border-r bg-card lg:flex">
      <div className="flex h-14 items-center gap-2 px-4">
        <span className="h-5 w-5 rounded-md bg-gradient-to-br from-[#a78bfa] to-[#2dd4bf]" aria-hidden />
        <span className="font-semibold">Lockstep</span>
      </div>
      <div className="px-3 pb-2">
        <div className="mb-1 px-1 text-2xs font-semibold uppercase text-muted-foreground">Project</div>
        <ProjectSwitcher orgId={orgId} projectId={projectId} projects={projects} />
      </div>
      <ScrollArea className="flex-1">
        <Nav base={base} counts={counts} />
      </ScrollArea>
      <div className="border-t px-4 py-3 text-2xs text-muted-foreground">v0.2 · <a href="https://www.getlockstep.dev" className="hover:text-foreground">docs</a></div>
    </aside>
  );
}
```
Rewrite `ProjectSwitcher.tsx` to use `Select` from shadcn (client): same props, `onValueChange={(v) => router.push(`/project/${orgId}/${v}`)}`, trigger `className="h-9"`.

`components/shell/Breadcrumb.tsx` (client):
```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
const LABELS: Record<string, string> = { "review-queue": "Review", decisions: "Decisions", questions: "Questions", tasks: "Tasks", contracts: "Contracts", dependencies: "Dependencies", sources: "Sources", features: "Features", graph: "Org graph", connections: "Connections", members: "Members & Repos", activity: "Activity", insights: "Insights", search: "Search" };
export function Breadcrumb({ base, orgName, projectName }: { base: string; orgName: string; projectName: string }) {
  const seg = usePathname().slice(base.length).split("/").filter(Boolean)[0];
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
      <span className="hidden truncate text-muted-foreground sm:inline">{orgName}</span>
      <span className="hidden text-muted-foreground sm:inline" aria-hidden>›</span>
      <Link href={base} className="truncate font-medium hover:text-foreground">{projectName}</Link>
      {seg && LABELS[seg] && (<><span className="text-muted-foreground" aria-hidden>›</span><span className="truncate text-muted-foreground">{LABELS[seg]}</span></>)}
    </nav>
  );
}
```

`components/shell/UserMenu.tsx` (client):
```tsx
"use client";
import { LogOut, ArrowLeftRight } from "lucide-react";
import Link from "next/link";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
export function UserMenu({ login, role, onSignOut }: { login: string; role: string; onSignOut: () => Promise<void> }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-8 w-8 items-center justify-center rounded-md bg-primary-soft text-xs font-semibold text-primary outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring" aria-label="Account menu">{(login[0] ?? "?").toUpperCase()}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal"><div className="text-sm font-medium">@{login}</div><div className="text-xs text-muted-foreground">{role}</div></DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild><Link href="/"><ArrowLeftRight className="mr-2 h-4 w-4" />Switch project</Link></DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void onSignOut()}><LogOut className="mr-2 h-4 w-4" />Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

`components/shell/MobileNav.tsx` (client): a `Sheet` with `side="left"` whose trigger is an icon Button (`Menu`) shown `lg:hidden`, content renders `<Nav base counts />`.

`components/shell/Topbar.tsx` (server):
```tsx
import { Bell, Search } from "lucide-react";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Breadcrumb } from "./Breadcrumb";
import { UserMenu } from "./UserMenu";
import { MobileNav } from "./MobileNav";
import type { NavCounts } from "./Nav";
import { logoutAction } from "@/actions";

export function Topbar({ base, orgName, projectName, login, role, reviewCount, counts }: { base: string; orgName: string; projectName: string; login: string; role: string; reviewCount: number; counts: NavCounts }) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur lg:px-6">
      <MobileNav base={base} counts={counts} />
      <Breadcrumb base={base} orgName={orgName} projectName={projectName} />
      <form action={`${base}/search`} method="get" className="ml-auto hidden w-72 md:block">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input name="q" placeholder="Search decisions…  ⌘K" className="h-9 pl-8" aria-label="Search decisions" data-hotkey="k" />
        </div>
      </form>
      <Link href={`${base}/review-queue`} className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Review queue, ${reviewCount} items`}>
        <Bell className="h-4 w-4" strokeWidth={1.75} />
        {reviewCount > 0 && <span className="absolute -right-0.5 -top-0.5 rounded-full bg-primary px-1 font-mono text-[10px] leading-4 text-primary-foreground">{reviewCount}</span>}
      </Link>
      <UserMenu login={login} role={role} onSignOut={logoutAction} />
    </header>
  );
}
```
Add a tiny client `Hotkey.tsx` that on `keydown` with `metaKey||ctrlKey` and `k` focuses `[data-hotkey="k"]`; render it once in the layout.

- [ ] **Step 4: Layout, redirect, loading, error**

`project/[orgId]/[projectId]/layout.tsx`:
```tsx
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import { getCounts, getOverview } from "@/lib/data";
import type { Me, OrgOverview } from "@/lib/types";
import { Sidebar } from "@/components/shell/Sidebar";
import { Topbar } from "@/components/shell/Topbar";
import { Hotkey } from "@/components/shell/Hotkey";

export const dynamic = "force-dynamic";

export default async function ProjectLayout({ children, params }: { children: ReactNode; params: { orgId: string; projectId: string } }) {
  const { orgId, projectId } = params;
  const me = await apiGet<Me>("/me");
  if (!me) redirect("/");
  const [org, o, projectCounts] = await Promise.all([
    apiGet<OrgOverview>(`/orgs/${orgId}/overview`),
    getOverview(orgId, projectId),
    getCounts(orgId, projectId),
  ]);
  const base = `/project/${orgId}/${projectId}`;
  const projectName = org?.projects.find((p) => p.id === projectId)?.name ?? "project";
  const counts = {
    review: projectCounts?.review.total ?? 0,
    decisions: o?.decisions.filter((d) => d.status !== "rejected" && d.status !== "superseded").length,
    questions: o?.questions.filter((q) => q.status !== "closed").length,
    tasks: o?.tasks.filter((t) => t.status !== "closed" && t.status !== "done").length,
    contracts: o?.contracts.length,
    dependencies: o?.dependencies.length,
    sources: projectCounts?.sources,
  };
  return (
    <div className="flex min-h-screen">
      <Sidebar orgId={orgId} projectId={projectId} projects={org?.projects ?? []} base={base} counts={counts} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar base={base} orgName={org?.projects.length ? "Workspace" : "Workspace"} projectName={projectName} login={me.principal.githubLogin} role={o?.viewer?.role ?? "member"} reviewCount={counts.review} counts={counts} />
        <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-6 lg:px-6"><Hotkey />{children}</main>
      </div>
    </div>
  );
}
```
The org name isn't in `OrgOverview` today; pass `"Workspace"` until core exposes it (do not add a core change for this).

`notifications/page.tsx`:
```tsx
import { redirect } from "next/navigation";
export default function Page({ params }: { params: { orgId: string; projectId: string } }) {
  redirect(`/project/${params.orgId}/${params.projectId}`);
}
```

`loading.tsx` (segment root):
```tsx
import { Skeleton } from "@/components/ui/skeleton";
export default function Loading() {
  return (
    <div>
      <Skeleton className="mb-2 h-7 w-48" /><Skeleton className="mb-6 h-4 w-80" />
      <div className="rounded-lg border">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0"><div className="flex-1"><Skeleton className="mb-2 h-4 w-2/3" /><Skeleton className="h-3 w-1/3" /></div><Skeleton className="h-6 w-16 rounded-full" /></div>)}</div>
    </div>
  );
}
```
`error.tsx` (client):
```tsx
"use client";
import { Button } from "@/components/ui/button";
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="rounded-lg border border-destructive-edge bg-destructive-soft p-6">
      <h2 className="text-base font-medium">Couldn't load this page</h2>
      <p className="mt-1 text-sm text-muted-foreground">{error.message || "The API returned an error."}</p>
      <Button variant="secondary" size="sm" className="mt-4" onClick={reset}>Retry</Button>
    </div>
  );
}
```

- [ ] **Step 5: Verify shell renders over the (still old) pages**

Run: `cd packages/web && npm run typecheck && npm run build 2>&1 | tail -3`; visit `http://localhost:3000/project/<org>/<proj>` (dev server picks up changes). Expected: new sidebar with all four groups visible, topbar with breadcrumb/search/bell/avatar, no clipping.

- [ ] **Step 6: Commit**

```bash
git add packages/web
git commit -m "feat(web): app shell — scrollable grouped sidebar, breadcrumb topbar, search, user menu, loading/error states

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Home

**Files:**
- Rewrite: `packages/web/app/project/[orgId]/[projectId]/page.tsx`
- Modify: `packages/web/app/actions.ts` (add `ackDecisionAction`)

- [ ] **Step 1: Server action**

Append to `actions.ts`:
```ts
export async function ackDecisionAction(formData: FormData): Promise<void> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const id = String(formData.get("id") ?? "");
  const version = Number(formData.get("version") ?? 0);
  await apiPost(`/orgs/${orgId}/projects/${projectId}/decisions/${id}/ack`, { version, verdict: "ack" });
  revalidatePath(`/project/${orgId}/${projectId}`);
  revalidatePath(`/project/${orgId}/${projectId}/decisions/${id}`);
}
```

- [ ] **Step 2: Home page**

```tsx
import Link from "next/link";
import { CheckCircle2, Inbox, HelpCircle, ListTodo, GitCommitHorizontal } from "lucide-react";
import { getOverview, getRatifications, getConflicts } from "@/lib/data";
import { PageHeader } from "@/components/PageHeader";
import { ListRow } from "@/components/ListRow";
import { StatusBadge } from "@/components/StatusBadge";
import { RefChip } from "@/components/RefChip";
import { Who } from "@/components/Who";
import { When } from "@/components/When";
import { Section } from "@/components/Section";
import { StatGrid, Stat } from "@/components/StatGrid";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { apiGet } from "@/lib/api";
import type { Me } from "@/lib/types";
import { ackDecisionAction } from "@/actions";

export const dynamic = "force-dynamic";

export default async function Home({ params }: { params: { orgId: string; projectId: string } }) {
  const { orgId, projectId } = params;
  const base = `/project/${orgId}/${projectId}`;
  const [o, me] = await Promise.all([getOverview(orgId, projectId), apiGet<Me>("/me")]);
  if (!o) return <EmptyState icon={<Inbox />} title="Couldn't load this project" />;
  const login = me?.principal.githubLogin ?? "";
  const isPm = o.viewer?.role === "pm" || o.viewer?.role === "owner";

  type Need = { key: string; impact: number; at: string; node: React.ReactNode };
  const needs: Need[] = [];
  for (const d of o.decisions.filter((d) => d.status === "open")) {
    needs.push({ key: `d:${d.id}`, impact: d.impact, at: d.createdAt, node: (
      <ListRow key={d.id} href={`${base}/decisions/${d.id}`} title={d.ruleText || d.scopeRef}
        meta={<><RefChip kind={d.scopeKind}>{d.scopeRef}</RefChip>{d.proposedBy && <Who login={d.proposedBy} />}<When at={d.createdAt} />{d.impact > 0 && <RefChip copy={false}>{`impact ${d.impact}`}</RefChip>}</>}
        status={<StatusBadge status={d.status} origin={d.origin} />}
        action={<form action={ackDecisionAction}><input type="hidden" name="orgId" value={orgId} /><input type="hidden" name="projectId" value={projectId} /><input type="hidden" name="id" value={d.id} /><input type="hidden" name="version" value={d.version} /><Button size="sm">Acknowledge</Button></form>} />
    ) });
  }
  for (const t of o.tasks.filter((t) => t.delegatedTo === login && t.status !== "done" && t.status !== "closed")) {
    needs.push({ key: `t:${t.id}`, impact: 0, at: t.createdAt, node: (
      <ListRow key={t.id} href={`${base}/tasks#${t.id}`} title={t.title} meta={<>{t.delegatedBy && <span>from <Who login={t.delegatedBy} /></span>}<When at={t.createdAt} /></>} status={<StatusBadge status={t.runState !== "done" ? t.runState : t.status} />} />
    ) });
  }
  for (const q of o.questions.filter((q) => q.urgent && q.status === "open")) {
    needs.push({ key: `q:${q.id}`, impact: 1, at: q.createdAt, node: (
      <ListRow key={q.id} href={`${base}/questions#${q.id}`} title={q.body} meta={<>{q.scopeRef && <RefChip>{q.scopeRef}</RefChip>}{q.askedBy && <Who login={q.askedBy} />}<When at={q.createdAt} /><StatusBadge status="urgent" /></>} status={<StatusBadge status="open_question" />} />
    ) });
  }
  for (const d of o.decisions.filter((d) => d.dueForReview && d.proposedBy === login)) {
    needs.push({ key: `r:${d.id}`, impact: d.impact, at: d.reviewAt ?? d.createdAt, node: (
      <ListRow key={d.id} href={`${base}/review-queue?tab=review-due`} title={d.ruleText} meta={<><RefChip>{d.scopeRef}</RefChip><span>review was due <When at={d.reviewAt!} /></span></>} status={<StatusBadge status="due" />} />
    ) });
  }
  if (isPm) {
    const [r, c] = await Promise.all([getRatifications(orgId, projectId), getConflicts(orgId, projectId, "open")]);
    for (const x of r?.candidates ?? []) needs.unshift({ key: `rat:${x.id}`, impact: 2, at: "", node: (
      <ListRow key={x.id} href={`${base}/review-queue?tab=ratifications`} title={x.ruleText} meta={<><RefChip>{x.scopeRef}</RefChip>{x.doc.title && <span>{x.doc.title}</span>}{typeof x.confidence === "number" && <span>confidence {Math.round(x.confidence * 100)}%</span>}</>} status={<StatusBadge status="proposed" />} action={<Button asChild size="sm" variant="secondary"><Link href={`${base}/review-queue?tab=ratifications`}>Ratify</Link></Button>} />
    ) });
    for (const x of c?.conflicts ?? []) needs.unshift({ key: `c:${x.id}`, impact: 3, at: x.openedAt, node: (
      <ListRow key={x.id} href={`${base}/review-queue?tab=conflicts`} title={x.constraintRuleText} meta={<><RefChip>{x.surface}</RefChip><When at={x.openedAt} /></>} status={<StatusBadge status="conflict" />} />
    ) });
  }
  needs.sort((a, b) => b.impact - a.impact || (a.at < b.at ? -1 : 1));

  const binding = o.decisions.filter((d) => d.status === "binding").length;
  const awaiting = o.decisions.filter((d) => d.status === "open").length;
  const openQ = o.questions.filter((q) => q.status !== "closed").length;
  const withConsumers = o.contracts.filter((c) => c.consumerCount > 0).length;
  const firstRun = binding + awaiting + openQ + o.contracts.length + o.tasks.length === 0;

  return (
    <>
      <PageHeader title="Home" description="What needs you, ranked by blast radius." />
      <Section label="Needs you" count={needs.length}>
        {needs.length === 0 ? <EmptyState icon={<CheckCircle2 />} title="You're in lockstep." action={<Button asChild variant="ghost" size="sm"><Link href={`${base}/activity`}>See recent activity</Link></Button>}>Nothing needs you right now.</EmptyState> : needs.slice(0, 8).map((n) => n.node)}
      </Section>
      {firstRun ? (
        <EmptyState icon={<GitCommitHorizontal />} title="Connect a repo to start">From inside a repo: <RefChip copy>{`npm i -g lockstep-cli`}</RefChip> then <RefChip copy>{`lockstep onboard`}</RefChip>.</EmptyState>
      ) : (
        <StatGrid>
          <Stat n={binding} label="Binding decisions" href={`${base}/decisions`} />
          <Stat n={awaiting} label="Awaiting ack" href={`${base}/decisions?status=open`} />
          <Stat n={openQ} label="Open questions" href={`${base}/questions`} />
          <Stat n={withConsumers} label="Surfaces with consumers" href={`${base}/contracts`} />
        </StatGrid>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Section label="Recent changes" href={`${base}/contracts`}>
          {o.changes.filter((c) => c.riskTier === "shared").length === 0 ? <EmptyState icon={<GitCommitHorizontal />} title="No shared changes yet">Contract changes captured from connected repos land here.</EmptyState> :
            o.changes.filter((c) => c.riskTier === "shared").slice(0, 6).map((c) => (
              <ListRow key={c.id} title={c.summary} meta={<>{c.surface && <RefChip>{c.surface}</RefChip>}{c.createdBy && <Who login={c.createdBy} />}<When at={c.createdAt} /></>} status={<StatusBadge status={c.riskTier} />} />
            ))}
        </Section>
        <Section label="Latest decisions" href={`${base}/decisions`}>
          {o.decisions.slice(0, 6).map((d) => (
            <ListRow key={d.id} href={`${base}/decisions/${d.id}`} title={d.ruleText || d.scopeRef} meta={<><RefChip>{d.scopeRef}</RefChip>{d.proposedBy && <Who login={d.proposedBy} />}<When at={d.createdAt} /></>} status={<StatusBadge status={d.status} origin={d.origin} />} />
          ))}
        </Section>
      </div>
    </>
  );
}
```
`statusView("shared")` and `("owned")` fall to muted; that's intended for risk tier.

- [ ] **Step 3: Verify and commit**

Typecheck, load Home in the browser with the seed: "Needs you" shows the two awaiting-ack decisions with Acknowledge buttons, tasks for alice, urgent question. Click Acknowledge on one → row disappears and Decisions count updates.
```bash
git add packages/web
git commit -m "feat(web): role-aware Home — needs-you list, linked stats, recent changes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Decisions list and Decision detail

**Files:**
- Rewrite: `project/[orgId]/[projectId]/decisions/page.tsx`
- Create: `project/[orgId]/[projectId]/decisions/[id]/page.tsx`, `…/[id]/ProposeVersionSheet.tsx`
- Modify: `actions.ts` (add `proposeVersionAction` returning a result for the Sheet)

- [ ] **Step 1: Decisions list**

Filters via query: `?status=open|binding|proposed|superseded`, `?impact=1` (cross-cutting). Compose: `PageHeader` (title "Decisions", description, `tabs` = link tabs All · Awaiting ack `n` · Cross-cutting `n` · History `n` built with `Tabs`/`TabsList`/`TabsTrigger asChild Link`), then one `Section` per group visible under the filter: "Awaiting review" (status open/proposed), "Binding" (binding), "History" (superseded/rejected). Each row:
```tsx
<ListRow key={d.id} href={`${base}/decisions/${d.id}`} title={d.ruleText || d.scopeRef}
  meta={<><RefChip kind={d.scopeKind}>{d.scopeRef}</RefChip>{d.proposedBy && <Who login={d.proposedBy} />}<When at={d.createdAt} />{d.impact > 0 && <RefChip copy={false}>{`impact ${d.impact}`}</RefChip>}{d.version > 1 && <RefChip copy={false}>{`v${d.version}`}</RefChip>}{d.decisionType === "principle" && <RefChip copy={false}>principle</RefChip>}{d.dueForReview && <StatusBadge status="due" />}</>}
  extra={d.rationale ? <span className="line-clamp-1">{d.rationale}</span> : undefined}
  status={<StatusBadge status={d.status} origin={d.origin} />}
  action={d.status === "open" || d.status === "proposed" ? <Button asChild size="sm" variant="ghost"><Link href={d.origin === "ingested" || d.origin === "document" ? `${base}/review-queue${d.origin === "document" ? "?tab=ratifications" : ""}` : `${base}/decisions/${d.id}`}>{d.origin === "document" ? "Ratify" : d.origin === "ingested" ? "Review" : "View"}</Link></Button> : undefined} />
```
Empty state icon `CheckCircle2`, copy as today.

- [ ] **Step 2: Propose-version action**

```ts
export async function proposeVersionAction(_prev: { error?: string } | undefined, formData: FormData): Promise<{ error?: string; ok?: boolean }> {
  const orgId = String(formData.get("orgId") ?? "");
  const projectId = String(formData.get("projectId") ?? "");
  const id = String(formData.get("id") ?? "");
  const res = await apiPostRaw(`/orgs/${orgId}/projects/${projectId}/decisions`, {
    scopeKind: String(formData.get("scopeKind")), scopeRef: String(formData.get("scopeRef")), ruleText: String(formData.get("ruleText")),
    baseVersion: Number(formData.get("baseVersion")), decisionType: String(formData.get("decisionType") || "rule"),
    rationale: String(formData.get("rationale") || "") || undefined, reviewAt: String(formData.get("reviewAt") || "") || undefined, supersedes: id,
  });
  if (res.status === 409) return { error: "This decision changed while you were editing. Reload to see the latest version." };
  if (!res.ok) return { error: `Could not propose (HTTP ${res.status}).` };
  revalidatePath(`/project/${orgId}/${projectId}/decisions`);
  return { ok: true };
}
```
Add `apiPostRaw` to `lib/api.ts` returning the raw `Response` (same headers as `apiPost`). Check `proposeDecision`'s CAS error status code in `ledger-service.ts` (search `statusCode`) and match it instead of 409 if different.

- [ ] **Step 3: Detail page**

`decisions/[id]/page.tsx` composes, top to bottom, exactly spec §7.2:
- `PageHeader` with `crumbs=[{label:"Decisions", href:`${base}/decisions`},{label:d.scopeRef}]`, `title={d.ruleText}`, `description` = meta line as a `div` of `RefChip`s + `StatusBadge` + `Who` + `When`, `actions` = eligible buttons: Acknowledge `<form action={ackDecisionAction}>` (status `open`), Confirm/Reject (origin `ingested` and status `proposed`, viewer owner/pm) using existing `confirmDecisionAction`/`rejectDecisionAction` with hidden fields as review-queue does, Ratify (origin `document`, status `proposed`, viewer pm/owner) via `ratifyDecisionAction`, `<ProposeVersionSheet …/>` (status `binding`). Reject is `variant="destructive"` inside a shadcn `Dialog` confirm.
- `Section "Rationale"`: rationale paragraph, alternatives `ul`, review date with `StatusBadge status="due"` when past. Omit when all empty.
- `Section "Blast radius" count={d.consumers.length}`: `ListRow` per consumer (`title=<RefChip>{repo short name}</RefChip>`, `meta` project chip + `source`), footer text `${d.sameSurfaceBinding} other binding decision(s) on this surface`. Empty: "No declared consumers. Own-area decision, bound on assertion."
- `Section "Agreement"`: `ListRow` per approval (`leading=<Who/>`, title = verdict, meta = comment + When); required reviewers without approval shown with `StatusBadge status="pending"`.
- `Section "Provenance"`: `EvidenceQuote` per provenance × evidence.
- `Section "History" count={d.versions.length}`: `ListRow` per version (`title=v{n} · {ruleText}`, meta = `Who` + `When`, status badge). Then lineage links (`supersedes`, `supersededBy`) as `ListRow href` to the other decision, and conflicts as `ListRow href=review-queue?tab=conflicts`.
- 404: `notFound()` from `next/navigation` when `getDecisionDetail` returns null.

`ProposeVersionSheet.tsx` (client): shadcn `Sheet` with `SheetTrigger asChild <Button variant="secondary" size="sm">Propose new version</Button>`; a `<form action={formAction}>` using `useFormState(proposeVersionAction, undefined)`; `Field`s: rule text (`Textarea` default `d.ruleText`), rationale (`Textarea`), review date (`Input type="date"`); hidden `orgId projectId id scopeKind scopeRef baseVersion decisionType`; error rendered under the form in `text-destructive`; on `state.ok` call `router.refresh()` and close.

- [ ] **Step 4: Verify and commit**

Typecheck; open a seeded decision detail; Acknowledge flow works from detail; Propose new version creates `v2` and the History section shows both; try with a stale `baseVersion` (edit the hidden input in devtools) → inline error.
```bash
git add packages/web
git commit -m "feat(web): Decisions list filters + Decision detail (blast radius, agreement, provenance, history, new version)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Activity, Questions, Tasks, Contracts, Dependencies, Search

**Files:** rewrite each `page.tsx`; modify `components/DependencyGraphFlow.tsx`.

Per-page composition (all use `PageHeader`, `Section`/`Card`, `ListRow`, `EmptyState`; no inline styles):

- **Activity.** Rows: `leading` = lucide icon by `entityKind` (`CheckCircle2` decision, `HelpCircle` question, `ListTodo` task, `GitCommitHorizontal` change, `GitFork` dependency, `History` default). `title` = `<span>{actor ? <Who login={actor}/> : "Lockstep"} {verb} {object && <em className="not-italic text-foreground">“{object}”</em>}</span>` using `humanizeAudit`. `meta` = `RefChip entityKind` + `When`. `href` = `entityHref(base, kind, id)`. Group rows by day with a `Section label={dayLabel}` (Today, Yesterday, else `toLocaleDateString`). Empty state as today.
- **Questions.** Rows `id={q.id}` anchor. `title` body; `meta` = scope chip, `asked by <Who/>`, `When`, `urgent` badge; `status` = `StatusBadge status={q.status === "open" ? "open_question" : q.status}`; `extra` = when `answer` exists: `<span><Who login={answer.by ?? "?"}/> answered <When at={answer.at}/>: {answer.body}</span>`. Two sections: Open, Answered & closed.
- **Tasks.** Rows `id={t.id}`; `meta` = `to <Who/>` · `from <Who/>` · `When`; single `status` = `<StatusBadge status={t.runState !== "done" ? t.runState : t.status}/>`. Sections: Open (status not done/closed) and Completed.
- **Contracts.** Keep filter form but as `Card` + `Input` + `Select` + `Button variant="secondary"`; result count as `text-xs text-muted-foreground`. One `Section` per repo. Row: `title=<span className="font-mono text-sm">{surface}</span>`, `meta` = `RefChip repoName`, `<RefChip copy={false}>{`${consumerCount} consumer${consumerCount===1?"":"s"}`}</RefChip>` (tone: if 0 keep muted; that's fine), `verifiedAgainst` text when present; `status` = `StatusBadge status={extracted|verified|asserted}` computed as today. Drop the method pill and `v1`; show `vN` only when > 1.
- **Dependencies.** `DependencyGraphFlow`: remove `MiniMap` import and element; wrap the filter `Input` in a `div className="absolute left-3 top-3 z-10 w-64"`; give the ReactFlow container `className="h-[480px] pt-12"` so nodes start below the filter; node styles keep their `style` objects with `// eslint-disable-next-line no-restricted-syntax` on the two object literals (React Flow requires them) and use `var(--card)`, `var(--muted)`, `var(--border)`, `var(--primary)`, `var(--font-mono)`. Edge list rows: `title=<span className="flex items-center gap-2"><RefChip>{consumer}</RefChip><ArrowRight className="h-3.5 w-3.5 text-muted-foreground"/><RefChip>{surface}</RefChip></span>`, `meta` = producer project chip when cross-project + `source`.
- **Search.** Form in a `Card`: `Input name=q` (prefilled from `?q`), two `Select`s, `Button variant="secondary"`. Results as Decisions rows (Task 7 grammar, `href` to detail). Title "Search".

- [ ] **Step 1: Rewrite the six pages and the graph component as specified.**
- [ ] **Step 2: Verify** typecheck + visit each route; the dependency graph shows all nodes with no overlay.
- [ ] **Step 3: Commit** `feat(web): Activity, Questions, Tasks, Contracts, Dependencies, Search on the row grammar`.

---

### Task 9: Review queue

**Files:** rewrite `review-queue/page.tsx`; delete `components/review/{Tabs,EvidenceBlock,ConflictWarning}.tsx`.

- Tabs: shadcn `Tabs value={tab}` with `TabsList` and four `TabsTrigger asChild` wrapping `Link`s (server-rendered, query-param driven), each showing its count via a small `font-mono` span. Default tab = first with items, in order proposed → ratifications → conflicts → review-due.
- Each item is a `Card` with `CardContent className="p-4"`: title `text-lg font-medium`, meta line (RefChips, confidence, sources count, `StatusBadge stale`), rationale paragraph, alternatives line, `EvidenceQuote` per provenance evidence, decided-by/review-on line, then an action row: `Button` default (Confirm / Ratify / "Still right — mark reviewed" / "Constraint holds"), `Button variant="secondary"` for Snooze, `Button variant="destructive"` for Reject/Dismiss inside a `Dialog` that hosts the existing hidden inputs and (for Dismiss) the reason `Input`.
- "Edit before confirming" / "Edit rule text" collapsibles become a `details` element styled with `className="group"` and `summary className="cursor-pointer text-xs text-muted-foreground"`; inside, `Field` + `Textarea`/`Input type=date`.
- Conflict warning becomes `<p className="mt-2 flex items-start gap-1.5 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0"/> …</p>`.
- Low-confidence and Recently-resolved groups remain collapsible `details`.

- [ ] **Step 1: Rewrite.** - [ ] **Step 2: Verify** all four tabs with the seed (Review due has one item; use `?tab=`). - [ ] **Step 3: Commit** `feat(web): Review queue on shadcn Tabs/Dialog, first non-empty tab default`.

---

### Task 10: Sources, Source detail, Features, Feature detail, Org graph, Insights

- **Sources.** Banner → `Card className="mb-4 border-warning-edge bg-warning-soft"` with text + Link. Register form → `Card` with `Input` + `Button` (default; it's the page's primary action). Rows: `leading=<FileText/>`, `title` Link to detail, `meta` = `{binding}/{total} binding`, conflicts `StatusBadge conflict`, anchors health, `synced <When/>`; `status` = `StatusBadge state` (with `title="Managed in Notion"` when mirrored) or a `Select` + `Button variant="secondary"` "Set"; `action` = ghost "Open ↗", ghost "Re-sync"; Unregister behind a `Dialog` with `variant="destructive"`.
- **Source detail.** `PageHeader crumbs=[Sources, title]`, header card as `ListRow`-shaped summary, three `Section`s (Constraints, Extraction history, Write-back log) with rows per current fields; constraint kind via `RefChip copy={false}`.
- **Features.** Rows `leading=<Target/>`, title Link, meta counts, `status` = conflicts badge when > 0.
- **Feature detail.** `PageHeader crumbs`, `StatGrid` of three `Stat`s, Constraints and Governed surfaces `Section`s; proposed edges get `StatusBadge proposed` + two ghost buttons (Confirm / Reject) as today.
- **Org graph.** `PageHeader actions=<form action={deriveGraphAction}><Button variant="secondary">Derive from members & decisions</Button></form>`. Nodes grouped by kind as `ListRow`s whose `extra` is a wrap of `RefChip`s (capabilities as `href` chips). Edges `Section` with `count`. Add-edge form → `Card` with two `Select`s, an `Input`, `Button variant="secondary"`.
- **Insights.** If every denominator is 0 → one `EmptyState` "No tuning signals yet". Else `StatGrid` with hints `x/y`. Dismiss reasons `Section` rows.

- [ ] **Step 1: Rewrite six pages.** - [ ] **Step 2: Verify** each route. - [ ] **Step 3: Commit** `feat(web): Sources, Features, Org graph, Insights on composites`.

---

### Task 11: Connections, Members & Repos, Login and workspace picker

- **Connections.** Two toggles as `Card`s: title, description, right side `Button variant={enabled ? "ghost" : "secondary"}` ("Disable"/"Enable"); non-owners see `StatusBadge`. "Connect a tool" `Card` with `Select` + `Button variant="secondary"`. Each connection is a `Card`: header row (`title` capitalised tool, `RefChip id`, account, `StatusBadge status`), Authorize `Button` default when not active (this is the region's one primary), allowlist rows as `ListRow`s, add-source form (`SourcePicker` restyled with Tailwind: `Input` + absolute `Card` dropdown using `bg-popover border shadow-md`), Notion state-mappings block with `Select`s and `Button variant="secondary"`.
- **Members & Repos.** `Section`s: GitHub App (replace the env-var sentence with "Ask an admin to enable the GitHub App." and wrap the env name in a `Tooltip` visible only when `isOwner`), Visibility (`Select` + secondary Button), Archive (destructive Button in a `Dialog`), Members (rows `leading=<Who size="md"/>`-style avatar, title `@login`, meta `StatusBadge` + Slack chip; trailing: Slack `Input` + secondary "Link", role `Select` + secondary "Update"), Invite form (`Input`, `Select`, default Button — the page's primary), Connected repos (rows `leading=<FolderGit2/>`, mono title, ghost Disconnect in a Dialog), Onboard (`pre className="rounded-md border bg-muted p-3 font-mono text-xs text-muted-foreground"`).
- **Login (`app/page.tsx`).** Centered `Card className="w-full max-w-sm p-6"`: logo mark + "Lockstep", `Button asChild` default "Sign in with GitHub", divider "or paste a token", `Input font-mono`, `Button variant="secondary"` "Sign in with token"; error in `text-destructive text-sm`. Workspace picker: header row with brand + ghost Sign out, `Section label="Projects"` with `ListRow href` per project (`meta` = members count), create org/project forms as `Card`s with `Input` + secondary Button.

- [ ] **Step 1: Rewrite three pages + SourcePicker.** - [ ] **Step 2: Verify.** - [ ] **Step 3: Commit** `feat(web): Connections, Members & Repos, login and workspace picker`.

---

### Task 12: Delete the old system, enforce lint, build

- [ ] **Step 1: Delete** `app/components/ui.tsx`, `app/components/icons.tsx`, `app/components/review/` directory; remove `humanizeAction` from `data.ts`.
- [ ] **Step 2: Grep guards**
```bash
cd packages/web && grep -rn "className=\"\(card\|row\|rows\|pill\|btn\|input\|meta\|title\|section-title\|stats\|stat\|empty\|code-ref\|animate-in\|stagger\)" app || echo "no legacy classes"
grep -rn "style={{" app | grep -v "eslint-disable-next-line no-restricted-syntax" -B1 | grep "style={{" || echo "no inline styles"
```
Expected: both print the "no …" line.
- [ ] **Step 3: Lint, typecheck, build**
```bash
cd ../.. && npm run lint && npm run typecheck && npm run build -w @lockstep/web 2>&1 | tail -3
```
Expected: 0 lint errors, build OK.
- [ ] **Step 4: Commit** `chore(web): remove legacy CSS system and components; lint-enforced composites`.

---

### Task 13: E2E seed + screenshot suite, CHANGELOG

**Files:**
- Create: `packages/web/e2e/seed.mjs` (from the audit seed: creates org "Acme Commerce", project "Checkout Platform", three members, three repos, surfaces, dependencies, eight decisions, changes, questions, tasks; prints `{orgId, projectId, token}`), `packages/web/e2e/shots.mjs` (routes × {1440, 1024} × {populated, empty}; empty = a fresh org with one empty project created by the script; outputs to `packages/web/e2e/out/` which is gitignored).
- Modify: `packages/web/package.json` scripts: `"e2e:seed": "node e2e/seed.mjs"`, `"e2e:shots": "node e2e/shots.mjs"`; devDependency `playwright@1.52.0`. Add `packages/web/e2e/out/` to `.gitignore`.
- Modify: `CHANGELOG.md` Unreleased: "**Dashboard redesign** — Tailwind + shadcn design system, one row grammar with who/when/impact, regrouped scrollable sidebar and breadcrumb topbar, role-aware Home, Decision detail page (blast radius, agreement, provenance, history, propose new version), one Review inbox (Notifications folded in), enriched overview API and `GET …/decisions/:id`."

- [ ] **Step 1: Write the scripts** (port the scratchpad `seed.mjs` and `shots.mjs`; parametrise `LOCKSTEP_API_URL` and `LOCKSTEP_WEB_URL` with localhost defaults; add the empty-project pass and the 1024 viewport).
- [ ] **Step 2: Run** `npm run e2e:seed -w @lockstep/web && npm run e2e:shots -w @lockstep/web` against the running local servers. Open every PNG and check against the spec: no clipped nav, all rows carry who/when, one primary per region, statuses use the vocabulary, empty states have copy, 1024 layout wraps correctly.
- [ ] **Step 3: Fix anything found**, re-run, then commit `chore(web): e2e seed + screenshot suite; changelog`.

---

### Task 14: Final verification and hand-off

- [ ] `npm run typecheck && npm run lint && npm test -w @lockstep/ingest && (cd packages/core && DATABASE_URL=… npm test)` — all green.
- [ ] `npm run build -w @lockstep/web` — OK.
- [ ] Push branch, open PR with the before/after screenshots attached (before set from the audit, after set from Task 13).

## Self-review

**Spec coverage.** §3 Foundations → Task 3. §4 Components → Task 4. §5 IA → Task 5 (sidebar, topbar, redirect), Task 7 (dead end), Task 9 (tab default). §6 Home + grammar → Tasks 6, 8–11; folded-in fixes: minimap/inset (Task 8), Insights empty (Task 10), GITHUB_APP_SLUG (Task 11). §7 Decision detail → Tasks 2, 7. §8 API → Tasks 1, 2. §9 States/a11y/responsive → Tasks 4 (Tooltip, focus ring in Task 3 CSS), 5 (loading/error, MobileNav). §10 Verification → Tasks 12–14.

**Placeholders.** Tasks 8–11 specify composition per page rather than full page code; each names exact components, props, variants, and copy. Acceptable because the executor holds the current page sources read during planning and the grammar table in the spec.

**Type consistency.** `statusView`/`toneClass` (Task 4) used by `StatusBadge`; `ListRow` prop names (`href, leading, title, meta, status, action, extra`) used identically in Tasks 6–11; `NavCounts` shared by `Nav`, `Sidebar`, `Topbar`, `MobileNav`; `DecisionDetail` type (Task 5) matches `decisionDetail` return (Task 1) field for field; `ackDecisionAction`/`proposeVersionAction` names used in Tasks 6–7 match `actions.ts` additions.
