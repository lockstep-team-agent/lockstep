#!/usr/bin/env node
/**
 * "Outline usable rows < 1s" (plan §7): Playwright, cold browser cache (a fresh context per run),
 * authenticated, from navigationStart until the first domain row of the Map outline is visible
 * and clickable. Run against a production build (`next build && next start`) with LOCKSTEP_NEW_UI=1.
 *
 *   node e2e/concept-timing.mjs <orgId> <projectId> [webUrl] [apiUrl]
 */
import { chromium } from "playwright";

const [orgId, projectId, web = "http://localhost:3000", api = "http://localhost:8080"] = process.argv.slice(2);
if (!orgId || !projectId) {
  console.error("usage: concept-timing.mjs <orgId> <projectId> [webUrl] [apiUrl]");
  process.exit(2);
}
const RUNS = 10;
const TARGET = 1000;

const { token } = await (
  await fetch(`${api}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ githubUserId: 424242, githubLogin: "fixture-owner" }),
  })
).json();

const browser = await chromium.launch();
const times = [];
for (let i = 0; i < RUNS + 1; i++) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: "lockstep_token", value: token, url: web }]);
  const page = await ctx.newPage();
  await page.goto(`${web}/project/${orgId}/${projectId}/map`, { waitUntil: "commit" });
  const row = page.locator('[role="tree"] [role="treeitem"] > button').first();
  await row.waitFor({ state: "visible" });
  await row.click({ trial: true }); // actionable: visible, stable, enabled, receives events
  const ms = await page.evaluate(() => performance.now()); // performance.now() is relative to navigationStart
  if (i > 0) times.push(ms); // the first run also warms the server's compiled routes
  await ctx.close();
}
await browser.close();
times.sort((a, b) => a - b);
const p = (q) => times[Math.min(times.length - 1, Math.floor(q * times.length))];
const ok = p(0.95) < TARGET;
console.log(
  `${ok ? "PASS" : "FAIL"}  outline usable rows  target ${TARGET}ms  p50 ${p(0.5).toFixed(0)}  p95 ${p(0.95).toFixed(0)}  (n=${RUNS})`,
);
process.exit(ok ? 0 : 1);
