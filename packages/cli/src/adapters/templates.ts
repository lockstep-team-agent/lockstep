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
- Respect any \`binding\` decision in scope.

## After making a change
- Summarize the change and call \`notify\` (include a contract delta for interface changes).
- For any surface you call, record the dependency with \`register_dependency\`.

## Coordinating
- Use \`ask\` for code/repo questions (set \`urgent\` if you're blocked).
- Use \`delegate\` / \`complete\` for handoffs. Propose binding rules with \`propose_decision\`.

## Incoming messages
- When you see a "[Lockstep]" notification, inform the user about the pending message(s).
- The user decides whether to respond — don't auto-answer on their behalf.
`;

export const CLAUDE_BLOCK = `## Lockstep (team coordination)
On session start, read your \`inbox\` and current \`decisions\`. Tell the user about any open questions or tasks. Before coding a shared/contract surface, \`query\` the ledger and obey binding decisions. After a change, summarize it, \`register_dependency\` for surfaces you call, and \`notify\`. Ask code/repo questions with \`ask\` (urgent if blocking). When you see a "[Lockstep]" notification, inform the user about pending messages. See the \`lockstep\` skill for detail.`;
