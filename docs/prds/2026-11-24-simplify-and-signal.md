# Simplify & Signal — build plan (Nov 2026)

Source: `docs/gtm/persona-interviews-2026-11.md`. Branch: `feat/simplify-and-signal`.

## What already exists (don't rebuild)

- Consumer alerts: `actions/pr-check` warns "consumed by N repos"; merged PRs fan out to consumer
  inboxes (`gateway/github-webhook-service.ts` → `recordChange` → `routing/routing-engine.ts`).
- Trust: supersession (`supersededById`), expiry (`expiresAt`, `ledger/expiry-job.ts`), review tripwire
  (`reviewAt`), provenance (`decision_provenances`), approvals, `audit_events`, briefing budget.
- A 5-tab dashboard shell (Inbox / Map / Ledger / Insights / Settings) behind `LOCKSTEP_NEW_UI`.

## Build

1. **Dashboard simplification** — new shell becomes the only UI; old 20-page UI deleted. Plain
   words (no "ratification", "housekeeping", "concept", "surface" in primary UI). Inbox shows only
   what needs *this viewer*; the rest is handled or folded away.
2. **Review comments → standards** — GitHub `pull_request_review_comment` webhook; similar comments
   repeated ≥3× in a project become one proposed standard ("You've said this 4×") via
   `fileProposedDecision` (origin `ingested`, source `github`). One-click confirm.
3. **Deprecations** — `decisionType: "deprecation"` with `{retired, replacement}`; briefings render
   "X is retired → use Y"; pr-check flags added lines that use a retired identifier.
4. **Audit export** — `GET /orgs/:org/projects/:p/audit-export?format=csv|json`: decision, version,
   rule, status, approver(s), timestamps, sources, linked PRs. Button in Ledger.

Deferred: Slack DM capture (existing sweeps stay), Cursor adapter, pricing.

## Done when

- typecheck + existing tests green; new logic has one focused test each.
- Screenshots regenerated; persona usability round scores the new UI vs the baseline.
