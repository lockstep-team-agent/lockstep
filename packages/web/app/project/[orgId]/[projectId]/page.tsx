import Link from "next/link";
import type { ReactNode } from "react";
import { CheckCircle2, Inbox, GitCommitHorizontal } from "lucide-react";
import { getOverview, getRatifications, getConflicts } from "@/lib/data";
import { apiGet } from "@/lib/api";
import type { Me } from "@/lib/types";
import { PageHeader } from "@/components/PageHeader";
import { ListRow } from "@/components/ListRow";
import { StatusBadge } from "@/components/StatusBadge";
import { RefChip } from "@/components/RefChip";
import { Who } from "@/components/Who";
import { When } from "@/components/When";
import { Section } from "@/components/Section";
import { StatGrid, Stat } from "@/components/StatGrid";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { ackDecisionAction } from "@/actions";

export const dynamic = "force-dynamic";

type Need = { key: string; impact: number; at: string; node: ReactNode };

export default async function Home({ params }: { params: { orgId: string; projectId: string } }) {
  const { orgId, projectId } = params;
  const base = `/project/${orgId}/${projectId}`;
  const [o, me] = await Promise.all([getOverview(orgId, projectId), apiGet<Me>("/me")]);
  if (!o) return <EmptyState icon={<Inbox />} title="Couldn't load this project" />;
  const login = me?.principal.githubLogin ?? "";
  const isPm = o.viewer?.role === "pm" || o.viewer?.role === "owner";

  const needs: Need[] = [];
  for (const d of o.decisions.filter((d) => d.status === "open")) {
    needs.push({
      key: `d:${d.id}`,
      impact: d.impact,
      at: d.createdAt,
      node: (
        <ListRow
          key={`d:${d.id}`}
          href={`${base}/decisions/${d.id}`}
          title={d.ruleText || d.scopeRef}
          meta={
            <>
              <RefChip kind={d.scopeKind}>{d.scopeRef}</RefChip>
              {d.proposedBy && <Who login={d.proposedBy} />}
              <When at={d.createdAt} />
              {d.impact > 0 && <RefChip copy={false}>{`impact ${d.impact}`}</RefChip>}
            </>
          }
          status={<StatusBadge status={d.status} origin={d.origin} />}
          action={
            <form action={ackDecisionAction}>
              <input type="hidden" name="orgId" value={orgId} />
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="id" value={d.id} />
              <input type="hidden" name="version" value={d.version} />
              <Button size="sm">Acknowledge</Button>
            </form>
          }
        />
      ),
    });
  }
  for (const t of o.tasks.filter((t) => t.delegatedTo === login && t.status !== "done" && t.status !== "closed")) {
    needs.push({
      key: `t:${t.id}`,
      impact: 0,
      at: t.createdAt,
      node: (
        <ListRow
          key={`t:${t.id}`}
          href={`${base}/tasks#${t.id}`}
          title={t.title}
          meta={
            <>
              {t.delegatedBy && (
                <span className="inline-flex items-center gap-1">
                  from <Who login={t.delegatedBy} />
                </span>
              )}
              <When at={t.createdAt} />
            </>
          }
          status={<StatusBadge status={t.runState !== "done" ? t.runState : t.status} />}
        />
      ),
    });
  }
  for (const q of o.questions.filter((q) => q.urgent && q.status === "open")) {
    needs.push({
      key: `q:${q.id}`,
      impact: 1,
      at: q.createdAt,
      node: (
        <ListRow
          key={`q:${q.id}`}
          href={`${base}/questions#${q.id}`}
          title={q.body}
          meta={
            <>
              {q.scopeRef && <RefChip>{q.scopeRef}</RefChip>}
              {q.askedBy && <Who login={q.askedBy} />}
              <When at={q.createdAt} />
              <StatusBadge status="urgent" />
            </>
          }
          status={<StatusBadge status="open_question" />}
        />
      ),
    });
  }
  for (const d of o.decisions.filter((d) => d.dueForReview && d.proposedBy === login)) {
    needs.push({
      key: `r:${d.id}`,
      impact: d.impact,
      at: d.reviewAt ?? d.createdAt,
      node: (
        <ListRow
          key={`r:${d.id}`}
          href={`${base}/review-queue?tab=review-due`}
          title={d.ruleText}
          meta={
            <>
              <RefChip>{d.scopeRef}</RefChip>
              {d.reviewAt && (
                <span className="inline-flex items-center gap-1">
                  review was due <When at={d.reviewAt} />
                </span>
              )}
            </>
          }
          status={<StatusBadge status="due" />}
        />
      ),
    });
  }
  if (isPm) {
    const [r, c] = await Promise.all([getRatifications(orgId, projectId), getConflicts(orgId, projectId, "open")]);
    for (const x of r?.candidates ?? []) {
      needs.push({
        key: `rat:${x.id}`,
        impact: 2,
        at: "",
        node: (
          <ListRow
            key={`rat:${x.id}`}
            href={`${base}/review-queue?tab=ratifications`}
            title={x.ruleText}
            meta={
              <>
                <RefChip>{x.scopeRef}</RefChip>
                {x.doc.title && <span>{x.doc.title}</span>}
                {typeof x.confidence === "number" && <span>confidence {Math.round(x.confidence * 100)}%</span>}
              </>
            }
            status={<StatusBadge status="proposed" />}
            action={
              <Button asChild size="sm" variant="secondary">
                <Link href={`${base}/review-queue?tab=ratifications`}>Ratify</Link>
              </Button>
            }
          />
        ),
      });
    }
    for (const x of c?.conflicts ?? []) {
      needs.push({
        key: `c:${x.id}`,
        impact: 3,
        at: x.openedAt,
        node: (
          <ListRow
            key={`c:${x.id}`}
            href={`${base}/review-queue?tab=conflicts`}
            title={x.constraintRuleText}
            meta={
              <>
                <RefChip>{x.surface}</RefChip>
                <When at={x.openedAt} />
              </>
            }
            status={<StatusBadge status="conflict" />}
          />
        ),
      });
    }
  }
  needs.sort((a, b) => b.impact - a.impact || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const binding = o.decisions.filter((d) => d.status === "binding").length;
  const awaiting = o.decisions.filter((d) => d.status === "open").length;
  const openQ = o.questions.filter((q) => q.status !== "closed").length;
  const withConsumers = o.contracts.filter((c) => c.consumerCount > 0).length;
  const firstRun = binding + awaiting + openQ + o.contracts.length + o.tasks.length === 0;
  const sharedChanges = o.changes.filter((c) => c.riskTier === "shared").slice(0, 6);

  return (
    <>
      <PageHeader title="Home" description="What needs you, ranked by blast radius." />

      <Section label="Needs you" count={needs.length}>
        {needs.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 />}
            title="You're in lockstep."
            action={
              <Button asChild variant="ghost" size="sm">
                <Link href={`${base}/activity`}>See recent activity</Link>
              </Button>
            }
          >
            Nothing needs you right now.
          </EmptyState>
        ) : (
          needs.slice(0, 8).map((n) => n.node)
        )}
      </Section>

      {firstRun ? (
        <div className="mb-6">
          <EmptyState icon={<GitCommitHorizontal />} title="Connect a repo to start">
            From inside a repo, run <RefChip>{"npm i -g lockstep-cli"}</RefChip> then{" "}
            <RefChip>{"lockstep onboard"}</RefChip>.
          </EmptyState>
        </div>
      ) : (
        <StatGrid>
          <Stat n={binding} label="Binding decisions" href={`${base}/decisions?view=binding`} />
          <Stat n={awaiting} label="Awaiting ack" href={`${base}/decisions?view=awaiting`} />
          <Stat n={openQ} label="Open questions" href={`${base}/questions`} />
          <Stat n={withConsumers} label="Surfaces with consumers" href={`${base}/contracts`} />
        </StatGrid>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section label="Recent changes" href={`${base}/contracts`}>
          {sharedChanges.length === 0 ? (
            <EmptyState icon={<GitCommitHorizontal />} title="No shared changes yet">
              Contract changes captured from connected repos land here.
            </EmptyState>
          ) : (
            sharedChanges.map((c) => (
              <ListRow
                key={c.id}
                title={c.summary}
                meta={
                  <>
                    {c.surface && <RefChip>{c.surface}</RefChip>}
                    {c.createdBy && <Who login={c.createdBy} />}
                    <When at={c.createdAt} />
                  </>
                }
                status={<StatusBadge status={c.riskTier} />}
              />
            ))
          )}
        </Section>
        <Section label="Latest decisions" href={`${base}/decisions`}>
          {o.decisions.length === 0 ? (
            <EmptyState icon={<CheckCircle2 />} title="No decisions yet">
              Agents record binding rules via <RefChip copy={false}>propose_decision</RefChip>.
            </EmptyState>
          ) : (
            o.decisions.slice(0, 6).map((d) => (
              <ListRow
                key={d.id}
                href={`${base}/decisions/${d.id}`}
                title={d.ruleText || d.scopeRef}
                meta={
                  <>
                    <RefChip>{d.scopeRef}</RefChip>
                    {d.proposedBy && <Who login={d.proposedBy} />}
                    <When at={d.createdAt} />
                  </>
                }
                status={<StatusBadge status={d.status} origin={d.origin} />}
              />
            ))
          )}
        </Section>
      </div>
    </>
  );
}
