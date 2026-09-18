"use client";
import { timeAgo } from "@/lib/time";

/** Relative time with the absolute timestamp on hover. Renders nothing when the timestamp is missing. */
export function When({ at, className }: { at: string | Date | null | undefined; className?: string }) {
  if (!at) return null;
  const iso = typeof at === "string" ? at : at.toISOString();
  if (Number.isNaN(new Date(iso).getTime())) return null;
  // Deterministic tooltip (server and client locales differ) — UTC, minute precision.
  const abs = new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  return (
    <time dateTime={iso} title={abs} className={className} suppressHydrationWarning>
      {timeAgo(iso)}
    </time>
  );
}
