"use client";
import { timeAgo } from "@/lib/data";

/** Relative time with the absolute timestamp on hover. */
export function When({ at, className }: { at: string | Date; className?: string }) {
  const iso = typeof at === "string" ? at : at.toISOString();
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()} className={className}>
      {timeAgo(iso)}
    </time>
  );
}
