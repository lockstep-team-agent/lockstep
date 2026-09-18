import Link from "next/link";
import { notFound } from "next/navigation";
import { GitFork, Users, FileText, History, AlertTriangle } from "lucide-react";
import { getDecisionDetail, getOverview } from "@/lib/data";
import { PageHeader } from "@/components/PageHeader";
import { ListRow } from "@/components/ListRow";
import { StatusBadge } from "@/components/StatusBadge";
import { RefChip } from "@/components/RefChip";
import { Who } from "@/components/Who";
import { When } from "@/components/When";
import { Section } from "@/components/Section";
import { EmptyState } from "@/components/EmptyState";
import { EvidenceQuote } from "@/components/EvidenceQuote";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ackDecisionAction, confirmDecisionAction, rejectDecisionAction, ratifyDecisionAction } from "@/actions";
import { ProposeVersionSheet } from "./ProposeVersionSheet";

export const dynamic = "force-dynamic";

const shortRepo = (remote: string | null) => (remote ? remote.split("/").slice(-2).join("/") : "repo");

export default async function Page({ params }: { params: { orgId: string; projectId: string; id: string } }) {
  const { orgId, projectId, id } = params;
  const base = `/project/${orgId}/${projectId}`;
  const [d, o] = await Promise.all([getDecisionDetail(orgId, projectId, id), getOverview(orgId, projectId)]);
  if (!d) notFound();

  const role = o?.viewer?.role ?? "member";
  const canModerate = role === "owner" || role === "pm";
  const awaitingAck = d.status === "open";
  const ingestedProposal = d.origin === "ingested" && d.status === "proposed" && canModerate;
  const documentProposal = d.origin === "document" && d.status === "proposed" && canModerate;
  const reviewDue = d.status === "binding" && d.reviewAt && new Date(d.reviewAt).getTime() < Date.now();
  const hidden = (
    <>
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="id" value={d.id} />
    </>
  );

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Decisions", href: `${base}/decisions` }, { label: d.scopeRef }]}
        title={<span className="whitespace-normal">{d.ruleText || d.scopeRef}</span>}
        description={
          <div className="flex flex-wrap items-center gap-2">
            <RefChip kind={d.scopeKind}>{d.scopeRef}</RefChip>
            <RefChip copy={false}>{d.decisionType}</RefChip>
            {d.origin !== "agent" && <RefChip copy={false}>{d.origin}</RefChip>}
            <StatusBadge status={d.status} origin={d.origin} />
            {d.impact > 0 && <RefChip copy={false}>{`impact ${d.impact}`}</RefChip>}
            {reviewDue && <StatusBadge status="due" />}
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              v{d.currentVersion}
              {d.proposedBy && (
                <>
                  <span>·</span>
                  <Who login={d.proposedBy} />
                </>
              )}
              <span>·</span>
              <When at={d.createdAt} />
            </span>
          </div>
        }
        actions={
          <>
            {awaitingAck && (
              <form action={ackDecisionAction}>
                {hidden}
                <input type="hidden" name="version" value={d.currentVersion} />
                <Button size="sm">Acknowledge</Button>
              </form>
            )}
            {ingestedProposal && (
              <form action={confirmDecisionAction}>
                {hidden}
                <input type="hidden" name="originalRuleText" value={d.ruleText} />
                <Button size="sm">Confirm</Button>
              </form>
            )}
            {documentProposal && (
              <form action={ratifyDecisionAction}>
                {hidden}
                <input type="hidden" name="originalRuleText" value={d.ruleText} />
                <Button size="sm">Ratify</Button>
              </form>
            )}
            {(ingestedProposal || documentProposal) && (
              <Dialog>
                <DialogTrigger asChild>
                  <Button size="sm" variant="destructive">
                    Reject
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Reject this proposal?</DialogTitle>
                    <DialogDescription>
                      It stays in history as rejected and never binds. Sources that re-surface it are deduplicated.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <form action={rejectDecisionAction}>
                      {hidden}
                      <Button variant="destructive">Reject</Button>
                    </form>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}
            {d.status === "binding" && (
              <ProposeVersionSheet
                orgId={orgId}
                projectId={projectId}
                id={d.id}
                scopeKind={d.scopeKind}
                scopeRef={d.scopeRef}
                decisionType={d.decisionType}
                baseVersion={d.currentVersion}
                ruleText={d.ruleText}
                rationale={d.rationale}
              />
            )}
          </>
        }
      />

      {(d.rationale || (d.alternatives && d.alternatives.length > 0) || d.reviewAt) && (
        <Section label="Rationale" bare>
          <Card className="shadow-none">
            <CardContent className="grid gap-4 p-4 text-sm">
              {d.rationale && <p className="text-foreground/90">{d.rationale}</p>}
              {d.alternatives && d.alternatives.length > 0 && (
                <div>
                  <div className="mb-1 text-2xs font-semibold uppercase text-muted-foreground">
                    Alternatives considered
                  </div>
                  <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                    {d.alternatives.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                </div>
              )}
              {d.reviewAt && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <span>Review on {new Date(d.reviewAt).toLocaleDateString()}</span>
                  {reviewDue && <StatusBadge status="due" />}
                </div>
              )}
            </CardContent>
          </Card>
        </Section>
      )}

      <Section label="Blast radius" count={d.consumers.length}>
        {d.consumers.length === 0 ? (
          <EmptyState icon={<GitFork />} title="No declared consumers">
            {d.scopeKind === "surface"
              ? "Own-area decision, bound on assertion. Consumers appear as repos declare this surface in lockstep.yaml."
              : "Topic- and capability-scoped decisions get their reach from the org graph."}
          </EmptyState>
        ) : (
          <>
            {d.consumers.map((c) => (
              <ListRow
                key={c.repoId}
                leading={<GitFork />}
                title={<span className="font-mono text-sm">{shortRepo(c.gitRemote)}</span>}
                meta={
                  <>
                    {c.project && (
                      <RefChip copy={false} href={`/project/${orgId}/${c.project.id}`}>
                        {c.project.name}
                      </RefChip>
                    )}
                    <span>via {c.source}</span>
                  </>
                }
              />
            ))}
            {d.sameSurfaceBinding > 0 && (
              <div className="border-t px-4 py-2 text-xs text-muted-foreground">
                {d.sameSurfaceBinding} other binding decision{d.sameSurfaceBinding === 1 ? "" : "s"} on this surface.
              </div>
            )}
          </>
        )}
      </Section>

      <Section label="Agreement" count={d.approvals.length}>
        {d.approvals.length === 0 && d.requiredReviewers.length === 0 ? (
          <EmptyState icon={<Users />} title="No acknowledgements yet">
            {awaitingAck ? "Waiting for an affected team to acknowledge." : "Own-area decisions bind without acks."}
          </EmptyState>
        ) : (
          <>
            {d.approvals.map((a, i) => (
              <ListRow
                key={i}
                title={
                  <span className="inline-flex items-center gap-2">
                    {a.reviewer ? <Who login={a.reviewer} /> : "Unknown"}{" "}
                    <span className="text-muted-foreground">·</span> {a.verdict}
                  </span>
                }
                meta={
                  <>
                    <RefChip copy={false}>{`v${a.version}`}</RefChip>
                    {a.comment && <span>{a.comment}</span>}
                    <When at={a.createdAt} />
                  </>
                }
                status={<StatusBadge status={a.verdict === "ack" ? "confirmed" : a.verdict} />}
              />
            ))}
            {d.requiredReviewers
              .filter((r) => r.reviewer && !d.approvals.some((a) => a.reviewer === r.reviewer))
              .map((r) => (
                <ListRow
                  key={r.reviewer!}
                  title={<Who login={r.reviewer!} />}
                  meta={<span>required reviewer</span>}
                  status={<StatusBadge status="pending" />}
                />
              ))}
          </>
        )}
      </Section>

      {d.provenances.length > 0 && (
        <Section label="Provenance" count={d.provenances.length} bare>
          <Card className="shadow-none">
            <CardContent className="p-4">
              {d.provenances.map((p, i) =>
                (p.evidence ?? []).length > 0 ? (
                  (p.evidence ?? []).map((e, j) => (
                    <EvidenceQuote
                      key={`${i}:${j}`}
                      quote={e.quote}
                      source={p.source}
                      url={p.url}
                      confidence={p.confidence}
                    />
                  ))
                ) : (
                  <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <FileText className="h-4 w-4" /> via {p.source}
                    {p.url && (
                      <a href={p.url} target="_blank" rel="noreferrer" className="hover:text-foreground">
                        open ↗
                      </a>
                    )}
                  </div>
                ),
              )}
            </CardContent>
          </Card>
        </Section>
      )}

      <Section label="History" count={d.versions.length}>
        {d.versions.map((v) => (
          <ListRow
            key={v.version}
            leading={<History />}
            title={
              <span>
                <span className="mr-2 font-mono text-xs text-muted-foreground">v{v.version}</span>
                {v.ruleText}
              </span>
            }
            meta={
              <>
                {v.proposedBy && <Who login={v.proposedBy} />}
                <When at={v.createdAt} />
              </>
            }
            status={<StatusBadge status={v.version === d.currentVersion ? d.status : v.status} origin={d.origin} />}
          />
        ))}
        {d.lineage.supersededBy && (
          <ListRow
            href={`${base}/decisions/${d.lineage.supersededBy.id}`}
            title={<span>Superseded by “{d.lineage.supersededBy.ruleText}”</span>}
            status={<StatusBadge status={d.lineage.supersededBy.status} />}
          />
        )}
        {d.lineage.supersedes.map((s) => (
          <ListRow
            key={s.id}
            href={`${base}/decisions/${s.id}`}
            title={<span>Supersedes “{s.ruleText}”</span>}
            status={<StatusBadge status={s.status} />}
          />
        ))}
        {d.conflicts.map((c) => (
          <ListRow
            key={c.id}
            href={`${base}/review-queue?tab=conflicts`}
            leading={<AlertTriangle className="text-destructive" />}
            title={
              <span>
                {c.kind === "drift" ? "Drift" : "Pre-approval"} conflict on{" "}
                <span className="font-mono text-sm">{c.surface}</span>
              </span>
            }
            status={<StatusBadge status={c.status === "open" ? "conflict" : c.status} />}
          />
        ))}
      </Section>

      <p className="text-xs text-muted-foreground">
        <Link href={`${base}/decisions`} className="hover:text-foreground">
          ← All decisions
        </Link>
      </p>
    </>
  );
}
