import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CLI_VERSION } from "../adapters/templates.js";
import { registerSession, type Session } from "./session.js";
import { call } from "./api.js";
import { gitRemote } from "./git.js";
import { writeFeatureContext } from "../capture/feature-context.js";
import { writeDecisionPack, packPath, decisionPackEndpoint, type PackResp } from "../pack.js";
import { performCheck } from "../check.js";
import { readLocalState, saveLocalState } from "../local-state.js";

/**
 * The per-session MCP server (one process per agent session). Registers the session,
 * then exposes the tools as thin proxies to the core API. The core stays LLM-free —
 * query() returns rows; the agent synthesizes. Identical across vendors (the seam).
 */
export async function runMcpServer(): Promise<void> {
  const vendor = process.env.LOCKSTEP_VENDOR ?? "unknown";
  // Start the stdio transport before authenticating so registries and clients can
  // discover tools without credentials. Register lazily on the first tool call.
  let sessionPromise: Promise<Session> | undefined;
  const getSession = (): Promise<Session> => {
    sessionPromise ??= registerSession(vendor);
    return sessionPromise;
  };
  const withSession = async <T>(
    fn: (sid: string) => Promise<T>,
  ): Promise<T> => fn((await getSession()).sessionId);
  let featureCtx: string | null = readLocalState().featureRef ?? null;
  const remote = gitRemote(process.cwd());
  const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

  const server = new McpServer({ name: "lockstep", version: CLI_VERSION });

  server.tool(
    "notify",
    "Record a change in the project's change feed, optionally tied to a surface (for example http:POST /session) with a contract delta. Risk tier owned publishes immediately; shared and contract changes wait for confirmation. Changes with a surface are delivered to repos that declared a dependency on it. Returns the change id, publish state, delivered count and impact (number of consuming repos).", {
      summary: z.string(),
      surface: z.string().optional(),
      contractDelta: z.any().optional(),
      riskTier: z.enum(["owned", "shared", "contract"]).optional(),
      verified: z.boolean().optional(),
      verifiedAgainst: z.string().optional(),
      diffHash: z.string().optional(),
      capabilityRef: z.string().optional(),
    },
    async (a) => ok(await withSession((sid) => call("POST", "/changes", sid, { ...a, capabilityRef: a.capabilityRef ?? featureCtx ?? undefined }))),
  );
  server.tool("inbox", "List this session's unread inbox items: changes, questions, tasks, decisions and conflicts. Does not mark them read; use ack_inbox for that.", {}, async () => ok(await withSession((sid) => call("GET", "/inbox", sid))));
  server.tool("ack_inbox", "Mark inbox items as read by id. With no ids, marks every unread item in this session's inbox. Returns the acknowledged count.", { itemIds: z.array(z.string()).optional() }, async (a) =>
    ok(await withSession((sid) => call("POST", "/inbox/ack", sid, { itemIds: a.itemIds }))),
  );
  server.tool("query", "Search the project's decisions, changes and answered questions for a natural-language question. The optional scope boosts matching results in the ranking rather than filtering them. Returns rows; the calling agent writes the answer.", { question: z.string(), scope: z.string().optional() }, async (a) =>
    ok(await withSession((sid) => call("POST", "/query", sid, a))),
  );
  server.tool(
    "ask",
    "Ask the project a question, optionally tied to a scope. It is delivered to the project's inboxes; urgent flags it. Returns the question id and status.", { question: z.string(), scope: z.string().optional(), urgent: z.boolean().optional() },
    async (a) => ok(await withSession((sid) => call("POST", "/questions", sid, a))),
  );
  server.tool("answer", "Answer a question by its questionId and record the response.", { questionId: z.string(), response: z.string() }, async (a) =>
    ok(await withSession((sid) => call("POST", `/questions/${a.questionId}/answer`, sid, { response: a.response }))),
  );
  server.tool("delegate", "Create a task from a description, with optional refs. The required to value is the assignee's GitHub login; if no member matches, the task is created with no assignee. Returns the task id and run state.", { to: z.string(), task: z.string(), refs: z.any().optional() }, async (a) =>
    ok(await withSession((sid) => call("POST", "/tasks", sid, a))),
  );
  server.tool("complete", "Mark a task closed by its taskId. The optional note is accepted but not currently stored.", { taskId: z.string(), note: z.string().optional() }, async (a) =>
    ok(await withSession((sid) => call("POST", `/tasks/${a.taskId}/complete`, sid, { note: a.note }))),
  );
  server.tool(
    "propose_decision",
    "Propose a decision (rule, architecture or principle) for a scope, with optional rationale, rejected alternatives and review date. Uses optimistic concurrency: baseVersion must equal the decision's current version (0 for a new decision), otherwise the call fails with a conflict. Owner-scoped decisions bind immediately; shared or cross-cutting ones stay open until acknowledged.", {
      scopeKind: z.string(),
      scopeRef: z.string(),
      ruleText: z.string(),
      baseVersion: z.number(),
      decisionType: z.enum(["rule", "architecture", "principle"]).optional(),
      capabilityRef: z.string().optional(),
      rationale: z.string().optional(), // the why, one or two sentences (ADR context)
      alternatives: z.array(z.string()).optional(), // options considered and rejected
      reviewAt: z.string().optional(), // ISO date — when this decision should be revisited
    },
    async (a) => ok(await withSession((sid) => call("POST", "/decisions", sid, { ...a, capabilityRef: a.capabilityRef ?? featureCtx ?? undefined }))),
  );
  server.tool(
    "ack_decision",
    "Acknowledge a decision version. An ack or approve verdict (default ack) moves an open decision to binding.", { decisionId: z.string(), version: z.number(), verdict: z.string().optional() },
    async (a) =>
      ok(await withSession((sid) => call("POST", `/decisions/${a.decisionId}/ack`, sid, { version: a.version, verdict: a.verdict }))),
  );
  server.tool(
    "register_dependency",
    "Declare that this repo consumes a surface (for example http:GET /orders/:id), so changes to that surface are delivered to this repo. producedRepoId optionally names the producing repo. Repeating the same declaration is harmless.", { producedSurface: z.string(), producedRepoId: z.string().optional() },
    async (a) => ok(await withSession((sid) => call("POST", "/dependencies", sid, a))),
  );
  server.tool("decisions", "List the project's decisions, optionally filtered by scope. Read-only.", { scope: z.string().optional() }, async (a) =>
    ok(await withSession((sid) => call("GET", `/decisions${a.scope ? `?scope=${encodeURIComponent(a.scope)}` : ""}`, sid))),
  );
  server.tool("whoowns", "Return the owners of a file path from the repo's current ownership snapshot (CODEOWNERS). Empty when there is no snapshot or no match. Read-only.", { path: z.string() }, async (a) =>
    ok(await withSession((sid) => call("GET", `/owners?path=${encodeURIComponent(a.path)}`, sid))),
  );
  server.tool("consumers", "List the repos that consume a surface, from the declared-dependency graph. Read-only.", { surface: z.string() }, async (a) =>
    ok(await withSession((sid) => call("GET", `/consumers?surface=${encodeURIComponent(a.surface)}`, sid))),
  );
  server.tool("get_product_context", "Return the full product constraints and governed surfaces for a capability, surface or text scope, plus project principles. Constraints are empty when the product layer is off for the project. Read-only.", { scope: z.string() }, async (a) =>
    ok(await withSession((sid) => call("GET", `/product-context?scope=${encodeURIComponent(a.scope)}`, sid))),
  );
  server.tool("set_feature_context", "Set the active capability reference for this session. Writes local state and a feature-context file for the checkout's git remote when one exists. Later notify and propose_decision calls use it unless they pass their own capabilityRef.", { capabilityRef: z.string() }, async (a) => {
    featureCtx = a.capabilityRef;
    if (remote) writeFeatureContext(remote, a.capabilityRef);
    saveLocalState({ featureRef: a.capabilityRef });
    return ok({ ok: true, capabilityRef: a.capabilityRef });
  });
  server.tool("check_decisions", "Check the working-tree diff against accepted decisions. Returns status skipped unless hosted diff checks are enabled (lockstep checks on). The optional base is the git ref to diff against.", { base: z.string().optional() }, async (a) => {
    if (!readLocalState().automaticChecks) return ok({ status: "skipped", message: "Hosted diff checks are not enabled. Ask the user to run lockstep checks on, or lockstep check --upload for a single check." });
    return ok(await performCheck({ base: a.base, session: await getSession(), featureRef: featureCtx ?? undefined }));
  });
  server.tool("session_briefing", "Return the continuity briefing for this session: what changed and what is binding, scoped to the current feature context when one is set. Read-only.", {}, async () => ok(await withSession((sid) => call("GET", `/continuity${featureCtx ? `?featureRef=${encodeURIComponent(featureCtx)}` : ""}`, sid))));
  // Local FS side effect (like set_feature_context): rewrites the generated decision-pack skill.
  server.tool("refresh_decision_pack", "Download the compiled decision pack and rewrite the generated local decision-pack skill in the working directory. Returns the pack hash, file path, whether the file changed and counts. Writes local files.", {}, async () => {
    const p = await withSession((sid) => call<PackResp>("GET", decisionPackEndpoint(), sid));
    const results = await writeDecisionPack(process.cwd(), p.markdown, false);
    return ok({
      packHash: p.packHash,
      path: packPath(process.cwd()),
      changed: results.some((r) => r.startsWith("wrote")),
      counts: p.counts,
    });
  });

  // Local FS side effect: sync this checkout's managed org skills. New files load next session.
  server.tool("sync_skills", "Sync managed organization skills into this checkout. Returns not_enrolled unless the checkout was enrolled with lockstep enroll. Installed or updated skills load from the next session. Writes local files.", {}, async () => {
    const envId = readLocalState().environmentId;
    if (!envId) return ok({ status: "not_enrolled", message: "Ask the user to run `lockstep enroll` to receive org skills here." });
    const { syncSkills, formatSync } = await import("../standards/sync.js");
    const { httpApi } = await import("../standards/client.js");
    const r = await syncSkills(process.cwd(), httpApi(envId, (await getSession()).sessionId));
    return ok({ ...r, summary: formatSync(r, "session") || "Org skills are up to date.", note: "Installed or updated skills are available from the next session." });
  });

  await server.connect(new StdioServerTransport());
}
