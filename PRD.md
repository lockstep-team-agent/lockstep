# Product spec — Lockstep

*Neutral, cross-vendor system-of-record for coordinating multiple developers' coding agents. Working name TBD.*

> **Status:** Final PRD (v4). Demand validated for the dogfood beachhead (Primathon, lived pain). Spike 0 (vendor feasibility) passed green. Ready to start a thin v1 build.

---

## 1. One-liner

A **neutral, cross-vendor system-of-record** for coordinating multiple developers' coding agents (Claude Code, Codex, Gemini CLI, …) on the same project — a durable, *locally-verified* ledger of decisions, contracts, ownership, dependencies, and tasks that agents read and write automatically, reconciled at the pull-request boundary — **without any source code leaving the machine it lives on.**

The short version of the vision: **let two teammates' coding agents stay in lockstep** — notify each other of changes, delegate tasks, ask and answer questions, and obey shared binding decisions on the same codebase — as durable, attributed, GitHub-inspired documents rather than ephemeral chat.

---

## 2. Problem & evidence

### The gap
Every mature tool today coordinates **one person's many agents on one machine** (Claude Code Agent Teams, claude-peers-mcp, AutoGen/CrewAI/LangGraph). Nobody coordinates **different people's independently-run agents across machines.** Each developer's agent learns the codebase in isolation; decisions, intent, and the contract between services live in one person's head or one agent's session and never transfer. Code syncs via git; **understanding does not.**

### Evidence this is real
- **Anthropic's own backlog:** open feature request *claude-code#38536* (an EM running 28 engineers) calls per-user memory *"the single biggest efficiency bottleneck for teams adopting Claude Code"* — still unimplemented. Official docs confirm Claude Code memory is per-user and machine-local.
- **A wave of 2026 startups** (Wato, Memory Store, PromptQL) chase *general team memory* — horizontal, async knowledge stores. None solve live, cross-vendor coordination of coding agents specifically.
- **Lived pain (beachhead validation):** confirmed first-hand inside Primathon's agency↔brand delivery work — coordinating contracts across a boundary where one side cannot see the other's source.

### Why this is defensible to attempt
The primitives exist but nobody has assembled them for **collaborators** (different people) rather than for **one power-user**. The specific seam — the contract/intent/ownership layer between services worked by different people on different tools — is unfilled.

---

## 3. Positioning — two wedges, separated by segment (do not mix in one deck)

| | **Wedge A — cross-org boundary** | **Wedge B — enterprise scale** |
|---|---|---|
| Customer | Two parties who can't/shouldn't share source but share an API: agency↔client, OSS maintainer↔contributor, contractor↔company | One company, many devs across many repos/services |
| Felt pain | "We must coordinate contracts but I can't see your code" | "40 devs across 12 services keep silently breaking each other's contracts pre-merge" |
| Why *this* tool | A **neutral third-party registrar** — neither side trusts the other's vendor/infra to hold shared truth | Durable, audited, queryable record of binding decisions across teams + bridge to product tools |
| Vendor mix | Naturally **heterogeneous** (two orgs, two tool choices) → neutrality is unbeatable here | Trends **homogeneous** (orgs standardize) → so we compete on the *record*, **never** on transport |
| "Source stays local" buys | Everything — it *is* the product | Less internally; emphasize scale + audit, not privacy |
| Adoption / payment | **Beachhead + dogfood** (Primathon). IP-boundary/compliance are budget lines. Monetizable directly. | Top-down mandate fixes two-sided cold-start; audit/compliance is the budget line |

**Monetization follows defensibility.** We are most defensible where the team is heterogeneous (A); most vendor-exposed where it's homogeneous (B). Lead with A — prove it by dogfooding inside Primathon — and weigh charging for A directly rather than treating it as merely a stepping stone to B.

---

## 4. The moat

Lockstep is the **neutral, durable system-of-record sitting above any vendor's transport** — the binding-decision ledger, the ownership graph, the dependency graph, cross-org identity + audit trail, and the optional GitHub / product-tool bridge.

- **Transport** (agent-to-agent messaging) is the model vendor's natural layer. Anthropic already owns it (Agent Teams). **Don't compete there.**
- **System-of-record + neutrality** is the layer the vendor won't keep and can't serve cross-vendor. That's ours — and it holds whether the team is homogeneous or not, because we sell the *record*, not the messaging.

**Honest framing of the moat (for internal planning, not a pitch deck):**
- It is **data gravity + within-team workflow lock-in + cross-vendor neutrality**, not a true cross-customer network effect. Team X's ledger gains nothing from Team Y adopting; the network effect is **bounded inside each team and modest.** Do not plan for viral growth dynamics that won't materialize across the customer base.
- After Spike 0, the **technical barrier is thin** (hooks + MCP + instructions are public and low-barrier on all vendors). Defensibility therefore rests entirely on **accumulated ledger data + neutrality + speed** — not on technical difficulty. "We got it working" ≠ "we're defended."

---

## 5. Platform-risk answer ("Anthropic can build this — then what?")

The Cursor precedent, read honestly: a third party can build a real business on a vendor's substrate **if it owns a different layer and stays neutral** — but expect the vendor to come, and expect it to hurt.

The test it forces — **which layer are we?**
- If Lockstep is the transport → we lose; already theirs.
- If Lockstep is the neutral cross-vendor system-of-record → Anthropic's native Claude↔Claude coordination doesn't kill us. They serve homogeneous Claude teams; we own **heterogeneous teams** plus the persistent org-level artifacts no transport bothers to keep.

The Codex/Gemini extension is the spine that moves us from "we lose" to "then nothing." It is sequenced, not optional.

**Stated bet (not a fact about their roadmap):** the residual exposure is Anthropic adding a *native, durable, compliance-grade decision-record* to Claude Code. We bet they won't prioritize that soon, because it's org-tooling, not model/agent capability. This is an explicit timing bet on runway — revisited quarterly, not asserted.

---

## 6. Architecture (data flow)

```
   Dev A's machine                          LOCKSTEP CLOUD                       Dev B's machine
 ┌────────────────────┐              (metadata-only, neutral core)            ┌────────────────────┐
 │  Claude Code        │   adapter    ┌────────────────────────────┐  adapter │  Codex / Gemini CLI │
 │   (any vendor)      │              │   VENDOR-AGNOSTIC CORE       │          │   (any vendor)      │
 │  ┌──────────────┐   │   ┌─────────►│  ┌──────────────────────┐   │◄──────┐  │  ┌──────────────┐   │
 │  │ hook + skill  │   │   │          │  │ System-of-record       │   │       │  │  │ hook + skill  │   │
 │  │ + LOCAL VERIFY├───┼───┘          │  │  • Decision ledger     │   │       └──┼──┤ + LOCAL VERIFY│   │
 │  └──────────────┘   │              │  │  • Ownership graph      │   │          │  └──────────────┘   │
 │  order-service       │              │  │  • Dependency graph     │   │          │  product-service    │
 │  (source LOCAL)      │              │  │  • Question / Task docs│   │          │  (source LOCAL)     │
 └─────────┬──────────┘              │  │  • Change feed          │   │          └─────────┬──────────┘
           │ PR opened                │  │  • Audit trail          │   │                    │ PR opened
           ▼                          │  └──────────────────────┘   │                    ▼
 ┌────────────────────┐              │   Conflict model · Review     │          ┌────────────────────┐
 │ PR CHECK (CI)       │─────────────►│   Neutral external API        │◄─────────│ PR CHECK (CI)       │
 │ reconcile diff↔ledger│             └──────────────┬───────────────┘          │ reconcile diff↔ledger│
 │ HARD GATE           │                    urgent → Slack ping                 │ HARD GATE           │
 └────────────────────┘              ┌────────────────────────────┐          └────────────────────┘
                                      │ Web dashboard (v2) · GitHub │ ← humans + product tools
                                      │ mirror · Jira/Linear bridge │   read/write via the API
                                      └────────────────────────────┘
```

**Three architectural rules that protect the moat:**

1. **Vendor-neutral capture, two ways, both portable** (see §7). Capture never depends on a single vendor's internals.
2. **Vendor-agnostic core + thin per-vendor adapters.** Go deep on the Claude Code adapter first, but the core never knows which vendor it's talking to. Draw the seam day one or neutrality dies quietly. (Spike 0 confirmed the adapter is thin — hook-config shim + instructions file, both pointing at the same MCP tools.)
3. **Neutral external API day one.** Shape the core's API as a real external API that can expose the ledger outward (read + write to product tools later), not just an MCP-internal channel. We don't build the Jira/Linear integration in v1, but the API is shaped so it's additive, not a rewrite.

Only coordination **metadata** crosses the wire — summaries, contracts, decisions, questions, tasks, ownership, dependencies. **Never source or diffs.**

---

## 7. Capture, verification & enforcement — the two-tier model

The system-of-record is worthless if it rots. Decision logs rot when humans maintain them by hand. Ours stays alive through **two tiers**: a soft real-time tier that captures as work happens, and a hard batch tier at the PR boundary that catches everything the first tier missed and *enforces* the ledger.

### Tier 1 — Soft, real-time, in-agent (capture as you work)
Fires while an agent is running. **Belt and suspenders, both portable across Claude / Codex / Gemini (Spike 0 confirmed):**

- **Skill / instructions file** (CLAUDE.md+Skill / AGENTS.md / GEMINI.md): convention — "after you finish, summarize the change, `register_dependency`, and `notify` via MCP."
- **PostToolUse / Stop hook:** deterministic backstop that fires even when the agent forgets the instruction.

**SessionStart replay:** on agent start (any vendor), auto-run `inbox()` + `decisions()` so the teammate is greeted with what changed, what's newly binding, what's delegated.

**Local verification (the key advantage):** before anything leaves the machine, the agent's *asserted* contract delta is diffed against the *actual* local types / function signatures / OpenAPI. On mismatch → block or flag. This is the difference between an **asserted** contract (B builds on A's agent's possibly-hallucinated claim) and a **verified** one (B builds on what the code actually exposes). It is only possible because **source stays local** — the constraint becomes the capability. *Caveat: typed langs + OpenAPI verify cleanly; dynamic langs are harder. Where we can't verify, we mark the contract `asserted, unverified` rather than pretending.*

**Publication is risk-tiered** (resolves the per-edit confirm-prompt tax):
- Change to a surface **you own** → auto-publish, no prompt.
- Change to a **shared/contract** surface → require one confirm, because it creates an obligation on someone else.
- *Bias when classification is uncertain: treat as shared → require confirm.* In Wedge A a false-negative (shared surface misclassified as owned, auto-published unreviewed) is a **confidentiality breach**, not just noise. Safety beats fewer prompts.

### Tier 2 — Hard, batch, at the pull request (reconcile + enforce)
A CI check on every PR (vendor-neutral by definition; catches edits made by *any* means — agent, plain editor, copy-paste, teammate). With the full diff available, it:

1. **Reconciles diff ↔ ledger.** If a contract surface changed with no corresponding verified ledger entry / decision → **fail the check** (or post a message). This is where the ledger is forced to match reality.
2. **Is the hard enforcement gate.** Binding decisions stop being agent-goodwill and become *the PR cannot merge until honored.*
3. **Surfaces stale dependencies in-flow.** If the diff changes `POST /orders` and the dependency graph shows `product-service` consumes it, the check comments on the PR: *"⚠ changes a contract product-service depends on — not yet acked."*
4. **Is the better home for contract-surface detection** (open Q2): more time, full diff, heavier analysis than a live hook.

Conceptually this is **consumer-driven contract testing (Pact-style), but ledger-backed and agent-aware.** It relies on protected branches / required PRs to be airtight (a direct push skips CI — a solved GitHub pattern).

> **What this killed:** v3's fs/git-watcher + headless-LLM path for editor-only edits is **dropped from v1.** Tier 2 catches those at the merge boundary — the natural point where code becomes shared — with no watcher and no extra LLM dependency. Real-time capture of *editor-only* edits (no agent) is deferred indefinitely; if ever needed it returns as the watcher, but the PR check makes it unnecessary for v1.

---

## 8. Routing, addressing & delivery

The system never asks the sender *"who should see this?"* — recipients are **derived** from the graphs. Coordination is **pub/sub keyed on code surfaces**: a sender publishes a *change tagged with its surface*; the broker computes who cares and delivers to the right **session**. This decouples sender from recipient (A need not know who depends on their code), which is what makes notification automatic *and* scalable.

### Two-level addressing — person, then workspace
Routing resolves in two steps:
1. **Which person(s)** — derived from the graphs (below).
2. **Which of that person's sessions** — a person runs many agents across many folders, so each running session must be individually addressable.

**Session registration:** when an agent starts in a folder, the Lockstep MCP server boots with it, reads **cwd + git remote**, and registers `session → (user, repo, project)` with the broker (reuses claude-peers-mcp's context-from-directory pattern). The repo→project mapping comes from onboarding (connected repos). **Delivery key = `(project, repo) → session`.**

### Who to notify — by event type
| Event | "Who" comes from | Recipient |
|---|---|---|
| A **surface** changed (`POST /orders`) | **Dependency graph** | The **consumers** of that surface — *not* the owner/author (that's the sender) |
| **Question** (any topic — see below) | Ledger first; else ownership / topic | Answered from the record if known; else routed to the **owner** (surface/repo-scoped) or **maintainers/subscribers** (topic/project-scoped) |
| **Decision** scoped to shared/contract | Ownership (for ack) + Dependency (for awareness) | Co-owners must ack; dependents informed |
| **Delegation** | Explicit | The named target |

The sender is **excluded** from its own change notification. Routing quality for surface changes depends entirely on the dependency graph being populated (`register_dependency` / local inference) — no edge, no recipient.

### Asking & querying the ledger — clearing doubts from the record
Questions are **general-purpose across the codebase/repo** — not just API surfaces, but anything about *the code or that repo*: its architecture, decisions, conventions, ownership, or work status. *"why do we use idempotency keys?"*, *"how does auth work in this repo?"*, *"who owns billing?"*, *"is the orders refactor done?"*, *"what's our error-handling convention?"* The scope is the code and that repo — **not** arbitrary off-topic chatter (that's Slack's job, not ours; consistent with §16's "don't chase general communication").

**Resolution order — answer-if-known, escalate-if-unknown:**
1. **Query the ledger first.** `query(question, scope?)` retrieves the relevant decisions, contracts, prior answered questions, change-feed entries, and completed tasks. The **asking agent synthesizes** the answer — the core stays LLM-free (it does retrieval; the agent reasons). If confidently answered → done, no teammate involved.
2. **Escalate only what's genuinely new.** If the ledger can't answer, open a Question doc and route it: surface/repo-scoped → the **owner** (ownership graph); topic-tagged or project-wide → topic subscribers / project maintainers.
3. **Capture the answer.** A human answer closes the Question doc **and writes back to the ledger**, so the next person — or agent — who asks gets it instantly. Deflection compounds.

**Who asks:** humans explicitly, and **agents reflexively** — an agent queries the ledger *before acting* (e.g., before coding against `/orders`) so it builds on the record instead of guessing, with zero human interruption. This turns the ledger into a self-service knowledge base whose value grows with use: a new contractor's agent can self-orient without pulling in a senior dev, and question-deflection rate rises as the record accumulates.

### The three triggers (send → route → deliver)
1. **Capture + publish (send)** — fired by the **PostToolUse/Stop hook or skill** (Tier 1), or the **PR check** (Tier 2). *Never* a human picking a recipient. Emits `notify(summary, contract_delta, surface, risk_tier)` to the broker.
2. **Route (fan-out)** — the **broker**, on receiving a publish, queries the dependency graph for the changed surface → resolves dependent repos → resolves the live session(s) for each (or the repo inbox if none live). Pure graph lookup; no human or agent decides.
3. **Deliver (receive)** — default **pull**: lands in the per-`(user, repo, project)` inbox, replayed by the recipient's **SessionStart hook when they open that folder**. Urgent: **also push** a Slack ping immediately.

### Scoping — which of B's open sessions actually get it
Given B has product-service, cart-service, and payment-service agents all open, and A changes `POST /orders` (consumed by product-service + cart-service):

| What changed | Delivered to |
|---|---|
| A **surface** | Only the **consumer-repo** sessions → product-service ✉, cart-service ✉, payment-service ⊘ |
| A **project-level decision** ("all services use UTC") | **All** of that user's sessions in the project |
| A **question** about product-service | The **owner's** session for that repo |
| Anything | **Never** sessions outside the project (unrelated folders stay silent — no cross-project leakage) |

### Monorepo nuance
If services are folders in one repo, `repo` is too coarse a key: one root session receives the repo's notifications, and **CODEOWNERS path-scoping** filters relevance in the replay (*"this touches `product-service/` which you own"*). Multi-repo → per-repo session targeting; monorepo → per-session with path-based relevance.

### Build-time forks (decide when building the broker)
- **Fan-out timing:** *eager* (write to each dependent's inbox on publish — simpler, instant urgent pings) vs *lazy* (compute "changes to surfaces I depend on" at `inbox()` — handles dependencies registered *after* the change). Default: **eager-write + a lazy reconciliation sweep at session start.**
- **Session match key:** **git remote** (robust to folder moves/renames — preferred) with absolute path as fallback.

---

## 9. Data model (schema-first — this *is* the product)

Everything is **append-only, versioned, attributed, provenance-stamped** so audit + conflict + review come for free.

| Entity | Shape | Key fields |
|---|---|---|
| Org | Billing + admin root | identity provider, retention policy |
| Project | Spans many repos/services | — |
| Member | Identity = GitHub OAuth, 1:1 with CODEOWNERS | vendor(s) in use |
| Ownership map | Committed CODEOWNERS + git history + override | **write-sharding key + review-required derivation** |
| Decision doc | Binding rule, scoped, attributed, injected | `version`, `base_version`, `provenance`, `status` (open→ack→binding→superseded), `required_reviewers` / `approvals` (optional) |
| Contract | Asserted-then-verified interface delta | `verified` flag + `verified_against` (local type/sig/OpenAPI ref) |
| Dependency | Edge: consumer → produced surface | e.g. `product-service → POST /orders`; written by `register_dependency` or inferred locally; **drives stale-impact** |
| Question doc | open→answered→closed; **any code/repo question**, not just surfaces | `scope` (surface/repo/topic/project), urgent flag, route trace; answer written back to the ledger |
| Change-feed entry | Agent-drafted, locally-verified summary + delta | `risk_tier` (owned vs shared/contract), publish state |
| Task | Delegated, status-tracked | approver, run state |
| Inbox | Per-agent unread queue | replay cursor |
| Audit trail | Immutable log of who decided/acked/changed/approved what, when | non-repudiation; the enterprise budget line |

Defer the dashboard *UI* to v2 — **never defer durable capture or the schema.** Every tool call and PR check writes to this schema from message zero.

---

## 10. Conflict model (concurrent edits) — three layers, cheapest first

Not merging source (it never crosses the wire), only coordinating declarative artifacts. No CRDT/OT needed.

1. **Ownership = write-sharding key (free).** CODEOWNERS → most surfaces have one writer → most conflicts impossible by construction. Contended set = the small number of co-owned / contract edges.
2. **Optimistic version-stamps on the rest.** Proposals carry `base_version`; broker rejects on stale base → re-fetch and re-base. Compare-and-swap / ETags. The "awaiting ack" flow *is* this primitive — formalized.
3. **True collision → escalate, never auto-resolve.** Last-writer-wins is unacceptable (contracts are semantic). On collision, emit an **explicit conflict** and route a decision doc — that's the coordination moment the product exists to manufacture. Optional advisory lease surfaces collisions early (advisory only; can't lock a local file).

**Honest limitation, stated on purpose:** guarantees *contract-level* consistency, not *behavioral* consistency. We detect contract divergence, not semantic drift — because we never see source. Local verification narrows the gap (checks contract vs real local types) but cannot reason about runtime behavior.

---

## 11. Review model (guardrails on the sacred docs — tiered, never blanket)

Gate **promotion to binding**, never gate **capture** (the draft is always recorded; review controls authority, not existence).

| Doc tier | Volume / blast radius | Gate |
|---|---|---|
| Auto-captured delta on a surface **you own** | High / low | **No gate.** Locally verified, auto-published. |
| **Shared / contract** change (obligation on a peer) | Medium / medium | **The `ack` *is* the review** — enriched into comment / request-changes / approve. No parallel PR system. |
| **Org-level "sacred" binding policy** | Low / high | **Full PR-style ratification.** Proposal → required reviewer(s) → merge, blocked until approved. |

- **Review-required derives from the ownership graph** (CODEOWNERS-style) — no new config surface.
- A "doc PR" composes with the conflict model for free: a long-lived `propose_decision` carrying `base_version`, requiring N `approvals`, with stale-base rejection.
- **Sequencing:** ack-as-review ships v1 (already exists). Full ratification for sacred org docs is Wedge-B / v2. Schema supports it day one (`required_reviewers` / `approvals`) so it's additive.

---

## 12. MCP tool surface (vendor-agnostic; every call writes durably to the ledger)

```
notify(summary, contract_delta, scope, risk_tier)     → change-feed entry (locally verified) + tiered publish
inbox()                                               → unread + new decisions (session start)
query(question, scope?)                               → retrieves relevant ledger entries (decisions/contracts/Q&A/changes); the asking agent synthesizes the answer
ask(question, scope?, urgent?)                        → opens a Question doc when the ledger can't answer; routes by scope (owner / topic / project)
answer(question_id, response)                          → closes the Question doc, pings asker, writes the answer back to the ledger
delegate(to, task, refs)                               → creates a task on peer's board
complete(task_id, note)                                → marks done, pings delegator
propose_decision(rule, scope, base_version)            → owner→binding; shared→awaits ack; CAS on base_version
ack_decision(decision_id, version, verdict?)           → review verdict on a shared decision (approve/request-changes)
register_dependency(consumer, produced_surface)        → writes a Dependency edge (or inferred locally) → stale-impact
decisions(scope)                                       → current binding rules for an area
whoowns(path)                                          → resolves owner via CODEOWNERS
```

---

## 13. End-to-end walkthrough (Shopify)

1. **Dev A:** "add idempotency to order creation." A's Claude edits `order-service`.
2. **Tier 1 capture:** the Stop hook (or the skill) summarizes the diff → **verifies the asserted contract against the real local route/types** → drafts *"POST /orders now requires `idempotencyKey`; returns `{id,status}`; reason: dedupe double-submits"* with `verified: true`. Shared-contract surface → A gets one confirm → published + recorded as a versioned Decision doc (`status: open`, awaiting B's ack).
3. **Earlier**, when B coded `product-service`'s call to `/orders`, `register_dependency(product-service, POST /orders)` recorded the edge (or it was inferred locally). So the **dependency edge exists.**
4. **Dev B** opens their agent (Codex) → **SessionStart replay** via the Codex adapter: *"📥 A changed POST /orders contract. 📌 Pending decision needs your ack. ⚠ product-service depends on POST /orders — your call may be stale."*
5. **B's agent** acks (CAS on version) → updates the call against the **verified** contract, never having seen A's handler source.
6. **B opens a PR.** **Tier 2 PR check** reconciles the diff against the ledger: contract matches the acked decision, dependency accounted for → check passes. Had B forgotten to ack, the check would **block the merge** and comment with the stale-dependency warning.
7. **B hits a blocker:** "does order-service emit a webhook on cancel?" → urgent `ask(...)` → Slack DMs A → `answer()` → B pinged, doc closed. All of it lands in the audit trail.

**Single-player / one-sided variant (Wedge A):** if the client's devs never install Lockstep, the agency still gets a verified, durable, queryable record of its own side, and Lockstep **publishes outward** with no install required from the other side — a synced OpenAPI spec, a mirrored GitHub PR/issue, or an emailed contract delta. Bidirectional agent coordination is the upside when both sides adopt; the floor is standalone value to whoever adopts first (Figma/Notion single-player-first pattern).

---

## 14. What we borrow

| From claude-peers-mcp / Agent Teams | From GitHub |
|---|---|
| MCP-per-session + central broker pattern | CODEOWNERS as ownership truth, write-sharding key, **and review-required derivation** |
| Agents discover peers, message instantly | Issues → Question docs (open/closed lifecycle) |
| Auto work-summaries on startup | **Required status checks → the Tier-2 PR reconciliation gate**; PR review on owned paths → tiered doc review; labels/routing, optional Issue mirror |
| *We change:* broker is remote + **neutral/cross-vendor**; identity, attribution, versioning, **local verification**, audit added | ADR-style binding Decision docs; "branch has conflicts" → stale-impact flagging; consumer-driven contract testing (Pact-style), ledger-backed |

---

## 15. Spike 0 results — vendor feasibility (PASSED GREEN)

The thesis-gating question: *does cross-vendor auto-capture physically function?* Answer: **yes.** All three major agents expose lifecycle hooks **and** MCP **and** an instructions file.

| Capability | Claude Code | Codex CLI | Gemini CLI |
|---|---|---|---|
| Lifecycle hooks | Full set | ✅ SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop (+Subagent); *command hooks only* | ✅ PreToolUse, PostToolUse, Stop, UserPromptSubmit + extras (Before/AfterAgent, SessionEnd, Notification) |
| The 3 events we need (SessionStart replay; PostToolUse/Stop capture) | ✅ | ✅ | ✅ |
| MCP tools | ✅ | ✅ STDIO + HTTP, `codex mcp` | ✅ settings.json |
| Instructions / "skill" file | CLAUDE.md + Skills | AGENTS.md | GEMINI.md + custom commands + agent skills |

Sources: developers.openai.com/codex/hooks, developers.openai.com/codex/guides/agents-md, geminicli.com/docs/hooks, google-gemini.github.io/gemini-cli/docs/extensions, code.claude.com/docs.

**Implications:**
- The adapter is **thin** — a hook-config shim + an instructions file pointing at the same MCP tools. The "go deep on Claude first, others are a heavy lift" framing relaxes.
- Skill **and** hook are both portable → belt-and-suspenders everywhere (resolves the soft-vs-hard tradeoff).
- **Residual amber, now closed by Tier 2:** hooks only fire while an agent is live; editor-only edits are caught by the PR check instead.
- **Strategic edge:** thin technical barrier means it's buildable by *anyone* → defensibility = data + neutrality + speed, not technical secrecy.

---

## 16. North star — where this goes (informs the API today, build later)

As agents write more code, humans shift from writing code to specifying intent — so the valuable artifact becomes the **decision/requirement/contract layer connecting intent to execution**, the layer we own. The expansion is to become the **bridge from product-intent to agent-execution**, not to sell PMs a seat.

- A requirement in Jira/Linear/Notion → a routed binding Decision in our ledger → auto-injects into the owning dev's agent at session start → the verified contract-delta / completion flows back up to the product tool.
- **Don't** chase general "communication" (that's Slack). The only comms we own are *structured, decision-attached* — questions/answers/acks tied to a decision.
- **Implication for v1:** shape the neutral core's external API for outward read+write day one (per §6 rule 3). Build the integration later.
- This is north star, **not now** — the dev wedge is validated; go horizontal only after.

---

## 17. Build plan — v1 vs deferred

### Spike 0 — DONE (passed green; see §15)

### v1 — prove the verified ledger + the PR gate, not the messaging
**Non-negotiable, ships first:**
- Vendor-agnostic core + durable, versioned, attributed **schema** (incl. Dependency, Contract `verified`, Decision `required_reviewers`) + audit trail.
- **Tier 1 capture** on Claude Code: skill + PostToolUse/Stop hook + **local contract verification** + risk-tiered publish + SessionStart replay.
- **Tier 2 PR check** (CI): reconcile diff ↔ ledger, hard-gate merges, surface stale dependencies. *This is the enforcement spine — do not cut it.*
- MCP tool surface incl. `register_dependency`, writing to the ledger every call.
- **ack-as-review** (tier-2 review model).
- **Single-player value + outward publishing** (OpenAPI sync / GitHub mirror / email) for the Wedge-A beachhead.
- Neutral **external API** shaped for later product-tool sync.
- Metadata-only broker; Slack for urgent.
- The neutral-core/adapter **seam** drawn cleanly so Codex/Gemini are additive.
- Scope: two members, one project, dogfooded inside Primathon (Wedge A).

**Deferred to v2 (UI, reach, heavy workflows — not the moat):**
- Web dashboard (browse/triage/audit) — UI only; data already exists from v1.
- Codex / Gemini CLI adapters (the *build*; feasibility already proven in Spike 0).
- Full PR/ratification review workflow for sacred org docs.
- GitHub Issue mirror UI; Jira/Linear product-intent bridge.
- Stale-impact flagging UI; org/billing; enterprise admin.
- (Only if ever needed: fs/git-watcher for editor-only real-time capture — Tier 2 makes it unnecessary for now.)

**The trap to avoid:** shipping transport-only in v1 builds the one layer Anthropic already owns. Defer the dashboard *front-end*; never defer durable, verified capture or the PR gate.

---

## 18. Open questions still to retire

1. **Risk-tier / contract-surface detection** (load-bearing, partly a safety gate): how does the system reliably decide "owned" vs "shared/contract" surface — at capture time *and* in the PR check? CODEOWNERS handles ownership; contract-surface detection is the hard call. Default bias: when unsure, treat as shared.
2. **Local-verification coverage:** which stacks/languages can we diff asserted-vs-real contracts (typed + OpenAPI easy; dynamic langs hard)? Where we can't, mark contracts `asserted, unverified`.
3. **Single-player floor strength:** is "verified OpenAPI sync + GitHub mirror + email delta" a *painkiller* on its own, or does adoption still secretly require the multiplayer magic (i.e., is cold-start solved or relabeled)? Test by dogfooding the one-sided case.
4. **Ledger trust durability:** even with two-tier auto-capture, does the record stay trustworthy enough that people *act* on it? The whole moat depends on the answer.
5. **Headless enrichment (deferred):** if editor-only real-time capture is ever needed, what summarizes the diff when no agent is live, and what does it depend on? (Out of scope for v1; Tier 2 covers the gap.)

---

## Appendix — design decisions log (answered)

| Decision | Choice |
|---|---|
| Topology | Org → Projects → members |
| Routing | Code-ownership; cross-cutting/contract → all affected |
| Notification delivery | Hybrid: session-start inbox/decision replay + urgent external ping |
| Delegation | Tasks queue for receiving human to approve before their agent runs |
| Ownership source | CODEOWNERS + git history + manual override |
| Change context | Agent-written summary + contract delta; raw source never leaves |
| Decisions governance | Owner rules their area; shared/contract needs all affected to ack; injected at session start |
| Questions & querying | Generic ask-the-ledger: `query()` retrieves & the asking agent synthesizes; answer-if-known, else open a Question doc routed by scope (owner / topic / project); answers written back so deflection compounds |
| Docs model | Decision docs + Question docs as durable, attributed, GitHub-inspired artifacts |
| Change publishing | Auto-capture always; risk-tiered publish (owned auto, shared confirm) |
| Project scope | One Project spans many repos/services |
| Staleness | Impact-flag affected work via dependency graph; surfaced at PR |
| Onboarding/identity | GitHub OAuth; identity = GitHub handle = CODEOWNERS handle |
| Human surface | Web dashboard (v2) + in-agent (v1) |
| GitHub relationship | Standalone, optionally GitHub-synced (Issue mirror, PR check) |
| Urgent channel | Slack |
| Capture mechanism | Two-tier: Tier 1 soft in-agent (skill + hook + local verify); Tier 2 hard PR reconciliation gate |
| Vendor strategy | Neutral core + thin adapters; Claude first, Codex/Gemini additive (Spike 0 green) |
```
