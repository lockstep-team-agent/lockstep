import Link from "next/link";
import { getFeature, constraintKindLabel, type ConstraintKind } from "@/lib/data";
import { PageHead, EmptyState, StatusPill, Stat } from "@/components/ui";
import { IconFeature } from "@/components/icons";
import { confirmGovernsEdgeAction, rejectGovernsEdgeAction } from "@/actions";

export const dynamic = "force-dynamic";

export default async function Page({
  params,
}: {
  params: { orgId: string; projectId: string; ref: string };
}) {
  const { orgId, projectId, ref } = params;
  const feature = await getFeature(orgId, projectId, decodeURIComponent(ref));
  const base = `/project/${orgId}/${projectId}`;

  if (!feature) {
    return (
      <>
        <PageHead title="Feature" />
        <EmptyState icon={<IconFeature />} title="Feature not found">
          It may have been removed, or core hasn&apos;t minted this capability yet.{" "}
          <Link href={`${base}/features`}>Back to Features</Link>.
        </EmptyState>
      </>
    );
  }

  const { doc, coverage } = feature;
  const constraints = feature.constraints ?? [];
  const surfaces = feature.governedSurfaces ?? [];
  const governedConfirmed = surfaces.filter((s) => s.status === "confirmed").length;

  return (
    <>
      <PageHead
        title={feature.label ?? feature.ref}
        subtitle="How the build reconciles against this capability's ratified constraints."
      />

      <div className="card animate-in">
        <div className="rows">
          <div className="row">
            <IconFeature style={{ width: 18, height: 18, color: "var(--dim)", marginTop: 2 }} />
            <div className="body">
              <div className="title">{feature.label ?? feature.ref}</div>
              <div className="meta">
                <span className="code-ref">{feature.ref}</span>
              </div>
            </div>
            {doc?.url && (
              <a href={doc.url} target="_blank" rel="noreferrer" className="btn ghost">
                Notion ↗
              </a>
            )}
            {doc && <StatusPill status={doc.state} />}
          </div>
        </div>
      </div>

      <div className="stats">
        <Stat
          n={`${coverage.constraintsWithActivity}/${coverage.totalConstraints}`}
          label="constraints with activity"
          icon={<IconFeature />}
        />
        <Stat n={coverage.openConflicts} label="open conflicts" icon={<IconFeature />} />
        <Stat n={governedConfirmed} label="governed surfaces" icon={<IconFeature />} />
      </div>

      <div className="section-title">Constraints</div>
      {constraints.length === 0 ? (
        <EmptyState icon={<IconFeature />} title="No constraints yet">
          Constraints ratified against this capability appear here.
        </EmptyState>
      ) : (
        <div className="card animate-in">
          <div className="rows stagger">
            {constraints.map((c) => (
              <div className="row" key={c.id}>
                <div className="body">
                  <div className="title">{c.ruleText}</div>
                  <div className="meta">
                    <span className="code-ref">{c.scopeRef}</span>
                    {c.constraintKind && (
                      <span className={`pill kind-${c.constraintKind}`}>
                        {constraintKindLabel(c.constraintKind as ConstraintKind)}
                      </span>
                    )}
                    {c.anchorUrl && (
                      <a className="code-ref" href={c.anchorUrl} target="_blank" rel="noreferrer">
                        view in PRD ↗
                      </a>
                    )}
                  </div>
                </div>
                <StatusPill status={c.conflict ? "conflict" : c.status} />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="section-title">Governed surfaces</div>
      {surfaces.length === 0 ? (
        <EmptyState icon={<IconFeature />} title="No governed surfaces yet">
          Surfaces this capability governs appear here as they are linked from the graph.
        </EmptyState>
      ) : (
        <div className="card animate-in">
          <div className="rows stagger">
            {surfaces.map((s) => (
              <div className={`row${s.status === "proposed" ? " proposed-edge" : ""}`} key={s.edgeId}>
                <div className="body">
                  <div className="title">
                    <span className="code-ref">{s.surface}</span>
                  </div>
                  <div className="meta">
                    <span>
                      {s.implementing.decisions} decisions · {s.implementing.changes} changes
                    </span>
                  </div>
                </div>
                {s.status === "confirmed" ? (
                  <span className="pill approved">confirmed</span>
                ) : (
                  <>
                    <span className="pill proposed">proposed</span>
                    <form action={confirmGovernsEdgeAction}>
                      <input type="hidden" name="orgId" value={orgId} />
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="edgeId" value={s.edgeId} />
                      <button className="btn ghost">Confirm</button>
                    </form>
                    <form action={rejectGovernsEdgeAction}>
                      <input type="hidden" name="orgId" value={orgId} />
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="edgeId" value={s.edgeId} />
                      <button className="btn ghost">Reject</button>
                    </form>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
