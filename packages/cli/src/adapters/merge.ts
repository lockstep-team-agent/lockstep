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

/** Merge statusLine config into settings JSON. Only sets it if not already configured. */
export function mergeStatusLine(existing: string | null, command: string, args: string[]): string {
  const obj: Json = existing ? (JSON.parse(existing) as Json) : {};
  // Only install if no statusLine is configured yet (don't overwrite user's custom one)
  if (!obj.statusLine) {
    obj.statusLine = { type: "command", command, args };
  }
  return JSON.stringify(obj, null, 2) + "\n";
}

/**
 * Strip lockstep-managed hook entries from a settings JSON, preserving foreign hooks byte-for-byte.
 * The healing half of the personal-scope move (IMPROVEMENTS #2): hooks/statusline used to land in
 * the committed `.claude/settings.json`; re-running init removes them there (this) and re-writes
 * them to `settings.local.json` (mergeHooks).
 */
export function removeManagedHooks(existing: string): string {
  const obj: Json = JSON.parse(existing) as Json;
  const hooks = obj.hooks as Record<string, HookEntry[]> | undefined;
  if (hooks) {
    for (const [event, arr] of Object.entries(hooks)) {
      if (!Array.isArray(arr)) continue;
      const foreign = arr.filter((e) => !isOurs(e));
      if (foreign.length > 0) hooks[event] = foreign;
      else delete hooks[event];
    }
    if (Object.keys(hooks).length === 0) delete obj.hooks;
  }
  return JSON.stringify(obj, null, 2) + "\n";
}

/** Strip a lockstep-managed statusLine (a user's custom one is never ours — mergeStatusLine never overwrote it). */
export function removeManagedStatusLine(existing: string): string {
  const obj: Json = JSON.parse(existing) as Json;
  const sl = obj.statusLine as { command?: string; args?: string[] } | undefined;
  if (sl && `${sl.command ?? ""} ${(sl.args ?? []).join(" ")}`.includes(MARKER)) delete obj.statusLine;
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
