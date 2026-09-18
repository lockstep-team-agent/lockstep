import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { getOverview } from "@/lib/data";
import type { ProjectOverview } from "@/lib/types";
import { PageHeader } from "@/components/PageHeader";
import { LinkTabs } from "@/components/LinkTabs";
import { ListRow } from "@/components/ListRow";
import { StatusBadge } from "@/components/StatusBadge";
import { RefChip } from "@/components/RefChip";
import { Who } from "@/components/Who";
import { When } from "@/components/When";
import { Section } from "@/components/Section";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

type Decision = ProjectOverview["decisions"][number];
type View = "all" | "awaiting" | "binding" | "cross" | "history";

const isAwaiting = (d: Decision) => d.status === "open" || d.status === "proposed";
const isHistory = (d: Decision) => d.status === "superseded" || d.status === "rejected";

export default async function Page({
  params,
  searchParams,
}: {
  params: { orgId: string; projectId: string };
  searchParams: { view?: string };
}) {
  const { orgId, projectId } = params;
  const base = `/project/${orgId}/${projectId}`;
  const o = await getOverview(orgId, projectId);
  const all = o?.decisions ?? [];
  const view = (["all", "awaiting", "binding", "cross", "history"] as View[]).includes(searchParams.view as View)
    ? (searchParams.view as View)
    : "all";

  const awaiting = all.filter(isAwaiting);
  const binding = all.filter((d) => d.status === "binding");
  const cross = all.filter((d) => d.impact > 0 && !isHistory(d));
  const history = all.filter(isHistory);

  const reviewHref = (d: Decision) =>
    d.origin === "document"
      ? `${base}/review-queue?tab=ratifications`
      : d.origin === "ingested"
        ? `${base}/review-queue`
        : `${base}/decisions/${d.id}`;

  const Row = ({ d }: { d: Decision }) => (
    <ListRow
      key={d.id}
      href={`${base}/decisions/${d.id}`}
      title={d.ruleText || d.scopeRef}
      meta={
        <>
          <RefChip kind={d.scopeKind}>{d.scopeRef}</RefChip>
          {d.proposedBy && <Who login={d.proposedBy} />}
          <When at={d.createdAt} />
          {d.impact > 0 && <RefChip copy={false}>{`impact ${d.impact}`}</RefChip>}
          {d.version > 1 && <RefChip copy={false}>{`v${d.version}`}</RefChip>}
          {d.decisionType === "principle" && <RefChip copy={false}>principle</RefChip>}
          {d.origin && d.origin !== "agent" && <RefChip copy={false}>{d.origin}</RefChip>}
          {d.dueForReview && <StatusBadge status="due" />}
        </>
      }
      extra={d.rationale ? <span className="line-clamp-1">{d.rationale}</span> : undefined}
      status={<StatusBadge status={d.status} origin={d.origin} />}
      action={
        isAwaiting(d) ? (
          <Button asChild size="sm" variant="ghost">
            <Link href={reviewHref(d)}>
              {d.origin === "document" ? "Ratify" : d.origin === "ingested" ? "Review" : "View"}
            </Link>
          </Button>
        ) : undefined
      }
    />
  );

  const groups: Array<{ key: View; label: string; items: Decision[] }> = [
    { key: "awaiting", label: "Awaiting review", items: awaiting },
    { key: "binding", label: "Binding", items: binding },
    { key: "history", label: "History", items: history },
  ];
  const visible =
    view === "all"
      ? groups.filter((g) => g.items.length > 0)
      : view === "cross"
        ? [{ key: "cross" as View, label: "Cross-cutting (impact > 0)", items: cross }]
        : groups.filter((g) => g.key === view);

  return (
    <>
      <PageHeader
        title="Decisions"
        description="Binding rules every agent must honor — versioned and attributed."
        tabs={
          <LinkTabs
            active={view}
            tabs={[
              { key: "all", label: "All", href: `${base}/decisions`, count: all.length },
              { key: "awaiting", label: "Awaiting", href: `${base}/decisions?view=awaiting`, count: awaiting.length },
              { key: "binding", label: "Binding", href: `${base}/decisions?view=binding`, count: binding.length },
              { key: "cross", label: "Cross-cutting", href: `${base}/decisions?view=cross`, count: cross.length },
              { key: "history", label: "History", href: `${base}/decisions?view=history`, count: history.length },
            ]}
          />
        }
      />
      {all.length === 0 ? (
        <EmptyState icon={<CheckCircle2 />} title="No decisions yet">
          Agents record binding rules here via <RefChip copy={false}>propose_decision</RefChip>.
        </EmptyState>
      ) : visible.every((g) => g.items.length === 0) ? (
        <EmptyState icon={<CheckCircle2 />} title="Nothing here">
          No decisions match this view.
        </EmptyState>
      ) : (
        visible.map((g) => (
          <Section key={g.key} label={g.label} count={g.items.length}>
            {g.items.length === 0 ? (
              <EmptyState icon={<CheckCircle2 />} title="Nothing here" />
            ) : (
              g.items.map((d) => <Row d={d} key={d.id} />)
            )}
          </Section>
        ))
      )}
    </>
  );
}
