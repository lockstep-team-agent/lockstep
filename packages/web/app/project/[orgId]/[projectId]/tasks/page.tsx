import { ListTodo } from "lucide-react";
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

type Task = ProjectOverview["tasks"][number];
const isDone = (t: Task) => t.status === "done" || t.status === "closed" || t.runState === "done";

export default async function Page({ params }: { params: { orgId: string; projectId: string } }) {
  const o = await getOverview(params.orgId, params.projectId);
  const items = o?.tasks ?? [];
  const open = items.filter((t) => !isDone(t));
  const done = items.filter(isDone);

  const Row = ({ t }: { t: Task }) => (
    <ListRow
      id={t.id}
      title={t.title}
      meta={
        <>
          {t.delegatedTo && (
            <span className="inline-flex items-center gap-1">
              to <Who login={t.delegatedTo} />
            </span>
          )}
          {t.delegatedBy && (
            <span className="inline-flex items-center gap-1">
              from <Who login={t.delegatedBy} />
            </span>
          )}
          <When at={t.createdAt} />
        </>
      }
      status={<StatusBadge status={isDone(t) ? "completed" : t.runState !== "done" ? t.runState : t.status} />}
    />
  );

  return (
    <>
      <PageHeader
        title="Tasks"
        description="Work delegated between agents — queued for the receiving human to approve."
      />
      {items.length === 0 ? (
        <EmptyState icon={<ListTodo />} title="No tasks yet">
          Agents hand off work via <RefChip copy={false}>delegate</RefChip>; it queues for approval here.
        </EmptyState>
      ) : (
        <>
          {open.length > 0 && (
            <Section label="Open" count={open.length}>
              {open.map((t) => (
                <Row t={t} key={t.id} />
              ))}
            </Section>
          )}
          {done.length > 0 && (
            <Section label="Completed" count={done.length}>
              {done.map((t) => (
                <Row t={t} key={t.id} />
              ))}
            </Section>
          )}
        </>
      )}
    </>
  );
}
