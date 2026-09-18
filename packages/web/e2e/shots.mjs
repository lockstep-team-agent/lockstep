#!/usr/bin/env node
/**
 * Screenshot every dashboard route for visual review (not pixel-diffed).
 *
 *   node e2e/shots.mjs '<seed json>' [--label populated] [--widths 1440,1024]
 *
 * Pass the JSON printed by e2e/seed.mjs. Output: e2e/out/<label>/<width>/<route>.png
 * Env: LOCKSTEP_WEB_URL (default http://localhost:3000).
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
