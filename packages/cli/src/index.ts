#!/usr/bin/env node
import { runInit, runStatus, runDoctor } from "./init.js";
import { runLogin } from "./login.js";
import type { Scope } from "./adapters/types.js";

const argv = process.argv.slice(2);
const cmd = argv[0];
const has = (n: string): boolean => argv.includes(`--${n}`);
const val = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

function help(): void {
  console.log(`lockstep — keep your team's coding agents in sync

usage: lockstep <command>

  login [--dev --dev-id <n> --dev-login <handle>]   authenticate (GitHub device flow; --dev for testing)
  init  [--vendor claude|all] [--scope project|user] [--dry-run]
                                                    wire up hooks + MCP + skill for the detected agent(s)
  status                                            show auth + config health
  doctor                                            diagnose vendor config
  mcp                                               run the per-session MCP server (used by agents)
  capture --event <E>                               hook entrypoint (used by hooks)              [P6]
`);
}

function notYet(name: string, phase: string): never {
  console.error(`\`lockstep ${name}\` is not implemented yet (arrives in ${phase}).`);
  process.exit(2);
}

async function main(): Promise<void> {
  switch (cmd) {
    case "login": {
      if (has("dev")) {
        const id = Number(val("dev-id") ?? "0");
        const login = val("dev-login") ?? "";
        if (!id || !login) {
          console.error("usage: lockstep login --dev --dev-id <n> --dev-login <handle>");
          process.exit(1);
        }
        return runLogin({ dev: { id, login } });
      }
      return runLogin({});
    }
    case "init":
      return runInit({
        vendor: val("vendor"),
        scope: (val("scope") as Scope) ?? "project",
        dryRun: has("dry-run"),
      });
    case "status":
      return runStatus();
    case "doctor":
      return runDoctor();
    case "mcp": {
      const { runMcpServer } = await import("./mcp/server.js");
      await runMcpServer();
      return;
    }
    case "capture": {
      const { runCapture } = await import("./capture/index.js");
      await runCapture(val("event") ?? "PostToolUse");
      return;
    }
    case "help":
    case "--help":
    case "-h":
    case undefined:
      return help();
    default:
      console.error(`unknown command: ${cmd}\n`);
      help();
      process.exit(1);
  }
}

void main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
