import { cn } from "@/lib/utils";
import { statusView, toneClass } from "@/lib/status";

/** The only component that turns a status string into a colour and a word (spec §3.3). */
export function StatusBadge({
  status,
  origin,
  className,
}: {
  status: string;
  origin?: string | null;
  className?: string;
}) {
  const v = statusView(status, { origin });
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-xs font-medium",
        toneClass[v.tone],
        className,
      )}
    >
      {v.dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
      {v.word}
    </span>
  );
}
