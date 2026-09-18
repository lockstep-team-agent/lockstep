import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The one row grammar (spec §6.2). Left to right: optional leading icon/avatar, title, one meta line,
 * then trailing status and one optional action. The whole row links when `href` is set; trailing
 * controls sit above the link so forms and buttons inside them still work.
 */
export function ListRow({
  id,
  href,
  leading,
  title,
  meta,
  status,
  action,
  extra,
  className,
}: {
  id?: string;
  href?: string;
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  status?: ReactNode;
  action?: ReactNode;
  extra?: ReactNode;
  className?: string;
}) {
  const body = (
    <div className="min-w-0 flex-1">
      <div className="truncate text-base font-medium leading-6 text-foreground">{title}</div>
      {meta && (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground [&>*]:shrink-0">
          {meta}
        </div>
      )}
      {extra && <div className="mt-1.5 text-sm text-muted-foreground">{extra}</div>}
    </div>
  );
  return (
    <div
      id={id}
      className={cn(
        "group relative flex min-h-12 items-start gap-3 border-b px-4 py-3 transition-colors last:border-b-0 hover:bg-muted/60",
        className,
      )}
    >
      {leading && <div className="mt-0.5 shrink-0 text-muted-foreground [&>svg]:h-4 [&>svg]:w-4">{leading}</div>}
      {href ? (
        <Link
          href={href}
          className="min-w-0 flex-1 rounded-sm outline-none after:absolute after:inset-0 after:content-['']"
        >
          {body}
        </Link>
      ) : (
        body
      )}
      {(status || action) && (
        <div className="relative z-10 flex shrink-0 flex-wrap items-center justify-end gap-2 self-center">
          {status}
          {action}
        </div>
      )}
    </div>
  );
}
