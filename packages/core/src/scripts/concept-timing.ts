/**
 * API latency check for the concept ledger against a running core (plan §7).
 *
 *   tsx src/scripts/concept-timing.ts <orgId> <projectId> [apiUrl]
 *
 * Per endpoint: 20 discarded warm-up requests, then 200 measured, at concurrency 1 (headline p95)
 * and 10 (must stay within 2× the target). Timed client-side from request start until the full
 * body is read. No application cache exists to warm. Exits 1 if any target is missed.
 */
const [orgId, projectId, api = "http://localhost:8080"] = process.argv.slice(2);
if (!orgId || !projectId) {
  console.error("usage: concept-timing.ts <orgId> <projectId> [apiUrl]");
  process.exit(2);
}
const WARMUP = 20;
const MEASURED = 200;

async function token(): Promise<string> {
  const r = await fetch(`${api}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ githubUserId: 424242, githubLogin: "fixture-owner" }),
  });
  return ((await r.json()) as { token: string }).token;
}

async function timed(url: string, auth: string): Promise<number> {
  const t = performance.now();
  const r = await fetch(url, { headers: { authorization: `Bearer ${auth}` } });
  await r.text();
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return performance.now() - t;
}

async function run(url: string, auth: string, concurrency: number): Promise<number[]> {
  for (let i = 0; i < WARMUP; i++) await timed(url, auth);
  const out: number[] = [];
  let left = MEASURED;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (left-- > 0) out.push(await timed(url, auth));
    }),
  );
  return out.sort((a, b) => a - b);
}
const p = (xs: number[], q: number) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]!;

async function main() {
  const auth = await token();
  const P = `${api}/orgs/${orgId}/projects/${projectId}`;
  const outline = (await (await fetch(`${P}/outline`, { headers: { authorization: `Bearer ${auth}` } })).json()) as {
    domains: Array<{
      id: string;
      counts: { items: number };
      concepts: Array<{ id: string; counts: { surfaces: number; decisions: number } }>;
    }>;
  };
  // the heaviest domain and the heaviest concept: the skewed worst case
  const dom = [...outline.domains].sort((a, b) => b.counts.items - a.counts.items)[0]!;
  const big = outline.domains
    .flatMap((d) => d.concepts)
    .sort((a, b) => b.counts.surfaces + b.counts.decisions - (a.counts.surfaces + a.counts.decisions))[0]!;
  console.log(
    `worst domain ${dom.id} (${dom.counts.items} items); worst concept ${big.id} (${big.counts.surfaces} surfaces)`,
  );

  const cases: Array<[string, string, number]> = [
    ["outline", `${P}/outline`, 300],
    ["graph?expand=<heaviest domain>", `${P}/graph/concepts?expand=${dom.id}`, 300],
    ["concept decisions p1 <oversized>", `${P}/concepts/${big.id}?tab=decisions`, 500],
    ["concept contracts p1 <oversized>", `${P}/concepts/${big.id}?tab=contracts`, 500],
  ];
  let failed = false;
  for (const [name, url, target] of cases) {
    const c1 = await run(url, auth, 1);
    const c10 = await run(url, auth, 10);
    const ok1 = p(c1, 0.95) < target;
    const ok10 = p(c10, 0.95) < target * 2;
    failed ||= !ok1 || !ok10;
    console.log(
      `${ok1 && ok10 ? "PASS" : "FAIL"}  ${name.padEnd(34)} target ${target}ms  p50 ${p(c1, 0.5).toFixed(0)}  p95 ${p(c1, 0.95).toFixed(0)}  | c=10 p95 ${p(c10, 0.95).toFixed(0)} (≤${target * 2})`,
    );
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
