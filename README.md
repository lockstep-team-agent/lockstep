<p align="center">
  <strong>Lockstep</strong><br>
  Keep your team's AI coding agents coordinated — without sharing source code.
</p>

<p align="center">
  <a href="https://github.com/naman7474/lockstep/actions/workflows/ci.yml"><img src="https://github.com/naman7474/lockstep/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/lockstep-cli"><img src="https://img.shields.io/npm/v/lockstep-cli" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/TypeScript-strict-blue" alt="TypeScript strict">
  <img src="https://img.shields.io/badge/Fastify-5-black" alt="Fastify 5">
  <img src="https://img.shields.io/badge/PostgreSQL-16-336791" alt="PostgreSQL 16">
</p>

---

## Why Lockstep?

When multiple developers use AI coding agents (Claude Code, Codex, Gemini CLI) on the same codebase, things break:

- **Agent A** renames an API endpoint. **Agent B** keeps calling the old one.
- **Agent A** decides on a new auth pattern. **Agent B** invents a conflicting one.
- Nobody knows who owns what, what changed, or what still needs review.

**Lockstep is a neutral system-of-record** that keeps every agent aware of every decision, contract change, and dependency — in real-time — without source code ever leaving the developer's machine.

## How It Works

```
  Developer A (machine)              Lockstep Cloud              Developer B (machine)
  ────────────────────              ───────────────              ────────────────────
  ┌─────────────────┐                                           ┌─────────────────┐
  │  Claude Code    │                                           │  Codex / Gemini │
  │  + MCP Server   │──── capture ────┐                         │  + MCP Server   │
  └─────────────────┘                 │                         └─────────────────┘
                                      ▼                                   ▲
                               ┌─────────────┐                           │
                               │  Decisions   │                           │
                               │  Contracts   │──── inbox/notify ─────────┘
                               │  Ownership   │
                               │  Deps Graph  │
                               └─────────────┘
                                Append-only ledger
                                RLS tenant isolation
                                No source code stored
```

1. **Capture** — As you code, the CLI detects contract-level changes (API surfaces, shared types, configs) and publishes them to the ledger.
2. **Route** — The dependency graph knows who consumes what. Changes are routed to the right teammates' inboxes.
3. **Replay** — When an agent starts a new session, it gets a replay of everything that changed since it last checked in.

Source code never leaves the machine. Only decisions, contracts, and metadata flow through the cloud.

## Features

| Feature               | Description                                                                  |
| --------------------- | ---------------------------------------------------------------------------- |
| **Cross-vendor**      | Works with Claude Code, Codex, Gemini CLI — any agent that supports MCP      |
| **Decision ledger**   | Append-only, CAS-versioned decisions with propose/acknowledge workflow       |
| **Dependency graph**  | Automatic routing — changes to a surface notify every consumer               |
| **Ownership graph**   | CODEOWNERS-powered ownership, auto-ingested on connect                       |
| **Two-tier capture**  | Tier-1: real-time change capture. Tier-2: PR-level reconciliation gate       |
| **Questions & tasks** | Cross-agent delegation — ask questions, assign tasks, get answers            |
| **MCP-native**        | 12-tool MCP server runs per-session on the developer's machine               |
| **Dashboard**         | Next.js UI for decisions, contracts, dependencies, activity, and tasks       |
| **Self-hostable**     | `docker compose up` on your own infra, or use the managed cloud              |
| **Secure by default** | RLS isolation, encrypted tokens, append-only audit trail, no secrets in code |

## Quick Start

Get a working local setup in under 3 minutes — no GitHub App keys needed.

### 1. Start the backend

```bash
git clone https://github.com/naman7474/lockstep.git
cd lockstep
npm install
cp .env.example .env
docker compose up --build
```

The `.env.example` defaults already include dev-mode settings. Postgres, the API, and the dashboard will start automatically.

### 2. Verify it's running

```bash
curl http://localhost:8080/readyz
# => { "ok": true, "db": "up", "deployment": "self-host" }
```

### 3. Install the CLI & log in (dev mode)

```bash
npm i -g lockstep-cli
lockstep login --dev --dev-id 1 --dev-login alice
```

### 4. Wire up your repo

```bash
cd your-project
lockstep init                        # installs MCP server + hooks
lockstep connect --project "my-team" # creates/joins a shared project
```

### 5. Open your AI agent

Start Claude Code (or any MCP-compatible agent) in the repo. On session start, the agent receives a Lockstep replay. As you work, contract changes are captured and routed to teammates.

> **Production setup**: For real GitHub-based auth, register a GitHub App and fill in the keys in `.env`. See [DEPLOY.md](./DEPLOY.md) for Railway/cloud deployment.

## Project Structure

```
packages/core/   # Fastify API + PostgreSQL (Drizzle ORM), RLS-isolated, append-only
packages/cli/    # lockstep-cli — login, init, connect, capture, MCP server
packages/web/    # Next.js dashboard — decisions, contracts, deps, activity
actions/pr-check # GitHub Action — Tier-2 reconciliation gate for PRs
```

## CLI Commands

| Command                               | What it does                                               |
| ------------------------------------- | ---------------------------------------------------------- |
| `lockstep login [--api <url>]`        | Authenticate via GitHub device flow (or `--dev` for local) |
| `lockstep init`                       | Wire MCP server + hooks into the current repo              |
| `lockstep connect [--project <name>]` | Link this repo to a shared project                         |
| `lockstep invite <github-handle>`     | Invite a teammate to your project                          |
| `lockstep capture`                    | Manually trigger change capture (also runs automatically)  |
| `lockstep status` / `lockstep doctor` | Check auth + config health                                 |

## Development

```bash
npm run build         # Build all workspaces
npm run typecheck     # Type-check all workspaces
npm run test          # Run all tests
npm run lint          # Lint all workspaces
npm run format        # Format with Prettier
npm run dev:core      # Start core API in watch mode
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for branch conventions, PR process, and code style.

## Deployment

Lockstep runs in two modes (12-factor config):

- **Self-host**: `docker compose up` on your infra — you register your own GitHub App
- **Managed cloud**: Multi-tenant SaaS with RLS isolation

See [DEPLOY.md](./DEPLOY.md) for step-by-step Railway deployment instructions.

## Architecture

- **25-table schema** with row-level security (RLS) for tenant isolation
- **Append-only ledger** — decisions are immutable, versioned with content-addressable storage
- **Vendor-neutral adapter pattern** — new AI agent integrations are a single adapter file
- **Zod validation** on every boundary, TypeScript strict mode throughout
- **Zero source code stored** — only decisions, contracts, and metadata flow through the system

## Security

See [SECURITY.md](./SECURITY.md) for our responsible disclosure policy.

## License

[MIT](./LICENSE) &copy; Naman Jain
