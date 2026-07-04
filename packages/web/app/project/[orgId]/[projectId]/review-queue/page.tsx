import { getProposed, getRatifications, constraintKindLabel } from "@/lib/data";
import type { RatificationCandidate } from "@/lib/data";
import { PageHead, EmptyState, StatusPill } from "@/components/ui";
import { IconQuestions, IconDoc } from "@/components/icons";
import { EvidenceBlock } from "@/components/review/EvidenceBlock";
import { ConflictWarning } from "@/components/review/ConflictWarning";
import { Tabs } from "@/components/review/Tabs";
import { confirmDecisionAction, rejectDecisionAction, ratifyDecisionAction } from "@/actions";

export const dynamic = "force-dynamic";

export default async function Page({
  params,
  searchParams,
}: {
  params: { orgId: string; projectId: string };
  searchParams: { tab?: string };
}) {
  const { orgId, projectId } = params;
  const tab = searchParams.tab === "ratifications" ? "ratifications" : "proposed";
  const [proposedData, ratificationData] = await Promise.all([
    getProposed(orgId, projectId),
    getRatifications(orgId, projectId),
  ]);
  const items = proposedData?.decisions ?? [];
  const candidates = ratificationData?.candidates ?? [];
  const main = candidates.filter((c) => !c.lowConfidence);
  const low = candidates.filter((c) => c.lowConfidence);
  const base = `/project/${orgId}/${projectId}/review-queue`;

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
                    </div>

                    {p.supersedes && (
                      <ConflictWarning>
                        May supersede an existing binding decision on <span className="code-ref">{d.scopeRef}</span> — review both.
                      </ConflictWarning>
                    )}

                    {p.rationale && <p style={{ margin: "10px 0 0", color: "var(--muted)" }}>{p.rationale}</p>}

                    <EvidenceBlock rows={rows} />

                    <div className="meta" style={{ marginTop: 10, gap: 12 }}>
                      {p.decidedBy && p.decidedBy.length > 0 && <span>decided by {p.decidedBy.join(", ")}</span>}
                    </div>

                    <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                      <form action={confirmDecisionAction}>
                        <input type="hidden" name="orgId" value={orgId} />
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="id" value={d.id} />
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
    </>
  );
}
