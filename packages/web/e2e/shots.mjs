#!/usr/bin/env node
/**
 * Screenshot every dashboard route for visual review (not pixel-diffed).
 *
 *   node e2e/shots.mjs '<seed json>' [--label populated] [--widths 1440,1024]
 *
 * Pass the JSON printed by e2e/seed.mjs. Output: e2e/out/<label>/<width>/<route>.png
 * Env: LOCKSTEP_WEB_URL (default http://localhost:3000).
 *
 *   Screenshots Home / inbox / areas / rules / settings / one rule page in dark AND
 *              light: e2e/out/<label>/<width>/<theme>/<route>.png. `token` may be omitted if the seed
 *              JSON carries githubUserId/login (e2e: dev-login), e.g. from core's concept-fixture.
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const seed = JSON.parse(args[0] ?? "{}");
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const label = flag("label", "populated");
const widths = flag("widths", "1440,1024").split(",").map(Number);
const WEB = (process.env.LOCKSTEP_WEB_URL ?? "http://localhost:3000").replace(/\/+$/, "");
if (!seed.token && seed.githubUserId) {
  const API = (process.env.LOCKSTEP_API_URL ?? "http://localhost:8080").replace(/\/+$/, "");
  const r = await fetch(`${API}/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ githubUserId: seed.githubUserId, githubLogin: seed.login }),
  });
  seed.token = (await r.json()).token;
}
if (!seed.orgId || !seed.projectId || !seed.token)
  throw new Error("pass the JSON from e2e/seed.mjs as the first argument");

const base = `/project/${seed.orgId}/${seed.projectId}`;
const browser = await chromium.launch();

{
  const NEW = ["", "/inbox", "/inbox?hk=1", "/map", "/ledger", "/ledger?tab=contracts", "/settings"];
  for (const width of widths) {
    for (const theme of ["dark", "light"]) {
      const out = new URL(`./out/${label}/${width}/${theme}/`, import.meta.url).pathname;
      mkdirSync(out, { recursive: true });
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      await ctx.addInitScript((t) => localStorage.setItem("lockstep:theme", t), theme);
      await ctx.addCookies([{ name: "lockstep_token", value: seed.token, domain: new URL(WEB).hostname, path: "/" }]);
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
      const shot = async (path, name) => {
        await page.goto(WEB + base + path, { waitUntil: "networkidle" });
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${out}${name}.png` });
        console.log(`${label}/${width}/${theme}/${name}.png`);
      };
      for (const r of NEW) await shot(r, r.slice(1).replace(/[/?=&]+/g, "-") || "home");
      // the first concept in the outline, on each tab
      await page.goto(WEB + base + "/map", { waitUntil: "networkidle" });
      const concept = await page.locator('[role="tree"] a[href*="concept="]').first().getAttribute("href").catch(() => null);
      if (concept) {
        const id = new URL(WEB + concept).searchParams.get("concept");
        for (const tab of ["decisions", "contracts", "sources"]) await shot(`/map?concept=${id}&tab=${tab}`, `concept-${tab}`);
      }
      // one rule page (who approved it, when, who depends on it)
      await page.goto(WEB + base + "/ledger", { waitUntil: "networkidle" });
      const rule = await page.locator('a[data-row-link][href*="/decisions/"]').first().getAttribute("href").catch(() => null);
      if (rule) await shot(rule.slice(base.length), "rule");
      if (errors.length) console.error("page errors:\n" + errors.join("\n"));
      await ctx.close();
    }
  }
  await browser.close();
  process.exit(0);
}
