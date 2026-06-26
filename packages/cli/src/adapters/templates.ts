import type { ManagedHook, McpServerSpec } from "./merge.js";

// Uses the globally-installed `lockstep` bin. (When the package is published to npm,
// an installer flag can switch these to `npx @lockstep/cli` for zero-install teammates.)
export const mcpSpec = (vendor: string): McpServerSpec => ({
  command: "lockstep",
  args: ["mcp"],
  env: { LOCKSTEP_VENDOR: vendor },
});

export const captureHooks: ManagedHook[] = [
  { event: "SessionStart", matcher: "*", args: ["capture", "--event", "SessionStart"], timeout: 20 },
  {
    event: "PostToolUse",
    matcher: "Edit|Write|MultiEdit|NotebookEdit",
    args: ["capture", "--event", "PostToolUse"],
    timeout: 30,
  },
  { event: "Stop", matcher: "*", args: ["capture", "--event", "Stop"], timeout: 45 },
];

export const SKILL_MD = `---
name: lockstep
description: Keep this repo's coding agents in lockstep — read the shared ledger before coding, publish changes after.
---

# Lockstep

This project uses Lockstep to coordinate multiple developers' coding agents on the same codebase.

## On session start
- Call \`inbox\` to see what changed, what's newly binding, and what's delegated to you.
- Call \`decisions\` to load the binding rules for the areas you'll touch.
- If you see open questions or tasks in the inbox, tell the user about them.

## Before coding a shared/contract surface
- Call \`query\` to check the ledger for existing decisions/contracts (answer instantly if known).
- Before changing or removing an endpoint/RPC, call \`consumers\` with its canonical surface ID
  (e.g. \`http:POST /auth/session\`) to see who depends on it — answer "does anyone use this?" from
  the graph instead of pinging a human. A high consumer count means high blast radius: log a decision.
- Respect any \`binding\` decision in scope.

## Decisions vs changes — the most important distinction
- A **change** is a routine event (you edited some files). It is captured automatically — you do NOT
  log it. Never call \`propose_decision\` just because you edited code.
- A **decision** is a durable **rule** or **architectural choice** that shapes future work
  (e.g. "auth tokens are JWT, 15-min expiry"; "we standardize on Postgres"; "rename POST /login to
  POST /session across the org"). These are the hero of Lockstep.
- **Whenever you (or the user) make a real decision like that, you MUST log it** with
  \`propose_decision\` — set \`decisionType\` to \`rule\` or \`architecture\`. If you're unsure whether
  something is a decision, ask: "will this constrain how others build later?" If yes, log it.

## After making a change
- Summarize the change and call \`notify\` (include a contract delta for interface changes).
- For any surface you call, record the dependency with \`register_dependency\`.

## Coordinating
- Use \`ask\` for code/repo questions (set \`urgent\` if you're blocked).
- Use \`delegate\` / \`complete\` for handoffs.

## Incoming messages
- When you see a "[Lockstep]" notification, inform the user about the pending message(s).
- The user decides whether to respond — don't auto-answer on their behalf.
`;

export const CLAUDE_BLOCK = `## Lockstep (team coordination)
IMPORTANT: On session start, BEFORE doing anything else, call \`inbox\` and \`decisions\`. If there are any open questions, tasks, or changes, you MUST tell the user immediately — do not skip this. Example: "You have 1 new question from a teammate: [question text]". Then proceed with the user's request.
Before coding a shared/contract surface, \`query\` the ledger and obey binding decisions. After a change, summarize it, \`register_dependency\` for surfaces you call, and \`notify\`. IMPORTANT: a routine code change is captured automatically — do NOT log it as a decision. But whenever you or the user make a durable **rule or architectural choice** that will constrain future work, you MUST record it with \`propose_decision\` (\`decisionType: rule | architecture\`). Ask code/repo questions with \`ask\` (urgent if blocking). When you see a "[Lockstep]" notification, inform the user about pending messages. See the \`lockstep\` skill for detail.`;
