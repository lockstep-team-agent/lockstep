<p align="center"><strong>Lockstep</strong></p>

<h3 align="center">Stop your team's AI coding agents from making conflicting changes — without sharing source code.</h3>

<p align="center">
  <a href="https://github.com/lockstep-team-agent/lockstep/actions/workflows/ci.yml"><img src="https://github.com/lockstep-team-agent/lockstep/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/lockstep-cli"><img src="https://img.shields.io/npm/v/lockstep-cli" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/TypeScript-strict-blue" alt="TypeScript strict">
  <img src="https://img.shields.io/badge/Fastify-5-black" alt="Fastify 5">
  <img src="https://img.shields.io/badge/PostgreSQL-16-336791" alt="PostgreSQL 16">
</p>

<!--
  HERO ASSET — record a 20–30s clip of the magic loop and embed it here:
  Agent A renames a contract surface → Lockstep captures the decision →
  Agent B's next session is warned automatically → an uncoordinated PR fails the gate.
  Save as docs/assets/demo.gif (+ docs/assets/demo.mp4 fallback), then uncomment:
  <p align="center"><img src="docs/assets/demo.gif" alt="Lockstep in action" width="820"></p>

  LIVE DEMO — once the hosted playground URL is live, add it to the nav line below:
  <a href="https://YOUR-DEMO-URL"><b>▶ Try the live demo</b></a> ·
-->

<p align="center">
  <a href="#quick-start"><b>Quick start</b></a> ·
  <a href="#how-it-works"><b>How it works</b></a> ·
  <a href="./DEPLOY.md"><b>Deploy</b></a>
</p>

---

When two developers point AI coding agents (Claude Code, Codex, Gemini CLI) at the same system, the agents have no idea what each other just did:

- **Agent A** renames an API endpoint → **Agent B** keeps calling the old one.
- **Agent A** picks an auth pattern → **Agent B** invents a conflicting one.
- Nobody knows who owns what, what changed, or what still needs review.

**Lockstep is a neutral system-of-record for your agents.** Every decision, contract change, and dependency is captured and routed to the agents that need it — in real time, and **without any source code ever leaving the developer's machine** (only decisions and metadata sync to the cloud).

```bash
npm i -g lockstep-cli
```

### How it compares

|                                         | Nothing | Slack / docs | CODEOWNERS  |      **Lockstep**      |
| --------------------------------------- | :-----: | :----------: | :---------: | :--------------------: |
| Agents learn what other agents changed  |   ❌    |    Manual    |     ❌      |      ✅ Automatic      |
| Contract changes routed to consumers    |   ❌    |      ❌      |     ❌      |  ✅ Dependency graph   |
| Blocks uncoordinated changes at PR time |   ❌    |      ❌      | Review only | ✅ Reconciliation gate |
| Works across agent vendors              |    —    |      —       |      —      | ✅ Claude/Codex/Gemini |
| Source code leaves your machine         |    —    |  Sometimes   |     ❌      |        ❌ Never        |

## How It Works

```
  Developer A (machine)              Lockstep Cloud              Developer B (machine)
  ────────────────────              ───────────────              ────────────────────
  ┌─────────────────┐                                           ┌─────────────────┐
  │  Claude Code    │                                           │  Codex / Gemini │
  │  + MCP Server   │──── capture ────┐                         │  + MCP Server   │
  └─────────────────┘                 │                         └─────────────────┘
         │                            ▼                                   ▲
         │                     ┌─────────────┐                            │
    hook fires on        ──→   │  Decisions   │   ──→   dependency graph  │
    every file edit            │  Contracts   │         looks up who      │
    (PostToolUse)              │  Ownership   │         consumes the      │
         │                     │  Deps Graph  │         changed surface   │
         ▼                     │   Inboxes    │              │            │
    classifies the             └─────────────┘              ▼            │
    diff as contract              Append-only          fan-out to ───────┘
    surface or owned              No source code       each consumer's inbox
```

### The notification lifecycle

**1. Capture** — A Claude Code hook fires on every file edit (`PostToolUse`) and on session end. The CLI diffs the working tree against HEAD, classifies each changed file — is it an API route, a `.proto`, an OpenAPI spec, an exported function? Files that expose a public interface are flagged as **contract surfaces**. The change is published to the ledger with a risk tier (`owned` if only you touch it, `shared` if it's a contract surface).

**2. Route** — When a change hits the ledger, the **dependency graph** kicks in. Every repo that has registered a dependency on the changed surface gets a notification fanned out to its inbox. The sender is excluded. If repo B declared `POST /auth/session` as a dependency, and repo A just changed that surface, repo B's inbox gets the change — automatically, with zero configuration beyond `register_dependency`.

**3. Replay** — When an agent starts a new session (`SessionStart` hook), Lockstep reads the inbox and replays everything that arrived since the last session: unread changes, binding decisions, and open questions. This is injected as `additionalContext` so the agent is immediately aware of what teammates have done.

**4. Decide** — Agents can propose decisions scoped to a surface (e.g. "rename `POST /auth/login` to `POST /auth/session`"). Owner-scoped decisions are binding immediately. Shared/contract decisions stay `open` until another team member acknowledges them — then they become `binding` for the whole project.

**5. Gate** — At PR time, the Tier-2 reconciliation gate (a GitHub Action) checks every changed contract surface against the ledger. If a surface was changed but has no binding decision, the PR check fails. This catches anything Tier-1 missed.

### Who gets notified?

| What happens                                               | Who gets notified                                       | How                                             |
| ---------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------- |
| Contract surface changed (API route, proto, exported type) | Every repo that registered a dependency on that surface | Inbox fan-out, delivered on next session replay |
| Decision proposed on a shared scope                        | All project members see it in their decision list       | `decisions` MCP tool / dashboard                |
| Question asked (optionally scoped to a surface)            | All project members                                     | Inbox / dashboard                               |
| Task delegated to a specific teammate                      | The delegatee                                           | Inbox / dashboard                               |
| PR touches a contract surface with no binding decision     | The PR author                                           | GitHub Action check fails with violation list   |

### What flows through the cloud (and what doesn't)

| Flows through Lockstep                                    | Never leaves the machine |
| --------------------------------------------------------- | ------------------------ |
| Decision text ("rename endpoint X to Y")                  | Source code              |
| Surface identifiers (`POST /auth/session`)                | File contents            |
| Change summaries ("changed 3 files: routes/auth.ts, ...") | Git diffs                |
| Dependency edges (repo B consumes surface X)              | Credentials or secrets   |
| Ownership rules (parsed from CODEOWNERS)                  | Environment variables    |

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

Get a working local setup in under 5 minutes — no GitHub App keys needed.

### 1. Start the stack

```bash
git clone https://github.com/lockstep-team-agent/lockstep.git
cd lockstep
cp .env.example .env       # dev-login is enabled by default
docker compose up --build   # starts Postgres + API + dashboard
```

Wait for `lockstep-core listening on :8080` in the logs. Verify:

```bash
curl http://localhost:8080/readyz
# => { "ok": true, "db": "up", "deployment": "self-host" }
```

This gives you:

- **API** at http://localhost:8080
- **Dashboard** at http://localhost:3000
- **Postgres** at localhost:5432

### 2. Install the CLI & log in

```bash
npm i -g lockstep-cli

# Point the CLI at your local server (saved permanently — only needed once)
lockstep login --api http://localhost:8080 --dev --dev-id 1 --dev-login alice
```

> **Important**: The `--api` flag tells the CLI where the backend is. Without it, the CLI defaults to `http://localhost:8080`. For a deployed server, use `lockstep login --api https://your-server.example.com`.

### 3. Connect your repo

```bash
cd your-project              # any git repo with an origin remote
lockstep init                # installs MCP server + hooks into the repo
lockstep connect --project "my-team"   # creates a project and links this repo
```

### 4. Open the dashboard

Open http://localhost:3000 in your browser. To sign in, you need the session token. Get it with:

```bash
# macOS (token stored in keychain)
security find-generic-password -s lockstep -a session-token -w

# Linux / fallback (token stored in file)
cat ~/.lockstep/credentials.json
```

Paste the `lsk_...` token into the dashboard sign-in field.

### 5. Add a teammate

Your teammate runs (on their machine):

```bash
npm i -g lockstep-cli
lockstep login --api http://localhost:8080 --dev --dev-id 2 --dev-login bob
cd their-project
lockstep init
lockstep connect --project "my-team"   # joins the existing project
```

Both developers are now in the same project. They'll see each other on the Members page in the dashboard.

### 6. Start coding with your AI agent

Open Claude Code (or any MCP-compatible agent) in the repo. On session start, the agent receives a Lockstep replay of everything that happened since the last session — changes, binding decisions, open questions, and assigned tasks.

As you work, contract changes are captured automatically and routed to teammates' inboxes.

> **Production setup**: For real GitHub-based auth (no `--dev` flag needed), register a GitHub App and fill in the keys in `.env`. Set `NODE_ENV=production` and `LOCKSTEP_DEV_LOGIN=0`. See [DEPLOY.md](./DEPLOY.md) for Railway/cloud deployment.

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

- **26-table schema** with row-level security (RLS) for tenant isolation
- **Append-only ledger** — decisions are immutable, versioned with content-addressable storage
- **Vendor-neutral adapter pattern** — new AI agent integrations are a single adapter file
- **Zod validation** on every boundary, TypeScript strict mode throughout
- **Zero source code stored** — only decisions, contracts, and metadata flow through the system

## Security

See [SECURITY.md](./SECURITY.md) for our responsible disclosure policy.

## License

[MIT](./LICENSE) &copy; Naman Jain
