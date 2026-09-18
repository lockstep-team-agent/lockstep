#!/usr/bin/env node
/**
 * Seed a realistic two-team project into a local core (dev-login mode) for visual review.
 *
 *   LOCKSTEP_API_URL=http://localhost:8080 node e2e/seed.mjs            # populated project
 *   node e2e/seed.mjs --empty                                           # a fresh org with one empty project
 *
 * Prints JSON: { orgId, projectId, token } — feed it to e2e/shots.mjs. Requires core started with
 * LOCKSTEP_DEV_LOGIN=1 and NODE_ENV=development.
 */
const API = (process.env.LOCKSTEP_API_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const empty = process.argv.includes("--empty");
const stamp = Date.now().toString(36);

async function call(method, path, body, token, sid) {
  const res = await fetch(API + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(sid ? { "x-lockstep-session": sid } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(j)}`);
  return j;
}
const login = async (id, handle) =>
  (await call("POST", "/auth/dev-login", { githubUserId: id, githubLogin: handle })).token;
const idOf = (o) => o.id ?? o.orgId ?? o.projectId ?? o.org?.id ?? o.project?.id;

const alice = await login(1001, "alice-chen");
const org = await call("POST", "/orgs", { name: empty ? `Empty Org ${stamp}` : "Acme Commerce" }, alice);
const orgId = idOf(org);
const proj = await call(
  "POST",
  `/orgs/${orgId}/projects`,
  { name: empty ? "New Project" : "Checkout Platform" },
  alice,
);
const projectId = idOf(proj);

if (empty) {
  console.log(JSON.stringify({ orgId, projectId, token: alice }));
  process.exit(0);
}

const remotes = {
  api: `https://github.com/acme/checkout-api-${stamp}`,
  app: `https://github.com/acme/mobile-app-${stamp}`,
  billing: `https://github.com/acme/billing-service-${stamp}`,
};
for (const r of Object.values(remotes))
  await call("POST", `/orgs/${orgId}/projects/${projectId}/repos`, { gitRemote: r }, alice);
await call("POST", `/orgs/${orgId}/projects/${projectId}/invite`, { githubLogin: "bob-okafor" }, alice);
await call(
  "POST",
  `/orgs/${orgId}/projects/${projectId}/invite`,
  { githubLogin: "priya-nair", role: "pm" },
  alice,
).catch(() => {});
const bob = await login(1002, "bob-okafor");
const priya = await login(1003, "priya-nair");

const session = async (tok, remote, vendor) =>
  (await call("POST", "/sessions/register", { gitRemote: remote, vendor }, tok)).sessionId;
const sA = await session(alice, remotes.api, "claude-code");
const sB = await session(bob, remotes.app, "claude-code");
const sC = await session(priya, remotes.billing, "codex");

await call(
  "POST",
  "/surfaces",
  {
    surfaces: [
      "http:POST /auth/session",
      "http:POST /auth/refresh",
      "http:POST /checkout",
      "http:GET /orders",
      "http:GET /orders/:id",
      "http:POST /refunds",
      "http:GET /search",
    ],
  },
  alice,
  sA,
);
await call(
  "POST",
  "/surfaces",
  {
    surfaces: [
      "proto:billing.v1.Billing/Charge",
      "proto:billing.v1.Billing/Webhook",
      "proto:billing.v1.Billing/Refund",
    ],
  },
  priya,
  sC,
);
for (const s of [
  "http:POST /auth/session",
  "http:POST /auth/refresh",
  "http:POST /checkout",
  "http:GET /orders",
  "http:GET /search",
]) {
  await call("POST", "/dependencies", { producedSurface: s, source: "lockstep.yaml" }, bob, sB);
}
for (const s of ["proto:billing.v1.Billing/Charge", "http:POST /refunds"]) {
  await call("POST", "/dependencies", { producedSurface: s, source: "lockstep.yaml" }, alice, sA);
}

const d = (body, tok = alice, sid = sA) => call("POST", "/decisions", { baseVersion: 0, ...body }, tok, sid);
const dec = [];
dec.push(
  await d({
    scopeKind: "surface",
    scopeRef: "http:POST /auth/session",
    ruleText: "Auth tokens are JWT with a 15-minute expiry; refresh via POST /auth/refresh.",
    decisionType: "architecture",
    rationale: "Stateless validation across 9 services; opaque tokens would add a DB round-trip per request.",
    alternatives: ["Opaque server-side sessions", "JWT with 24h expiry"],
  }),
);
dec.push(
  await d({
    scopeKind: "surface",
    scopeRef: "http:POST /checkout",
    ruleText: "Guests can complete checkout without creating an account.",
    decisionType: "rule",
    rationale: "62% of Q2 cart abandonments happened on the account-creation step.",
  }),
);
dec.push(
  await d({
    scopeKind: "surface",
    scopeRef: "http:POST /refunds",
    ruleText: "Refunds are issued to the original payment method only; store credit is never substituted.",
    decisionType: "rule",
  }),
);
dec.push(
  await d({
    scopeKind: "topic",
    scopeRef: "topic:error-format",
    ruleText: "All new HTTP endpoints return RFC 7807 problem+json for errors.",
    decisionType: "rule",
    rationale: "Mobile team asked for a stable error shape.",
    alternatives: ["Keep custom {error: string}"],
  }),
);
dec.push(
  await d({
    scopeKind: "topic",
    scopeRef: "topic:observability",
    ruleText: "Every service emits OpenTelemetry traces with the shared propagation headers.",
    decisionType: "principle",
  }),
);
dec.push(
  await d(
    {
      scopeKind: "surface",
      scopeRef: "proto:billing.v1.Billing/Webhook",
      ruleText: "Payment webhook handlers are idempotent on (provider, event_id); handlers upsert, never insert.",
      decisionType: "rule",
      rationale: "Retry storm in the July outage double-charged 41 orders.",
      reviewAt: new Date(Date.now() - 86400000).toISOString(),
    },
    priya,
    sC,
  ),
);
dec.push(
  await d({
    scopeKind: "surface",
    scopeRef: "http:GET /search",
    ruleText: "Search never returns out-of-stock items to guest users.",
    decisionType: "rule",
  }),
);
dec.push(
  await d(
    {
      scopeKind: "topic",
      scopeRef: "topic:retries",
      ruleText: "All outbound HTTP clients use exponential backoff with jitter, max 5 attempts.",
      decisionType: "rule",
    },
    bob,
    sB,
  ),
);
for (const x of dec.slice(0, 2)) {
  if (x.status !== "binding")
    await call("POST", `/decisions/${x.decisionId}/ack`, { version: x.version, verdict: "ack" }, bob, sB).catch(
      () => {},
    );
}

await call(
  "POST",
  "/changes",
  {
    summary: "Renamed POST /login → POST /auth/session; old route returns 410",
    surface: "http:POST /auth/session",
    riskTier: "shared",
    verified: true,
    verifiedAgainst: "git-diff",
  },
  alice,
  sA,
);
await call(
  "POST",
  "/changes",
  {
    summary: "Added optional `currency` to Charge request",
    surface: "proto:billing.v1.Billing/Charge",
    riskTier: "shared",
    verified: true,
    verifiedAgainst: "git-diff",
  },
  priya,
  sC,
);
await call(
  "POST",
  "/changes",
  { summary: "Paginated GET /orders at 50 per page", surface: "http:GET /orders", riskTier: "shared" },
  alice,
  sA,
);
await call("POST", "/changes", { summary: "Refactored cart pricing helpers", riskTier: "owned" }, alice, sA);
await call(
  "POST",
  "/changes",
  { summary: "Order history screen now uses GET /orders/:id", surface: "http:GET /orders/:id", riskTier: "shared" },
  bob,
  sB,
);

const q1 = await call(
  "POST",
  "/questions",
  {
    question: "Does anyone still call GET /orders without pagination params? Planning to make `page` required.",
    scope: "http:GET /orders",
    urgent: false,
  },
  alice,
  sA,
);
await call(
  "POST",
  "/questions",
  {
    question: "Is Apple Pay in scope for guest checkout in v1? Finance is checking fees.",
    scope: "http:POST /checkout",
    urgent: true,
  },
  bob,
  sB,
);
await call(
  "POST",
  `/questions/${q1.questionId ?? q1.id}/answer`,
  { response: "Mobile passes page + limit since 2.3.0. Web admin does not — I'll fix it this week." },
  bob,
  sB,
).catch(() => {});
await call(
  "POST",
  "/tasks",
  {
    to: "bob-okafor",
    task: "Migrate mobile-app to POST /auth/session before the 410 lands",
    refs: { surface: "http:POST /auth/session" },
  },
  alice,
  sA,
);
await call(
  "POST",
  "/tasks",
  { to: "alice-chen", task: "Add `currency` to the checkout → billing Charge call" },
  priya,
  sC,
);
await call(
  "POST",
  "/tasks",
  { to: "priya-nair", task: "Document webhook idempotency in the billing runbook" },
  alice,
  sA,
);

console.log(JSON.stringify({ orgId, projectId, token: alice }));
