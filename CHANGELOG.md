# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

**Versioning policy:** Lockstep is a monorepo released as a single unit. The root,
`@lockstep/core`, `@lockstep/web`, `lockstep-cli`, and `@lockstep/pr-check` packages
share one version number, tagged on this repository (e.g. `v0.1.0`). The `lockstep-cli`
package is the only one published to npm; its npm version tracks the repo version.

## [Unreleased]

### Changed

- License changed from MIT to Apache-2.0.
- Capture records *changes*, not decisions — decisions are logged explicitly and typed (`rule` | `architecture`).
- Surfaces use canonical vendor-neutral IDs (`http:`, `proto:`, `gql:`) so changes route to their consumers.
- Decisions and changes carry an impact score (blast radius) that ranks the session briefing and drives binding.

### Added

- `lockstep.yaml` manifest to declare the surfaces a repo produces and consumes.
- `consumers` tool / `GET /consumers` — "does anyone use this surface?", answered from the usage graph.

### Fixed

- Cross-service teammates now join a project via invite instead of silently getting a separate workspace; `lockstep invite` resolves the project by git remote.

## [0.1.0] - 2026-06-23

First public release.

### Added

- **Capture (Tier-1)** — Claude Code `PostToolUse`/`SessionEnd` hooks diff the working
  tree, classify changed files as contract surfaces or owned, and publish to the ledger
  with a risk tier.
- **Routing** — dependency-graph fan-out: a contract change notifies every repo that
  registered a dependency on the changed surface, delivered to its inbox.
- **Replay** — `SessionStart` injects unread changes, binding decisions, and open
  questions into the agent as `additionalContext`.
- **Decision ledger** — append-only, content-addressable (CAS) versioned decisions with a
  propose/acknowledge workflow; owner-scoped decisions bind immediately, shared ones bind
  on acknowledgement.
- **Reconciliation gate (Tier-2)** — GitHub Action that fails a PR when a changed contract
  surface has no binding decision.
- **Ownership graph** — CODEOWNERS parser, auto-ingested on connect.
- **MCP server** — per-session, 12 tools (notify, inbox, ack, query, ask, answer,
  delegate, complete, propose_decision, ack_decision, register_dependency, decisions,
  whoowns).
- **CLI** (`lockstep-cli`) — `login` (GitHub device flow + dev mode), `init`, `connect`,
  `invite`, `capture`, `status`, `doctor`; OS-keychain token storage with encrypted file
  fallback.
- **Dashboard** — Next.js UI for decisions, contracts, dependencies, activity, members,
  questions, and tasks.
- **Backend** — Fastify 5 API on PostgreSQL (Drizzle ORM), 26-table schema with
  row-level-security tenant isolation and append-only enforcement; runs self-hosted via
  `docker compose` or managed on Railway.
- **Project hygiene** — CI (build, typecheck, lint, test on Node 20 & 22), ESLint +
  Prettier, issue/PR templates, SECURITY.md, CONTRIBUTING.md.

[Unreleased]: https://github.com/lockstep-team-agent/lockstep/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lockstep-team-agent/lockstep/releases/tag/v0.1.0
