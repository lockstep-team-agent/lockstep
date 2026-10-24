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
    "Publish a change to the project's change feed so other teams' agents see it. Use for something that already changed or is about to; use ask to pose a question and propose_decision to record a rule. Optionally tied to a surface (for example http:POST /session) with a contract delta. Risk tier owned publishes immediately; shared and contract changes wait for confirmation. Changes with a surface are delivered to repos that declared a dependency on it. Returns the change id, publish state, delivered count and impact (number of consuming repos).", {
      summary: z.string().describe("One-sentence description of what changed, written for other teams' agents."),
      surface: z.string().optional().describe("Surface the change touches, for example http:POST /session. Repos that declared a dependency on it are notified."),
      contractDelta: z.any().optional().describe("Optional JSON describing the contract change (for example old and new request or response shape). Stored with the change as given."),
      riskTier: z.enum(["owned", "shared", "contract"]).optional().describe("owned (default) publishes immediately. shared and contract wait for confirmation before they are delivered."),
      verified: z.boolean().optional().describe("True if you checked the delta against running code or tests. Default false, recorded as asserted but unverified."),
      verifiedAgainst: z.string().optional().describe("What you verified against, for example a test name or commit. Only meaningful with verified."),
      diffHash: z.string().optional().describe("Optional hash of the diff this change describes, stored for traceability."),
      capabilityRef: z.string().optional().describe("Capability or feature reference to attach. Defaults to the one set with set_feature_context."),
    },
    async (a) => ok(await withSession((sid) => call("POST", "/changes", sid, { ...a, capabilityRef: a.capabilityRef ?? featureCtx ?? undefined }))),
  );
  server.tool("inbox", "List this session's unread inbox items: changes, questions, tasks, decisions and conflicts. Does not mark them read; use ack_inbox for that. Use query instead to search the ledger by topic, and decisions to list decisions.", {}, async () => ok(await withSession((sid) => call("GET", "/inbox", sid))));
  server.tool("ack_inbox", "Mark inbox items as read by id. With no ids, marks every unread item in this session's inbox. Returns the acknowledged count. This only clears inbox items; to respond to a decision use ack_decision, and to reply to a question use answer.", { itemIds: z.array(z.string()).optional().describe("Ids of the inbox items to mark read, as returned by inbox. Omit to mark every unread item.") }, async (a) =>
    ok(await withSession((sid) => call("POST", "/inbox/ack", sid, { itemIds: a.itemIds }))),
  );
  server.tool("query", "Search the project's decisions, changes and answered questions for a natural-language question. The optional scope boosts matching results in the ranking rather than filtering them. Returns rows; the calling agent writes the answer. Read-only, nothing is sent to anyone; use ask when the ledger has no answer and a teammate should respond.", { question: z.string().describe("Natural-language question to search for, for example \"how do we authenticate service calls?\"."), scope: z.string().optional().describe("Optional scope reference (for example a surface, repo or topic) whose matches should rank higher. It does not exclude other results.") }, async (a) =>
    ok(await withSession((sid) => call("POST", "/query", sid, a))),
  );
  server.tool(
    "ask",
    "Ask the project a question, optionally tied to a scope. It is delivered to the project's inboxes; urgent flags it. Returns the question id and status. Use for a question that needs a person or another team to reply; try query first, since it searches existing answers without notifying anyone. Replies are recorded with answer.", { question: z.string().describe("The question to send to the project, in full sentences with enough context to be answered on its own."), scope: z.string().optional().describe("Optional scope reference the question relates to, for example a surface like http:GET /orders/:id. It is recorded as a surface scope. Omit for a project-wide question."), urgent: z.boolean().optional().describe("True to flag the question as urgent in recipients' inboxes. Default false.") },
    async (a) => ok(await withSession((sid) => call("POST", "/questions", sid, a))),
  );
  server.tool("answer", "Answer a question from the project's inbox by its questionId. Records the response as an answer, marks the question answered and returns the answer id and status. Use ask to raise a question; answer is only for replying to one. Writes a permanent record; the call does not check that the question is still unanswered, so a second call adds another answer.", { questionId: z.string().describe("Id of the question to answer, as shown in the inbox item or returned by ask."), response: z.string().describe("The answer text, plain prose. Be specific; it is stored and shown to the asker as written.") }, async (a) =>
    ok(await withSession((sid) => call("POST", `/questions/${a.questionId}/answer`, sid, { response: a.response }))),
  );
  server.tool("delegate", "Create a task from a description, with optional refs. The required to value is the assignee's GitHub login; if no member matches, the task is created with no assignee. Returns the task id and run state. Creates an open task and notifies the assignee through their inbox. Use complete to close it later; use ask instead if you only need an answer.", { to: z.string().describe("GitHub login of the assignee, for example octocat. If no member has that login, the task is still created with no assignee."), task: z.string().describe("What needs doing, as a short title or sentence. Stored as the task title."), refs: z.any().optional().describe("Optional JSON with related references (for example decision ids, surfaces or PR links). Stored with the task as given.") }, async (a) =>
    ok(await withSession((sid) => call("POST", "/tasks", sid, a))),
  );
  server.tool("complete", "Mark a task closed by its taskId. The optional note is accepted but not currently stored. Sets the task to done and closed and returns the status; the call does not check who the assignee is. Use for a task created with delegate.", { taskId: z.string().describe("Id of the task to close, as returned by delegate or shown in the inbox."), note: z.string().optional().describe("Optional completion note. Currently accepted but not stored, so put anything important in notify or answer instead.") }, async (a) =>
    ok(await withSession((sid) => call("POST", `/tasks/${a.taskId}/complete`, sid, { note: a.note }))),
  );
  server.tool(
    "propose_decision",
    "Propose a decision (rule, architecture or principle) for a scope, with optional rationale, rejected alternatives and review date. Uses optimistic concurrency: baseVersion must equal the decision's current version (0 for a new decision), otherwise the call fails with a conflict. Owner-scoped decisions bind immediately; shared or cross-cutting ones stay open until acknowledged.", {
      scopeKind: z.string().describe("What kind of thing the decision is about. Kinds used by the ledger are surface, repo, topic, project, capability, shared and contract; the value is not validated here."),
      scopeRef: z.string().describe("Identifier within that kind, for example http:POST /session for a surface, a repo name, or a topic name."),
      ruleText: z.string().describe("The decision itself, stated as a clear rule others can follow."),
      baseVersion: z.number().describe("Current version of the decision for this scope, or 0 when proposing a new one. A stale value fails with a conflict; read decisions first to get it."),
      decisionType: z.enum(["rule", "architecture", "principle"]).optional().describe("Kind of decision. Defaults to rule when omitted."),
      capabilityRef: z.string().optional().describe("Capability or feature reference to attach. Defaults to the one set with set_feature_context."),
      rationale: z.string().optional().describe("Why, in one or two sentences (the ADR context)."),
      alternatives: z.array(z.string()).optional().describe("Options considered and rejected, one string each."),
      reviewAt: z.string().optional().describe("ISO date when the decision should be revisited, for example 2026-12-01. An invalid date is rejected."),
    },
    async (a) => ok(await withSession((sid) => call("POST", "/decisions", sid, { ...a, capabilityRef: a.capabilityRef ?? featureCtx ?? undefined }))),
  );
  server.tool(
    "ack_decision",
    "Acknowledge a decision version. An ack or approve verdict (default ack) moves an open decision to binding. Records your review in the audit trail either way and returns the decision status. Use for a decision proposed by someone else that is awaiting acknowledgement; use propose_decision to create or change one, and decisions to find ids and versions.", { decisionId: z.string().describe("Id of the decision, as returned by decisions or propose_decision."), version: z.number().describe("The decision version you are acknowledging, as shown by decisions."), verdict: z.string().optional().describe("Your verdict. ack (default) or approve binds an open decision; any other value is recorded but does not bind it.") },
    async (a) =>
      ok(await withSession((sid) => call("POST", `/decisions/${a.decisionId}/ack`, sid, { version: a.version, verdict: a.verdict }))),
  );
  server.tool(
    "register_dependency",
    "Declare that this repo consumes a surface (for example http:GET /orders/:id), so changes to that surface are delivered to this repo. producedRepoId optionally names the producing repo. Repeating the same declaration is harmless. Changes to a declared surface then reach this repo through notify and its inbox. Use consumers to see who depends on a surface.", { producedSurface: z.string().describe("Surface this repo depends on, for example http:GET /orders/:id."), producedRepoId: z.string().optional().describe("Optional id of the repo that produces the surface, when known.") },
    async (a) => ok(await withSession((sid) => call("POST", "/dependencies", sid, a))),
  );
  server.tool("decisions", "List the project's decisions, optionally filtered by scope. Read-only. Returns each decision with its id, scope, status (for example open or binding), version, rule text and review fields. Use query to search by topic instead, and check_decisions to test a diff against decisions.", { scope: z.string().optional().describe("Optional scope reference to match exactly, for example http:POST /session or a repo name. Omit to list every decision in the project.") }, async (a) =>
    ok(await withSession((sid) => call("GET", `/decisions${a.scope ? `?scope=${encodeURIComponent(a.scope)}` : ""}`, sid))),
  );
  server.tool("whoowns", "Return the owners of a file path from the repo's current ownership snapshot (CODEOWNERS). Empty when there is no snapshot or no match. Read-only. Use before asking or delegating to find the right person; use consumers for who depends on a surface.", { path: z.string().describe("Repo-relative file path, for example packages/api/src/routes/orders.ts.") }, async (a) =>
    ok(await withSession((sid) => call("GET", `/owners?path=${encodeURIComponent(a.path)}`, sid))),
  );
  server.tool("consumers", "List the repos that consume a surface, from the declared-dependency graph. Read-only. Only dependencies declared with register_dependency or found by scanning appear. Use before changing a surface to see who is affected; use whoowns for file owners.", { surface: z.string().describe("Surface to look up, for example http:GET /orders/:id.") }, async (a) =>
    ok(await withSession((sid) => call("GET", `/consumers?surface=${encodeURIComponent(a.surface)}`, sid))),
  );
  server.tool("get_product_context", "Return the full product constraints and governed surfaces for a capability, surface or text scope, plus project principles. Constraints are empty when the product layer is off for the project. Read-only. Use before building a feature to learn the product rules for it.", { scope: z.string().describe("Capability reference, surface or free-text scope to fetch constraints for.") }, async (a) =>
    ok(await withSession((sid) => call("GET", `/product-context?scope=${encodeURIComponent(a.scope)}`, sid))),
  );
  server.tool("set_feature_context", "Set the active capability reference for this session. Writes local state and a feature-context file for the checkout's git remote when one exists. Later notify and propose_decision calls use it unless they pass their own capabilityRef. Call it when starting work on a feature; it changes only local state and never contacts the server.", { capabilityRef: z.string().describe("Capability or feature reference to make active for this session.") }, async (a) => {
    featureCtx = a.capabilityRef;
    if (remote) writeFeatureContext(remote, a.capabilityRef);
    saveLocalState({ featureRef: a.capabilityRef });
    return ok({ ok: true, capabilityRef: a.capabilityRef });
  });
  server.tool("check_decisions", "Check the working-tree diff against accepted decisions. Returns status skipped unless hosted diff checks are enabled (lockstep checks on). The optional base is the git ref to diff against. Uploads the diff of tracked changes (untracked files are not uploaded) to the Lockstep server and returns the findings: possible contradictions with accepted decisions, each with file, line and the rule. Findings are advisory; use decisions to read the decisions themselves.", { base: z.string().optional().describe("Git ref to diff the working tree against, for example origin/main. Defaults to HEAD (uncommitted changes only).") }, async (a) => {
    if (!readLocalState().automaticChecks) return ok({ status: "skipped", message: "Hosted diff checks are not enabled. Ask the user to run lockstep checks on, or lockstep check --upload for a single check." });
    return ok(await performCheck({ base: a.base, session: await getSession(), featureRef: featureCtx ?? undefined }));
  });
  server.tool("session_briefing", "Return the continuity briefing for this session: what changed and what is binding, scoped to the current feature context when one is set. Read-only. Call at the start of a session or after being away; use inbox for unread items addressed to you and decisions for the full list.", {}, async () => ok(await withSession((sid) => call("GET", `/continuity${featureCtx ? `?featureRef=${encodeURIComponent(featureCtx)}` : ""}`, sid))));
  // Local FS side effect (like set_feature_context): rewrites the generated decision-pack skill.
  server.tool("refresh_decision_pack", "Download the compiled decision pack and rewrite the generated local decision-pack skill in the working directory. Returns the pack hash, file path, whether the file changed and counts. Writes local files. Call when decisions may have changed and the local skill is stale; it does not change any decision on the server and takes no input.", {}, async () => {
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
  server.tool("sync_skills", "Sync managed organization skills into this checkout. Returns not_enrolled unless the checkout was enrolled with lockstep enroll. Installed or updated skills load from the next session. Writes local files in the checkout. Takes no input; use refresh_decision_pack for decisions instead of skills.", {}, async () => {
    const envId = readLocalState().environmentId;
    if (!envId) return ok({ status: "not_enrolled", message: "Ask the user to run `lockstep enroll` to receive org skills here." });
    const { syncSkills, formatSync } = await import("../standards/sync.js");
    const { httpApi } = await import("../standards/client.js");
    const r = await syncSkills(process.cwd(), httpApi(envId, (await getSession()).sessionId));
    return ok({ ...r, summary: formatSync(r, "session") || "Org skills are up to date.", note: "Installed or updated skills are available from the next session." });
  });

  await server.connect(new StdioServerTransport());
}
