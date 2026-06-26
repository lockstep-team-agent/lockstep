import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerSession } from "./session.js";
import { call } from "./api.js";

/**
 * The per-session MCP server (one process per agent session). Registers the session,
 * then exposes the 12 tools as thin proxies to the core API. The core stays LLM-free —
 * query() returns rows; the agent synthesizes. Identical across vendors (the seam).
 */
export async function runMcpServer(): Promise<void> {
  const vendor = process.env.LOCKSTEP_VENDOR ?? "unknown";
  const session = await registerSession(vendor); // stderr-safe: throws to caller on failure
  const sid = session.sessionId;
  const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

  const server = new McpServer({ name: "lockstep", version: "0.0.1" });

  server.tool(
    "notify",
    {
      summary: z.string(),
      surface: z.string().optional(),
      contractDelta: z.any().optional(),
      riskTier: z.enum(["owned", "shared", "contract"]).optional(),
      verified: z.boolean().optional(),
      verifiedAgainst: z.string().optional(),
      diffHash: z.string().optional(),
    },
    async (a) => ok(await call("POST", "/changes", sid, a)),
  );
  server.tool("inbox", {}, async () => ok(await call("GET", "/inbox", sid)));
  server.tool("ack_inbox", { itemIds: z.array(z.string()).optional() }, async (a) =>
    ok(await call("POST", "/inbox/ack", sid, { itemIds: a.itemIds })),
  );
  server.tool("query", { question: z.string(), scope: z.string().optional() }, async (a) =>
    ok(await call("POST", "/query", sid, a)),
  );
  server.tool(
    "ask",
    { question: z.string(), scope: z.string().optional(), urgent: z.boolean().optional() },
    async (a) => ok(await call("POST", "/questions", sid, a)),
  );
  server.tool("answer", { questionId: z.string(), response: z.string() }, async (a) =>
    ok(await call("POST", `/questions/${a.questionId}/answer`, sid, { response: a.response })),
  );
  server.tool("delegate", { to: z.string(), task: z.string(), refs: z.any().optional() }, async (a) =>
    ok(await call("POST", "/tasks", sid, a)),
  );
  server.tool("complete", { taskId: z.string(), note: z.string().optional() }, async (a) =>
    ok(await call("POST", `/tasks/${a.taskId}/complete`, sid, { note: a.note })),
  );
  server.tool(
    "propose_decision",
    {
      scopeKind: z.string(),
      scopeRef: z.string(),
      ruleText: z.string(),
      baseVersion: z.number(),
      decisionType: z.enum(["rule", "architecture"]).optional(),
    },
    async (a) => ok(await call("POST", "/decisions", sid, a)),
  );
  server.tool(
    "ack_decision",
    { decisionId: z.string(), version: z.number(), verdict: z.string().optional() },
    async (a) =>
      ok(await call("POST", `/decisions/${a.decisionId}/ack`, sid, { version: a.version, verdict: a.verdict })),
  );
  server.tool(
    "register_dependency",
    { producedSurface: z.string(), producedRepoId: z.string().optional() },
    async (a) => ok(await call("POST", "/dependencies", sid, a)),
  );
  server.tool("decisions", { scope: z.string().optional() }, async (a) =>
    ok(await call("GET", `/decisions${a.scope ? `?scope=${encodeURIComponent(a.scope)}` : ""}`, sid)),
  );
  server.tool("whoowns", { path: z.string() }, async (a) =>
    ok(await call("GET", `/owners?path=${encodeURIComponent(a.path)}`, sid)),
  );
  server.tool("consumers", { surface: z.string() }, async (a) =>
    ok(await call("GET", `/consumers?surface=${encodeURIComponent(a.surface)}`, sid)),
  );

  await server.connect(new StdioServerTransport());
}
