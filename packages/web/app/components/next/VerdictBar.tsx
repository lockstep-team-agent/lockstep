"use client";
import { useState } from "react";
import { FileText, MessagesSquare } from "lucide-react";
import { VerdictButton } from "./VerdictButton";
import { btn } from "./bits";

export interface VerdictSpec {
  op: string;
  label: string;
  kind?: keyof typeof btn;
  extra?: Record<string, string>;
  disabled?: boolean;
}

/**
 * The verdict row: buttons plus an optional note. When the decision has an external source, the
 * verdict (and the note) is posted back there — the row says exactly where before you click.
 */
export function VerdictBar({
  orgId,
  projectId,
  decisionId,
  actions,
  blocked,
  target,
  history,
}: {
  orgId: string;
  projectId: string;
  decisionId: string;
  actions: VerdictSpec[];
  blocked?: string | null;
  target: { tool: string; label: string } | null;
  history: Array<{ tool: string; verdict: string; status: string; postedAt: string | null }>;
}) {
  const [note, setNote] = useState("");
  const noted = ["ratify", "confirm", "reject"];
  const Icon = target?.tool === "slack" ? MessagesSquare : FileText;
  if (actions.length === 0 && history.length === 0) return null;
  return (
    <div className="space-y-2">
      {actions.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {actions.map((a) =>
              a.disabled ? (
                <button key={a.op} type="button" disabled className={btn[a.kind ?? "outline"]}>
                  {a.label}
                </button>
              ) : (
                <VerdictButton
                  key={a.op}
                  orgId={orgId}
                  projectId={projectId}
                  id={decisionId}
                  op={a.op}
                  label={a.label}
                  kind={a.kind}
                  extra={noted.includes(a.op) && note.trim() ? { ...a.extra, note } : a.extra}
                />
              ),
            )}
            {blocked && <span className="text-[12px] text-faint">{blocked}</span>}
          </div>
          {actions.some((a) => noted.includes(a.op) && !a.disabled) && (
            <div className="max-w-xl">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, 1000))}
                rows={2}
                placeholder={target ? "Add a note (optional) — posted with your decision" : "Add a note (optional)"}
                aria-label="Note for this decision"
                className="w-full resize-y rounded-md border bg-muted px-2.5 py-1.5 text-[12px] leading-5 outline-none placeholder:text-faint focus:border-border-strong focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-faint">
                {target ? (
                  <>
                    <Icon className="h-3 w-3" />
                    Your decision will be posted to {target.label}
                  </>
                ) : (
                  "No external source — the decision is recorded in Lockstep only."
                )}
              </div>
            </div>
          )}
        </>
      )}
      {history.length > 0 && (
        <ul className="space-y-0.5 text-[11px] text-faint">
          {history.map((h, i) => (
            <li key={i}>
              {h.verdict} → {h.tool === "slack" ? "Slack thread" : h.tool}:{" "}
              <span
                className={
                  h.status === "posted"
                    ? "text-primary-ink"
                    : h.status === "failed"
                      ? "text-destructive"
                      : "text-warning"
                }
              >
                {h.status === "posted"
                  ? "posted"
                  : h.status === "failed"
                    ? "couldn’t post (check the connection)"
                    : "queued — posts within ~5 minutes"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
