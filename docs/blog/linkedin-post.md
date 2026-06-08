# LinkedIn Post

---

Your AI coding agents are sabotaging each other. And you won't find out until CI breaks at 11pm.

Here's the scenario playing out in engineering teams right now:

Developer A's Claude Code renames POST /auth/login to POST /auth/session.
Developer B's Codex, working on the frontend, keeps calling the old endpoint.
Both agents reason perfectly — within their own context. Neither knows what the other did.
Tests pass locally. PRs look fine. The merge breaks everything.

This is the coordination problem nobody warned us about when we adopted AI coding agents.

Git doesn't prevent it — it only tells you about conflicts after they've happened.
PRs don't prevent it — they review finished work, not in-progress decisions.
Slack doesn't prevent it — agents don't read Slack.

The real issue: there's no shared memory between agents. Each one starts every session from zero context about what the rest of the team has been doing.

I built Lockstep to fix this.

Lockstep is an open-source system-of-record that sits between AI coding agents and keeps them in sync. Here's how:

Every time an agent edits a file, a hook classifies the change — is it an API route? An exported function? A .proto file? Contract-level changes get published to an append-only ledger. Internal changes stay local.

A dependency graph does the routing. If your repo depends on POST /auth/session and someone else changes it, your agent's inbox gets the notification automatically.

When your agent starts a new session, it gets a replay of everything it missed — unread changes, binding decisions, open questions — injected as context before it writes a single line of code.

Agents can propose decisions ("we're renaming this endpoint"). Shared decisions stay open until a teammate acknowledges them, then become binding for the whole project.

At PR time, a GitHub Action checks every changed API surface against the ledger. No binding decision? The PR fails.

The critical constraint: source code never leaves the developer's machine. Only decisions and metadata flow through the system.

It works across vendors — Claude Code, Codex, Gemini CLI — anything that supports the Model Context Protocol (MCP). Self-hostable with docker compose or deployable as a managed service.

I wrote a deep technical blog on exactly how the capture pipeline, dependency graph routing, CAS-versioned decision ledger, and two-tier reconciliation gate work under the hood. Link in the comments.

If your team uses AI coding agents, this is the coordination layer that's missing.

GitHub: https://github.com/naman7474/lockstep

#OpenSource #AIAgents #DeveloperTools #SoftwareEngineering #DevOps #ClaudeCode #Coordination

---

## First comment (post immediately after publishing):

Deep dive on how it all works under the hood — the capture pipeline, dependency graph fan-out, CAS-versioned decision ledger, and the PR reconciliation gate:

[Link to blog post on Dev.to / Hashnode / your blog]
