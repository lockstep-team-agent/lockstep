import { Inbox, FileText, AlertTriangle, CheckCircle2 } from "lucide-react";
import type { ReactNode } from "react";
import {
  getProposed,
  getRatifications,
  getConflicts,
  getOverview,
  constraintKindLabel,
  conflictKindLabel,
  type RatificationCandidate,
  type ConflictView,
  type ProvenanceRow,
} from "@/lib/data";
import { PageHeader } from "@/components/PageHeader";
import { LinkTabs } from "@/components/LinkTabs";
import { StatusBadge } from "@/components/StatusBadge";
import { RefChip } from "@/components/RefChip";
import { When } from "@/components/When";
import { EmptyState } from "@/components/EmptyState";
import { EvidenceQuote } from "@/components/EvidenceQuote";
import { Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  confirmDecisionAction,
  rejectDecisionAction,
  ratifyDecisionAction,
  resolveConflictAction,
  reviewDecisionAction,
} from "@/actions";

export const dynamic = "force-dynamic";

type Tab = "proposed" | "ratifications" | "conflicts" | "review-due";
const TABS: Tab[] = ["proposed", "ratifications", "conflicts", "review-due"];

function Warning({ children }: { children: ReactNode }) {
  return (
    <p className="mt-2 flex items-start gap-1.5 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function Collapsible({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group">
      <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">
        {summary}
      </summary>
      <div className="mt-3 grid gap-3">{children}</div>
    </details>
  );
}

function Evidence({ rows }: { rows: ProvenanceRow[] }) {
  return (
    <>
      {rows.map((row, ri) =>
        (row.evidence ?? []).length > 0 ? (
          (row.evidence ?? []).map((e, i) => (
            <EvidenceQuote
              key={`${ri}:${i}`}
              quote={e.quote}
              source={row.source}
              url={row.url}
              confidence={row.confidence}
            />
          ))
        ) : (
          <div key={ri} className="mt-2 text-xs text-muted-foreground">
            via {row.source}
            {row.url && (
              <a href={row.url} target="_blank" rel="noreferrer" className="ml-2 hover:text-foreground">
                open ↗
              </a>
            )}
          </div>
        ),
      )}
    </>
  );
}

export default async function Page({
  params,
  searchParams,
}: {
  params: { orgId: string; projectId: string };
  searchParams: { tab?: string };
}) {
  const { orgId, projectId } = params;
  const base = `/project/${orgId}/${projectId}/review-queue`;
  const [proposedData, ratificationData, conflictData, overview] = await Promise.all([
    getProposed(orgId, projectId),
    getRatifications(orgId, projectId),
    getConflicts(orgId, projectId),
    getOverview(orgId, projectId),
  ]);
  const items = proposedData?.decisions ?? [];
  const reviewDue = (overview?.decisions ?? []).filter((d) => d.dueForReview);
  const candidates = ratificationData?.candidates ?? [];
  const main = candidates.filter((c) => !c.lowConfidence);
  const low = candidates.filter((c) => c.lowConfidence);
  const conflicts = conflictData?.conflicts ?? [];
  const openConflicts = conflicts.filter((c) => c.status === "open");
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const recentlyResolved = conflicts.filter(
    (c) => c.status !== "open" && c.resolvedAt !== null && Date.now() - new Date(c.resolvedAt).getTime() <= SEVEN_DAYS,
  );

  const counts: Record<Tab, number> = {
    proposed: items.length,
    ratifications: candidates.length,
    conflicts: openConflicts.length,
    "review-due": reviewDue.length,
  };
  // Open on the first tab that has items (spec §5.4) unless the URL names one.
  const requested = TABS.includes(searchParams.tab as Tab) ? (searchParams.tab as Tab) : undefined;
  const tab: Tab = requested ?? TABS.find((t) => counts[t] > 0) ?? "proposed";

  const hidden = (id: string) => (
    <>
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="id" value={id} />
    </>
  );

  const RejectDialog = ({ id, what }: { id: string; what: string }) => (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="destructive">
          Reject
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject this {what}?</DialogTitle>
          <DialogDescription>It stays in history as rejected and never binds.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <form action={rejectDecisionAction}>
            {hidden(id)}
            <DialogClose asChild>
              <Button type="submit" variant="destructive">
                Reject
              </Button>
            </DialogClose>
          </form>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const renderConflict = (c: ConflictView, resolved: boolean) => (
    <Card key={c.id} className="shadow-none">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <RefChip>{c.surface}</RefChip>
          <RefChip copy={false}>{conflictKindLabel(c.kind)}</RefChip>
          <StatusBadge status={c.status === "open" ? "conflict" : c.status} />
          <When at={c.openedAt} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <FileText className="h-4 w-4" aria-hidden />
          <span>{c.docTitle ?? "Untitled document"}</span>
          {c.docUrl && (
            <a href={c.docUrl} target="_blank" rel="noreferrer" className="hover:text-foreground">
              open ↗
            </a>
          )}
        </div>
        <EvidenceQuote quote={c.constraintRuleText} />
        <Warning>
          May conflict on <RefChip copy={false}>{c.surface}</RefChip> — review both.
        </Warning>
        {c.engRuleText && <EvidenceQuote quote={c.engRuleText} source="engineering decision" />}
        {c.dismissReason && <p className="mt-2 text-sm text-muted-foreground">Dismissed: {c.dismissReason}</p>}
        {!resolved && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <form action={resolveConflictAction}>
              {hidden(c.id)}
              <input type="hidden" name="resolution" value="holds" />
              <Button size="sm">Constraint holds</Button>
            </form>
            <Dialog>
              <DialogTrigger asChild>
                <Button size="sm" variant="destructive">
                  Dismiss
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Dismiss this conflict?</DialogTitle>
                  <DialogDescription>
                    Say why so the extraction can be tuned. Dismissals show up in Insights.
                  </DialogDescription>
                </DialogHeader>
                <form action={resolveConflictAction} className="grid gap-3">
                  {hidden(c.id)}
                  <input type="hidden" name="resolution" value="dismiss" />
                  <Field label="Reason" htmlFor={`dismiss-${c.id}`}>
                    <Input id={`dismiss-${c.id}`} name="reason" placeholder="Why is this not a real conflict?" />
                  </Field>
                  <DialogFooter>
                    <Button variant="destructive">Dismiss</Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
            <span className="text-xs text-muted-foreground">
              To amend the requirement, edit the PRD — Lockstep picks it up.
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );

  const renderCandidate = (c: RatificationCandidate) => (
    <Card key={c.id} className="shadow-none">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <FileText className="h-4 w-4" aria-hidden />
          <span>{c.doc.title ?? "Untitled document"}</span>
          {c.doc.url && (
            <a href={c.doc.url} target="_blank" rel="noreferrer" className="hover:text-foreground">
              open ↗
            </a>
          )}
          <StatusBadge status={c.doc.state} />
        </div>
        <div className="mt-2 text-lg font-medium leading-6">{c.ruleText}</div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <RefChip kind={c.scopeKind}>{c.scopeRef}</RefChip>
          {c.constraintKind && <RefChip copy={false}>{constraintKindLabel(c.constraintKind)}</RefChip>}
          {typeof c.confidence === "number" && <span>confidence {Math.round(c.confidence * 100)}%</span>}
          {c.anchor.url && (
            <a href={c.anchor.url} target="_blank" rel="noreferrer" className="hover:text-foreground">
              view in PRD{c.anchor.heading ? ` § ${c.anchor.heading}` : ""} ↗
            </a>
          )}
        </div>
        {c.conflict && (
          <>
            <Warning>
              May conflict with a binding decision on <RefChip copy={false}>{c.conflict.surface}</RefChip> — review
              both.
            </Warning>
            <EvidenceQuote quote={c.conflict.engRuleText} source="engineering decision" />
          </>
        )}
        <Evidence rows={c.provenances ?? []} />
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <form action={ratifyDecisionAction} className="grid gap-3">
            {hidden(c.id)}
            <input type="hidden" name="originalRuleText" value={c.ruleText} />
            <Collapsible summary="Edit rule text before ratifying">
              <Textarea name="ruleText" rows={3} defaultValue={c.ruleText} className="min-w-80" />
            </Collapsible>
            {c.canRatify ? (
              <Button size="sm">Ratify</Button>
            ) : (
              <Button size="sm" disabled title={c.blockedReason ?? "Ratification unavailable"}>
                Ratify
              </Button>
            )}
          </form>
          <RejectDialog id={c.id} what="constraint" />
        </div>
      </CardContent>
    </Card>
  );

  return (
    <>
      <PageHeader
        title="Review queue"
        description="Everything that needs a human before it binds — distilled decisions, PRD constraints, conflicts, and review tripwires."
        tabs={
          <LinkTabs
            active={tab}
            tabs={[
              { key: "proposed", label: "Proposed", href: `${base}?tab=proposed`, count: counts.proposed },
              {
                key: "ratifications",
                label: "Ratifications",
                href: `${base}?tab=ratifications`,
                count: counts.ratifications,
              },
              { key: "conflicts", label: "Conflicts", href: `${base}?tab=conflicts`, count: counts.conflicts },
              { key: "review-due", label: "Review due", href: `${base}?tab=review-due`, count: counts["review-due"] },
            ]}
          />
        }
      />

      {tab === "proposed" &&
        (items.length === 0 ? (
          <EmptyState icon={<Inbox />} title="Nothing to review">
            When a sweep distills a decision from an allowlisted Slack channel, it lands here as a draft with the exact
            quote it came from.
          </EmptyState>
        ) : (
          <div className="grid gap-4">
            {items.map((d) => {
              const p = d.provenance ?? {};
              const conf = typeof p.confidence === "number" ? Math.round(p.confidence * 100) : null;
              const rows: ProvenanceRow[] =
                d.provenances && d.provenances.length > 0
                  ? d.provenances
                  : [
                      {
                        source: p.source ?? "source",
                        externalId: null,
                        url: p.url ?? null,
                        evidence: p.evidence ?? [],
                        confidence: null,
                      },
                    ];
              return (
                <Card key={d.id} className="shadow-none">
                  <CardContent className="p-4">
                    <div className="text-lg font-medium leading-6">{d.ruleText}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <RefChip kind={d.scopeKind}>{d.scopeRef}</RefChip>
                      <RefChip copy={false}>{d.decisionType}</RefChip>
                      {conf !== null && <span>confidence {conf}%</span>}
                      {rows.length > 1 && <RefChip copy={false}>{`${rows.length} sources`}</RefChip>}
                      {d.stale && <StatusBadge status="stale" />}
                      {d.stale && <span>{d.ageDays}d waiting</span>}
                      <When at={d.createdAt} />
                    </div>
                    {p.supersedes && (
                      <Warning>
                        May supersede an existing binding decision on <RefChip copy={false}>{d.scopeRef}</RefChip> —
                        review both.
                      </Warning>
                    )}
                    {(d.rationale ?? p.rationale) && (
                      <p className="mt-3 text-sm text-muted-foreground">{d.rationale ?? p.rationale}</p>
                    )}
                    {(d.alternatives ?? p.alternatives)?.length ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Alternatives considered: {(d.alternatives ?? p.alternatives)!.join(" · ")}
                      </p>
                    ) : null}
                    {p.reviewHint && !d.reviewAt && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Revisit hint from the team: “{p.reviewHint}” — set a date below before confirming.
                      </p>
                    )}
                    <Evidence rows={rows} />
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      {p.decidedBy && p.decidedBy.length > 0 && <span>decided by {p.decidedBy.join(", ")}</span>}
                      {d.reviewAt && <span>review on {new Date(d.reviewAt).toLocaleDateString("en-GB")}</span>}
                    </div>
                    <div className="mt-4 flex flex-wrap items-end gap-2">
                      <form action={confirmDecisionAction} className="grid gap-3">
                        {hidden(d.id)}
                        <input type="hidden" name="originalRuleText" value={d.ruleText} />
                        <Collapsible summary="Edit before confirming">
                          <Field label="Rule text" htmlFor={`rule-${d.id}`}>
                            <Textarea
                              id={`rule-${d.id}`}
                              name="ruleText"
                              rows={2}
                              defaultValue={d.ruleText}
                              className="min-w-80"
                            />
                          </Field>
                          <Field label="Rationale" htmlFor={`rat-${d.id}`}>
                            <Textarea
                              id={`rat-${d.id}`}
                              name="rationale"
                              rows={2}
                              defaultValue={d.rationale ?? p.rationale ?? ""}
                              className="min-w-80"
                            />
                          </Field>
                          <Field label="Review on" htmlFor={`rev-${d.id}`}>
                            <Input id={`rev-${d.id}`} type="date" name="reviewAt" className="w-48" />
                          </Field>
                        </Collapsible>
                        <Button size="sm">Confirm</Button>
                      </form>
                      <RejectDialog id={d.id} what="proposal" />
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ))}

      {tab === "ratifications" &&
        (candidates.length === 0 ? (
          <EmptyState icon={<FileText />} title="No constraints awaiting ratification">
            When a sweep extracts product constraints from a PRD, they land here for a PM to ratify — with the exact
            section they came from.
          </EmptyState>
        ) : (
          <div className="grid gap-4">
            {main.map(renderCandidate)}
            {low.length > 0 && (
              <Collapsible summary={`Low confidence (${low.length})`}>{low.map(renderCandidate)}</Collapsible>
            )}
          </div>
        ))}

      {tab === "conflicts" &&
        (openConflicts.length === 0 && recentlyResolved.length === 0 ? (
          <EmptyState icon={<CheckCircle2 />} title="No conflicts">
            When an engineering decision lands on a surface a ratified constraint governs, it shows up here.
          </EmptyState>
        ) : (
          <div className="grid gap-4">
            {openConflicts.map((c) => renderConflict(c, false))}
            {recentlyResolved.length > 0 && (
              <Collapsible summary={`Recently resolved (${recentlyResolved.length})`}>
                {recentlyResolved.map((c) => renderConflict(c, true))}
              </Collapsible>
            )}
          </div>
        ))}

      {tab === "review-due" &&
        (reviewDue.length === 0 ? (
          <EmptyState icon={<CheckCircle2 />} title="Nothing due for review">
            A binding decision with a review date lands here when the date passes. It stays binding — this is a nudge,
            not an expiry.
          </EmptyState>
        ) : (
          <div className="grid gap-4">
            {reviewDue.map((d) => {
              const snooze = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
              return (
                <Card key={d.id} className="shadow-none">
                  <CardContent className="p-4">
                    <div className="text-lg font-medium leading-6">{d.ruleText || d.scopeRef}</div>
                    {d.rationale && <p className="mt-2 text-sm text-muted-foreground">{d.rationale}</p>}
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <RefChip kind={d.scopeKind}>{d.scopeRef}</RefChip>
                      <StatusBadge status="due" />
                      {d.reviewAt && (
                        <span className="inline-flex items-center gap-1">
                          due <When at={d.reviewAt} />
                        </span>
                      )}
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <form action={reviewDecisionAction}>
                        {hidden(d.id)}
                        <Button size="sm">Still right — mark reviewed</Button>
                      </form>
                      <form action={reviewDecisionAction}>
                        {hidden(d.id)}
                        <input type="hidden" name="reviewAt" value={snooze} />
                        <Button size="sm" variant="secondary">
                          Snooze 30 days
                        </Button>
                      </form>
                      <span className="text-xs text-muted-foreground">
                        No longer right? Propose a replacement from its detail page — confirming it supersedes this one.
                      </span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        ))}
    </>
  );
}
