# Lockstep v2 — Human-Decision Ingestion Plan

> Expand the *source* side of "GitHub for decisions": harvest decisions humans make in
> Slack / Jira / Notion / Confluence **before** any code is written, distill them into the
> **same** decision ledger, and replay them to agents — while making humans real users.
>
> Seven locked product decisions (see `memory/lockstep-v2-ingestion.md`):
> distilled decisions (not raw artifacts) · read-in only · scheduled sweeps · draft-then-confirm ·
> org-graph beyond code surfaces · one-decision-many-provenances · **allowlisted sources only**.
> Connector layer: **Composio** (SaaS, MCP-native, free tier). First slice: **Slack → review → briefing**.

---

## Part A — The distillation engine (the make-or-break)

The hard question isn't "how do we connect Slack" — Composio does that. It's **"given a firehose of
messages, how do we reliably pull out the handful that are real, durable decisions, and nothing else."**
Everything downstream (binding, PR gates) trusts this. We treat it as a **recall-first funnel that
narrows to precision**, with a human as the final precision gate.

### A.1 The decision rubric — what actually qualifies

A message becomes a *decision* only if it passes four tests. This rubric is the literal grading
instruction we give the extraction model, and the definition humans see in the review queue.

| Test | Question | Fails → it's a… |
|------|----------|-----------------|
| **Durability** | Does it constrain *future* work beyond the task at hand? | one-off action → **change/task**, not a decision |
| **Agreement** | Was it actually *concluded*, or still being debated? | still open → **question**, or discard |
| **Agency** | Was it a real *choice among alternatives* (vs a statement of fact)? | fact/status update → discard |
| **Specificity** | Can it be restated as one imperative rule? | vague sentiment → discard |

This mirrors the v1 change-vs-decision split — now applied to human text instead of git diffs.
A decision is a **durable rule or architectural choice**; everything else is noise we deliberately drop.

### A.2 The funnel (cheap → expensive → human)

```
Stage 0  SEGMENT     threads/pages since watermark → conversation units (a Slack thread = 1 unit)
Stage 1  RECALL      cheap filter: "could this unit contain a decision?"   (Haiku / keyword+embedding)
Stage 2  EXTRACT     structured LLM call: rubric + provenance              (Sonnet, forced JSON schema)
Stage 3  SCOPE       map to canonical surface OR org-graph node → impact
Stage 4  DEDUP       vs already-ingested (idempotency) + vs existing decisions (semantic)
Stage 5  GATE        confidence + finality → propose / raise-question / discard
Stage 6  FILE        proposed decision, rich provenance, ranked into review queue
Stage 7  HUMAN       confirm / edit / merge / reject  → only now can it bind
```

Why a funnel: running the expensive extraction model on every Slack message is cost-prohibitive and
noisy. Stage 1 is tuned for **recall** (better to pass junk forward than miss a decision); Stages 2–5
add **precision**; Stage 7 is the **guaranteed** precision gate — no extracted decision ever binds
without a human, per the locked product decision.

### A.3 Stage 1 — cheap candidate filter (recall)

Goal: drop the ~95% of threads that obviously contain no decision, cheaply.
- **Signals:** decision-language markers ("let's go with", "we decided", "final call", "agreed",
  "going forward", "from now on", "the plan is", "approved", "RFC/ADR"), ✅/👍 reactions on a proposal,
  thread resolved/📌 pinned, Jira status→Done with a comment, Notion page tagged decision/ADR.
- **Mechanism:** keyword pre-filter → embedding similarity to a "decision prototype" set → Haiku 4.5
  binary "maybe-decision?" on the survivors. Cheap, high-recall. Tune the threshold on the eval set (A.7).

### A.4 Stage 2 — structured extraction (precision core)

One forced-JSON Claude call (Sonnet 4.6; escalate low-confidence to Opus 4.8) per candidate unit,
grading against the A.1 rubric and returning:

```jsonc
{
  "is_decision": true,
  "decision_type": "rule" | "architecture",
  "finality": "agreed" | "proposed" | "reversed" | "superseded",  // only "agreed" is binding-eligible
  "rule_text": "Auth tokens are JWT with 15-minute expiry.",       // durable, imperative
  "rationale": "Chosen over sessions to stay stateless across services.",
  "alternatives_considered": ["server-side sessions", "opaque tokens"],
  "decided_by": ["@alice", "@bob"],           // who assented
  "decided_at": "2026-06-30T14:12:00Z",
  "scope_hint": "authentication",             // free-text area, resolved in Stage 3
  "surface_candidates": ["POST /auth/session"],// code surfaces referenced, if any
  "confidence": 0.86,
  "evidence": [                               // exact quotes — provenance + what the reviewer reads
    { "externalId": "C123/p1699", "quote": "ok let's lock it: JWT, 15 min. shipping it." }
  ]
}
```

`evidence` is mandatory and verbatim — it is both the provenance trail and what a human reviews, so a
hallucinated rule has a quote a reviewer can immediately falsify. System prompt is **prompt-cached**
(rubric + schema are constant) to cut cost.

### A.5 Stage 3 — scope resolution & impact

- Try to canonicalize each `surface_candidate` with the existing grammar
  (`http:METHOD /path`, `proto:pkg.Service/Rpc`, `gql:Root.field` — reuse `capture/surface.ts` logic).
- **Surface matches the dependency graph** → real impact via `impactForScopeTx` (v1 path, unchanged).
- **No surface** → resolve `scope_hint` to an **org-graph node** (team/project/topic) and assign a
  coarse impact from that node's fan-out. Until the org-graph ships (Phase 3), non-code decisions land
  `scopeKind:"topic"`, impact 0 (own-area) — recorded, low-ranked, honestly flagged "unscoped".

### A.6 Stages 4–6 — dedup, gate, file

- **Idempotency:** every unit hashes to `(connectionId, externalId, contentHash)` in `ingestArtifacts`;
  a re-seen thread is never re-distilled. This is the watermark's correctness backstop.
- **Semantic dedup (Phase 2+):** embedding-match `rule_text` against existing decisions in the same
  scope. Match → **attach as another provenance** (the "one decision, many provenances" goal) rather
  than mint a duplicate. Contradiction with a *binding* decision → file as a **proposed supersession**,
  surfacing both to the reviewer. Ambiguous → flag for human merge in the queue (the accepted fallback).
- **Gate:** `is_decision:false` or `confidence < floor` → discard (logged for tuning, not shown).
  `finality != "agreed"` → file as a **Question** ("Did the team decide X?"), never a rule.
  Otherwise → **proposed decision**. Confidence ranks the queue and pre-selects the reviewer's default
  action; it never lets anything skip the human.
- **File:** `fileProposedDecision()` writes `status:"proposed"`, `origin:"ingested"`, full provenance.

### A.7 Making it *good* over time (the eval loop)

Extraction quality is a tuning problem, so we build for it from day one:
- **Golden set:** ~50 hand-labeled real threads (decision / not / which rule) → measured precision &
  recall per stage on every prompt change.
- **Human feedback = labels:** every reject/edit/merge in the review queue is written back as an eval
  example. Reject rate and edit-distance are the north-star quality metrics.
- **Model tiering:** Haiku (Stage 1) → Sonnet (Stage 2) → Opus only on low-confidence re-checks.
  Batch + prompt caching keep cost roughly linear in *candidate* volume, not *message* volume.

---

## Part B — Architecture & new components

Nothing in v1 polls or runs background work; all fan-out is in-band in a request transaction. v2 adds
one new long-running process and keeps core as the **single DB owner** (RLS intact). The worker never
touches Postgres directly — it talks to core over HTTP with a service token, matching the existing
"packages communicate over HTTP boundaries" design.

```
                       ┌───────────────── packages/ingest  (NEW, long-running) ─────────────────┐
   Composio cloud  ◀──▶ │  scheduler → SourceConnector(Composio) → distillation funnel (Part A)  │
   Slack/Jira/…         │            (Anthropic SDK: Haiku/Sonnet/Opus, prompt-cached)           │
                        └───────────────────────────────┬───────────────────────────────────────┘
                                     service-token HTTP  │  GET /ingest/work · POST /ingest/proposed-decisions · POST /ingest/watermark
                                                         ▼
   packages/core (Fastify + PG, RLS)  ──  new routes/ingest.ts + ledgerService.fileProposedDecision/confirm/reject
                                                         │
   packages/web (Next.js)  ──  /review-queue · /connections (Composio OAuth + allowlist) · /search
```

### B.1 New package: `packages/ingest` (`@lockstep/ingest`)
- `src/scheduler.ts` — per-connection sweep loop (default 15 min); reads due work from `GET /ingest/work`.
- `src/connectors/SourceConnector.ts` — **interface** (`listUpdatedSince`, `fetchUnit`, `resolveMembers`).
  This is the seam that lets a self-hosted **Nango** backend replace Composio later (the accepted mitigation).
- `src/connectors/ComposioConnector.ts` — Composio SDK/MCP impl for Slack (Jira/Notion/Confluence in Phase 2).
- `src/connectors/StubConnector.ts` — returns canned threads; powers deterministic e2e tests with no network.
- `src/distill/{recall.ts, extract.ts, scope.ts, dedup.ts, gate.ts}` — the Part-A funnel.
- `src/client.ts` — thin authed HTTP client to core (`/ingest/*`).
- Deployed as a second Railway service; same image, different entrypoint.

### B.2 Core changes (`packages/core`)
- **Schema** (`src/db/schema.ts` + new migration `drizzle/0002_ingestion.sql`):
  - `decisions.status`: add `proposed`, `rejected`. `decisions.origin`: new enum `agent | ingested` (default `agent`).
  - `decisionVersions.provenance` (JSONB, already exists) carries `{source, connectionId, externalId, url, evidence[], extractorModel, confidence, decidedBy, decidedAt}` — no shape migration needed.
  - `sourceConnections` — `(orgId, projectId, tool, composioConnectionId, status, createdBy)`.
  - `ingestAllowlist` — `(orgId, projectId, connectionId, sourceKind[channel|project|space], sourceRef, sourceName, enabled)` — the opt-in; **nothing is swept unless listed here**.
  - `ingestWatermarks` — `(orgId, connectionId, sourceRef, cursor, updatedAt)`.
  - `ingestArtifacts` — `(orgId, connectionId, externalId, contentHash, status[distilled|discarded|proposed], confidence, decisionId?)` — idempotency + tuning audit. Stores evidence quotes only, not full raw content.
  - Phase 3 org-graph: `graphNodes (kind[team|project|doc|person|surface], ref, label, source[derived|manual])` + `graphEdges (fromId, toId, kind, weight)`.
- **Service** (`src/ledger/ledger-service.ts`): `fileProposedDecision()` (origin=ingested, status=proposed, bypasses binding), `confirmDecision()` (proposed → runs the normal impact/binding path), `rejectDecision()`, `mergeDecision(intoId)` (attach provenance / supersede). `listDecisions` gains a `status`/`origin` filter.
- **Routes** (`src/api/routes/ingest.ts` + additions to `ledger.ts`/`dashboard.ts`):
  - Worker (service-token): `GET /ingest/work`, `POST /ingest/proposed-decisions`, `POST /ingest/watermark`.
  - Admin: `POST/GET /orgs/:o/connections`, `POST/GET /orgs/:o/projects/:p/allowlist`.
  - Review: `GET …/decisions?status=proposed`, `POST /decisions/:id/confirm|reject|merge`.
  - Search: `GET …/decisions/search?q=&scopeKind=&status=&from=&to=`.
- **Auth:** a new **service principal** + token scope for the worker (write proposed decisions across a
  tenant); reuses the existing token/RLS machinery.

### B.3 Web changes (`packages/web`)
- `app/project/[orgId]/[projectId]/review-queue/page.tsx` — proposed-decision cards: rule text, the
  clickable Slack/Jira/Notion provenance, the verbatim evidence quote, confidence, suggested
  scope/impact, and **Confirm / Edit / Reject / Merge**. Nav badge shows the queue count. (Phase 1)
- `app/project/[orgId]/[projectId]/connections/page.tsx` — Connect Slack via Composio OAuth; pick the
  allowlisted channels. (Phase 1)
- `app/project/[orgId]/[projectId]/search/page.tsx` — "what did we decide about X?" over the ledger. (Phase 2)
- Blast-radius notifications for humans (bell/email) — reuses audit + graph. (Phase 3)
- Follows the existing custom-CSS design system (`globals.css` tokens, `StatusPill`, `PageHead`, `EmptyState`).

### B.4 What does NOT change
- The **agent path is untouched**: once a proposed decision is confirmed, it's an ordinary ledger
  decision — it flows into the existing session-start briefing and PR gate with no agent-side change.
  The skill (`adapters/templates.ts`) needs only a one-line note that a briefing item may cite an
  external source. No new MCP tools required for the core loop.

---

## Part C — Phased delivery

| Phase | Goal | Ships |
|-------|------|-------|
| **0 — Foundation** | Rails for everything, no user-visible feature | schema migration (proposed/origin/source tables), `packages/ingest` skeleton, `SourceConnector` interface + `StubConnector`, service-token auth, `/ingest/*` routes, `fileProposedDecision/confirm/reject`. E2e: Stub → proposed → confirm → appears in a briefing. |
| **1 — Slack vertical slice** ⭐ | **The demo.** One channel end-to-end | `ComposioConnector` (Slack), connect+allowlist UI, the full Part-A funnel for Slack, review-queue UI, confirmed decision → existing briefing. **Single-source, idempotency-only dedup.** |
| **2 — Breadth + memory** | More sources, humans can search | Jira + Notion + Confluence connectors (same interface, per-source segmentation/prompts), decision **search** page, intra-tool semantic dedup + supersession detection. |
| **3 — Org graph + fusion** | Impact for non-code, one-decision-many-provenances | `graphNodes/graphEdges` auto-derived from connectors + human correction UI, impact for non-surface decisions, cross-tool identity resolution, blast-radius notifications. |
| **4 — Hardening / enterprise** | Trust, cost, coverage | Nango self-host swap behind `SourceConnector`, cost controls + eval harness in CI, retention/redaction policy, ClickUp / Google Docs. |

Slice 1 is the proof: it exercises sweep → distill → propose → confirm → replay on the hardest,
highest-value source, and is independently demoable.

---

## Part D — Key risks & how the design contains them

| Risk | Containment |
|------|-------------|
| **Bad extraction binds a false rule** | Universal draft-then-confirm (Stage 7); nothing binds without a human. Mandatory verbatim `evidence` makes review fast and falsifiable. |
| **LLM cost on Slack firehose** | Recall funnel (cheap Stage 1), model tiering, batching, prompt caching. Cost scales with *candidates*, not messages. |
| **Reads sensitive content** | Allowlist-only — nothing swept unless a channel/project/space is opted in. Store evidence quotes, not full raw content. |
| **Composio data residency** | `SourceConnector` seam → Nango self-host swap in Phase 4; documented as an accepted v1 trade-off. |
| **Cross-tool dedup is hard** | Deferred past slice 1; idempotency (Stage 4a) ships first, semantic fusion is Phase 2–3, ambiguous cases fall to human merge. |
| **Org-graph is a big lift** | Non-code decisions honestly land impact-0/`topic` until Phase 3; not blocking the slice. |

## Part E — Testing
- Local PG at `127.0.0.1:5433` (existing test setup). Migrations hand-authored against the journal.
- **Deterministic e2e** via `StubConnector`: canned threads → assert proposed decisions land, confirm
  → assert briefing contains them. No network, no Composio in CI.
- **Extraction eval:** golden set of ~50 labeled threads; precision/recall gate on prompt changes.
- Live Composio smoke test kept out of CI (interactive auth), run manually against a sandbox workspace.
