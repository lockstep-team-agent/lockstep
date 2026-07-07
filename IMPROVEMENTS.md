# Lockstep — Improvements Backlog

Running list of product/engineering gaps surfaced while pressure-testing the pitch
(context: preparing to pitch **GoKwik**, a fairly large org — so "does it scale beyond a
2–5 person pilot" is the lens for everything below).

Legend — **Severity**: 🔴 blocks large-org adoption · 🟠 real friction · 🟡 rough edge / polish.

> **Shipped & removed:** per-project/walled visibility (was #2) and the `/lockstep-setup`
> onboarding skill (was #11) are done and have been dropped from this list. #11's delivery also
> resolved the top of #1 (agent-assisted `consumes` authoring) — see #1 for what remains.

---

## 1. 🟠 `consumes` autodetection — top gap shipped; deeper coverage + runtime import remain

**Shipped (2026-07-07):** the `/lockstep-setup` skill + `lockstep scan` now scan the repo for
outbound `fetch`/`axios`/gRPC-client calls and **graph-resolve** them — each call is matched against
the produced-surface catalog of the *other* repos in the project (closed-world matching), so a match
becomes a `consumes:` entry with the producer repo named. AI proposes, human approves (same trust
model as decisions). `produces:` is auto-filled from served routes and synced to the catalog, so the
graph self-improves as repos onboard. This closed the original 🔴 "100% hand-written `consumes`" gap.

**What still remains:**
- **Deeper static coverage** — the outbound detector handles `fetch`/`axios`/gRPC-client stubs and
  scoped-package import hints; it does not yet parse GraphQL client documents, base-URL/non-literal
  indirection, or non-JS/TS languages. A concrete-literal path param (`/inventory/42`) only matches
  when written as a template param.
- **Service-level shorthand** — `consumes` is still endpoint-level canonical IDs; there's no
  "I depend on inventory-service" rollup.
- **Import from existing infra** — API gateway / service mesh / OpenTelemetry traces already encode
  the real service graph. Ingesting that would build the graph for free (the zero-friction endgame).

---

## 2. 🟠 Setup: "one commits, everyone git-pulls" can clobber teammates' config

**What today:** `lockstep init` itself is well-behaved — it MERGES (`.mcp.json` keeps other
servers; `.claude/settings.json` keeps foreign hooks; `CLAUDE.md` edits only a marked block;
writes `.lockstep.bak` backups). SKILL.md is a full overwrite (acceptable — reference docs).

**The gap:** the merge only runs when a developer runs `init` locally. In the documented
"one person commits, everyone `git pull`s" flow, **git pull copies committed files verbatim — the
merge never runs.** So:
- A teammate's own repo-local `.claude/settings.json` / `CLAUDE.md` can conflict or be overwritten.
- The committer's *personal* hooks leak to the whole team via the committed `settings.json`.

**Fix (owner's preferred direction):** don't rely on commit+pull for personal config. Have each
developer run `lockstep init` + `lockstep connect --project "X"` themselves so the merge runs
against their local setup. Commit only the genuinely shared, safe artifacts (`CLAUDE.md` lockstep
block, `.mcp.json`, `lockstep.yaml`); keep hooks/personal bits in per-developer scope
(`.claude/settings.local.json` / `~/.claude`, which is the Claude Code convention for personal vs shared).
Consider a `lockstep onboard` command that does init+connect in one step for teammates.

---

## 3. 🟠 `produces` "verified" means source-extracted, not runtime-verified

**What today:** `verified: true` / `verifiedAgainst: "git-diff"` means the surface was mechanically
extracted from the git diff / source code — NOT confirmed against a running service. (The catalog
sync from `lockstep scan` is likewise labeled `verifiedAgainst: "source-extracted"`.)

**Why it matters:** Don't overclaim "verified" in the pitch — a sharp CTO will ask. It's
"this route exists in the code," not "this route responds in prod."

**Fix:** Optional runtime/OpenAPI verification pass; or just tighten the wording to "extracted
from source" and reserve "verified" for a future live check.

---

## 4. 🟠 Cross-project dependencies are thin

**What today:** The graph is strongest *within* a project (surfaces matched by exact ID among a
project's repos). Real orgs have service-in-project-X calling service-in-project-Y.

**Why it matters:** Where you draw project boundaries determines how much of the true graph you
capture. Large orgs won't fit in one project.

**Fix:** First-class cross-project edges; guidance on drawing project boundaries around
tightly-coupled clusters.

---

## 5. 🟡 Inbox has no cross-session de-dup for one person

**What today:** A ping to a person is replicated as one inbox item per repo in the project, so the
same ping can surface in multiple folders' sessions until cleared.

**Why it matters:** For someone running Claude across many repos, the same question shows up
repeatedly — noise.

**Fix:** De-dup a person's messages across their own repo sessions, or a person-level inbox with
per-session read state.

---

## 6. 🟡 Fusion / supersession use lexical (Jaccard) similarity

**What today:** Dedup of the same decision across sources and supersession detection use lexical
Jaccard overlap (≥0.6 fuse, <0.4 supersede). Embeddings deferred.

**Why it matters:** Lexical similarity misses paraphrases and over-merges superficially similar
rules — accuracy risk as decision volume grows.

**Fix:** Swap in embedding-based similarity.

---

## 7. 🟠 No SOC2 / SSO yet (enterprise readiness)

**What today:** Auth is GitHub-based; hosted instance is a best-effort demo; no SOC2, no SSO/SAML.

**Why it matters:** GoKwik-scale procurement will ask. Current honest answer is "self-host,
your data never leaves your tenant."

**Fix:** Harden self-host as the enterprise story near-term; SOC2/SSO on the roadmap.

---

## 8. 🟡 Human-confirm queue could bottleneck at scale

**What today:** Every proposed/ingested decision lands as a draft a human must confirm before it
binds. Correct trust model, but volume-sensitive.

**Why it matters:** At large-org decision volume, the review queue can back up; if it does, agents
run against stale/unconfirmed rules.

**Fix:** Confidence-based auto-bind for low-impact/own-area decisions (already the intended model —
ensure it's enforced), batching, and good queue triage UX.

---

## 9. 🟡 Scope today = engineering decisions only

**What today:** The product handles *engineering* decisions (architecture/rules/contracts). v2
ingestion widens the *sources* (Slack/Jira/Notion) but still distills engineering decisions.
Product/PM decisions are the stated north star; the v3 product layer (PRDs → ratified constraints)
now partly addresses this, but full product-decision management is not built.

**Why it matters:** Don't promise product-decision management in the GoKwik pitch — scope to
engineering coordination.

**Fix:** Keep the ledger source-agnostic (already the design intent); build product-decision
support later.

---

## 10. 🟠 Ingest connections are project-scoped — one Slack workspace = reconnect per project

**What today:** Per-channel→per-project source tagging already works (`ingest_allowlist` binds a
`sourceKind`/`sourceRef` to a `projectId`). BUT `source_connections` is itself project-scoped
(one connection per project+tool), so the same Slack/Jira/Notion workspace must be re-authorized
once per project.

**Why it matters:** A large org with many projects re-connects the same Slack workspace many times —
annoying and error-prone.

**Fix:** Lift the connection to **org level** (connect each tool once), then route each
channel/board/database to a project purely via the allowlist. Surface the tagging clearly in the
`/connections` UI.

## Pitch guidance distilled from the above
- **Wedge = a small cluster of interdependent services**, where hand-declaring a few dependencies
  is trivial and the payoff is immediate. "Grows to GoKwik/Shopify" is the *vision*, not the
  *starting* claim. Conflating the two is what makes the product hard to defend.
- **Lead with the deterministic skeleton** (surfaces, dependencies, impact, reconcile are all
  mechanical — no AI guessing) and confine AI to "propose a decision, human confirms."
- **Volunteer the honest gaps** (`consumes` autodetection still deepening, no SOC2/SSO, cross-project
  edges thin) before you're cornered — that's what makes the rest credible.
