import Link from "next/link";
import { getDocument, timeAgo, constraintKindLabel } from "@/lib/data";
import { PageHead, EmptyState, StatusPill } from "@/components/ui";
import { IconDoc } from "@/components/icons";
import { resyncDocumentAction } from "@/actions";

export const dynamic = "force-dynamic";

export default async function Page({
  params,
}: {
  params: { orgId: string; projectId: string; docId: string };
}) {
  const { orgId, projectId, docId } = params;
  const doc = await getDocument(orgId, projectId, docId);
  const base = `/project/${orgId}/${projectId}`;

  if (!doc) {
    return (
      <>
        <PageHead title="Source document" />
        <EmptyState icon={<IconDoc />} title="Document not found">
          It may have been removed, or core hasn&apos;t synced it yet.{" "}
          <Link href={`${base}/sources`}>Back to Sources</Link>.
        </EmptyState>
      </>
    );
  }

  const constraints = doc.constraints ?? [];
  const history = doc.extractionHistory ?? [];
  const writebacks = doc.writeBackLog ?? [];

  return (
    <>
      <PageHead
        title={doc.title ?? "Untitled document"}
        subtitle="Everything Lockstep knows about this document — its constraints, extraction runs, and write-backs."
      />

      <div className="card animate-in">
        <div className="rows">
          <div className="row">
            <IconDoc style={{ width: 18, height: 18, color: "var(--dim)", marginTop: 2 }} />
            <div className="body">
              <div className="meta" style={{ marginTop: 0 }}>
                <span>
                  {doc.constraintCounts.binding}/{doc.constraintCounts.total} binding
                </span>
                {doc.openConflicts > 0 && (
                  <span className="pill urgent">
                    {doc.openConflicts} conflict{doc.openConflicts === 1 ? "" : "s"}
                  </span>
                )}
                {doc.anchors.needsReverify > 0 ? (
                  <span className="pill unverified">
                    {doc.anchors.needsReverify} anchor{doc.anchors.needsReverify === 1 ? "" : "s"} need reverify
                  </span>
                ) : (
                  <span>
                    {doc.anchors.total} anchor{doc.anchors.total === 1 ? "" : "s"} healthy
                  </span>
                )}
                {doc.lastSyncedAt && <span>synced {timeAgo(doc.lastSyncedAt)}</span>}
              </div>
            </div>
            {doc.stateAuthority === "mirrored" ? (
              <span className="tip" data-tip="Managed in Notion">
                <StatusPill status={doc.state} />
              </span>
            ) : (
              <StatusPill status={doc.state} />
            )}
            {doc.url && (
              <a href={doc.url} target="_blank" rel="noreferrer" className="btn ghost">
                Open ↗
              </a>
            )}
            <form action={resyncDocumentAction}>
              <input type="hidden" name="orgId" value={orgId} />
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="docId" value={doc.id} />
              <button className="btn ghost">Re-sync</button>
            </form>
          </div>
        </div>
      </div>

      <div className="section-title">Constraints</div>
      {constraints.length === 0 ? (
        <EmptyState icon={<IconDoc />} title="No constraints extracted yet">
          Once a sweep extracts binding rules from this document, they appear here with the section they anchor to.
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
                      <span className={`pill kind-${c.constraintKind}`}>{constraintKindLabel(c.constraintKind)}</span>
                    )}
                    {c.anchor.url ? (
                      <a href={c.anchor.url} target="_blank" rel="noreferrer">
                        § {c.anchor.heading ?? "section"} ↗
                      </a>
                    ) : (
                      c.anchor.heading && <span>§ {c.anchor.heading}</span>
                    )}
                    {!c.anchor.healthy && <span className="pill unverified">anchor needs reverify</span>}
                  </div>
                </div>
                <StatusPill status={c.status} />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="section-title">Extraction history</div>
      {history.length === 0 ? (
        <EmptyState icon={<IconDoc />} title="No extraction runs yet">
          Each sweep that reads this document is recorded here.
        </EmptyState>
      ) : (
        <div className="card animate-in">
          <div className="rows stagger">
            {history.map((h) => (
              <div className="row" key={h.id}>
                <div className="body">
                  <div className="title">{timeAgo(h.at)}</div>
                  <div className="meta">
                    {typeof h.confidence === "number" && <span>confidence {Math.round(h.confidence * 100)}%</span>}
                  </div>
                </div>
                <StatusPill status={h.status} />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="section-title">Write-back log</div>
      {writebacks.length === 0 ? (
        <EmptyState icon={<IconDoc />} title="No write-backs yet">
          Conflict comments and Slack digests sent for this document are logged here.
        </EmptyState>
      ) : (
        <div className="card animate-in">
          <div className="rows stagger">
            {writebacks.map((w) => (
              <div className="row" key={w.id}>
                <div className="body">
                  <div className="title">{w.kind.replace(/_/g, " ")}</div>
                  <div className="meta">
                    <span>{timeAgo(w.at)}</span>
                    {w.url && (
                      <a href={w.url} target="_blank" rel="noreferrer" className="code-ref">
                        open ↗
                      </a>
                    )}
                  </div>
                </div>
                <StatusPill status={w.status} />
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
