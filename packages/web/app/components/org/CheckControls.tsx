"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { checkDocumentAction, decideExceptionAction, findingAction, requestExceptionAction } from "@/org-actions";
import { btn } from "@/components/next/bits";

const input = "h-7 rounded-md border bg-muted px-2 text-[12px] outline-none focus:border-border-strong";

function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.error ?? "Failed");
      after?.();
      router.refresh();
    });
  const alert = error ? (
    <span role="alert" className="text-[12px] text-destructive">
      {error}
    </span>
  ) : null;
  return { pending, act, alert };
}

/** Submit the latest saved revision of a Lockstep document. Hosted review is a per-submission choice. */
export function CheckDocumentForm({
  orgId,
  projectId,
  documents,
}: {
  orgId: string;
  projectId: string;
  documents: Array<{ id: string; title: string; latestVersion: number | null }>;
}) {
  const { pending, act, alert } = useAct();
  const [doc, setDoc] = useState(documents[0]?.id ?? "");
  const [hosted, setHosted] = useState(false);
  if (!documents.length)
    return (
      <p className="text-[12px] text-faint">
        No saved Lockstep documents in this project yet. Save a PRD in Lockstep, then check a revision here.
      </p>
    );
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={doc}
          onChange={(e) => setDoc(e.target.value)}
          aria-label="Document"
          className={`${input} max-w-xs`}
        >
          {documents.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
              {d.latestVersion ? ` · v${d.latestVersion}` : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={pending || !doc}
          className={btn.outline}
          onClick={() => act(() => checkDocumentAction(orgId, projectId, doc, hosted))}
        >
          Check this revision
        </button>
        {pending && <span className="text-[12px] text-faint">Checking…</span>}
        {alert}
      </div>
      <label className="flex items-start gap-2 text-[12px] text-muted-foreground">
        <input
          type="checkbox"
          checked={hosted}
          onChange={(e) => setHosted(e.target.checked)}
          className="mt-0.5 accent-[var(--primary)]"
        />
        <span>
          Also run rubric reviews for this submission — sends this revision’s text to the configured review provider.
          Section checks run in Lockstep without it.
        </span>
      </label>
    </div>
  );
}

/** Dismiss a finding (with rationale) or turn it into an exception request. */
export function FindingActions({
  orgId,
  projectId,
  checkId,
  findingKey,
  canRequest,
}: {
  orgId: string;
  projectId: string;
  checkId: string;
  findingKey: string;
  canRequest: boolean;
}) {
  const { pending, act, alert } = useAct();
  const [mode, setMode] = useState<null | "dismiss" | "exception_requested">(null);
  const [why, setWhy] = useState("");
  const [until, setUntil] = useState("");
  if (!mode)
    return (
      <span className="inline-flex gap-1">
        <button type="button" className={btn.ghost} onClick={() => setMode("dismiss")}>
          Dismiss
        </button>
        {canRequest && (
          <button type="button" className={btn.ghost} onClick={() => setMode("exception_requested")}>
            Request exception
          </button>
        )}
      </span>
    );
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1.5">
      <input
        value={why}
        onChange={(e) => setWhy(e.target.value)}
        placeholder={mode === "dismiss" ? "Why this isn’t an issue" : "Why an exception is needed"}
        aria-label="Rationale"
        className={`${input} w-72`}
      />
      {mode === "exception_requested" && (
        <input
          type="date"
          value={until}
          onChange={(e) => setUntil(e.target.value)}
          aria-label="Expires"
          className={input}
        />
      )}
      <button
        type="button"
        disabled={pending || !why.trim()}
        className={btn.outline}
        onClick={() =>
          act(
            () =>
              findingAction(
                orgId,
                projectId,
                checkId,
                findingKey,
                mode,
                why,
                until ? new Date(`${until}T23:59:59`).toISOString() : undefined,
              ),
            () => setMode(null),
          )
        }
      >
        {mode === "dismiss" ? "Dismiss" : "Request"}
      </button>
      <button type="button" className={btn.ghost} onClick={() => setMode(null)}>
        Cancel
      </button>
      {alert}
    </span>
  );
}

/** Request an exception to one requirement for this project. */
export function RequestException({
  orgId,
  projectId,
  versionId,
  requirementKey,
}: {
  orgId: string;
  projectId: string;
  versionId: string;
  requirementKey: string;
}) {
  const { pending, act, alert } = useAct();
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState("");
  const [until, setUntil] = useState("");
  const [done, setDone] = useState(false);
  if (done) return <span className="text-[11px] text-faint">Exception requested</span>;
  if (!open)
    return (
      <button type="button" className="text-[11px] text-faint hover:text-foreground" onClick={() => setOpen(true)}>
        Request exception
      </button>
    );
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1.5">
      <input
        value={why}
        onChange={(e) => setWhy(e.target.value)}
        placeholder="Why this project needs an exception"
        aria-label="Reason"
        className={`${input} w-72`}
      />
      <input
        type="date"
        value={until}
        onChange={(e) => setUntil(e.target.value)}
        aria-label="Expires"
        className={input}
      />
      <button
        type="button"
        disabled={pending || !why.trim()}
        className={btn.outline}
        onClick={() =>
          act(
            () =>
              requestExceptionAction(orgId, {
                target: "requirement",
                versionId,
                requirementKey,
                scope: { projectId },
                reason: why,
                expiresAt: until ? new Date(`${until}T23:59:59`).toISOString() : undefined,
              }),
            () => setDone(true),
          )
        }
      >
        Request
      </button>
      <button type="button" className={btn.ghost} onClick={() => setOpen(false)}>
        Cancel
      </button>
      {alert}
    </span>
  );
}

export function DecideException({ orgId, exceptionId }: { orgId: string; exceptionId: string }) {
  const { pending, act, alert } = useAct();
  const [note, setNote] = useState("");
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)"
        aria-label="Decision note"
        className={`${input} w-56`}
      />
      <button
        type="button"
        disabled={pending}
        className={btn.primary}
        onClick={() => act(() => decideExceptionAction(orgId, exceptionId, true, note))}
      >
        Approve
      </button>
      <button
        type="button"
        disabled={pending}
        className={btn.ghost}
        onClick={() => act(() => decideExceptionAction(orgId, exceptionId, false, note))}
      >
        Reject
      </button>
      {alert}
    </span>
  );
}
