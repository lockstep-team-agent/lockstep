/**
 * Plain words for the dashboard. Usability rounds (docs/gtm/persona-interviews-2026-11.md) found
 * "Constraint holds", "Ratify", "Acknowledge", "Housekeeping", "impact 4" unreadable — every label a
 * person clicks lives here, with the one-line effect shown on hover.
 */
import type { InboxKind } from "./next-data";

export const KIND_WORD: Record<InboxKind, string> = {
  conflict: "Clash",
  proposal: "Suggested",
  ratification: "Approve?",
  question: "Question",
  task: "Task",
  review_due: "Recheck",
  placement: "Filing",
  check_finding: "Caught",
  exception_request: "Exception",
  rollout_failure: "Rollout",
};

export const KIND_TAB: Partial<Record<InboxKind, string>> = {
  conflict: "Clashes",
  proposal: "Suggested rules",
  ratification: "Approvals",
  question: "Questions",
  task: "Tasks",
  review_due: "Recheck",
  check_finding: "Caught in code",
  exception_request: "Exceptions",
};

/** Verdict ops → button label + what clicking it does. */
export const VERB: Record<string, { label: string; effect: string }> = {
  confirm: { label: "Make it a rule", effect: "Becomes a rule every agent session is briefed on." },
  reject: { label: "Not a rule", effect: "Discarded. Agents never see it. Kept in history." },
  ack: { label: "Agree", effect: "Records that you agree. Once the affected teams agree, it binds." },
  ratify: { label: "Approve", effect: "Approves this requirement. Agents are briefed on it from now on." },
  holds: { label: "Keep the rule", effect: "The rule stands; the conflicting change has to adapt." },
  dismiss: { label: "Not a clash", effect: "Closes this as a false alarm. Both rules stay as they are." },
  place: { label: "File it here", effect: "Files this under the suggested area." },
};

export const SEVERITY_WORD = ["Low priority", "Normal", "Important", "Blocking"] as const;

/** impact = number of services that consume the thing a rule governs. */
export function affects(n: number): string | null {
  return n > 0 ? `affects ${n} service${n === 1 ? "" : "s"}` : null;
}
