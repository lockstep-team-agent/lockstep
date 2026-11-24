# Persona interviews — Nov 2026

> Simulated interviews (LLM role-play, Sonnet), not real customers. Use as hypotheses to test in
> real calls. Two rounds: (1) five ICP personas shown Lockstep + Switch and three directions;
> (2) five generic personas interviewed about pains only, no product mentioned (Mom Test style).

## Context: Switch (sandbox-quantum/switch)

Open-source "AI teammates in Slack/Teams/Discord" (4.7k★, Apache 2.0 + Commons Clause). Channels
become rooms where people and agents (Claude Code, Codex, Cursor…) share chat context; agents get
roles and connectors; multi-agent workflows. No decision store, dependency graph, or PR gate.

Directions tested:
- **A** Stay focused on core (decisions, briefings, graph, PR gate, standards rollout)
- **B** Chat-native decision layer: Slack capture/approve, ADR export, Switch MCP integration
- **C** "Enhanced Switch": rebuild Switch's agent-in-chat + orchestration + decision memory

## Round 1 — ICP personas, product shown

| Persona | Pick | A | B | C |
|---|---|---|---|---|
| Priya — CTO, 80 eng (core buyer) | B (+A core) | 6 | 8 | 2 |
| Marcus — staff eng (bottom-up champion) | A | 7 | 5–6 | 2 |
| Aisha — PM, fintech | B | 5 | 8 | 2 |
| Daniel — VP Eng, 200 eng, HIPAA, mixed agents | A + ADR export | 6 | 5 | 2 |
| Leo — seed CTO, already uses Switch | B | 6 | 8 | 1 |

Consensus:
- C is actively harmful ("smaller company doing two things", "why not just use Switch").
- Decisions are born in Slack threads; capture must happen there — but quietly (opt-in, DM).
- Staleness/supersession raised unprompted by all five. One wrong "binding" briefing kills trust.
- Approval must be near-free; a 30-item weekly queue = empty memory.
- Noise kills: junk prompts, bloated briefings, PR-gate false positives.

Splits: Slack bot (buyers yes, engineers/security wary); ADR publishing (compliance yes, small teams
no → audit export, not living pages); Switch integration (only Leo cares → docs recipe); pricing
(flat for small teams; per-seat blocked while Claude Code–only).

Questions we must answer crisply: "Why not CLAUDE.md/AGENTS.md?", "What if Anthropic builds this?",
"When is Cursor supported?"

## Round 2 — generic personas, no product mentioned

| Persona | #1 pain | Lockstep's problem appeared as | Rank |
|---|---|---|---|
| Sofia — senior backend, 300-eng e-com | Not knowing what other teams changed / who depends on what | Payments timeout change → 1,200 orders reconciled; "same five review comments" | **#1** |
| Rohan — EM, 60-eng agency | Context lost on engineer rotation | Rounding bug → $9k payment held | **#1** |
| Grace — tech lead, regulated bank | ARB/CAB + env queues | "Almost every incident = a decision/contract we didn't know about at the moment of change" | #3 |
| Kenji — head of DevEx, 500 eng | Flaky CI | Deprecated HTTP client shipped; standards stuck at 35% after 6 months | #3 |
| Tom — CTO, 8-eng seed | No post-deploy visibility | "Said 'use the shared client' 15 times" | #3 |

Takeaways:
1. **Cross-team change awareness is the sharpest pain** (Sofia, Grace, and Priya in round 1) —
   Lockstep's graph/routing is the answer and the clearest differentiator.
2. **"Anything that needs humans to curate it dies"** (5/5: Backstage, Notion, Confluence, ADRs,
   CLAUDE.md). Biggest risk to Lockstep.
3. **Repeated PR review comments are the best capture source** ("use X not Y"). Lint rules work,
   docs don't.
4. Budget holders want **proof**: AI ROI (Kenji), "was AI used on this change?" audit evidence (Grace).
5. **Agencies** are a promising segment: rotation context loss is #1 pain, $2–3k/mo budget.

Not our problem: flaky CI, environments, deploy monitoring, CAB cadence.

## What we're building (priority order)

1. **Consumer change alerts** — contract/config/event change → warn dependents in the PR and their next session.
2. **Repeated review comments → standards** — "You've written this 6×. Make it a standard?" One click.
3. **Deprecations as first-class** — "X retired, use Y", with the old thing visibly dead.
4. **Zero-curation trust** — auto-expiry/supersession, provenance, short briefings, no weekly queue.
5. **Proof reports** — which standards landed where, incidents caught, AI-usage/audit export.
6. **Slack capture** — opt-in, DM to owner, one-click approve (demoted).
7. **Simplified dashboard** — few screens, built around the above.

Not building: agents-in-chat, multi-agent orchestration, CI/env/deploy tooling.

## Round 3 — baseline usability (current UI, before changes)

Screens: concept-ledger shell (Inbox/Map/Ledger/Settings) + old Home/Decisions for comparison.

| Persona | Score | Back weekly? |
|---|---|---|
| Priya — CTO | 4 | N — "no reason to open it on a schedule" |
| Marcus — staff eng | 5 | N — "can't tell me who consumes this endpoint" |
| Aisha — PM | 4 | N — no approver trail, no "did agents get my PRD update" |
| Tom — seed CTO | 4 | N — "it gives me a to-do list, value invisible" |

Shared fixes: proof strip (sessions briefed / warnings / PRs blocked) before any queue; "Needs you"
capped and personal; plain verbs that state their effect; human rule titles (no "Product:", "(#43)");
rule page with why/owner/approver/absolute dates/consumers by name/history + export; hide setup chores
(API-key banner, regex grouping); drop the Map graph that admits it shows no dependencies.
Old Home's "Needs you" + stat tiles + sentence rules were preferred over the new Inbox.
