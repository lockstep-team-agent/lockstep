"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Inbox, Network, Rows3, Settings2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const ITEMS: Array<{ seg: string; label: string; icon: LucideIcon; key: string }> = [
  { seg: "inbox", label: "Inbox", icon: Inbox, key: "I" },
  { seg: "map", label: "Map", icon: Network, key: "M" },
  { seg: "ledger", label: "Ledger", icon: Rows3, key: "L" },
  { seg: "insights", label: "Insights", icon: BarChart3, key: "N" },
  { seg: "settings", label: "Settings", icon: Settings2, key: "S" },
];

// admin pages that live under Settings in the new shell
const SETTINGS_SEGS = ["settings", "connections", "members", "activity"];

export function NavLinks({ base, inboxCount }: { base: string; inboxCount: number }) {
  const path = usePathname();
  const seg = path.slice(base.length + 1).split("/")[0] ?? "";
  const active = (s: string) =>
    s === "settings"
      ? SETTINGS_SEGS.includes(seg)
      : s === "ledger"
        ? ["ledger", "decisions", "questions", "tasks", "sources"].includes(seg)
        : seg === s;
  return (
    <nav aria-label="Primary" className="flex flex-col gap-px px-2">
      {ITEMS.map(({ seg: s, label, icon: Icon, key }) => (
        <Link
          key={s}
          href={`${base}/${s}`}
          aria-current={active(s) ? "page" : undefined}
          className={cn(
            "group flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] font-medium text-muted-foreground transition-colors duration-150",
            "hover:bg-muted hover:text-foreground",
            active(s) && "bg-muted text-foreground",
          )}
        >
          <Icon
            className={cn(
              "h-4 w-4 shrink-0",
              active(s) ? "text-foreground" : "text-faint group-hover:text-muted-foreground",
            )}
          />
          <span className="flex-1">{label}</span>
          {s === "inbox" && inboxCount > 0 ? (
            <span className="tnum rounded bg-primary-soft px-1.5 text-[11px] font-semibold leading-5 text-primary-ink">
              {inboxCount}
            </span>
          ) : (
            <kbd className="hidden font-mono text-[10px] text-faint group-hover:inline">G {key}</kbd>
          )}
        </Link>
      ))}
    </nav>
  );
}
