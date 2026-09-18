import { GitFork, ArrowRight } from "lucide-react";
import { getOverview } from "@/lib/data";
import { PageHeader } from "@/components/PageHeader";
import { ListRow } from "@/components/ListRow";
import { RefChip } from "@/components/RefChip";
import { Section } from "@/components/Section";
import { EmptyState } from "@/components/EmptyState";
import { DependencyGraphFlow } from "@/components/DependencyGraphFlow";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: { orgId: string; projectId: string } }) {
  const o = await getOverview(params.orgId, params.projectId);
  const deps = o?.dependencies ?? [];
  const repos = o?.repos ?? [];
  const repoName = new Map(repos.map((r) => [r.id, r.gitRemote.split("/").pop() ?? r.gitRemote]));

  return (
    <>
      <PageHeader
        title="Dependencies"
        description="Which services consume which surfaces — this is what routes a change to the right teammate."
      />
      {deps.length === 0 ? (
        <EmptyState icon={<GitFork />} title="No dependencies yet">
          Declare what a repo consumes in <RefChip copy={false}>lockstep.yaml</RefChip>, or let an agent record the edge
          via <RefChip copy={false}>register_dependency</RefChip>.
        </EmptyState>
      ) : (
        <>
          <DependencyGraphFlow repos={repos} dependencies={deps} />
          <Section label="All edges" count={deps.length}>
            {deps.map((d) => (
              <ListRow
                key={d.id}
                title={
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <RefChip copy={false}>{repoName.get(d.consumerRepoId) ?? "consumer"}</RefChip>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                    <RefChip>{d.producedSurface}</RefChip>
                  </span>
                }
                meta={
                  <>
                    {d.producerProject && (
                      <RefChip
                        copy={false}
                        kind="Produced by a repo in another project"
                        href={`/project/${params.orgId}/${d.producerProject.id}`}
                      >
                        {`↗ ${d.producerProject.name}`}
                      </RefChip>
                    )}
                    <span>via {d.source}</span>
                  </>
                }
              />
            ))}
          </Section>
        </>
      )}
    </>
  );
}
