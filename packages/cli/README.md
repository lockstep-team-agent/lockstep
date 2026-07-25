# lockstep-cli

The CLI for [Lockstep](https://www.getlockstep.dev) — one source of truth for every engineering decision, read by every human and every AI agent before work starts.

Lockstep captures decisions automatically from Slack, Notion, Jira, and pull requests, gets each one confirmed by its owner, briefs any MCP-compatible coding agent (Claude Code, Cursor, and others) at session start, and flags work that contradicts a Locked decision before it ships.

## Install

```bash
npm install -g lockstep-cli
```

## Quick start

```bash
lockstep login     # authenticate
lockstep onboard   # one step: wire up hooks + MCP for your agent, link this repo
lockstep status    # check auth + config health
```

Full setup, MCP configuration, and self-hosting (Apache-2.0, one `docker compose up`):

- **Website:** https://www.getlockstep.dev
- **How it works:** https://www.getlockstep.dev/how-it-works
- **Source:** https://github.com/lockstep-team-agent/lockstep

## License

Apache-2.0
