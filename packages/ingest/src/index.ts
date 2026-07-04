#!/usr/bin/env node
import { LockstepClient } from "./client.js";
import { StubConnector } from "./connectors/StubConnector.js";
import { ComposioConnector, type Tool } from "./connectors/ComposioConnector.js";
import { NangoConnector } from "./connectors/NangoConnector.js";
import type { SourceConnector } from "./connectors/SourceConnector.js";
import { runFunnel } from "./funnel.js";
import { runEval } from "./eval/run.js";

/**
 * lockstep-ingest — the v2 sweep worker CLI.
 *
 *   lockstep-ingest channels --entity <projectId>        list Slack channels (to find allowlist ids)
 *   lockstep-ingest connect  --connection <id> --entity <projectId>   run Composio OAuth, finalize
 *   lockstep-ingest sweep    [--stub] [--no-haiku]        one-shot: fetch → distill → propose
 *   lockstep-ingest serve    [--interval <sec>]           loop sweep on an interval (default 900s)
 *
 * Env: LOCKSTEP_API_URL, LOCKSTEP_INGEST_TOKEN, COMPOSIO_API_KEY, ANTHROPIC_API_KEY.
 */

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function env(name: string, required = false): string {
  const v = process.env[name];
  if (!v && required) throw new Error(`${name} is required`);
  return v ?? "";
}
function client(): LockstepClient {
  return new LockstepClient(env("LOCKSTEP_API_URL") || "http://localhost:8080", env("LOCKSTEP_INGEST_TOKEN", true));
}
function composio(entity: string, tool: Tool = "slack"): ComposioConnector {
  return new ComposioConnector(env("COMPOSIO_API_KEY", true), entity, tool);
}
function toolFlag(): Tool {
  return (flag("tool") as Tool) ?? "slack";
}

async function cmdChannels(): Promise<void> {
  const entity = flag("entity");
  if (!entity) throw new Error("--entity <projectId> required");
  const chans = await composio(entity, toolFlag()).listChannels();
  for (const c of chans) console.log(`${c.id}\t${c.name}`);
  console.log(`\n${chans.length} source(s). Add the ones you want swept in the dashboard Connections page.`);
}

async function cmdConnect(): Promise<void> {
  const connectionId = flag("connection");
  const entity = flag("entity");
  if (!connectionId || !entity) throw new Error("--connection <id> --entity <projectId> required");
  const conn = composio(entity, toolFlag());
  const { redirectUrl, connectedAccountId } = await conn.initiate();
  console.log(`\nAuthorize Slack here, then return:\n\n  ${redirectUrl}\n`);
  process.stdout.write("Waiting for authorization");
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    process.stdout.write(".");
    if (await conn.isActive(connectedAccountId)) {
      await client().finalizeConnection(connectionId, connectedAccountId);
      console.log(`\n✓ Connected. Connection ${connectionId} is now active.`);
      return;
    }
  }
  console.log(`\nTimed out. Once authorized, finalize manually via the worker endpoint with account ${connectedAccountId}.`);
}

async function sweepOnce(): Promise<void> {
  const ls = client();
  const useStub = has("stub");
  const useNango = has("nango");
  const batch = has("batch");
  const useHaiku = !has("no-haiku");
  const work = await ls.getWork();
  console.log(`[sweep] ${work.length} connection(s) with allowlisted sources${batch ? " (batch mode)" : ""}`);
  for (const w of work) {
    if (!useStub && !w.connectedAccountId) {
      console.log(`[sweep] skip ${w.connectionId} (not connected)`);
      continue;
    }
    const connector: SourceConnector = useStub
      ? new StubConnector()
      : useNango
        ? new NangoConnector(env("NANGO_SECRET_KEY", true), w.connectedAccountId ?? w.entity, w.tool)
        : composio(w.entity, w.tool as Tool);
    console.log(`[sweep] connection ${w.connectionId} (${w.tool}) — ${w.sources.length} source(s)`);
    const { items, cursors, stats } = await runFunnel({
      connector,
      orgId: w.orgId,
      projectId: w.projectId,
      connectionId: w.connectionId,
      sources: w.sources.map((s) => ({ sourceRef: s.sourceRef, cursor: s.cursor })),
      tool: w.tool,
      useHaiku,
      batch,
      log: (m) => console.log(m),
    });
    const res = await ls.postProposed(items);
    for (const [sourceRef, cursor] of Object.entries(cursors)) {
      await ls.setWatermark(w.orgId, w.connectionId, sourceRef, cursor);
    }
    console.log(
      `[sweep] seen=${stats.seen} recalled=${stats.recalled} proposed=${stats.proposed} ` +
        `questions=${stats.questions} discarded=${stats.discarded} → filed=${res.filed} deduped=${res.deduped}`,
    );
  }
  console.log("[sweep] done");
}

async function cmdServe(): Promise<void> {
  const interval = Number(flag("interval") ?? 900) * 1000;
  console.log(`[serve] sweeping every ${interval / 1000}s`);
  for (;;) {
    try {
      await sweepOnce();
    } catch (e) {
      console.error("[serve] sweep error:", e);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  switch (cmd) {
    case "channels":
      return cmdChannels();
    case "connect":
      return cmdConnect();
    case "sweep":
      return sweepOnce();
    case "serve":
      return cmdServe();
    case "eval":
      return runEval();
    default:
      console.log("usage: lockstep-ingest <channels|connect|sweep|serve|eval> [flags]");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
