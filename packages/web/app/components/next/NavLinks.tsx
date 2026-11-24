"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Rows3, Settings2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const ITEMS: Array<{ seg: string; label: string; icon: LucideIcon; key: string }> = [
  { seg: "", label: "Home", icon: Home, key: "H" },
  { seg: "ledger", label: "Rules", icon: Rows3, key: "L" },
  { seg: "settings", label: "Settings", icon: Settings2, key: "S" },
];

// admin pages that live under Settings in the new shell
const SETTINGS_SEGS = ["settings", "connections", "members", "activity"];

export function NavLinks({ base }: { base: string }) {
  const path = usePathname();
  const seg = path.slice(base.length + 1).split("/")[0] ?? "";
  const active = (s: string) =>
    s === "settings"
      ? SETTINGS_SEGS.includes(seg)
      : s === "ledger"
        ? ["ledger", "decisions", "questions", "tasks", "sources", "map"].includes(seg)
        : s === ""
          ? seg === "" || seg === "inbox"
          : seg === s;
  return (
    <nav aria-label="Primary" className="flex flex-col gap-px px-2">
      {ITEMS.map(({ seg: s, label, icon: Icon, key }) => (
        <Link
          key={s}
          href={s ? `${base}/${s}` : base}
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
          <kbd className="hidden font-mono text-[10px] text-faint group-hover:inline">G {key}</kbd>
        </Link>
      ))}
    </nav>
  );
}
