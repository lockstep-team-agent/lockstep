"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  IconOverview,
  IconDecisions,
  IconQuestions,
  IconTasks,
  IconContracts,
  IconDependencies,
  IconActivity,
  IconMembers,
} from "./icons";

export interface NavCounts {
  decisions?: number;
  questions?: number;
  tasks?: number;
  contracts?: number;
  dependencies?: number;
}

export function Nav({ base, counts }: { base: string; counts: NavCounts }) {
  const pathname = usePathname();
  const items = [
    { href: "", label: "Overview", Icon: IconOverview, badge: undefined as number | undefined },
    { href: "/decisions", label: "Decisions", Icon: IconDecisions, badge: counts.decisions },
    { href: "/questions", label: "Questions", Icon: IconQuestions, badge: counts.questions },
    { href: "/tasks", label: "Tasks", Icon: IconTasks, badge: counts.tasks },
    { href: "/contracts", label: "Contracts", Icon: IconContracts, badge: counts.contracts },
    { href: "/dependencies", label: "Dependencies", Icon: IconDependencies, badge: counts.dependencies },
    { href: "/activity", label: "Activity", Icon: IconActivity, badge: undefined },
    { href: "/members", label: "Members & Repos", Icon: IconMembers, badge: undefined },
  ];
  return (
    <nav className="nav">
      {items.map(({ href, label, Icon, badge }) => {
        const full = base + href;
        const active = href === "" ? pathname === base : pathname.startsWith(full);
        return (
          <Link key={label} href={full} className={`nav-item${active ? " active" : ""}`}>
            <Icon />
            {label}
            {badge ? <span className="badge">{badge}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
