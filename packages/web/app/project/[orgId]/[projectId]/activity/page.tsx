import {
  History,
  CheckCircle2,
  HelpCircle,
  ListTodo,
  GitCommitHorizontal,
  GitFork,
  FileText,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { getOverview, humanizeAudit, entityHref } from "@/lib/data";
import { PageHeader } from "@/components/PageHeader";
import { ListRow } from "@/components/ListRow";
import { RefChip } from "@/components/RefChip";
import { Who } from "@/components/Who";
import { When } from "@/components/When";
import { Section } from "@/components/Section";
import { EmptyState } from "@/components/EmptyState";

export const dynamic = "force-dynamic";

const ICON: Record<string, ReactNode> = {
  decision: <CheckCircle2 />,
  question: <HelpCircle />,
  task: <ListTodo />,
  change_feed_entry: <GitCommitHorizontal />,
  dependency_edge: <GitFork />,
  source_document: <FileText />,
  member: <Users />,
};

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = (a: Date, b: Date) => a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
  if (sameDay(d, today)) return "Today";
  const y = new Date(today);
  y.setUTCDate(y.getUTCDate() - 1);
  if (sameDay(d, y)) return "Yesterday";
  return d.toISOString().slice(0, 10);
}

export default async function Page({ params }: { params: { orgId: string; projectId: string } }) {
  const { orgId, projectId } = params;
  const base = `/project/${orgId}/${projectId}`;
  const o = await getOverview(orgId, projectId);
  const items = o?.audit ?? [];

  const byDay = new Map<string, typeof items>();
  for (const a of items) {
    const k = dayLabel(a.createdAt);
    byDay.set(k, [...(byDay.get(k) ?? []), a]);
  }

  return (
    <>
      <PageHeader
        title="Activity"
        description="Immutable audit trail — who decided, acked, changed, or delegated what."
      />
      {items.length === 0 ? (
        <EmptyState icon={<History />} title="No activity yet">
          Every decision, ack, change, and delegation lands here as it happens.
        </EmptyState>
      ) : (
        [...byDay.entries()].map(([day, rows]) => (
          <Section key={day} label={day} count={rows.length}>
            {rows.map((a, i) => {
              const h = humanizeAudit(a);
              return (
                <ListRow
                  key={`${day}:${i}`}
                  href={entityHref(base, a.entityKind, a.entityId)}
                  leading={ICON[a.entityKind ?? ""] ?? <History />}
                  title={
                    <span className="inline-flex flex-wrap items-center gap-1.5 whitespace-normal">
                      {h.actor ? <Who login={h.actor} className="text-foreground" /> : <span>Lockstep</span>}
                      <span className="text-muted-foreground">{h.verb}</span>
                      {h.object && <span className="text-foreground">“{h.object}”</span>}
                    </span>
                  }
                  meta={
                    <>
                      {a.entityKind && <RefChip copy={false}>{a.entityKind.replace(/_/g, " ")}</RefChip>}
                      <When at={a.createdAt} />
                    </>
                  }
                />
              );
            })}
          </Section>
        ))
      )}
    </>
  );
}
