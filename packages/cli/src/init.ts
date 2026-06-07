import { getAdapters } from "./adapters/registry.js";
import type { Scope } from "./adapters/types.js";
import { cloud } from "./cloud.js";
import { getToken } from "./auth/token-store.js";

export async function runInit(opts: { vendor?: string; scope: Scope; dryRun: boolean }): Promise<void> {
  const cwd = process.cwd();
  const adapters = await getAdapters(opts.vendor);
  if (adapters.length === 0) {
    console.error(`no adapter for vendor: ${opts.vendor}`);
    process.exit(1);
  }
  console.log(`lockstep init — scope=${opts.scope}${opts.dryRun ? " (dry-run)" : ""}`);
  for (const a of adapters) {
    console.log(`\n[${a.id}]`);
    for (const line of await a.install(cwd, opts.scope, opts.dryRun)) {
      console.log("  " + line);
    }
  }
  if (!opts.dryRun && opts.scope === "project") {
    console.log("\nCommit the written files so teammates get Lockstep automatically on clone.");
  }
}

export async function runStatus(): Promise<void> {
  console.log(`api:   ${cloud.apiUrl}`);
  console.log(`auth:  ${(await getToken()) ? "logged in" : "not logged in (run: lockstep login)"}`);
  const cwd = process.cwd();
  for (const a of await getAdapters()) {
    const v = await a.verify(cwd, "project");
    console.log(`\n[${a.id}] ${v.ok ? "configured" : "not configured"}`);
    for (const d of v.details) console.log("  " + d);
  }
}

export async function runDoctor(): Promise<void> {
  const cwd = process.cwd();
  let ok = true;
  for (const a of await getAdapters()) {
    const v = await a.verify(cwd, "project");
    if (!v.ok) ok = false;
    console.log(`[${a.id}] ${v.ok ? "OK" : "PROBLEM"}`);
    for (const d of v.details) console.log("  " + d);
  }
  process.exit(ok ? 0 : 1);
}
