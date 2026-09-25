"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { verdictAction } from "@/next-actions";
import { btn } from "./bits";

/** A verdict button that never fails silently: pending state, then the refusal in plain words. */
export function VerdictButton({
  orgId,
  projectId,
  id,
  op,
  label,
  kind = "outline",
  extra,
}: {
  orgId: string;
  projectId: string;
  id: string;
  op: string;
  label: string;
  kind?: keyof typeof btn;
  extra?: Record<string, string>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex">
      <button
        type="button"
        disabled={pending}
        className={btn[kind]}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await verdictAction(orgId, projectId, id, op, extra);
            if (r.ok) router.refresh();
            else setError(r.error ?? "That didn’t work.");
          })
        }
      >
        {pending ? `${label}…` : label}
      </button>
      {/* fixed to the viewport: scroll panels and table rows can't clip it */}
      {error && (
        <span
          role="alert"
          className="fixed bottom-4 right-4 z-50 flex w-[360px] items-start gap-2 rounded-md border border-destructive-edge bg-raised px-3 py-2.5 text-[13px] leading-5 text-foreground shadow-[0_12px_32px_-8px_rgba(0,0,0,.55)]"
        >
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
          <span className="flex-1">
            <span className="block text-[11px] font-medium text-faint">{label} didn’t go through</span>
            {error}
          </span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-faint hover:text-foreground"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </span>
      )}
    </span>
  );
}
