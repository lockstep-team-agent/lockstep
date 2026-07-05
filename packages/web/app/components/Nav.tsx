"use client";
import { Fragment } from "react";
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
  IconDoc,
  IconFeature,
} from "./icons";

export interface NavCounts {
  decisions?: number;
  questions?: number;
  tasks?: number;
  contracts?: number;
  dependencies?: number;
  review?: number;
  sources?: number;
  features?: number;
}

export function Nav({ base, counts }: { base: string; counts: NavCounts }) {
  const pathname = usePathname();
  const sections = [
    {
      label: "Overview",
      items: [
        { href: "", label: "Overview", Icon: IconOverview, badge: undefined as number | undefined },
        { href: "/insights", label: "Insights", Icon: IconActivity, badge: undefined },
        { href: "/search", label: "Search", Icon: IconOverview, badge: undefined },
      ],
    },
    {
      label: "Inbox",
      items: [
        { href: "/review-queue", label: "Review", Icon: IconQuestions, badge: counts.review },
        { href: "/notifications", label: "Notifications", Icon: IconActivity, badge: undefined },
      ],
    },
    {
      label: "Ledger",
      items: [
        { href: "/decisions", label: "Decisions", Icon: IconDecisions, badge: counts.decisions },
        { href: "/questions", label: "Questions", Icon: IconQuestions, badge: counts.questions },
        { href: "/tasks", label: "Tasks", Icon: IconTasks, badge: counts.tasks },
        { href: "/contracts", label: "Contracts", Icon: IconContracts, badge: counts.contracts },
        { href: "/dependencies", label: "Dependencies", Icon: IconDependencies, badge: counts.dependencies },
      ],
    },
    {
      label: "Product",
      items: [
        { href: "/sources", label: "Sources", Icon: IconDoc, badge: counts.sources },
        { href: "/features", label: "Features", Icon: IconFeature, badge: counts.features },
      ],
    },
    {
      label: "Graph",
      items: [{ href: "/graph", label: "Org graph", Icon: IconDependencies, badge: undefined }],
    },
    {
      label: "Admin",
      items: [
        { href: "/connections", label: "Connections", Icon: IconMembers, badge: undefined },
        { href: "/activity", label: "Activity", Icon: IconActivity, badge: undefined },
        { href: "/members", label: "Members & Repos", Icon: IconMembers, badge: undefined },
      ],
    },
  ];
  return (
    <nav className="nav">
      {sections.map(({ label, items }) => (
        <Fragment key={label}>
          <div className="nav-group-label">{label}</div>
          {items.map(({ href, label: itemLabel, Icon, badge }) => {
            const full = base + href;
            const active = href === "" ? pathname === base : pathname.startsWith(full);
            return (
              <Link key={itemLabel} href={full} className={`nav-item${active ? " active" : ""}`}>
                <Icon />
                {itemLabel}
                {badge ? <span className="badge">{badge}</span> : null}
              </Link>
            );
          })}
        </Fragment>
      ))}
    </nav>
  );
}
