# Onboarding a teammate to Lockstep

Lockstep keeps your AI coding agents (Claude Code, etc.) in sync across repos — shared
decisions, contracts, ownership and dependencies — without your source ever leaving your machine.

## 1. Install the CLI (once per machine)

```bash
npm i -g lockstep-cli
```

## 2. Log in (GitHub)

```bash
lockstep login --api https://lockstep-production.up.railway.app
```

This opens a GitHub device-flow prompt (a code + a URL). It also **remembers the server**, so
you never pass `--api` again.

## 3. In each repo you work on

```bash
lockstep init       # wires the hooks + MCP server + skill into this repo
lockstep connect --project "<shared project name>"   # link the repo to your team's project
```

> **Important — the shared project:** for two repos to coordinate, both must be connected to the
> **same project**. The project owner creates it (their first `lockstep connect`) and **invites**
> teammates (`lockstep invite <handle>` or in the dashboard). Once invited + logged in, a teammate
> runs `lockstep connect --project "<that same name>"` so their repo joins the same project.

## 4. Open Claude Code in the repo

- On session start you'll get a Lockstep replay (what changed, what's binding, what's delegated).
- As you work, changes to shared API surfaces are captured and routed to the teammates whose repos depend on them.

## See it in the dashboard

Open the Lockstep dashboard, sign in with a token from `lockstep login`, and browse Decisions,
Questions, Tasks, Contracts, Dependencies, and the Activity trail for your project.

## Commands

| Command                               | What it does                                        |
| ------------------------------------- | --------------------------------------------------- |
| `lockstep login [--api <url>]`        | authenticate (GitHub device flow); saves the server |
| `lockstep init`                       | wire hooks + MCP + skill into the current repo      |
| `lockstep connect [--project <name>]` | link this repo to a project (creates one if needed) |
| `lockstep invite <github-handle>`     | invite a teammate to this repo's project            |
| `lockstep status` / `lockstep doctor` | check auth + config health                          |
