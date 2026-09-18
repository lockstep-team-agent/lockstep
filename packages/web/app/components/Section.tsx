import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Labelled group wrapping a Card. Label + optional count + optional "View all" link. */
export function Section({
  label,
  count,
  href,
  hrefLabel = "View all →",
  children,
  className,
  bare = false,
}: {
  label: string;
  count?: number;
  href?: string;
  hrefLabel?: string;
  children: ReactNode;
  className?: string;
  /** Render children without the Card wrapper (for grids of cards or empty states). */
  bare?: boolean;
}) {
  return (
    <section className={cn("mb-6", className)}>
      <div className="mb-2 flex items-center justify-between px-0.5">
        <h2 className="text-2xs font-semibold uppercase text-muted-foreground">
          {label}
          {typeof count === "number" && <span className="ml-1.5 font-mono normal-case tracking-normal">{count}</span>}
        </h2>
        {href && (
          <Link href={href} className="text-xs text-muted-foreground hover:text-foreground">
            {hrefLabel}
          </Link>
        )}
      </div>
      {bare ? children : <Card className="overflow-hidden shadow-none">{children}</Card>}
    </section>
  );
}
