"use client";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/** Mono chip for surface IDs, scope refs, repo names, kinds. Click copies unless `copy={false}`. */
export function RefChip({
  children,
  kind,
  href,
  copy = true,
  className,
}: {
  children: string;
  kind?: string;
  href?: string;
  copy?: boolean;
  className?: string;
}) {
  const cls = cn(
    "inline-flex h-6 max-w-full items-center truncate rounded-md border bg-muted px-1.5 font-mono text-xs text-muted-foreground",
    href && "hover:text-foreground",
    className,
  );
  const inner = href ? (
    <Link href={href} className={cls}>
      {children}
    </Link>
  ) : copy ? (
    <button
      type="button"
      className={cn(cls, "cursor-copy hover:text-foreground")}
      onClick={() => navigator.clipboard?.writeText(children)}
      aria-label={`Copy ${children}`}
    >
      {children}
    </button>
  ) : (
    <span className={cls}>{children}</span>
  );
  if (!kind) return inner;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{inner}</TooltipTrigger>
        <TooltipContent>{kind}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
