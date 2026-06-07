# Lockstep

Neutral, cross-vendor **system-of-record** that keeps two+ developers' coding agents
(Claude Code, Codex, Gemini CLI) in lockstep on the same codebase — sharing decisions,
contracts, ownership, dependencies, questions and tasks **without source code ever
leaving the machine**.

- Product spec: [`PRD.md`](./PRD.md)
- Interactive concept demo: [`lockstep-demo.html`](./lockstep-demo.html)
- Implementation plan: `~/.claude/plans/lexical-dreaming-abelson.md`

## Repo layout

```
packages/core/   # cloud system-of-record — Fastify + Postgres (Drizzle), RLS-isolated, append-only
packages/cli/    # @lockstep/cli — login / init / mcp / capture (the developer-machine edge)
packages/web/    # Next.js dashboard (read-first + onboarding)            [P8]
actions/pr-check # GitHub Action — Tier-2 reconciliation gate              [P7]
```

## Quickstart (dev)

```bash
npm install
cp .env.example .env                 # fill GitHub App keys for auth phases
npm run db:generate                  # generate Drizzle migrations from the schema
docker compose up --build            # Postgres + core (migrations apply on boot)
curl localhost:8080/readyz           # { ok: true, db: "up" }
```

## Status

**v1 complete — all 9 phases built and verified** against a real Postgres:

| Phase | What | Verified by |
|---|---|---|
| P0 | Monorepo, 25-table schema, RLS isolation, append-only triggers | cross-tenant isolation + append-only + fail-closed |
| P1 | GitHub-App auth, principals/members, invites, RLS request context | 2-user identity e2e (auth/invite/403/401) |
| P2 | Ownership graph (CODEOWNERS parser, `whoowns`) | parser unit tests + DB last-match-wins |
| P3 | Ledger (CAS decisions) + per-session MCP server (12 tools) | CAS + broker spine over HTTP |
| P4 | `lockstep init` + vendor adapter (idempotent config merge) | golden idempotency + on-disk integration |
| P5 | Dependency-graph routing + inbox | Shopify fan-out (consumer gets it, non-consumer doesn't) |
| P6 | Tier-1 capture (`lockstep capture`: diff→classify→publish) | classify tests + capture e2e on a real git repo |
| P7 | Questions/tasks + Tier-2 PR-check reconcile gate | lifecycle + gate (fails→propose+ack→passes) |
| P8 | Next.js dashboard (read-first + onboarding) | read endpoints e2e + `next build` |

Run the verification scripts in `packages/core/src/scripts/` and the e2e flows to reproduce.

## Deployment

One image, two modes (12-factor env):
- **Managed cloud** — multi-tenant (RLS), our GitHub App.
- **Self-host** — `docker compose up` on the customer's infra; they register their own GitHub App.
