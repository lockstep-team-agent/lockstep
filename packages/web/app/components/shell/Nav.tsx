"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home,
  Inbox,
  CheckCircle2,
  HelpCircle,
  ListTodo,
  FileCode2,
  GitFork,
  FileText,
  Target,
  Waypoints,
  Plug,
  Users,
  History,
  Gauge,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface NavCounts {
  review?: number;
  decisions?: number;
  questions?: number;
  tasks?: number;
  contracts?: number;
  dependencies?: number;
  sources?: number;
  features?: number;
}

interface Item {
  href: string;
  label: string;
  Icon: LucideIcon;
  badge?: number;
}

export function Nav({ base, counts, onNavigate }: { base: string; counts: NavCounts; onNavigate?: () => void }) {
  const pathname = usePathname();
  const groups: Array<{ label?: string; items: Item[] }> = [
    {
      items: [
        { href: "", label: "Home", Icon: Home },
        { href: "/review-queue", label: "Review", Icon: Inbox, badge: counts.review },
      ],
    },
    {
      label: "Ledger",
      items: [
        { href: "/decisions", label: "Decisions", Icon: CheckCircle2, badge: counts.decisions },
        { href: "/questions", label: "Questions", Icon: HelpCircle, badge: counts.questions },
        { href: "/tasks", label: "Tasks", Icon: ListTodo, badge: counts.tasks },
        { href: "/contracts", label: "Contracts", Icon: FileCode2, badge: counts.contracts },
        { href: "/dependencies", label: "Dependencies", Icon: GitFork, badge: counts.dependencies },
      ],
    },
    {
      label: "Product",
      items: [
        { href: "/sources", label: "Sources", Icon: FileText, badge: counts.sources },
        { href: "/features", label: "Features", Icon: Target, badge: counts.features },
        { href: "/graph", label: "Org graph", Icon: Waypoints },
      ],
    },
    {
      label: "Admin",
      items: [
        { href: "/connections", label: "Connections", Icon: Plug },
        { href: "/members", label: "Members & Repos", Icon: Users },
        { href: "/activity", label: "Activity", Icon: History },
        { href: "/insights", label: "Insights", Icon: Gauge },
      ],
    },
  ];
  return (
    <nav className="flex flex-col gap-4 px-3 py-2" aria-label="Project">
      {groups.map((g, gi) => (
        <div key={gi}>
          {g.label && <div className="mb-1 px-2 text-2xs font-semibold uppercase text-muted-foreground">{g.label}</div>}
          <ul className="flex flex-col gap-0.5">
            {g.items.map(({ href, label, Icon, badge }) => {
              const full = base + href;
              const active = href === "" ? pathname === base : pathname.startsWith(full);
              return (
                <li key={label}>
                  <Link
                    href={full}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                      active && "bg-primary-soft text-foreground",
                    )}
                  >
                    <Icon className={cn("h-4 w-4 shrink-0", active && "text-primary")} strokeWidth={1.75} />
                    <span className="flex-1 truncate">{label}</span>
                    {badge ? (
                      <span className="rounded-full bg-muted px-1.5 font-mono text-2xs tracking-normal text-muted-foreground">
                        {badge}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
