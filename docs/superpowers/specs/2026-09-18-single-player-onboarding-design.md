# Lockstep: Single-Player Onboarding and the Adoption Loop

**Date:** 2026-09-18
**Status:** Draft for review
**Scope:** `packages/cli` (onboard, scan, capture, pack, templates), `packages/core` (three routes, Jev generalization), `actions/pr-check` (comment text), README.

## 1. Why

Lockstep's value appears when a second developer's agent receives a briefing about a change the first developer's agent made. Today's quick start requires two humans, eight steps, and a staged scene before that happens. A comparables study (Swimm, ADR tooling, CodeSee, Backstage, Multiplayer vs. Unblocked, Sourcegraph, CodeRabbit, Turborepo) showed every tool whose value needed a second person died, pivoted, or went top-down enterprise; the survivors mined data the developer already had and used a collaborator-visible surface to recruit the next person.

This spec makes day zero useful to one developer on one repo, and wires the three signals that already name specific teammates into invites. The two-developer moment then arrives on its own.

Deferred to later specs: org-level coverage view and digest headline, public-repo read-only packs, Codex/Cursor adapters, since-last-session agent audit digest, review-due nudges, pre-seeded hosted demo project, demo GIF.

## 2. Decisions taken

| Question | Decision |
| --- | --- |
| Where the LLM runs | In core, synchronously, on the request. Docker Compose has no ingest worker; self-hosters must get this too. Keys never reach the CLI. |
| Which model | Jev (Typesafe System One) for every judgment: file triage, section recall, verbatim-or-rewrite, decision type. Sonnet only to rewrite prose sections, and only when `ANTHROPIC_API_KEY` is set on core. No key at all: the docs step prints one line and is skipped. |
| How a human confirms | In the terminal during `onboard`, one item at a time (y / n / e / s). Non-TTY runs file proposals and print the review-queue URL. Honors the locked draft-then-confirm rule with no new UI. |
| How repo-doc decisions are stored | Ordinary decisions via `fileProposedDecision`, origin left at the default (`ingested`), `provenance.source = "repo_doc"`, `scopeKind = "repo"`, `scopeRef = gitRemote`. They appear in the existing Proposed tab and in the pack once confirmed. Impact is 0, so confirm binds. Existing relation verdicts dedupe them. |
| Enforcement posture | Advisory. Violations are reported to the agent and in the PR comment; the PR check does not fail on them. Upgrade path: a per-project setting to fail. |
| Default API URL | The hosted instance. Self-hosters pass `--api` once; it persists in `~/.lockstep/config.json` as today. |
| Not doing | Referral rewards, invite-count gating, generic memory, docs retrieval, code review. |

## 3. The flow being built

```
npx lockstep-cli onboard
  login (device flow, only if no token)
  init          → hooks in settings.local.json; skill files + lockstep.yaml committed
  connect
  scan --apply  → produces + matched consumes written; unmatched kept for invites
  distill       → sections of README/CLAUDE.md/AGENTS.md/docs/**.md → core → Jev → proposals
  confirm loop  → y/n/e/s per proposal → existing confirm/reject routes
  pack          → confirmed decisions render as binding
  summary       → counts + recommended invites (unmatched calls × git authors)
```

First session: briefing lists the confirmed decisions and the repo's surfaces. On each capture, binding rules in scope are checked against the diff and violations are handed back to the agent. On a PR, the comment names consumers, connected-repo count, violations, and the one-line install.

## 4. Phases

Order is deliberate: instrument first, then the entry point, then the reason to keep it, then the recruiting surfaces, then enforcement.

### Phase 0. Metric

**Time from install to first non-empty briefing.**

- `GET /briefing` (core) records on the session row an integer `briefingItems` = principles + constraints + inbox unread + binding decisions returned. New nullable column on `sessions`.
- `members` gains `firstBriefingAt` (nullable), set the first time a member's session returns `briefingItems > 0`.
- No UI. The metric is one SQL query in DEPLOY.md: median of `firstBriefingAt - members.createdAt`. Insights page can show it later.

### Phase 1. One-line entry

`packages/cli/src/index.ts`, `config.ts`, `login.ts`, `onboard.ts` (new, the orchestration moves out of `index.ts`), `adapters/templates.ts`, README.

- `config.ts`: default API URL becomes `https://lockstep-production.up.railway.app` (one exported const `HOSTED_API`). Env var and saved config still win.
- `login.ts`: export `ensureLoggedIn()` — returns if `getToken()` is set, otherwise runs the device flow. Prints "signed in as @login".
- `onboard.ts`: `ensureLoggedIn → runInit → runConnect → runScan({apply:true}) → runDistill (Phase 2) → runPack → summary`. Flags: `--vendor`, `--scope`, `--dry-run`, `--no-docs`, `--api <url>` (calls `setApiUrl` first). Every step after connect is best-effort: a failure prints one line and the next step runs. Summary is one block: surfaces produced / consumed / unmatched, decisions confirmed, then Phase 3's invite suggestions, then "Open Claude Code in this repo."
- `runScan({apply:true})`: writes produces and graph-matched consumes; items under `review` and `unmatched` are reported, never written. Verify current `--apply` semantics match this in the plan.
- `templates.ts`: the committed `lockstep` SKILL.md and `CLAUDE_BLOCK` gain one line: "If the Lockstep MCP tools are not available in this session, tell the user to run `npx lockstep-cli onboard` once in this repo, then continue without them." Existing merge logic carries it to already-initialised repos on their next onboard.
- README quick start collapses to the one command plus the self-host `--api` variant. The dashboard link moves below the install.

Test: one unit test on `onboard.ts` with every step stubbed, asserting order, that `--no-docs` skips distill, and that a failing distill does not stop pack.

### Phase 2. Repo-doc distillation

#### 2.1 CLI: `packages/cli/src/distill.ts` (new), `capture/markdown.ts` (new, pure)

- Candidate files, in order: `README.md`, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `docs/**/*.md`, any directory named `adr`, `adrs`, `decisions`, or `rfcs` (case-insensitive) under the repo. Tracked files only (reuse `trackedFiles`). Skip files over 200 KB.
- `sectionize(path, markdown)`: split on ATX headings into `{ anchorKey, headingPath, text }` matching the ingest `DocSection` shape. `anchorKey = "<path>#<slug-of-heading-path>"`. Preamble before the first heading is its own section. Strip fenced code blocks from `text` (they are never rules). Drop sections under 40 characters.
- Caps: 40 files, 60 sections total (files in the order above until the cap), 4 KB per section (truncate). Caps are constants with a `ponytail:` comment.
- `runDistill({ interactive })`: `registerSession` → `POST /repo/distill` with `{ commit, files: [{ path, sections }] }` → confirm loop (2.3) → returns counts for the summary.

Test: `markdown.test.ts` on `sectionize`: headings nest, preamble kept, code fences stripped, short sections dropped, cap respected.

#### 2.2 Core: `POST /repo/distill` in `packages/core/src/api/routes/ledger.ts`, logic in `packages/core/src/ledger/repo-distill.ts` (new), Jev in `packages/core/src/ledger/jev.ts`

Auth: session context (`ctx()`), same as `/surfaces`.

Jev generalization: extract a `systemOne(state, questions)` helper in core's `jev.ts` with the same contract as the ingest client (null on any failure, one retry on 429/529, 10 s timeout). `judgeWithJev` is rewritten on top of it; behaviour unchanged. No dependency on `packages/ingest` (it pulls Composio).

Pipeline, all judgments through `systemOne`, each stage skipped when Jev returns null:

1. **File triage.** One request; one `choice` question per file (key = path) with `state = { files: { path: first 1500 chars } }`. Criteria: `conventions`, `architecture_decision`, `changelog`, `tutorial`, `api_reference`, `other`. Keep `conventions` and `architecture_decision` with confidence ≥ 0.6. `CLAUDE.md` and `AGENTS.md` always pass.
2. **Section recall.** One request per 20 sections; one `noul` per section: "Does this section state a durable constraint on future work that the team has agreed to?" Keep ≥ 0.67 (the floor calibrated on 2026-09-18 in the ingest funnel).
3. **Verbatim or rewrite.** Same request as 2, a second `noul` per section: "Is this section already a single imperative rule as written?" ≥ 0.7 → `mode = "verbatim"`, rule text = first sentence of the body (split on `.`, `!`, `?`, or newline; fall back to the whole text when ≤ 200 chars). Else `mode = "rewrite"`.
4. **Rewrite.** Only when `ANTHROPIC_API_KEY` is set on core. Plain `fetch` to the Messages API, `claude-sonnet-5`, one call per section, JSON output `{ rule_text, rationale }`. Without the key, these sections are counted in `skipped.needsRewrite` and not filed. Cap 10 rewrites per request.
5. **Type.** One request; one `choice` per surviving section: `rule`, `architecture`, `principle`. Default `rule` when abstaining.
6. **File.** `fileProposedDecision(orgId, { projectId, scopeKind: "repo", scopeRef: gitRemote, ruleText, decisionType, provenance: { source: "repo_doc", path, headingPath, commit, mode, confidence }, connectionId: "repo:" + repoId, externalId: anchorKey, contentHash: sha256(section text), confidence, rationale })`. Idempotent on (externalId, contentHash), so re-running onboard after editing docs only files what changed. Deduped or fused results are returned with a flag, not shown as new.

Plan must verify `connectionId` is a free-text idempotency key and not a foreign key to `connections`; if it is, add a nullable path.

Response: `{ orgId, projectId, proposals: [{ decisionId, ruleText, decisionType, path, heading, mode, confidence, deduped }], skipped: { files, sections, needsRewrite }, jev: boolean }`. `jev: false` when no Typesafe key, with `proposals: []`.

Cost ceiling per onboard: ≤ 1 + 3 + 1 Jev requests, ≤ 10 Sonnet calls.

Tests: `repo-distill.test.ts` with `systemOne` injected: triage drops a changelog, recall floor holds, verbatim picks the first sentence, no-key path returns `jev:false`, rewrite skipped without Anthropic key. One API test on the route with the same injection.

#### 2.3 CLI confirm loop (in `distill.ts`)

- Interactive when `process.stdin.isTTY`. For each proposal not `deduped`: print index, rule text, `path › heading`, `type · mode · confidence`. Prompt `[y] confirm [n] reject [e] edit [s] skip rest`.
  - `y` → `POST /orgs/:orgId/decisions/:id/confirm`.
  - `e` → readline for new text → confirm with `{ ruleText }`.
  - `n` → `POST /orgs/:orgId/decisions/:id/reject`.
  - `s` → stop; remaining stay proposed.
- Non-TTY: no prompts; print `N decisions proposed — review at <dashboard>/project/<orgId>/<projectId>/review-queue`.
- Cap the interactive loop at 12 items; the rest are left proposed with the same message. `ponytail:` comment.
- One line before the network call: "Sending N sections from M files to <api> for review. Skip with --no-docs."

### Phase 3. Adoption hooks

#### 3.1 Invite suggestions (`scan.ts`, `onboard.ts`)

- `OutboundRef` gains `file: string`. `scanCode` sets it.
- `suggestInvites(unmatched)`: for each unmatched ref, `git log -n 30 --format=%an|%ae -- <file>`, dedupe, drop the current user's email and any email already in `/me` memberships. Extract a GitHub handle when the email matches `\d+\+(.+)@users\.noreply\.github\.com`; otherwise show the name. Group by surface, show the top 2 authors each, then one `lockstep invite <handles>` line for the handles found. `ponytail:` author-to-handle mapping is heuristic; the GitHub App can resolve it later.
- Test: `suggestInvites` with an injected `gitLog`, asserting noreply extraction, self-exclusion, and grouping.

#### 3.2 Consumers coverage hint (`ledger.ts`, `listConsumers`)

- `GET /consumers` response gains `coverage: { connectedRepos }` (count of repos in the project) and, when the list is empty, `hint: "unknown blast radius — only N repo(s) in this project are connected; run \`lockstep invite\` for the teams that call this"`.
- Test: extend the existing consumers API test.

#### 3.3 PR comment (`actions/pr-check/comment.mjs`, `index.mjs`, core PR-check endpoint)

- The core endpoint the action calls returns, per violating surface, `knownConsumers` (count) and `connectedRepos`.
- `buildComment` gains a line per surface: `Known consumers: none registered (3 repos connected in this project)` or `Known consumers: 2 (web, mobile-bff)`. Footer gains: `Bring the consumers in: npx lockstep-cli onboard (in their repo)`.
- Behaviour unchanged: the check still fails on missing binding decisions exactly as today.
- Test: extend `comment.test.mjs`.

### Phase 4. Enforcement

#### 4.1 Core: `POST /enforce` (`ledger.ts`, `packages/core/src/ledger/enforce.ts` new)

- Auth: session context.
- Body: `{ hunks: [{ file, text }], surfaces: string[] }`. Caps: 20 hunks, 3 KB each.
- Core loads binding decisions in scope for the session's repo (same selection the briefing uses: project principles + repo-scoped + surface-scoped for the given surfaces). Cap 30 rules.
- One Jev request: `state = { rules: { id: ruleText }, change: hunks }`, one `noul` per rule: "Does this change violate rule <id>?" Keep ≥ 0.8 (`JEV_ENFORCE_MIN_CONF`, a starting point to recalibrate).
- Response: `{ violations: [{ decisionId, ruleText, confidence, file }], checked: number, jev: boolean }`. `file` is the hunk with the highest per-hunk score when hunks are judged individually; v1 judges the whole change and returns `file: null`. `ponytail:` per-hunk attribution when the whole-change verdict proves too coarse.
- Violations are also written to the change rows the capture creates: `/changes` body accepts `violations: string[]` (decision ids), stored in the existing change payload JSON. No schema change.

Test: `enforce.test.ts` with injected `systemOne`; API test on the route.

#### 4.2 Capture hook (`capture/index.ts`)

- On `PostToolUse`/`Stop`, after computing changed files: build hunks from `git diff` for those files (reuse `capture/diff.ts`), call `/enforce`, then post `/changes` as today with `violations`.
- Output for the agent: `hookSpecificOutput.additionalContext` = `[Lockstep] This change may violate N binding decision(s): • "<rule>" (0.91) …  Confirm it is intended, or adjust.` Only when violations exist. Also mirrored to stderr.
- Time budget: `/enforce` has a 6 s client timeout; on timeout the change is posted without violations. The hook never exits non-zero.

Test: extend the existing capture tests with a stubbed `/enforce`.

#### 4.3 PR comment

- The action sends the PR diff hunks (same caps) to `/enforce` with the changed surfaces. `buildComment` gains a `### ⚠ Lockstep: possible rule violations` section listing rule text and confidence. Advisory: does not affect the exit code.

## 5. Copy

Onboard summary, exact text:

```
✓ 9 surfaces produced · 0 consumed (matched) · 6 unmatched
✓ 5 decisions confirmed · 1 rejected · 1 left for review
✓ decision pack written

Your repo depends on 6 surfaces nobody has declared yet.
They probably live in repos owned by people you already know:
  http:POST /auth/session            src/clients/auth.ts     @dev-marco
  http:GET /billing/customers/:id    src/clients/billing.ts  @dev-lin

  lockstep invite dev-marco dev-lin

Open Claude Code in this repo. Your agent starts with 5 binding decisions and 9 known surfaces.
```

Positioning line for README and site: "IDE memory remembers what you said. Lockstep remembers what you decided, checks the code against it, and tells every agent, including the one running in the background."

## 6. Deploy changes

- `TYPESAFE_API_KEY` on the core service moves from optional to recommended in DEPLOY.md's matrix. `ANTHROPIC_API_KEY` on core is new and optional.
- `.env.example` gains both with comments.
- No new services. No migrations except Phase 0's two nullable columns.

## 7. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| README sections leave the developer's machine | One-line notice before the call, `--no-docs`, self-host unaffected. |
| Noisy proposals, confirm fatigue | Jev floors, 60-section cap, 12-item interactive cap, rest to the review queue. |
| Jev false positives on enforcement annoy the agent | Advisory only, 0.8 floor, recalibrate against captured examples after two weeks. |
| Hosted Railway URL baked into the CLI | One const; `--api` and env override; already what the README instructs. |
| Duplicate rules across two repos' docs | Existing relation verdicts fuse `same_rule`. |
| Hooks in personal settings mean no passive install | Committed skill fallback line covers the gap without leaking machine paths. |

## 8. Success criteria

- `npx lockstep-cli onboard` on a repo with a CLAUDE.md produces a non-empty first briefing with no second developer, in under three minutes including login.
- Phase 0's metric is queryable on the hosted instance before Phase 1 ships.
- Existing tests, Slack and Notion ingest, ratification flow, and PR check exit codes are unchanged.
