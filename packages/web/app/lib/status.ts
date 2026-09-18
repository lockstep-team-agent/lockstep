export type Tone = "primary" | "success" | "warning" | "destructive" | "muted";
export interface StatusView {
  word: string;
  tone: Tone;
  dot: boolean;
}

const MAP: Record<string, StatusView> = {
  binding: { word: "binding", tone: "primary", dot: true },
  ratified: { word: "ratified", tone: "primary", dot: true },
  verified: { word: "verified", tone: "success", dot: true },
  answered: { word: "answered", tone: "success", dot: true },
  completed: { word: "completed", tone: "success", dot: true },
  done: { word: "completed", tone: "success", dot: true },
  active: { word: "active", tone: "success", dot: true },
  confirmed: { word: "confirmed", tone: "success", dot: true },
  enabled: { word: "enabled", tone: "success", dot: true },
  open: { word: "awaiting ack", tone: "warning", dot: true },
  proposed: { word: "proposed", tone: "warning", dot: true },
  queued: { word: "queued", tone: "warning", dot: true },
  running: { word: "running", tone: "warning", dot: true },
  pending: { word: "pending", tone: "warning", dot: true },
  review: { word: "in review", tone: "warning", dot: true },
  draft: { word: "draft", tone: "warning", dot: true },
  urgent: { word: "urgent", tone: "destructive", dot: true },
  conflict: { word: "conflict", tone: "destructive", dot: true },
  drift: { word: "drift", tone: "destructive", dot: true },
  due: { word: "due for review", tone: "destructive", dot: true },
  stale: { word: "stale", tone: "destructive", dot: true },
  expired: { word: "expired", tone: "destructive", dot: true },
  superseded: { word: "superseded", tone: "muted", dot: false },
  rejected: { word: "rejected", tone: "muted", dot: false },
  dismissed: { word: "dismissed", tone: "muted", dot: false },
  closed: { word: "closed", tone: "muted", dot: false },
  archived: { word: "archived", tone: "muted", dot: false },
  disabled: { word: "disabled", tone: "muted", dot: false },
  extracted: { word: "extracted", tone: "muted", dot: false },
  asserted: { word: "asserted", tone: "muted", dot: false },
  shared: { word: "shared", tone: "warning", dot: true },
  owned: { word: "owned", tone: "muted", dot: false },
  resolved_eng_revised: { word: "resolved · eng revised", tone: "success", dot: true },
  resolved_prd_amended: { word: "resolved · PRD amended", tone: "success", dot: true },
};

/**
 * The only status → (word, tone) mapping in the app (spec §3.3). A question's "open" is passed as
 * "open_question" because a decision's "open" means "awaiting ack". Unknown statuses render muted.
 */
export function statusView(status: string, ctx?: { origin?: string | null }): StatusView {
  if (status === "binding" && ctx?.origin === "document") return MAP.ratified!;
  if (status === "open_question") return { word: "open", tone: "warning", dot: true };
  return MAP[status] ?? { word: status.replace(/_/g, " "), tone: "muted", dot: false };
}

export const toneClass: Record<Tone, string> = {
  primary: "bg-primary-soft text-primary border-primary-edge",
  success: "bg-success-soft text-success border-success-edge",
  warning: "bg-warning-soft text-warning border-warning-edge",
  destructive: "bg-destructive-soft text-destructive border-destructive-edge",
  muted: "bg-muted text-muted-foreground border-border",
};
