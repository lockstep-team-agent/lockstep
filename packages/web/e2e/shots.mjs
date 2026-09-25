#!/usr/bin/env node
/**
 * Screenshot every dashboard route for visual review (not pixel-diffed).
 *
 *   node e2e/shots.mjs '<seed json>' [--label populated] [--widths 1440,1024]
 *
 * Pass the JSON printed by e2e/seed.mjs. Output: e2e/out/<label>/<width>/<route>.png
 * Env: LOCKSTEP_WEB_URL (default http://localhost:3000).
 *
 *   --new-ui   screenshot the concept-ledger shell (web started with LOCKSTEP_NEW_UI=1) in dark AND
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
const newUi = args.includes("--new-ui");
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
const routes = [
  "",
  "/review-queue",
  "/decisions",
  "/questions",
  "/tasks",
  "/contracts",
  "/dependencies",
  "/sources",
  "/features",
  "/graph",
  "/insights",
  "/search",
  "/connections",
  "/activity",
  "/members",
];

const browser = await chromium.launch();

if (newUi) {
  const NEW = ["/inbox", "/inbox?hk=1", "/map", "/map?view=graph", "/ledger", "/ledger?tab=contracts", "/settings"];
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
      for (const r of NEW) await shot(r, r.slice(1).replace(/[/?=&]+/g, "-"));
      // the first concept in the outline, on each tab
      await page.goto(WEB + base + "/map", { waitUntil: "networkidle" });
      const concept = await page.locator('[role="tree"] a[href*="concept="]').first().getAttribute("href").catch(() => null);
      if (concept) {
        const id = new URL(WEB + concept).searchParams.get("concept");
        for (const tab of ["decisions", "contracts", "sources"]) await shot(`/map?concept=${id}&tab=${tab}`, `concept-${tab}`);
      }
      if (errors.length) console.error("page errors:\n" + errors.join("\n"));
      await ctx.close();
    }
  }
  await browser.close();
  process.exit(0);
}

for (const width of widths) {
  const out = new URL(`./out/${label}/${width}/`, import.meta.url).pathname;
  mkdirSync(out, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  await ctx.addCookies([{ name: "lockstep_token", value: seed.token, domain: new URL(WEB).hostname, path: "/" }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
  for (const r of routes) {
    await page.goto(WEB + base + r, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    const name = (r || "/home").slice(1).replace(/\//g, "-");
    await page.screenshot({ path: `${out}${name}.png`, fullPage: true });
    console.log(`${label}/${width}/${name}.png`);
  }
  // One decision detail page, if any decision exists.
  await page.goto(WEB + base + "/decisions", { waitUntil: "networkidle" });
  const first = await page
    .locator(`a[href^="${base}/decisions/"]`)
    .first()
    .getAttribute("href")
    .catch(() => null);
  if (first) {
    await page.goto(WEB + first, { waitUntil: "networkidle" });
    await page.screenshot({ path: `${out}decision-detail.png`, fullPage: true });
    console.log(`${label}/${width}/decision-detail.png`);
  }
  await page.goto(WEB + "/", { waitUntil: "networkidle" });
  await page.screenshot({ path: `${out}workspace.png`, fullPage: true });
  await ctx.clearCookies();
  await page.goto(WEB + "/", { waitUntil: "networkidle" });
  await page.screenshot({ path: `${out}login.png`, fullPage: true });
  if (errors.length) console.error("page errors:\n" + errors.join("\n"));
  await ctx.close();
}
await browser.close();
