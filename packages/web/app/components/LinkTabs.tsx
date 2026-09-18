import Link from "next/link";
import { cn } from "@/lib/utils";

export interface LinkTab {
  key: string;
  label: string;
  href: string;
  count?: number;
}

/** Server-rendered tab row driven by a query param; the active tab is a prop, not client state. */
export function LinkTabs({ tabs, active, className }: { tabs: LinkTab[]; active: string; className?: string }) {
  return (
    <div role="tablist" className={cn("inline-flex h-9 items-center gap-1 rounded-lg bg-muted p-1", className)}>
      {tabs.map((t) => {
        const isActive = t.key === active;
        return (
          <Link
            key={t.key}
            href={t.href}
            role="tab"
            aria-selected={isActive}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors",
              isActive ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            {typeof t.count === "number" && (
              <span className={cn("font-mono text-2xs tracking-normal", isActive ? "text-muted-foreground" : "")}>
                {t.count}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
