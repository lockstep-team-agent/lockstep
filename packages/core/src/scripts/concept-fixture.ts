/**
 * Concept-ledger fixture: one generic project built through the real ledger services, so every
 * placement/queue hook runs exactly as in production.
 *
 *   tsx src/scripts/concept-fixture.ts --size demo      # ~300 surfaces, ~60 decisions (visual review)
 *   tsx src/scripts/concept-fixture.ts --size release   # 10k surfaces, 2k decisions (performance)
 *
 * The release size is deliberately SKEWED: one oversized concept (3k surfaces), one decision
 * referenced from ~200 concepts, one concept pair carrying 300 conflicts, and a long tail.
 * Classification uses a deterministic keyword classifier (labelled `fixture`), never a network
 * model. Prints { orgId, projectId, login, githubUserId } — sign in with dev-login as that user.
 */
import { sql } from "drizzle-orm";
import { withOrg, withSystem } from "../db/rls.js";
import {
  conflicts,
  graphEdges,
  graphNodes,
  members,
  orgs,
  principals,
  projectMembers,
  projects,
  questions,
  repos,
  sourceDocuments,
} from "../db/schema.js";
import { fileProposedDecision, proposeDecision, syncProducedSurfaces } from "../ledger/ledger-service.js";
import { drainConceptTasks, type Classifier } from "../concepts/queue.js";
import type { ChoiceInput } from "../concepts/classify.js";

const size = process.argv.includes("release") || process.argv.includes("--release") ? "release" : "demo";
const R = size === "release";
const stamp = Date.now().toString(36);
const one = <T>(r: T[]): T => r[0]!;

// deterministic PRNG so two runs build the same shape
let seed = 42;
const rand = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;

const RESOURCES: Record<string, string[]> = {
  identity: ["auth", "sessions", "tokens", "roles", "permissions", "sso", "mfa"],
  users: ["users", "accounts", "profiles", "teams", "invitations", "preferences"],
  payments: ["payments", "invoices", "refunds", "subscriptions", "plans", "payouts", "disputes", "taxes", "coupons"],
  content: ["products", "catalog", "inventory", "reviews", "media", "files", "categories", "search"],
  messaging: ["notifications", "emails", "messages", "threads", "webhooks", "sms"],
  data: ["reports", "analytics", "exports", "metrics", "events-log"],
  integrations: ["integrations", "apps", "connectors", "oauth-clients"],
  platform: ["health", "feature-flags", "jobs", "audit", "settings", "rate-limits"],
  commerce: ["orders", "carts", "checkout", "shipments", "addresses", "returns"],
};
const ALL = Object.values(RESOURCES).flat();
const DOMAIN_WORDS: Record<string, string[]> = {
  "Identity & Access": RESOURCES.identity!,
  "Users & Accounts": RESOURCES.users!,
  "Payments & Billing": [...RESOURCES.payments!, ...RESOURCES.commerce!, "Invoice", "Payment", "Order", "Cart"],
  "Content & Catalog": [...RESOURCES.content!, "Product"],
  "Messaging & Notifications": RESOURCES.messaging!,
  "Data & Analytics": RESOURCES.data!,
  Integrations: RESOURCES.integrations!,
  "Platform & Infra": RESOURCES.platform!,
};
const SUBS = ["items", "history", "status", "export", "preview", "summary", "settings", "events", "notes", "links"];
const VERBS = ["GET", "POST", "PATCH", "DELETE"];
const singular = (s: string) =>
  s
    .replace(/ies$/, "y")
    .replace(/(ss|sh|ch|x)es$/, "$1")
    .replace(/([^s])s$/, "$1");
const cap = (s: string) => {
  const w = singular(s).replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
  return w[0]!.toUpperCase() + w.slice(1);
};

function surfacesFor(
  repoIdx: number,
  n: number,
): Array<string | { surface: string; returnType: string; returnTypeKind: string }> {
  const out = new Set<string>();
  const meta: Array<{ surface: string; returnType: string; returnTypeKind: string }> = [];
  const own = ALL.filter((_, i) => i % 5 === repoIdx);
  let guard = 0;
  while (out.size + meta.length < n && guard++ < n * 20) {
    const r = pick(own);
    const k = rand();
    if (k < 0.72) {
      const v = pick(["/api/v1", "/api/v2", "/v1", ""]);
      const path = pick([
        `/${r}`,
        `/${r}/:id`,
        `/${r}/:id/${pick(SUBS)}`,
        `/me/${r}`,
        `/${r}/:id/${pick(SUBS)}/:subId`,
      ]);
      out.add(`http:${pick(VERBS)} ${v}${path}`);
    } else if (k < 0.84) {
      const root = rand() < 0.6 ? "Query" : "Mutation";
      const field =
        root === "Query"
          ? `${r.replace(/-/g, "")}${pick(["", "ById", "List", "Count"])}`
          : `${pick(["create", "update", "delete"])}${cap(r)}`;
      const s = `gql:${root}.${field}`;
      if (!meta.some((m) => m.surface === s)) {
        const count = field.endsWith("Count");
        meta.push({
          surface: s,
          returnType: count ? "Int!" : root === "Mutation" ? `${cap(field)}Payload` : `[${cap(r)}!]!`,
          returnTypeKind: count ? "scalar" : "object",
        });
      }
    } else if (k < 0.92) {
      out.add(`proto:${r.replace(/-/g, "")}.v1.${cap(r)}Service/${pick(["Get", "List", "Create", "Update", "Watch"])}`);
    } else if (k < 0.97) {
      out.add(`event:${r}.${pick(["created", "updated", "deleted", "failed", "completed"])}`);
    } else {
      out.add(`ws:/v1/${r}/${pick(["live", "stream", "presence"])}`);
    }
  }
  return [...out, ...meta];
}

/** Deterministic stand-in for Jev/Claude: keyword overlap between subject and option labels. */
const fixtureClassifier: Classifier = async (input: ChoiceInput) => {
  const text = JSON.stringify(input.subject).toLowerCase();
  let best = Object.keys(input.options)[0]!;
  let bestScore = -1;
  for (const [id, label] of Object.entries(input.options)) {
    const words =
      DOMAIN_WORDS[label] ??
      label
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((w) => w.length > 2);
    const score = words.filter((w) => text.includes(w.toLowerCase())).length;
    if (score > bestScore && id !== "__none__") {
      best = id;
      bestScore = score;
    }
  }
  return {
    ok: true,
    choice: best,
    confidence: bestScore > 0 ? 0.72 + Math.min(0.2, bestScore * 0.05) : 0.41,
    classifier: "fixture",
  };
};

async function main() {
  const t0 = Date.now();
  const githubUserId = 424242;
  const login = "fixture-owner";
  const { orgId, projectId, memberId, repoIds, team } = await withSystem(async (tx) => {
    const org = one(
      await tx
        .insert(orgs)
        .values({ name: `Fixture ${size} ${stamp}` })
        .returning(),
    );
    const existing = (
      await tx
        .select()
        .from(principals)
        .where(sql`github_user_id = ${githubUserId}`)
        .limit(1)
    )[0];
    const p = existing ?? one(await tx.insert(principals).values({ githubUserId, githubLogin: login }).returning());
    const m = one(
      await tx
        .insert(members)
        .values({ orgId: org.id, principalId: p.id, githubUserId, githubLogin: login })
        .returning(),
    );
    const proj = one(
      await tx
        .insert(projects)
        .values({
          orgId: org.id,
          name: size === "release" ? "Release fixture (10k)" : "Northwind Platform",
          createdBy: m.id,
          settings: { productLayer: { enabled: true } },
        })
        .returning(),
    );
    await tx.insert(projectMembers).values({
      orgId: org.id,
      projectId: proj.id,
      memberId: m.id,
      invitedGithubLogin: login,
      role: "owner",
      status: "active",
    });
    // teammates, so proposals carry real-looking authors
    const team: string[] = [];
    for (const [i, handle] of ["alice-chen", "bob-okafor", "priya-nair"].entries()) {
      const uidN = githubUserId + 1 + i;
      const tp =
        (
          await tx
            .select()
            .from(principals)
            .where(sql`github_user_id = ${uidN}`)
            .limit(1)
        )[0] ?? one(await tx.insert(principals).values({ githubUserId: uidN, githubLogin: handle }).returning());
      const tm = one(
        await tx
          .insert(members)
          .values({ orgId: org.id, principalId: tp.id, githubUserId: uidN, githubLogin: handle })
          .returning(),
      );
      await tx.insert(projectMembers).values({
        orgId: org.id,
        projectId: proj.id,
        memberId: tm.id,
        invitedGithubLogin: handle,
        role: i === 2 ? "pm" : "member",
        status: "active",
      });
      team.push(tm.id);
    }
    const names = ["core-api", "billing-service", "catalog-service", "web-app", "mobile-app"];
    const rs = [];
    for (const n of names)
      rs.push(
        one(
          await tx
            .insert(repos)
            .values({ orgId: org.id, projectId: proj.id, gitRemote: `github.com/northwind/${n}-${stamp}` })
            .returning(),
        ).id,
      );
    return { orgId: org.id, projectId: proj.id, memberId: m.id, repoIds: rs, team };
  });
  const ctx = (repoId: string) => ({ projectId, repoId, memberId });

  // ── surfaces (producers: the first 3 repos) ──
  const perRepo = R ? 2300 : 100;
  const produced: string[] = [];
  for (let i = 0; i < 3; i++) {
    const list = surfacesFor(i, perRepo);
    await syncProducedSurfaces(orgId, { ...ctx(repoIds[i]!), surfaces: list });
    produced.push(...list.map((s) => (typeof s === "string" ? s : s.surface)));
  }
  if (R) {
    // the oversized concept: 3k surfaces under /users
    const big = Array.from(
      { length: 3000 },
      (_, i) => `http:${VERBS[i % 4]} /api/v1/users/:id/${SUBS[i % SUBS.length]}-${Math.floor(i / 4)}`,
    );
    await syncProducedSurfaces(orgId, { ...ctx(repoIds[0]!), surfaces: big });
    produced.push(...big);
  }
  console.error(`[fixture] ${produced.length} surfaces in ${Date.now() - t0}ms`);

  // ── dependencies (consumers: web + mobile) — bulk, as a real graph would have many ──
  const depCount = R ? 20000 : 150;
  await withOrg(orgId, async (tx) => {
    const rows = [];
    const seen = new Set<string>(); // one edge per (consumer repo, surface), as registerDependency keeps it
    for (let i = 0; rows.length < Math.min(depCount, produced.length * 2) && i < depCount * 4; i++) {
      const consumer = repoIds[3 + (i % 2)]!;
      const surface = produced[Math.floor(rand() * produced.length)]!;
      if (seen.has(`${consumer} ${surface}`)) continue;
      seen.add(`${consumer} ${surface}`);
      rows.push({
        orgId,
        projectId,
        consumerRepoId: consumer,
        producedRepoId: null,
        producedSurface: surface,
        source: "inferred",
      });
    }
    for (let i = 0; i < rows.length; i += 1000)
      await tx.insert((await import("../db/schema.js")).dependencyEdges).values(rows.slice(i, i + 1000));
  });

  // ── capabilities: governs edges onto real surfaces ──
  const caps = R ? 40 : 4;
  const capRefs: string[] = [];
  await withOrg(orgId, async (tx) => {
    for (let c = 0; c < caps; c++) {
      const ref = `cap:feature-${c}`;
      capRefs.push(ref);
      const node = one(
        await tx
          .insert(graphNodes)
          .values({ orgId, projectId, kind: "capability", ref, label: `Feature ${c}` })
          .returning(),
      );
      const governed = c === 0 && R ? 200 : 3;
      for (let k = 0; k < governed; k++) {
        const s = produced[(c * 97 + k * 31) % produced.length]!;
        const sn = (
          await tx
            .insert(graphNodes)
            .values({ orgId, projectId, kind: "surface", ref: s })
            .onConflictDoUpdate({
              target: [graphNodes.projectId, graphNodes.kind, graphNodes.ref],
              set: { label: sql`graph_nodes.label` },
            })
            .returning()
        )[0]!;
        await tx
          .insert(graphEdges)
          .values({ orgId, projectId, fromId: node.id, toId: sn.id, kind: "governs", status: "confirmed" })
          .onConflictDoNothing();
      }
    }
  });

  // ── decisions ──
  const nDecisions = R ? 2000 : 60;
  const eng: Array<{ id: string; surface: string }> = [];
  const RATIONALES = [
    "Mobile clients time out on unbounded lists; the p99 payload was 4.2 MB last quarter.",
    "Two incidents in Q2 came from retried writes creating duplicates.",
    "Support can't correlate errors without a stable problem+json shape.",
    "Guests could enumerate records through sequential ids during the July pen test.",
    "Compliance asked for a change trail on anything customer-visible.",
    "Partners pin SDK versions for months; breaking changes cost us two integrations last year.",
  ];
  const ALTERNATIVES = [
    "Cursor pagination only for new endpoints",
    "Let each team choose its own error shape",
    "Idempotency on the server side via request hashing",
    "Opaque ids only for public endpoints",
    "Rely on database triggers for auditing",
    "Version the whole API instead of individual endpoints",
  ];
  const RULES = [
    "must paginate list responses at 50 items",
    "must return RFC 7807 problem+json errors",
    "must be idempotent on the client request id",
    "must not expose internal ids to guests",
    "must emit an audit event on every change",
    "must stay backwards compatible for two minor versions",
    "must reject requests without a tenant header",
    "must respond within 300ms p95",
  ];
  for (let i = 0; i < nDecisions; i++) {
    const k = rand();
    const surface = produced[(i * 7919) % produced.length]!; // distinct scopes: one decision per scope
    const scope =
      k < 0.6
        ? { scopeKind: "surface", scopeRef: surface }
        : k < 0.8
          ? { scopeKind: "topic", scopeRef: `topic:${pick(ALL)}-${i}` }
          : k < 0.85
            ? { scopeKind: "project", scopeRef: projectId }
            : k < 0.9
              ? { scopeKind: "topic", scopeRef: `topic:${pick(ALL)}-policy-${i}` }
              : { scopeKind: "capability", scopeRef: i === 0 && R ? capRefs[0]! : pick(capRefs) };
    const ruleText = `${scope.scopeKind === "surface" ? surface.replace(/^[a-z]+:/, "") : pick(ALL)} ${pick(RULES)} (#${i})`;
    try {
      const author = i % 4 === 0 ? memberId : team[i % team.length]!;
      const r = await proposeDecision(orgId, {
        ...scope,
        ...ctx(repoIds[0]!),
        memberId: author,
        ruleText,
        baseVersion: 0,
        rationale: pick(RATIONALES),
        alternatives: rand() < 0.6 ? [...new Set([pick(ALTERNATIVES), pick(ALTERNATIVES)])] : undefined,
      });
      if (scope.scopeKind === "surface") eng.push({ id: r.decisionId, surface });
      if (i % 9 === 0) {
        await proposeDecision(orgId, {
          ...scope,
          ...ctx(repoIds[0]!),
          ruleText: `${ruleText} — revised`,
          baseVersion: r.version,
        });
      }
    } catch {
      /* same scope twice → CAS conflict; skip */
    }
  }
  console.error(`[fixture] decisions done in ${Date.now() - t0}ms`);

  // ── product constraints (origin=document) + conflicts ──
  const nConstraints = R ? 700 : 12;
  const docs = await withOrg(orgId, async (tx) => {
    const out: Array<{ id: string; title: string; url: string }> = [];
    const titles = [
      "PRD: Checkout v2",
      "PRD: Identity & SSO",
      "Spec: Reporting & exports",
      "PRD: Notifications revamp",
    ];
    for (const [i, title] of titles.entries()) {
      const url = `https://www.notion.so/northwind/${title.replace(/[^a-z0-9]+/gi, "-")}-${stamp}${i}`;
      const d = one(
        await tx
          .insert(sourceDocuments)
          .values({
            orgId,
            projectId,
            tool: "notion",
            externalId: `doc-${stamp}-${i}`,
            title,
            url,
            state: "active",
            registeredBy: team[2],
          })
          .returning(),
      );
      out.push({ id: d.id, title, url });
    }
    return out;
  });
  const SECTIONS = ["Requirements", "Constraints", "Out of scope", "Launch criteria", "Privacy"];
  const constraintIds: Array<{ id: string; surface: string }> = [];
  for (let i = 0; i < nConstraints; i++) {
    const target =
      i < 300 && R
        ? (eng.filter((e) => e.surface.includes("/orders"))[i % 20] ?? eng[i % eng.length]!)
        : eng[i % eng.length]!;
    const surface = i < 300 && R ? (produced.find((s) => s.includes("/payments")) ?? target.surface) : target.surface;
    const r = await fileProposedDecision(
      orgId,
      {
        projectId,
        scopeKind: "surface",
        scopeRef: surface,
        ruleText: `Product: ${surface.replace(/^[a-z]+:/, "")} ${pick(["requires explicit consent", "is limited to paid plans", "must show a receipt", "is out of scope for v1"])} (#${i})`,
        provenance: {
          source: "notion",
          documentId: docs[i % docs.length]!.id,
          url: docs[i % docs.length]!.url,
          evidence: [
            {
              quote: `${surface.replace(/^[a-z]+:/, "")} ${pick(["must ask the customer before it runs", "is only available on paid plans", "has to show a receipt", "is not part of the first release"])}.`,
            },
          ],
          extractorModel: "claude-sonnet-4-6",
          decidedBy: "@priya-nair",
        },
        anchor: {
          type: "notion_block",
          pageId: docs[i % docs.length]!.id,
          headingPath: [docs[i % docs.length]!.title, pick(SECTIONS)],
          snippet: "",
        },
        rationale: pick(RATIONALES),
        connectionId: "00000000-0000-0000-0000-000000000000",
        externalId: `fixture-${stamp}-${i}`,
        contentHash: `h-${stamp}-${i}`,
        origin: "document",
        constraintKind: pick(["behavioral", "launch_gate", "scope_exclusion"]),
        confidence: 80,
      },
      async () => null,
      async () => null,
    );
    constraintIds.push({ id: r.decisionId, surface });
    await withOrg(orgId, (tx) =>
      tx
        .insert(conflicts)
        .values({
          orgId,
          projectId,
          constraintDecisionId: r.decisionId,
          engDecisionId: target.id,
          surface,
          kind: rand() < 0.5 ? "drift" : "pre_approval",
          status: "open",
        })
        .onConflictDoNothing(),
    );
  }

  // rules distilled from team conversations, awaiting a human confirm
  for (let i = 0; i < (R ? 120 : 8); i++) {
    const surface = produced[(i * 104729 + 17) % produced.length]!;
    const path = surface.replace(/^[a-z]+:/, "");
    await fileProposedDecision(
      orgId,
      {
        projectId,
        scopeKind: "surface",
        scopeRef: surface,
        ruleText: `${path} ${pick(RULES)} (thread #${i})`,
        provenance: {
          source: "slack",
          url: `https://northwind.slack.com/archives/C0${(i % 7) + 1}PLATFORM/p17${stamp}${i}`,
          evidence: [
            {
              quote: `Can we agree ${path} ${pick(RULES).replace(/^must /, "should ")}? We got bitten by this again yesterday.`,
            },
            {
              quote: pick([
                "+1, let's make it the rule.",
                "Agreed — writing it down so the agents pick it up.",
                "Yes, as long as the old behaviour stays behind a flag for a sprint.",
              ]),
            },
          ],
          extractorModel: "claude-sonnet-4-6",
          decidedBy: pick(["@alice-chen", "@bob-okafor", "@priya-nair"]),
        },
        connectionId: "00000000-0000-0000-0000-000000000001",
        externalId: `slack-${stamp}-${i}`,
        contentHash: `s-${stamp}-${i}`,
        confidence: 60 + Math.floor(rand() * 35),
        rationale: pick(RATIONALES),
      },
      async () => null,
      async () => null,
    ).catch(() => undefined);
  }

  await withOrg(orgId, async (tx) => {
    for (let i = 0; i < (R ? 40 : 4); i++) {
      await tx.insert(questions).values({
        orgId,
        projectId,
        scopeKind: "project",
        body: `Who owns ${pick(ALL)} after the migration? (#${i})`,
        urgent: i % 3 === 0,
        askedBy: memberId,
      });
    }
  });
  console.error(`[fixture] product layer done in ${Date.now() - t0}ms; draining classification…`);

  // ── classification with the deterministic stand-in ──
  for (let round = 0; round < 5000; round++) {
    await withSystem((tx) =>
      tx.execute(
        sql`UPDATE concept_tasks SET next_attempt_at = now() WHERE project_id = ${projectId} AND state = 'queued'`,
      ),
    );
    const r = await drainConceptTasks({
      projectId,
      classify: fixtureClassifier,
      keys: { jev: "fixture" },
      batch: 200,
      perProject: 200,
    });
    if (r.claimed === 0) break;
  }
  console.error(`[fixture] ready in ${Date.now() - t0}ms`);
  console.log(JSON.stringify({ size, orgId, projectId, login, githubUserId }));
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
