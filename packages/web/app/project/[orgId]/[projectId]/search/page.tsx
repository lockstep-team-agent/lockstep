import { Search as SearchIcon } from "lucide-react";
import { searchDecisions } from "@/lib/data";
import { PageHeader } from "@/components/PageHeader";
import { ListRow } from "@/components/ListRow";
import { StatusBadge } from "@/components/StatusBadge";
import { RefChip } from "@/components/RefChip";
import { When } from "@/components/When";
import { Section } from "@/components/Section";
import { EmptyState } from "@/components/EmptyState";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

export default async function Page({
  params,
  searchParams,
}: {
  params: { orgId: string; projectId: string };
  searchParams: { q?: string; status?: string; origin?: string };
}) {
  const { orgId, projectId } = params;
  const base = `/project/${orgId}/${projectId}`;
  const q = searchParams.q ?? "";
  const status = searchParams.status ?? "";
  const origin = searchParams.origin ?? "";
  const qs = new URLSearchParams(
    Object.entries({ q, status, origin }).filter(([, v]) => v) as [string, string][],
  ).toString();
  const data = await searchDecisions(orgId, projectId, qs ? `?${qs}` : "");
  const items = data?.decisions ?? [];
  const selectCls = "h-9 rounded-md border bg-card px-3 text-sm";

  return (
    <>
      <PageHeader title="Search" description="Ask what the team decided — answered from the ledger, with provenance." />
      <Card className="mb-6 shadow-none">
        <CardContent className="p-4">
          <form method="get" className="flex flex-wrap items-center gap-2">
            <Input
              name="q"
              defaultValue={q}
              placeholder="What did we decide about…"
              className="min-w-56 flex-1"
              aria-label="Search decisions"
              autoFocus
            />
            <select name="status" defaultValue={status} className={selectCls} aria-label="Status">
              <option value="">Any status</option>
              <option value="binding">binding</option>
              <option value="open">awaiting ack</option>
              <option value="proposed">proposed</option>
              <option value="superseded">superseded</option>
            </select>
            <select name="origin" defaultValue={origin} className={selectCls} aria-label="Origin">
              <option value="">Any origin</option>
              <option value="agent">agent</option>
              <option value="ingested">ingested</option>
              <option value="document">document</option>
            </select>
            <Button variant="secondary">Search</Button>
          </form>
        </CardContent>
      </Card>

      {items.length === 0 ? (
        <EmptyState icon={<SearchIcon />} title={q ? "No matches" : "Search the decision ledger"}>
          Try a topic, a rule keyword, a surface, or a phrase from the source quote.
        </EmptyState>
      ) : (
        <Section label={q ? `Results for “${q}”` : "All decisions"} count={items.length}>
          {items.map((d) => (
            <ListRow
              key={d.id}
              href={`${base}/decisions/${d.id}`}
              title={d.ruleText || d.scopeRef}
              meta={
                <>
                  <RefChip kind={d.scopeKind}>{d.scopeRef}</RefChip>
                  {d.origin !== "agent" && <RefChip copy={false}>{d.origin}</RefChip>}
                  {d.impact > 0 && <RefChip copy={false}>{`impact ${d.impact}`}</RefChip>}
                  {d.provenance?.source && <span>via {d.provenance.source}</span>}
                  <When at={d.createdAt} />
                </>
              }
              status={<StatusBadge status={d.status} origin={d.origin} />}
            />
          ))}
        </Section>
      )}
    </>
  );
}
