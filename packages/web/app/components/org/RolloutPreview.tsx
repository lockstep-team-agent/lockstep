"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyRolloutAction, previewRolloutAction, type RolloutChange } from "@/org-actions";
import type { RolloutPreview } from "@/lib/org-data";
import { btn } from "@/components/next/bits";
import { When } from "@/components/When";
import { cn } from "@/lib/utils";

/** The impact of a change before it's applied: who gets what, what's blocked, who isn't enrolled. */
export function PreviewPanel({ p }: { p: RolloutPreview }) {
  const n = (x: number, one: string, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;
  return (
    <section aria-label="Impact preview" className="space-y-3 rounded-md border bg-muted/40 px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        <span className="text-[20px] font-semibold tabular-nums tracking-[-0.01em]">{p.environments.affected}</span>
        <span className="text-[12px] text-muted-foreground">
          of {n(p.environments.total, "enrolled environment")} change
        </span>
        <span className="text-[12px] text-muted-foreground">
          {p.totals.install} install · {p.totals.update} update · {p.totals.remove} remove
        </span>
      </div>
      {p.environments.notEnrolledMembers > 0 && (
        <p className="text-[12px] text-muted-foreground">
          {n(p.environments.notEnrolledMembers, "person", "people")} in scope haven’t enrolled a checkout yet — they
          aren’t counted as covered until they run <code className="font-mono text-[11px]">lockstep enroll</code>.
        </p>
      )}
      {p.environments.unsupported > 0 && (
        <p className="text-[12px] text-destructive">
          {n(p.environments.unsupported, "affected environment")} can’t install skills (unsupported adapter).
        </p>
      )}
      {(p.exceptionsNeedingReview ?? []).map((x) => (
        <p key={x.id} className="text-[12px] text-destructive">
          Exception on {x.item}
          {x.requirementKey ? ` (${x.requirementKey})` : ""} will stop applying — the content it covers changes. Review
          it after applying (“{x.reason}”).
        </p>
      ))}
      {p.blocked.map((b) => (
        <p key={b.name} className="text-[12px] text-destructive">
          Blocked: {b.name} would be assigned at v{b.versions.join(" and v")} in the same checkout. Nothing installs
          there until the overlap is resolved.
        </p>
      ))}
      {p.rows.length > 0 && (
        <ul className="max-h-64 divide-y overflow-y-auto rounded-md border bg-background text-[12px]">
          {p.rows.map((r) => (
            <li key={r.envId} className="flex flex-wrap items-baseline gap-x-3 px-3 py-1.5">
              <span className="font-medium">{r.login}</span>
              <span className="truncate font-mono text-[11px] text-faint">{r.repo ?? "workspace"}</span>
              <span className="text-faint">{r.adapter}</span>
              <span className="ml-auto text-muted-foreground">
                {r.changes
                  .map((c) => `${c.action} ${c.name}${c.from ? ` v${c.from}` : ""}${c.to ? ` → v${c.to}` : ""}`)
                  .join(" · ")}
                {r.blocked.length > 0 && <span className="text-destructive"> · blocked: {r.blocked.join(", ")}</span>}
              </span>
              <When at={r.lastContactAt} className="text-[11px] text-faint" />
            </li>
          ))}
        </ul>
      )}
      {p.truncated && <p className="text-[11px] text-faint">Showing the first {p.rows.length} environments.</p>}
      <p className="text-[11px] text-faint">{p.timing}</p>
    </section>
  );
}

/** A button that previews a change and applies it only after the impact has been shown. */
export function ChangeButton({
  orgId,
  change,
  label,
  confirm,
  variant = "outline",
  onApplied,
}: {
  orgId: string;
  change: RolloutChange;
  label: string;
  confirm: string;
  variant?: "outline" | "ghost" | "danger";
  onApplied?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [p, setP] = useState<RolloutPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={pending}
        className={btn[variant]}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await previewRolloutAction(orgId, change);
            if (r.ok) setP(r.data);
            else setError(r.error);
          })
        }
      >
        {label}
      </button>
      {error && (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      )}
      {p && (
        <div className="space-y-2">
          <PreviewPanel p={p} />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              className={cn(btn.primary)}
              onClick={() =>
                start(async () => {
                  const r = await applyRolloutAction(orgId, change, p!.basis);
                  if (!r.ok) return setError(r.error);
                  setP(null);
                  if (onApplied) router.push(onApplied);
                  else router.refresh();
                })
              }
            >
              {confirm}
            </button>
            <button type="button" className={btn.ghost} onClick={() => setP(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Withdraw a release (optionally naming a replacement); previewed like every other change. */
export function WithdrawControl({
  orgId,
  releaseId,
  others,
}: {
  orgId: string;
  releaseId: string;
  others: Array<{ id: string; name: string }>;
}) {
  const [rep, setRep] = useState("");
  const [reason, setReason] = useState("");
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why (shown in the audit log)"
          aria-label="Withdrawal reason"
          className="h-7 w-64 rounded-md border bg-muted px-2 text-[12px]"
        />
        <select
          value={rep}
          onChange={(e) => setRep(e.target.value)}
          aria-label="Replacement release"
          className="h-7 rounded-md border bg-muted px-2 text-[12px]"
        >
          <option value="">No replacement — remove it</option>
          {others.map((o) => (
            <option key={o.id} value={o.id}>
              Replace with {o.name}
            </option>
          ))}
        </select>
      </div>
      <ChangeButton
        key={`${rep}|${reason}`}
        orgId={orgId}
        change={{ kind: "withdraw", releaseId, replacementReleaseId: rep || null, reason }}
        label="Preview withdrawal"
        confirm="Withdraw release"
        variant="danger"
      />
    </div>
  );
}
