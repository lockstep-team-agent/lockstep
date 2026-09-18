import { HelpCircle } from "lucide-react";
import { getOverview } from "@/lib/data";
import type { ProjectOverview } from "@/lib/types";
import { PageHeader } from "@/components/PageHeader";
import { ListRow } from "@/components/ListRow";
import { StatusBadge } from "@/components/StatusBadge";
import { RefChip } from "@/components/RefChip";
import { Who } from "@/components/Who";
import { When } from "@/components/When";
import { Section } from "@/components/Section";
import { EmptyState } from "@/components/EmptyState";

export const dynamic = "force-dynamic";

type Question = ProjectOverview["questions"][number];

export default async function Page({ params }: { params: { orgId: string; projectId: string } }) {
  const o = await getOverview(params.orgId, params.projectId);
  const items = o?.questions ?? [];
  const open = items.filter((q) => q.status === "open");
  const settled = items.filter((q) => q.status !== "open");

  const Row = ({ q }: { q: Question }) => (
    <ListRow
      id={q.id}
      title={q.body}
      meta={
        <>
          {q.scopeRef && <RefChip>{q.scopeRef}</RefChip>}
          {q.askedBy && (
            <span className="inline-flex items-center gap-1">
              asked by <Who login={q.askedBy} />
            </span>
          )}
          <When at={q.createdAt} />
          {q.urgent && <StatusBadge status="urgent" />}
        </>
      }
      extra={
        q.answer ? (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {q.answer.by && <Who login={q.answer.by} />}
            <span>answered</span>
            <When at={q.answer.at} />
            <span>·</span>
            <span className="text-foreground/90">{q.answer.body}</span>
          </span>
        ) : undefined
      }
      status={<StatusBadge status={q.status === "open" ? "open_question" : q.status} />}
    />
  );

  return (
    <>
      <PageHeader
        title="Questions"
        description="Code & repo questions, routed to owners and answered into the ledger."
      />
      {items.length === 0 ? (
        <EmptyState icon={<HelpCircle />} title="No questions yet">
          Agents ask code and repo questions via <RefChip copy={false}>ask</RefChip>; answers are written back here.
        </EmptyState>
      ) : (
        <>
          {open.length > 0 && (
            <Section label="Open" count={open.length}>
              {open.map((q) => (
                <Row q={q} key={q.id} />
              ))}
            </Section>
          )}
          {settled.length > 0 && (
            <Section label="Answered & closed" count={settled.length}>
              {settled.map((q) => (
                <Row q={q} key={q.id} />
              ))}
            </Section>
          )}
        </>
      )}
    </>
  );
}
