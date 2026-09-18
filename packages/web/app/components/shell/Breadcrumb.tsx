"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LABELS: Record<string, string> = {
  "review-queue": "Review",
  decisions: "Decisions",
  questions: "Questions",
  tasks: "Tasks",
  contracts: "Contracts",
  dependencies: "Dependencies",
  sources: "Sources",
  features: "Features",
  graph: "Org graph",
  connections: "Connections",
  members: "Members & Repos",
  activity: "Activity",
  insights: "Insights",
  search: "Search",
};

export function Breadcrumb({ base, orgName, projectName }: { base: string; orgName: string; projectName: string }) {
  const seg = usePathname().slice(base.length).split("/").filter(Boolean)[0];
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
      <span className="hidden truncate text-muted-foreground sm:inline">{orgName}</span>
      <span className="hidden text-muted-foreground sm:inline" aria-hidden>
        ›
      </span>
      <Link href={base} className="truncate font-medium hover:text-foreground">
        {projectName}
      </Link>
      {seg && LABELS[seg] && (
        <>
          <span className="text-muted-foreground" aria-hidden>
            ›
          </span>
          <span className="truncate text-muted-foreground">{LABELS[seg]}</span>
        </>
      )}
    </nav>
  );
}
