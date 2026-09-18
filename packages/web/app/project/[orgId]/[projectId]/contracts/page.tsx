import { FileCode2 } from "lucide-react";
import { getOverview } from "@/lib/data";
import { PageHeader } from "@/components/PageHeader";
import { ListRow } from "@/components/ListRow";
import { StatusBadge } from "@/components/StatusBadge";
import { RefChip } from "@/components/RefChip";
import { Section } from "@/components/Section";
import { EmptyState } from "@/components/EmptyState";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

const shortRepo = (remote: string) => remote.split("/").pop() ?? remote;

export default async function Page({
  params,
  searchParams,
}: {
  params: { orgId: string; projectId: string };
  searchParams?: { q?: string; repo?: string };
}) {
  const o = await getOverview(params.orgId, params.projectId);
  const all = o?.contracts ?? [];
  const repos = o?.repos ?? [];
  const repoName = new Map(repos.map((r) => [r.id, shortRepo(r.gitRemote)]));

  const q = (searchParams?.q ?? "").trim().toLowerCase();
  const repoFilter = searchParams?.repo ?? "";
  const items = all
    .filter((c) => (repoFilter ? c.repoId === repoFilter : true))
    .filter((c) => (q ? c.surface.toLowerCase().includes(q) : true))
    .sort((a, b) => a.surface.localeCompare(b.surface));

  const byRepo = new Map<string, typeof items>();
  for (const c of items) byRepo.set(c.repoId, [...(byRepo.get(c.repoId) ?? []), c]);

  const verification = (c: (typeof all)[number]) =>
    c.verifiedAgainst === "git-diff" || c.verifiedAgainst === "source-extracted"
      ? "extracted"
      : c.verified
        ? "verified"
        : "asserted";

  return (
    <>
      <PageHeader
        title="Contracts"
        description="Interface surfaces across your repos, extracted from source. Consumer counts come from the usage graph."
      />

      {all.length > 0 && (
        <Card className="mb-6 shadow-none">
          <CardContent className="p-4">
            <form method="get" className="flex flex-wrap items-center gap-2">
              <Input
                name="q"
                defaultValue={searchParams?.q ?? ""}
                placeholder="Search surfaces, e.g. /auth or POST"
                className="min-w-56 flex-1"
                aria-label="Search surfaces"
              />
              <select
                name="repo"
                defaultValue={repoFilter}
                aria-label="Filter by repo"
                className="h-9 rounded-md border bg-card px-3 text-sm"
              >
                <option value="">All repos</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {repoName.get(r.id)}
                  </option>
                ))}
              </select>
              <Button variant="secondary">Filter</Button>
              <span className="ml-auto text-xs text-muted-foreground">
                {items.length} of {all.length} surfaces
              </span>
            </form>
          </CardContent>
        </Card>
      )}

      {all.length === 0 ? (
        <EmptyState icon={<FileCode2 />} title="No contracts captured yet">
          When an agent changes an API surface, or <RefChip copy={false}>lockstep scan</RefChip> syncs a repo, surfaces
          appear here.
        </EmptyState>
      ) : items.length === 0 ? (
        <EmptyState icon={<FileCode2 />} title="No matches">
          Nothing matches this search — clear it to see all {all.length} surfaces.
        </EmptyState>
      ) : (
        [...byRepo.entries()].map(([repoId, list]) => (
          <Section key={repoId} label={repoName.get(repoId) ?? "repo"} count={list.length}>
            {list.map((c) => (
              <ListRow
                key={c.id}
                title={<span className="font-mono text-sm">{c.surface}</span>}
                meta={
                  <>
                    <RefChip copy={false}>{`${c.consumerCount} consumer${c.consumerCount === 1 ? "" : "s"}`}</RefChip>
                    {c.verifiedAgainst && <span>via {c.verifiedAgainst}</span>}
                    {c.version > 1 && <RefChip copy={false}>{`v${c.version}`}</RefChip>}
                  </>
                }
                status={<StatusBadge status={verification(c)} />}
              />
            ))}
          </Section>
        ))
      )}
    </>
  );
}
