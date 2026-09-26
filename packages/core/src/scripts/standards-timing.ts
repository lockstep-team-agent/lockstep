/**
 * Standards & Skills latency check against a running core with the scale fixture loaded.
 *
 *   tsx src/scripts/standards-timing.ts '<fixture JSON>' [apiUrl]
 *
 * Budgets (p95, client-side, full body read; same laptop-class hardware as the dashboard fixture):
 *   GET  /environments/:id/sync          < 300 ms   (c=1; c=10 must stay within 2×)
 *   POST /orgs/:o/rollouts/preview        < 2000 ms  (org-wide rollout of 50 skills)
 *   GET  /orgs/:o/assignments/:id/adoption < 500 ms  (the org baseline: every environment)
 * Plus: syncs keep their budget while a broad rollout is applied concurrently, and the apply
 * itself stays under 2 s. Exits 1 if any budget is missed.
 */
const [fixture, api = "http://localhost:8080"] = process.argv.slice(2);
if (!fixture) {
  console.error("usage: standards-timing.ts '<fixture JSON>' [apiUrl]");
  process.exit(2);
}
const fx = JSON.parse(fixture) as { orgId: string; login: string; githubUserId: number; repoRemote: string };
let headers: Record<string, string> = {};

async function req<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  const r = await fetch(`${api}${path}`, { method, headers: { ...headers, ...extra, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}
async function timed(fn: () => Promise<unknown>): Promise<number> {
  const t = performance.now();
  await fn();
  return performance.now() - t;
}
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)]!;
async function measure(label: string, n: number, conc: number, fn: (i: number) => Promise<unknown>, warm = 10) {
  for (let i = 0; i < warm; i++) await fn(i);
  const out: number[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (next < n) {
        const i = next++;
        out.push(await timed(() => fn(i)));
      }
    }),
  );
  const v = p95(out);
  console.log(`${label.padEnd(44)} c=${conc}  p50 ${[...out].sort((a, b) => a - b)[Math.floor(n / 2)]!.toFixed(0)}ms  p95 ${v.toFixed(0)}ms`);
  return v;
}

async function main() {
  const { token } = await req<{ token: string }>("POST", "/auth/dev-login", { githubUserId: fx.githubUserId, githubLogin: fx.login });
  headers = { authorization: `Bearer ${token}` };
  const s = await req<{ sessionId: string }>("POST", "/sessions/register", { gitRemote: fx.repoRemote, vendor: "claude" });
  headers["x-lockstep-session"] = s.sessionId;
  const O = `/orgs/${fx.orgId}`;
  const mine = await req<{ environments: Array<{ id: string; repoId: string | null }> }>("GET", `${O}/me/environments`);
  const envIds = mine.environments.map((e) => e.id);
  // An environment answers only to a session from its own checkout: one session per repository.
  const overview = await req<{ projects: Array<{ repos: Array<{ id: string; gitRemote: string }> }> }>("GET", `${O}/overview`);
  const remoteOf = new Map(overview.projects.flatMap((p) => p.repos).map((r) => [r.id, r.gitRemote]));
  const sessionOf = new Map<string, string>();
  for (const e of mine.environments)
    if (e.repoId && !sessionOf.has(e.repoId))
      sessionOf.set(e.repoId, (await req<{ sessionId: string }>("POST", "/sessions/register", { gitRemote: remoteOf.get(e.repoId), vendor: "claude" })).sessionId);
  const envSession = new Map(mine.environments.map((e) => [e.id, sessionOf.get(e.repoId ?? "")!]));
  const list = await req<{ assignments: Array<{ id: string; selectors: Record<string, unknown> | null }> }>("GET", `${O}/assignments`);
  const baseline = list.assignments.find((a) => !Object.values(a.selectors ?? {}).some((v) => Array.isArray(v) && v.length) && (a.selectors as { audience?: { kind: string } })?.audience?.kind !== "teams")!;
  const cat = await req<{ items: Array<{ published: { id: string } | null }> }>("GET", `${O}/catalog?kind=skill`);
  const fifty = cat.items.filter((i) => i.published).slice(100, 150).map((i) => i.published!.id);
  const broad = { kind: "create", name: "Broad rollout", versionIds: fifty, selectors: {}, level: "required" };
  console.log(`fixture: ${envIds.length} owner environments of 1000; baseline ${baseline.id}`);

  const misses: string[] = [];
  const budget = (label: string, v: number, max: number) => v > max && misses.push(`${label}: ${v.toFixed(0)}ms > ${max}ms`);
  const sync = (i: number) => {
    const id = envIds[i % envIds.length]!;
    return req("GET", `/environments/${id}/sync`, undefined, { "x-lockstep-session": envSession.get(id)! });
  };
  budget("sync c=1", await measure("GET /environments/:id/sync", 200, 1, sync, 20), 300);
  budget("sync c=10", await measure("GET /environments/:id/sync", 200, 10, sync), 600);
  budget("preview", await measure("POST /rollouts/preview (org-wide, 50 skills)", 20, 1, () => req("POST", `${O}/rollouts/preview`, { change: broad }), 3), 2000);
  budget("adoption", await measure("GET /assignments/:id/adoption (baseline)", 50, 1, () => req("GET", `${O}/assignments/${baseline.id}/adoption`), 5), 500);

  // Apply a broad rollout (previewed first, as the UI does) while 10 clients keep syncing.
  const { basis } = await req<{ basis: string }>("POST", `${O}/rollouts/preview`, { change: broad });
  const during: number[] = [];
  let stop = false;
  const loops = Array.from({ length: 10 }, async (_, k) => {
    for (let i = k; !stop; i += 10) during.push(await timed(() => sync(i)));
  });
  await new Promise((r) => setTimeout(r, 300));
  const applyMs = await timed(() => req("POST", `${O}/rollouts/apply`, { change: broad, basis }));
  await new Promise((r) => setTimeout(r, 1500));
  stop = true;
  await Promise.all(loops);
  const dur = p95(during);
  console.log(`${"POST /rollouts/apply (broad, under sync load)".padEnd(44)}       ${applyMs.toFixed(0)}ms`);
  console.log(`${"sync during apply".padEnd(44)} c=10  p95 ${dur.toFixed(0)}ms (${during.length} requests)`);
  budget("apply", applyMs, 2000);
  budget("sync during apply", dur, 600);
  // After the apply, every enrolled environment's desired generation moved: syncs see it at once.
  const after = await req<{ desired: unknown[] }>("GET", `/environments/${envIds[0]}/sync`, undefined, { "x-lockstep-session": envSession.get(envIds[0]!)! });
  console.log(`after apply: owner env desires ${after.desired.length} skills`);

  if (misses.length) {
    console.error(`\nMISSED:\n  ${misses.join("\n  ")}`);
    process.exit(1);
  }
  console.log("\nAll budgets met.");
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
