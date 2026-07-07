import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { classify, scanCode, runScan, report, type CatalogEntry } from "./scan.js";
import { extractOutbound } from "./capture/outbound.js";

const catalog: CatalogEntry[] = [
  { surface: "http:GET /inventory/:sku", repoId: "r-inv", gitRemote: "github.com/acme/inventory" },
  { surface: "proto:billing.v1.Billing/Charge", repoId: "r-bill", gitRemote: "github.com/acme/billing" },
  { surface: "http:POST /own", repoId: "r-self", gitRemote: "github.com/acme/self" },
];

test("classify: exact catalog hit → matched consume with producer named", () => {
  const ob = extractOutbound("src/a.ts", `fetch("/inventory/42")`).map((o) => ({
    ...o,
    surface: "http:GET /inventory/:sku",
  }));
  const { consumes } = classify(ob, catalog, "r-self");
  assert.deepEqual(consumes, [{ surface: "http:GET /inventory/:sku", producer: "github.com/acme/inventory" }]);
});

test("classify: outbound call with no producer in the graph → unmatched", () => {
  const ob = extractOutbound("src/a.ts", `fetch("https://api.stripe.com/v1/charges")`);
  const { consumes, unmatched } = classify(ob, catalog, "r-self");
  assert.equal(consumes.length, 0);
  assert.deepEqual(unmatched, [{ ref: "https://api.stripe.com/v1/charges", via: "fetch" }]);
});

test("classify: service hint → review with candidate sibling surfaces", () => {
  const ob = extractOutbound("src/a.ts", `const c = new BillingServiceClient(addr)`);
  const { review } = classify(ob, catalog, "r-self");
  assert.equal(review.length, 1);
  assert.equal(review[0]!.hint, "billing");
  assert.deepEqual(
    review[0]!.candidates.map((c) => c.surface),
    ["proto:billing.v1.Billing/Charge"],
  );
});

test("classify: a repo never consumes its own produced surface", () => {
  const ob = [{ via: "fetch" as const, ref: "/own", surface: "http:POST /own" }];
  const { consumes, unmatched } = classify(ob, catalog, "r-self");
  assert.equal(consumes.length, 0, "own surface excluded from producers");
  assert.deepEqual(unmatched, [{ ref: "/own", via: "fetch" }]);
});

test("classify: matches param-insensitively, records the producer's canonical surface", () => {
  // Consumer calls `/inventory/${sku}` → :param; producer serves :sku. Same endpoint.
  const ob = extractOutbound("src/a.ts", "fetch(`/inventory/${sku}`)");
  const { consumes } = classify(ob, catalog, "r-self");
  assert.deepEqual(consumes, [{ surface: "http:GET /inventory/:sku", producer: "github.com/acme/inventory" }]);
});

test("report: connected proposal renders matched / review / unmatched sections", () => {
  const text = report({
    connected: true,
    produces: ["http:POST /orders"],
    consumes: [{ surface: "http:GET /inventory/:sku", producer: "github.com/acme/inventory" }],
    unmatched: [{ ref: "https://api.stripe.com/v1/charges", via: "fetch" }],
    review: [
      {
        ref: "BillingServiceClient",
        via: "grpc-client",
        hint: "billing",
        candidates: [{ surface: "proto:billing.v1.Billing/Charge", producer: "github.com/acme/billing" }],
      },
    ],
    newProduces: ["http:POST /orders"],
    newConsumes: ["http:GET /inventory/:sku"],
  });
  assert.match(text, /matched to the graph/);
  assert.match(text, /→ github\.com\/acme\/inventory/);
  assert.match(text, /needs review/);
  assert.match(text, /unmatched/);
});

test("scanCode: walks a real repo → produces (served) + outbound candidates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lockstep-scan-"));
  await mkdir(join(dir, "src", "routes"), { recursive: true });
  await writeFile(join(dir, "src", "routes", "orders.ts"), `router.post("/orders", create)`);
  await writeFile(join(dir, "src", "client.ts"), `fetch("/inventory/42")`);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "add", "-A"]);

  const { produces, outbound } = scanCode(dir);
  assert.deepEqual(produces, ["http:POST /orders"]);
  assert.deepEqual(
    outbound.map((o) => o.surface),
    ["http:GET /inventory/42"],
  );
});

test("runScan --apply (disconnected) writes produces to lockstep.yaml without syncing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lockstep-scan-apply-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "routes.ts"), `app.get("/health", h)`);
  execFileSync("git", ["-C", dir, "init", "-q"]); // no 'origin' remote → registerSession throws → disconnected

  const cwd = process.cwd();
  const logs: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => (logs.push(s), true);
  try {
    process.chdir(dir);
    await runScan({ json: true, apply: true });
  } finally {
    process.chdir(cwd);
    (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
  }

  const proposal = JSON.parse(logs.join(""));
  assert.equal(proposal.connected, false);
  assert.deepEqual(proposal.produces, ["http:GET /health"]);
  await access(join(dir, "lockstep.yaml"));
  const raw = await readFile(join(dir, "lockstep.yaml"), "utf8");
  assert.ok(raw.includes("http:GET /health"), "produces written even when disconnected");
});

test("runScan --apply (connected) resolves consumes against the catalog and syncs the graph", async () => {
  // Stub API: session register, catalog (GET /surfaces), and the two write endpoints.
  const posted: Record<string, unknown[]> = { "/surfaces": [], "/dependencies": [] };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (o: unknown) => res.end(JSON.stringify(o));
      res.setHeader("content-type", "application/json");
      if (req.url === "/sessions/register")
        return send({ sessionId: "s1", orgId: "o", projectId: "p", repoId: "r-web", memberId: "m" });
      if (req.url === "/surfaces" && req.method === "GET")
        return send({
          surfaces: [{ surface: "http:GET /inventory/:sku", repoId: "r-inv", gitRemote: "github.com/acme/inventory" }],
        });
      if (req.url === "/surfaces")
        return (posted["/surfaces"]!.push(JSON.parse(body || "{}")), send({ added: 1, total: 1 }));
      if (req.url === "/dependencies")
        return (posted["/dependencies"]!.push(JSON.parse(body || "{}")), send({ edgeId: "e1" }));
      res.statusCode = 404;
      send({ error: "nope" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const dir = await mkdtemp(join(tmpdir(), "lockstep-scan-conn-"));
  await mkdir(join(dir, "src", "routes"), { recursive: true });
  await writeFile(join(dir, "src", "routes", "orders.ts"), `app.post("/orders", h)`);
  await writeFile(join(dir, "src", "client.ts"), "fetch(`/inventory/${sku}`); fetch('https://api.stripe.com/pay')");
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:acme/web.git"]);

  const cwd = process.cwd();
  const logs: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => (logs.push(s), true);
  process.env.LOCKSTEP_API_URL = `http://127.0.0.1:${port}`;
  try {
    process.chdir(dir);
    await runScan({ json: true, apply: true });
  } finally {
    process.chdir(cwd);
    (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
    delete process.env.LOCKSTEP_API_URL;
    await new Promise<void>((r) => server.close(() => r()));
  }

  const proposal = JSON.parse(logs.join(""));
  assert.equal(proposal.connected, true);
  assert.deepEqual(proposal.consumes, [{ surface: "http:GET /inventory/:sku", producer: "github.com/acme/inventory" }]);
  assert.deepEqual(proposal.unmatched, [{ ref: "https://api.stripe.com/pay", via: "fetch" }]);
  assert.deepEqual(posted["/surfaces"], [{ surfaces: ["http:POST /orders"] }], "produces synced to catalog");
  assert.deepEqual(
    posted["/dependencies"],
    [{ producedSurface: "http:GET /inventory/:sku", source: "manifest" }],
    "matched consume registered",
  );
  const raw = await readFile(join(dir, "lockstep.yaml"), "utf8");
  assert.ok(raw.includes("http:POST /orders") && raw.includes("http:GET /inventory/:sku"));
});
