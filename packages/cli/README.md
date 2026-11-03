# lockstep-cli

The CLI for [Lockstep AI](https://www.getlockstep.dev): shared team memory for Claude Code.

Lockstep captures decisions from PRDs, Slack, Jira, and pull requests, gets each one approved by its owner, rolls out your team's standards and skills, and briefs every Claude Code session at start. Any MCP client can call the same tools. An opt-in check flags changes that may conflict with a binding decision.

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

## Star the repo

If Lockstep helps your team, [star it on GitHub](https://github.com/lockstep-team-agent/lockstep) so other teams can find it.

## License

Apache-2.0
