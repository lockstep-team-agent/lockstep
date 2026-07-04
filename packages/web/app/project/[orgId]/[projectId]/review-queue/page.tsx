import { getProposed } from "@/lib/data";
import { PageHead, EmptyState } from "@/components/ui";
import { IconQuestions } from "@/components/icons";
import { confirmDecisionAction, rejectDecisionAction } from "@/actions";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: { orgId: string; projectId: string } }) {
  const { orgId, projectId } = params;
  const data = await getProposed(orgId, projectId);
  const items = data?.decisions ?? [];

  return (
    <>
      <PageHead
        title="Review queue"
        subtitle="Decisions distilled from your connected tools. Nothing binds until you confirm it here."
      />
      {items.length === 0 ? (
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
                    <p style={{ margin: "8px 0 0", color: "var(--red, #e5484d)" }}>
                      ⚠ May supersede an existing binding decision on <span className="code-ref">{d.scopeRef}</span> — review both.
                    </p>
                  )}

                  {p.rationale && <p style={{ margin: "10px 0 0", color: "var(--muted)" }}>{p.rationale}</p>}

                  {rows.map((row, ri) => (
                    <div key={ri} style={{ marginTop: 10 }}>
                      <div className="meta" style={{ marginBottom: 4 }}>
                        <span>via {row.source}</span>
                        {row.url && (
                          <a href={row.url} target="_blank" rel="noreferrer" className="code-ref">open ↗</a>
                        )}
                      </div>
                      {(row.evidence ?? []).map((e, i) => (
                        <blockquote
                          key={i}
                          style={{
                            margin: "6px 0 0",
                            padding: "8px 12px",
                            borderLeft: "3px solid var(--violet)",
                            background: "var(--surface)",
                            borderRadius: "var(--radius-sm)",
                            color: "var(--text)",
                            fontStyle: "italic",
                          }}
                        >
                          “{e.quote}”
                        </blockquote>
                      ))}
                    </div>
                  ))}

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
      )}
    </>
  );
}
