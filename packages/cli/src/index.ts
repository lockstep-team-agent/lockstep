#!/usr/bin/env node
import { runInit, runStatus, runDoctor } from "./init.js";
import { runLogin } from "./login.js";
import { runConnect, runInvite } from "./connect.js";
import type { Scope } from "./adapters/types.js";

const argv = process.argv.slice(2);
const cmd = argv[0];
const has = (n: string): boolean => argv.includes(`--${n}`);
const val = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

function help(): void {
  console.log(`lockstep — keep decisions consistent across Claude sessions

usage: lockstep <command>

  login [--api <url>] [--dev --dev-id <n> --dev-login <handle>]
                                                    authenticate; --api saves your server (once), --dev for testing
  init  [--vendor claude|all] [--scope project|user] [--dry-run]
                                                    wire up hooks + MCP + skill for the detected agent(s)
  connect [--project <name>]                        link this repo to a Lockstep project (creates one if needed)
  onboard [--project-id <id>] [--dry-run]            preview → connect → review decisions → configure Claude
         [--yes --upload-docs] [--no-docs] [--enable-checks|--disable-checks]
         [--feature feature:name] [--docs path1.md,path2.md] [--decision "rule"]
  check [--base <revision>] [--upload]                advisory decision check of tracked changes
  checks on|off                                     enable/revoke automatic hosted diff checks for this checkout
  brief                                             print a copyable decision brief for this project
  uninstall [--dry-run] [--scope project|user]        remove managed Claude integration; preserve history
  scan  [--json] [--apply] [--dry-run]              scan the repo → propose lockstep.yaml (produces + graph-resolved consumes)
  sync                                              push lockstep.yaml (produces + consumes) to the graph, no rescan
  pack  [--check] [--dry-run]                       write the compiled decision pack skill (--check: exit 1 if stale)
  invite <github-handle>                            invite a teammate to this repo's project
  status                                            show auth + config health
  doctor                                            diagnose vendor config
  mcp                                               run the per-session MCP server (used by agents)
  capture --event <E>                               hook entrypoint (used by hooks)              [P6]
`);
}

async function main(): Promise<void> {
  switch (cmd) {
    case "login": {
      // Remember the server so the user never has to export anything again.
      const api = val("api") ?? process.env.LOCKSTEP_API_URL;
      if (api) {
        const { setApiUrl } = await import("./config.js");
        setApiUrl(api);
      }
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
    case "connect":
      return runConnect({ org: val("org"), project: val("project"), projectId: val("project-id") });
    case "onboard": {
      const { runOnboard } = await import("./onboard.js");
      return runOnboard({ vendor: val("vendor"), scope: (val("scope") as Scope) ?? "project", dryRun: has("dry-run"),
        api: val("api"), project: val("project"), projectId: val("project-id"), feature: val("feature"), noDocs: has("no-docs"), broadDocs: has("broad-docs"),
        yes: has("yes"), uploadDocs: has("upload-docs"), enableChecks: has("enable-checks"), disableChecks: has("disable-checks"), docs: val("docs")?.split(","), manualDecision: val("decision") });
    }
    case "checks": {
      if (argv[1] !== "on" && argv[1] !== "off") throw new Error("usage: lockstep checks on|off");
      const { saveLocalState } = await import("./local-state.js");
      saveLocalState({ automaticChecks: argv[1] === "on" });
      console.log(argv[1] === "on" ? "Hosted checks enabled: bounded tracked-code diffs will be sent to your configured API and judgment provider at task completion." : "Hosted code checks disabled. Decision continuity remains available.");
      return;
    }
    case "check": {
      const { readLocalState } = await import("./local-state.js");
      const { collectDiff, performCheck, formatCheck } = await import("./check.js");
      let approved = has("upload") || readLocalState().automaticChecks === true;
      if (!approved) {
        const preview = collectDiff(process.cwd(), val("base"));
        console.log(`Preview: ${preview.hunks.length} bounded diff hunk(s) in ${[...new Set(preview.hunks.map((h) => h.file))].join(", ") || "no tracked files"}.`);
        if (process.stdin.isTTY) {
          const { createInterface } = await import("node:readline/promises");
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try { approved = /^(y|yes)$/i.test((await rl.question("Send this tracked-code diff to the configured API and judgment provider for this check? [y/N] ")).trim()); }
          finally { rl.close(); }
        } else console.log("No upload performed. Use --upload for this invocation, or lockstep checks on for automatic checks.");
      }
      console.log(formatCheck(await performCheck({ base: val("base"), uploadApproved: approved })));
      return;
    }
    case "brief": {
      const { registerSession } = await import("./mcp/session.js");
      const { cloud } = await import("./cloud.js");
      const s = await registerSession("cli");
      const result = await cloud.get<{ markdown: string; hash: string }>(`/orgs/${s.orgId}/projects/${s.projectId}/brief`);
      console.log(result.markdown);
      await cloud.post(`/orgs/${s.orgId}/projects/${s.projectId}/brief/exported`, { hash: result.hash });
      return;
    }
    case "uninstall": {
      const { runUninstall } = await import("./uninstall.js");
      return runUninstall({ dryRun: has("dry-run"), scope: (val("scope") as Scope) ?? "project" });
    }
    case "scan": {
      const { runScan } = await import("./scan.js");
      await runScan({ json: has("json"), apply: has("apply"), dryRun: has("dry-run") });
      return;
    }
    case "sync": {
      const { runSync } = await import("./scan.js");
      return runSync();
    }
    case "pack": {
      const { runPack } = await import("./pack.js");
      return runPack({ check: has("check"), dryRun: has("dry-run") });
    }
    case "invite": {
      const handle = argv[1];
      if (!handle) {
        console.error("usage: lockstep invite <github-handle>");
        process.exit(1);
      }
      return runInvite(handle);
    }
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
    case "statusline": {
      const { runStatusLine } = await import("./statusline.js");
      await runStatusLine();
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
