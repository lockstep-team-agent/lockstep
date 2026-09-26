import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Binding-rail class for a decision row: the product's signature state stripe. */
export function railFor(status: string | null | undefined, opts: { conflict?: boolean; drift?: boolean } = {}): string {
  if (opts.conflict) return "rail rail-conflict";
  if (opts.drift) return "rail rail-drift";
  switch (status) {
    case "binding":
      return "rail rail-binding";
    case "proposed":
    case "open":
    case "ack":
      return "rail rail-proposed";
    case "superseded":
    case "rejected":
    case "stale":
    case "expired":
      return "rail rail-superseded";
    default:
      return "rail rail-none";
  }
}

const TAG: Record<string, string> = {
  binding: "text-primary-ink",
  confirmed: "text-muted-foreground",
  proposed: "text-muted-foreground",
  open: "text-muted-foreground",
  suggested: "text-warning",
  failed: "text-destructive",
  conflict: "text-destructive",
  superseded: "text-faint line-through",
  rejected: "text-faint line-through",
  stale: "text-faint",
  expired: "text-faint",
  pending: "text-faint",
};

/** Lowercase state word — color only where the state needs attention. */
export function StateTag({ state, className }: { state: string; className?: string }) {
  return (
    <span className={cn("text-[11px] font-medium", TAG[state] ?? "text-muted-foreground", className)}>{state}</span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border px-1 font-mono text-[10px] leading-4 text-faint">{children}</kbd>;
}

/** Page header: title leads (18/600, tight), meta is quiet, actions sit right. */
export function PageHead({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b px-5">
      <h1 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h1>
      {meta && <div className="text-[12px] text-faint">{meta}</div>}
      <div className="ml-auto flex items-center gap-2">{actions}</div>
    </header>
  );
}

/** A failed request is not an empty list — say so. */
export function LoadError({ what }: { what: string }) {
  return <Empty title={`Couldn’t load ${what}`} hint="The API didn’t respond or refused the request. Nothing here was changed — try again in a moment." />;
}

export function Empty({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-6 py-16 text-center">
      <div className="text-[13px] font-medium text-muted-foreground">{title}</div>
      {hint && <div className="max-w-sm text-[12px] text-faint">{hint}</div>}
    </div>
  );
}

/** Mono surface id with the kind prefix demoted. */
export function SurfaceId({ surface, className }: { surface: string; className?: string }) {
  const m = /^([a-z][a-z0-9_-]*):(.*)$/.exec(surface);
  return (
    <span className={cn("font-mono text-[12px]", className)}>
      {m ? (
        <>
          <span className="text-faint">{m[1]}:</span>
          <span>{m[2]}</span>
        </>
      ) : (
        surface
      )}
    </span>
  );
}

export const btn = {
  primary:
    "press inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[12px] font-semibold text-primary-foreground transition-[filter] duration-150 hover:brightness-105 disabled:cursor-not-allowed disabled:bg-muted disabled:text-faint disabled:hover:brightness-100",
  ghost:
    "press inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground disabled:opacity-50",
  outline:
    "press inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12px] font-medium text-foreground transition-colors duration-150 hover:border-border-strong hover:bg-muted disabled:opacity-50",
  danger:
    "press inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-destructive transition-colors duration-150 hover:bg-destructive-soft disabled:opacity-50",
};

/** Non-surface scope in words: "project-wide", "repo core-api", "topic retries", "feature cap:x". */
export function scopeText(kind: string, label: string): string {
  if (kind === "project") return "project-wide";
  if (kind === "capability") return `feature ${label}`;
  return `${kind} ${label}`;
}
