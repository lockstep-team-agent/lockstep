import { getProposed, getRatifications, getConflicts, getOverview, constraintKindLabel, conflictKindLabel } from "@/lib/data";
import type { RatificationCandidate, ConflictView } from "@/lib/data";
import { PageHead, EmptyState, StatusPill } from "@/components/ui";
import { IconQuestions, IconDoc, IconDecisions } from "@/components/icons";
import { EvidenceBlock } from "@/components/review/EvidenceBlock";
import { ConflictWarning } from "@/components/review/ConflictWarning";
import { Tabs } from "@/components/review/Tabs";
import {
  confirmDecisionAction,
  rejectDecisionAction,
  ratifyDecisionAction,
  resolveConflictAction,
  reviewDecisionAction,
} from "@/actions";

export const dynamic = "force-dynamic";

export default async function Page({
  params,
  searchParams,
}: {
  params: { orgId: string; projectId: string };
  searchParams: { tab?: string };
}) {
  const { orgId, projectId } = params;
  const tab =
    searchParams.tab === "ratifications"
      ? "ratifications"
      : searchParams.tab === "conflicts"
        ? "conflicts"
        : searchParams.tab === "review-due"
          ? "review-due"
          : "proposed";
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
  const base = `/project/${orgId}/${projectId}/review-queue`;

  const renderConflict = (c: ConflictView, resolved: boolean) => (
    <div className="card animate-in" key={c.id} style={{ marginBottom: 14 }}>
      <div className="body" style={{ padding: "4px 2px" }}>
        <div className="meta" style={{ marginBottom: 8, marginTop: 0 }}>
          <span className="code-ref">{c.surface}</span>
          <span className="pill conflict">{conflictKindLabel(c.kind)}</span>
          <StatusPill status={c.status} />
        </div>

        <div className={`meta${resolved ? " resolved" : ""}`} style={{ marginTop: 6 }}>
          <IconDoc style={{ width: 15, height: 15 }} />
          <span>{c.docTitle ?? "Untitled document"}</span>
          {c.docUrl && (
            <a href={c.docUrl} target="_blank" rel="noreferrer" className="code-ref">
              Notion ↗
            </a>
          )}
        </div>
        <blockquote className="evidence">“{c.constraintRuleText}”</blockquote>

        <ConflictWarning>
          May conflict on <span className="code-ref">{c.surface}</span> — review both.
        </ConflictWarning>
        {c.engRuleText && <blockquote className="evidence plain">“{c.engRuleText}”</blockquote>}

        {c.dismissReason && (
          <p style={{ margin: "8px 0 0", color: "var(--muted)" }}>Dismissed: {c.dismissReason}</p>
        )}

        {!resolved && (
          <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
            <form action={resolveConflictAction}>
              <input type="hidden" name="orgId" value={orgId} />
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="id" value={c.id} />
              <input type="hidden" name="resolution" value="holds" />
              <button className="btn primary">Constraint holds</button>
            </form>
            <details className="collapse">
              <summary>Dismiss</summary>
              <form action={resolveConflictAction} style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                <input type="hidden" name="orgId" value={orgId} />
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="id" value={c.id} />
                <input type="hidden" name="resolution" value="dismiss" />
                <input
                  type="text"
                  name="reason"
                  className="input"
                  placeholder="Why dismiss this conflict?"
                  style={{ minWidth: 260, maxWidth: "100%" }}
                />
                <button className="btn">Dismiss</button>
              </form>
            </details>
          </div>
        )}

        {!resolved && (
          <p style={{ margin: "10px 0 0", color: "var(--muted)", fontSize: 13 }}>
            To amend the requirement, edit the PRD in Notion — Lockstep will pick it up.
          </p>
        )}
      </div>
    </div>
  );

  const renderCandidate = (c: RatificationCandidate) => {
    const conf = typeof c.confidence === "number" ? Math.round(c.confidence * 100) : null;
    return (
      <div className="card animate-in" key={c.id} style={{ marginBottom: 14 }}>
        <div className="body" style={{ padding: "4px 2px" }}>
          <div className="meta" style={{ marginBottom: 8, marginTop: 0 }}>
            <IconDoc style={{ width: 15, height: 15 }} />
            <span>{c.doc.title ?? "Untitled document"}</span>
            {c.doc.url && (
              <a href={c.doc.url} target="_blank" rel="noreferrer" className="code-ref">
                Notion ↗
              </a>
            )}
            <StatusPill status={c.doc.state} />
          </div>
          <div className="title" style={{ fontSize: 16 }}>{c.ruleText}</div>
          <div className="meta" style={{ marginTop: 6 }}>
            <span className="code-ref">{c.scopeRef}</span>
            <span className="pill plain">{c.scopeKind}</span>
            {c.constraintKind && <span className={`pill kind-${c.constraintKind}`}>{constraintKindLabel(c.constraintKind)}</span>}
            {conf !== null && <span>confidence {conf}%</span>}
          </div>

          {c.anchor.url && (
            <div className="meta" style={{ marginTop: 6 }}>
              <a href={c.anchor.url} target="_blank" rel="noreferrer">
                view in PRD{c.anchor.heading ? ` § ${c.anchor.heading}` : ""} ↗
              </a>
            </div>
          )}

          {c.conflict && (
            <>
              <ConflictWarning>
                May conflict with a binding decision on <span className="code-ref">{c.conflict.surface}</span> — review both.
              </ConflictWarning>
              <blockquote className="evidence">“{c.conflict.engRuleText}”</blockquote>
            </>
          )}

          <EvidenceBlock rows={c.provenances ?? []} />

          <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
            <form action={ratifyDecisionAction}>
              <input type="hidden" name="orgId" value={orgId} />
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="id" value={c.id} />
              <input type="hidden" name="originalRuleText" value={c.ruleText} />
              <details className="collapse" style={{ marginBottom: 8 }}>
                <summary>Edit rule text</summary>
                <textarea
                  name="ruleText"
                  className="input"
                  rows={3}
                  defaultValue={c.ruleText}
                  style={{ marginTop: 8, minWidth: 380, maxWidth: "100%" }}
                />
              </details>
              {c.canRatify ? (
                <button className="btn primary">Ratify</button>
              ) : (
                <span className="tip" data-tip={c.blockedReason ?? "Ratification unavailable"}>
                  <button className="btn primary" disabled>Ratify</button>
                </span>
              )}
            </form>
            <form action={rejectDecisionAction}>
              <input type="hidden" name="orgId" value={orgId} />
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="id" value={c.id} />
              <button className="btn">Reject</button>
            </form>
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <PageHead
        title="Review queue"
        subtitle="Decisions distilled from your connected tools. Nothing binds until you confirm it here."
      />
      <Tabs
        active={tab}
        tabs={[
          { key: "proposed", label: "Proposed", href: base, count: items.length },
          { key: "ratifications", label: "Ratifications", href: `${base}?tab=ratifications`, count: candidates.length },
          { key: "conflicts", label: "Conflicts", href: `${base}?tab=conflicts`, count: openConflicts.length },
          { key: "review-due", label: "Review due", href: `${base}?tab=review-due`, count: reviewDue.length },
        ]}
      />

      {tab === "proposed" &&
        (items.length === 0 ? (
          <EmptyState icon={<IconQuestions />} title="Nothing to review">
            When a sweep distills a decision from an allowlisted Slack channel, it lands here as a draft with
            the exact quote it came from.
          </EmptyState>
        ) : (
          <div className="rows stagger">
            {items.map((d) => {
              const p = d.provenance ?? {};
              const conf = typeof p.confidence === "number" ? Math.round(p.confidence * 100) : null;
              // Prefer the fused provenance rows (one decision, many sources); fall back to the version's.
              const rows =
                d.provenances && d.provenances.length > 0
                  ? d.provenances
                  : [{ source: p.source ?? "source", externalId: null, url: p.url ?? null, evidence: p.evidence ?? [], confidence: null }];
              return (
                <div className="card animate-in" key={d.id} style={{ marginBottom: 14 }}>
                  <div className="body" style={{ padding: "4px 2px" }}>
                    <div className="title" style={{ fontSize: 16 }}>{d.ruleText}</div>
                    <div className="meta" style={{ marginTop: 6 }}>
                      <span className="code-ref">{d.scopeRef}</span>
                      <span className="pill plain">{d.scopeKind}</span>
                      <span className="pill plain">{d.decisionType}</span>
                      {conf !== null && <span>confidence {conf}%</span>}
                      {rows.length > 1 && <span className="pill plain">{rows.length} sources</span>}
                      {d.stale && (
                        <span className="pill conflict tip" data-tip="Waiting past the project's review window — agents are working without this rule.">
                          stale · {d.ageDays}d
                        </span>
                      )}
                    </div>

                    {p.supersedes && (
                      <ConflictWarning>
                        May supersede an existing binding decision on <span className="code-ref">{d.scopeRef}</span> — review both.
                      </ConflictWarning>
                    )}

                    {(d.rationale ?? p.rationale) && (
                      <p style={{ margin: "10px 0 0", color: "var(--muted)" }}>{d.rationale ?? p.rationale}</p>
                    )}
                    {(d.alternatives ?? p.alternatives)?.length ? (
                      <div className="meta" style={{ marginTop: 6 }}>
                        <span>alternatives considered: {(d.alternatives ?? p.alternatives)!.join(" · ")}</span>
                      </div>
                    ) : null}
                    {p.reviewHint && !d.reviewAt && (
                      <div className="meta" style={{ marginTop: 6 }}>
                        <span className="tip" data-tip="The team said to revisit this, but gave no date — set one below before confirming.">
                          revisit hint: “{p.reviewHint}”
                        </span>
                      </div>
                    )}

                    <EvidenceBlock rows={rows} />

                    <div className="meta" style={{ marginTop: 10, gap: 12 }}>
                      {p.decidedBy && p.decidedBy.length > 0 && <span>decided by {p.decidedBy.join(", ")}</span>}
                      {d.reviewAt && <span>review on {new Date(d.reviewAt).toLocaleDateString()}</span>}
                    </div>

                    <div style={{ display: "flex", gap: 8, marginTop: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
                      <form action={confirmDecisionAction}>
                        <input type="hidden" name="orgId" value={orgId} />
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="id" value={d.id} />
                        <input type="hidden" name="originalRuleText" value={d.ruleText} />
                        <details className="collapse" style={{ marginBottom: 8 }}>
                          <summary>Edit before confirming</summary>
                          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                            <textarea
                              name="ruleText"
                              className="input"
                              rows={2}
                              defaultValue={d.ruleText}
                              style={{ minWidth: 380, maxWidth: "100%" }}
                            />
                            <textarea
                              name="rationale"
                              className="input"
                              rows={2}
                              placeholder="Rationale — why this rule?"
                              defaultValue={d.rationale ?? p.rationale ?? ""}
                              style={{ minWidth: 380, maxWidth: "100%" }}
                            />
                            <label className="meta" style={{ gap: 8 }}>
                              <span>review on</span>
                              <input type="date" name="reviewAt" className="input" />
                            </label>
                          </div>
                        </details>
                        <button className="btn primary">Confirm</button>
                      </form>
                      <form action={rejectDecisionAction}>
                        <input type="hidden" name="orgId" value={orgId} />
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="id" value={d.id} />
                        <button className="btn">Reject</button>
                      </form>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}

      {tab === "ratifications" &&
        (candidates.length === 0 ? (
          <EmptyState icon={<IconDoc />} title="No constraints awaiting ratification">
            When a sweep extracts product constraints from a PRD in Notion, they land here for a PM to
            ratify — with the exact section they came from.
          </EmptyState>
        ) : (
          <>
            <div className="rows stagger">{main.map(renderCandidate)}</div>
            {low.length > 0 && (
              <details className="collapse animate-in" style={{ marginTop: 10 }}>
                <summary>Low confidence ({low.length})</summary>
                <div className="rows" style={{ marginTop: 10 }}>{low.map(renderCandidate)}</div>
              </details>
            )}
          </>
        ))}

      {tab === "conflicts" &&
        (openConflicts.length === 0 && recentlyResolved.length === 0 ? (
          <EmptyState icon={<IconQuestions />} title="No conflicts 🎉">
            When an engineering decision lands on a surface a ratified constraint governs, it shows up here.
          </EmptyState>
        ) : (
          <>
            <div className="rows stagger">{openConflicts.map((c) => renderConflict(c, false))}</div>
            {recentlyResolved.length > 0 && (
              <details className="collapse animate-in" style={{ marginTop: 10 }}>
                <summary>Recently resolved ({recentlyResolved.length})</summary>
                <div className="rows" style={{ marginTop: 10 }}>{recentlyResolved.map((c) => renderConflict(c, true))}</div>
              </details>
            )}
          </>
        ))}

      {tab === "review-due" &&
        (reviewDue.length === 0 ? (
          <EmptyState icon={<IconDecisions />} title="Nothing due for review">
            A binding decision with a review date (“revisit in 30 days”) lands here when the date passes.
            It stays binding — this is a nudge, not an expiry.
          </EmptyState>
        ) : (
          <div className="rows stagger">
            {reviewDue.map((d) => {
              const snooze = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
              return (
                <div className="card animate-in" key={d.id} style={{ marginBottom: 14 }}>
                  <div className="body" style={{ padding: "4px 2px" }}>
                    <div className="title" style={{ fontSize: 16 }}>{d.ruleText || d.scopeRef}</div>
                    {d.rationale && <p style={{ margin: "6px 0 0", color: "var(--muted)" }}>{d.rationale}</p>}
                    <div className="meta" style={{ marginTop: 6 }}>
                      <span className="code-ref">{d.scopeRef}</span>
                      <span className="pill plain">{d.scopeKind}</span>
                      {d.reviewAt && <span>review was due {new Date(d.reviewAt).toLocaleDateString()}</span>}
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                      <form action={reviewDecisionAction}>
                        <input type="hidden" name="orgId" value={orgId} />
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="id" value={d.id} />
                        {/* no reviewAt → clears the tripwire */}
                        <button className="btn primary">Still right — mark reviewed</button>
                      </form>
                      <form action={reviewDecisionAction}>
                        <input type="hidden" name="orgId" value={orgId} />
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="id" value={d.id} />
                        <input type="hidden" name="reviewAt" value={snooze} />
                        <button className="btn">Snooze 30d</button>
                      </form>
                    </div>
                    <p style={{ margin: "10px 0 0", color: "var(--muted)", fontSize: 13 }}>
                      No longer right? Have an agent (or a teammate) propose the replacement — confirming it
                      will supersede this one.
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
    </>
  );
}
