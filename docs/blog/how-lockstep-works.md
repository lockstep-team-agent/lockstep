# How Lockstep Keeps AI Coding Agents in Sync — Without Sharing Source Code

## The problem nobody warned us about

Your team adopted AI coding agents. Developer A uses Claude Code. Developer B uses Codex. Maybe someone is trying Gemini CLI. Individual productivity went through the roof.

Then the bugs started.

Developer A's agent renamed `POST /auth/login` to `POST /auth/session`. Developer B's agent, working on the frontend, kept calling the old endpoint. Neither agent knew what the other had done. The tests passed locally. The PR looked fine. CI broke at 11pm.

This isn't a hypothetical. This is what happens when two intelligent systems operate on the same codebase without a shared memory. Each agent reasons perfectly within its own context window — but that context ends at the boundary of one developer's machine.

The problem gets worse with scale. Three developers? Six potential conflicts. Five developers? Twenty. Every new agent multiplies the coordination surface.

## Why existing tools don't solve this

You might think: "We have Git. We have PRs. We have Slack." Sure. But:

**Git** is a conflict resolution tool, not a conflict prevention tool. It tells you about conflicts after they've happened — when two branches touch the same lines. It doesn't tell Developer B that Developer A _decided_ to rename an endpoint. It only tells them when the merge fails.

**PRs** are a code review tool. They're async, they're slow, and they operate on finished work. By the time Developer B reviews Developer A's PR, they've already built a feature on top of the old API surface.

**Slack** is a communication tool for humans. Agents don't read Slack. Even if developers mentioned the rename in a channel, the agent starting a new session tomorrow won't see it.

The missing piece is a **shared system-of-record that agents can read and write** — a coordination layer that operates at the speed of code, not the speed of human communication.

## Introducing Lockstep

Lockstep is an open-source, neutral system-of-record that sits between AI coding agents and keeps them synchronized. It shares decisions, contracts, ownership, and dependencies across repos — without source code ever leaving the developer's machine.

Here's the full picture of how it works:

```
  Developer A (machine)              Lockstep Cloud              Developer B (machine)
  ────────────────────              ───────────────              ────────────────────
  ┌─────────────────┐                                           ┌─────────────────┐
  │  Claude Code    │                                           │  Codex / Gemini │
  │  + MCP Server   │──── capture ────┐                         │  + MCP Server   │
  └─────────────────┘                 │                         └─────────────────┘
         │                            ▼                                   ▲
    hook fires on              ┌─────────────┐                            │
    every file edit    ──→     │  Decisions   │   ──→   dependency graph  │
    (PostToolUse)              │  Contracts   │         looks up who      │
         │                     │  Ownership   │         consumes the      │
         ▼                     │  Deps Graph  │         changed surface   │
    classifies the             │   Inboxes    │              │            │
    diff as contract           └─────────────┘              ▼            │
    surface or owned              Append-only          fan-out to ───────┘
                                  No source code       each consumer's inbox
```

Let me walk through each stage.

## Stage 1: Capture — detecting what changed and why it matters

When you run `lockstep init` in a repo, the CLI installs three hooks into your AI agent:

- **SessionStart** — fires when the agent opens a new session
- **PostToolUse** — fires after every file edit (Edit, Write, MultiEdit)
- **Stop** — fires when the session ends

The PostToolUse hook is where the real work happens. Every time the agent edits a file, Lockstep's capture pipeline runs:

**Step 1: Diff.** The CLI runs `git diff --name-only HEAD` and `git ls-files --others --exclude-standard` to get the list of changed and untracked files. No file contents are read beyond what's needed for classification.

**Step 2: Classify.** Each changed file is run through a classifier that answers one question: _does this file expose a public interface that other code depends on?_ The classifier checks:

- Is it an OpenAPI/Swagger spec? (`.yaml`, `.json` with `openapi` or `swagger` in the name)
- Is it a Protocol Buffer or GraphQL schema? (`.proto`, `.graphql`)
- Is it in a routes/controllers/handlers/endpoints directory?
- Does it contain `export function`, `export class`, `export interface`, or `export type`?

Files that match any of these heuristics are flagged as **contract surfaces**. Everything else is internal.

**Step 3: Risk-tier.** The change gets a risk tier:

- `owned` — all changed files are internal to you, no contract surfaces touched
- `shared` — at least one contract surface was modified, or files are owned by someone else

**Step 4: Publish.** The change summary is published to the ledger. Not the file contents. Not the diff. Just: "changed 3 files: routes/auth.ts, types/order.ts, utils/format.ts" + the surface identifier + the risk tier + a diff hash for dedup.

```typescript
await call("POST", "/changes", session.sessionId, {
  summary: "PostToolUse: changed 3 file(s): routes/auth.ts, types/order.ts, ...",
  surface: "routes/auth.ts",
  riskTier: "shared",
  verified: true,
  verifiedAgainst: "git-diff",
  diffHash: "a1b2c3d4e5f6g7h8",
});
```

The entire capture pipeline runs in under a second. If anything fails, it exits silently — it never breaks the agent.

## Stage 2: Route — the dependency graph decides who needs to know

When a change hits the ledger, the routing engine kicks in. This is the part that makes Lockstep more than just a log.

The system maintains a **dependency graph** — an edge table where each row says "repo B consumes surface X". These edges are created when an agent calls `register_dependency`:

```
register_dependency({ producedSurface: "POST /auth/session" })
```

When repo A publishes a change to surface `POST /auth/session`, the routing engine:

1. Queries all active dependency edges for that surface
2. Collects the set of consumer repos (excluding the sender)
3. For each consumer repo, for each member of the org (excluding the sender), delivers an inbox item

The fan-out is transactional — it happens inside the same database transaction as the change insert. No message queues, no eventual consistency bugs. Either the change and all its notifications commit together, or nothing does.

```typescript
export async function fanoutChangeTx(tx, orgId, args) {
  const edges = await tx
    .select()
    .from(dependencyEdges)
    .where(and(eq(dependencyEdges.producedSurface, args.surface), eq(dependencyEdges.active, true)));

  const consumerRepos = [...new Set(edges.map((e) => e.consumerRepoId))].filter((r) => r !== args.senderRepoId);

  for (const repoId of consumerRepos) {
    for (const member of orgMembers) {
      if (member.id === args.senderMemberId) continue;
      const inboxId = await ensureInbox(tx, orgId, member.id, repoId, args.projectId);
      await tx
        .insert(inboxItems)
        .values({
          orgId,
          inboxId,
          kind: "change",
          refId: args.changeId,
          reason: { surface: args.surface, consumerRepoId: repoId },
        })
        .onConflictDoNothing();
    }
  }
}
```

Each inbox item carries a `reason` — a trace of _why_ you got this notification. Not "something changed somewhere" but "the surface `POST /auth/session` was modified, and your repo consumes it."

## Stage 3: Replay — bringing agents up to speed

When an agent starts a new session, the `SessionStart` hook fires. This is where everything comes together.

The capture pipeline reads the inbox and the current binding decisions, then formats them as `additionalContext` that gets injected into the agent's session:

```
Lockstep:
📥 2 change(s) since you were last here:
  • PostToolUse: changed 3 file(s): routes/auth.ts, ... (routes/auth.ts)
  • PostToolUse: changed 1 file(s): types/order.ts (types/order.ts)
📌 1 binding decision(s) in effect:
  • [POST /auth/session] Rename POST /auth/login to POST /auth/session for consistency
```

The agent sees this before it writes a single line of code. It knows:

- What files changed since it was last active
- Which contract surfaces were modified
- What decisions are binding (rules it must follow)
- What questions are open for it to answer

Reading the inbox marks items as `read`, so the next session doesn't replay them again.

## Stage 4: Decide — propose/acknowledge workflow

Not every coordination problem is a notification. Sometimes the team needs to _agree_ on something before anyone acts.

Lockstep's decision ledger uses **content-addressable storage (CAS) versioning** — the same optimistic concurrency pattern used in databases and distributed systems:

1. Agent A proposes a decision: "Rename POST /auth/login to POST /auth/session" with `baseVersion: 0`
2. The decision is created with `status: open` and `currentVersion: 1`
3. Agent B (or a human on the dashboard) acknowledges it
4. The decision becomes `binding` — every agent in the project must respect it

If two agents try to propose conflicting decisions on the same scope, the second one gets a `409 Conflict` and must re-base. No silent overwrites. No last-write-wins.

Owner-scoped decisions (things that only affect your code) are binding immediately. Shared and contract-scoped decisions require at least one acknowledgment before they bind. This matches the natural trust boundary: you can decide things about your own code, but shared surfaces need consensus.

## Stage 5: Gate — the PR safety net

Tier-1 capture is real-time but best-effort. The agent might not capture every change. The developer might make manual edits outside the agent. The hook might not fire for some edge case.

Tier-2 is the hard gate: a GitHub Action that runs on every PR.

The PR check extracts the list of changed contract surfaces from the diff, then calls the `/reconcile` endpoint:

```typescript
const result = await reconcile(orgId, projectId, contractSurfaces);
// { ok: false, violations: ["POST /auth/session"], staleDependents: [...] }
```

For each changed surface, it checks: _is there a binding decision in the ledger?_ If not, the PR check fails with a violation list. The developer (or their agent) must propose a decision and get it acknowledged before the PR can merge.

This catches everything Tier-1 missed. It's the seatbelt for the real-time system.

## The 12-tool MCP server

Every agent session gets its own MCP server process. The server exposes 12 tools that are thin proxies to the core API:

| Tool                  | What it does                                                     |
| --------------------- | ---------------------------------------------------------------- |
| `notify`              | Publish a change to the ledger (with optional contract delta)    |
| `inbox`               | Read unread changes, decisions, questions routed to you          |
| `query`               | Search the ledger for decisions, changes, and answered questions |
| `propose_decision`    | Propose a new rule (CAS-versioned)                               |
| `ack_decision`        | Acknowledge a shared decision (promotes it to binding)           |
| `decisions`           | List all decisions in the project                                |
| `register_dependency` | Declare that your repo consumes a surface                        |
| `ask`                 | Ask a question (optionally scoped, optionally urgent)            |
| `answer`              | Answer an open question                                          |
| `delegate`            | Create a task for a teammate                                     |
| `complete`            | Mark a delegated task as done                                    |
| `whoowns`             | Look up who owns a file path (from CODEOWNERS)                   |

The agent doesn't need to know about HTTP endpoints, session tokens, or routing. It just calls `inbox()` and gets back a structured list of what it needs to know. It calls `notify()` with a summary, and the routing engine handles the rest.

The MCP server is vendor-neutral. Claude Code, Codex, Gemini CLI — any agent that supports the Model Context Protocol gets the same 12 tools, the same session lifecycle, the same coordination semantics. The vendor adapter pattern means adding a new agent is a single file.

## What stays on the machine

This is the critical design constraint. AI agents operate on source code. Lockstep coordinates them. The two concerns must never cross:

| Flows through Lockstep                       | Never leaves the machine |
| -------------------------------------------- | ------------------------ |
| Decision text ("rename endpoint X to Y")     | Source code              |
| Surface identifiers (`POST /auth/session`)   | File contents            |
| Change summaries ("changed 3 files: ...")    | Git diffs                |
| Dependency edges (repo B consumes surface X) | Credentials or secrets   |
| Ownership rules (from CODEOWNERS)            | Environment variables    |

The append-only ledger stores decisions, contracts, and metadata. Every row is scoped to an org via row-level security (RLS) — a Postgres feature that makes cross-tenant data access physically impossible at the database level, not just at the application level.

## The schema

25 tables, organized into clear domains:

- **Tenancy** — orgs, principals, members, projects, repos, sessions
- **Ownership** — snapshots, rules, rule owners (parsed from CODEOWNERS)
- **Decisions** — decisions, versions (CAS), required reviewers, approvals
- **Contracts** — surfaces with delta, verification status, link to decisions
- **Dependencies** — directed edges (consumer repo → produced surface)
- **Change feed** — summaries, risk tiers, publish state, provenance
- **Questions & tasks** — cross-agent delegation with state machines
- **Inboxes** — per-(member, repo, project) queues with read/unread state
- **Audit** — append-only event log of every action

Every child table carries an `orgId` column. The RLS policy enforces: you can only see rows where `orgId` matches your session's org. The app connects as a restricted `lockstep_app` role. Append-only triggers prevent mutation of ledger rows.

## Try it

```bash
git clone https://github.com/naman7474/lockstep.git
cd lockstep
npm install
cp .env.example .env
docker compose up --build
```

No GitHub App keys needed. Dev-login is enabled by default. The full stack (Postgres, API, dashboard) starts in one command.

```bash
npm i -g lockstep-cli
lockstep login --dev --dev-id 1 --dev-login alice
cd your-project
lockstep init
lockstep connect --project "my-team"
```

Open Claude Code. Your agent is now coordinated.

---

MIT licensed. Built with TypeScript (strict), Fastify, PostgreSQL, Drizzle ORM, and the Model Context Protocol.

GitHub: https://github.com/naman7474/lockstep
npm: https://www.npmjs.com/package/lockstep-cli
