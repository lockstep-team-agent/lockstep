/**
 * Pure, idempotent, non-clobbering config merges. The hard part of `lockstep init`:
 * we write into users' existing vendor configs without trampling foreign entries, and
 * running init twice must produce byte-identical output (golden test).
 *
 * "Ours" is identified by the stable marker `@lockstep/cli` in a hook command/args.
 */
type Json = Record<string, unknown>;

// Identifies lockstep-owned hook entries (matches both the global-bin form `lockstep …`
// and the legacy `npx @lockstep/cli …` form, so re-running init migrates old configs).
const MARKER = "lockstep";

export interface HookCommand {
  type: "command";
  command: string;
  args?: string[];
  timeout?: number;
}
export interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}
export interface ManagedHook {
  event: string;
  matcher: string;
  args: string[];
  timeout: number;
}
export interface McpServerSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function isOurs(entry: HookEntry): boolean {
  return (entry.hooks ?? []).some((h) => `${h.command} ${(h.args ?? []).join(" ")}`.includes(MARKER));
}

/** Merge our capture hooks into an existing settings JSON, preserving foreign hooks. */
export function mergeHooks(existing: string | null, managed: ManagedHook[], command = "npx"): string {
  const obj: Json = existing ? (JSON.parse(existing) as Json) : {};
  const hooks = (obj.hooks as Record<string, HookEntry[]>) ?? {};

  const byEvent = new Map<string, ManagedHook[]>();
  for (const m of managed) {
    const list = byEvent.get(m.event) ?? [];
    list.push(m);
    byEvent.set(m.event, list);
  }

  for (const [event, ms] of byEvent) {
    const arr: HookEntry[] = Array.isArray(hooks[event]) ? hooks[event]! : [];
    const foreign = arr.filter((e) => !isOurs(e));
    const ours: HookEntry[] = ms.map((m) => ({
      matcher: m.matcher,
      hooks: [{ type: "command", command, args: m.args, timeout: m.timeout }],
    }));
    hooks[event] = [...foreign, ...ours];
  }
  obj.hooks = hooks;
  return JSON.stringify(obj, null, 2) + "\n";
}

/** Upsert our MCP server under its stable key; leave sibling servers untouched. */
export function mergeMcp(existing: string | null, name: string, spec: McpServerSpec): string {
  const obj: Json = existing ? (JSON.parse(existing) as Json) : {};
  const servers = (obj.mcpServers as Record<string, McpServerSpec>) ?? {};
  servers[name] = spec;
  obj.mcpServers = servers;
  return JSON.stringify(obj, null, 2) + "\n";
}

const START = "<!-- lockstep:start -->";
const END = "<!-- lockstep:end -->";

/** Replace only the delimited managed block in a markdown file; append if absent. */
export function upsertManagedBlock(existing: string | null, block: string): string {
  const wrapped = `${START}\n${block}\n${END}`;
  if (!existing) return wrapped + "\n";
  const re = new RegExp(`${START}[\\s\\S]*?${END}`);
  if (re.test(existing)) return existing.replace(re, wrapped);
  return existing.trimEnd() + "\n\n" + wrapped + "\n";
}
