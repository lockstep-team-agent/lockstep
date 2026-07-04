import Link from "next/link";
import { getDocuments, timeAgo } from "@/lib/data";
import { PageHead, EmptyState, StatusPill } from "@/components/ui";
import { IconDoc } from "@/components/icons";
import { resyncDocumentAction } from "@/actions";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: { orgId: string; projectId: string } }) {
  const { orgId, projectId } = params;
  const data = await getDocuments(orgId, projectId);
  const docs = data?.documents ?? [];
  const pending = data?.pendingStatusValues ?? [];
  const base = `/project/${orgId}/${projectId}`;

  return (
    <>
      <PageHead
        title="Sources"
        subtitle="PRDs mirrored from Notion. Constraints extracted here land in the review queue for ratification."
      />

      {pending.length > 0 && (
        <div className="banner animate-in">
          <span>
            {pending.length} unmapped status value{pending.length === 1 ? "" : "s"} found in Notion — documents keep
            their last known state until you map them.
          </span>
          <Link href={`${base}/connections`}>Map them in Connections →</Link>
        </div>
      )}

      {docs.length === 0 ? (
        <EmptyState icon={<IconDoc />} title="No documents yet">
          Connect Notion and allowlist a database of PRDs — swept documents show up here with their extracted
          constraints.
        </EmptyState>
      ) : (
        <div className="card animate-in">
          <div className="rows stagger">
            {docs.map((d) => (
              <div className="row" key={d.id}>
                <IconDoc style={{ width: 18, height: 18, color: "var(--dim)", marginTop: 2 }} />
                <div className="body">
                  <div className="title">
                    <Link href={`${base}/sources/${d.id}`}>{d.title ?? "Untitled document"}</Link>
                  </div>
                  <div className="meta">
                    <span>
                      {d.constraintCounts.binding}/{d.constraintCounts.total} binding
                    </span>
                    {d.openConflicts > 0 && (
                      <span className="pill urgent">
                        {d.openConflicts} conflict{d.openConflicts === 1 ? "" : "s"}
                      </span>
                    )}
                    {d.anchors.needsReverify > 0 ? (
                      <span className="pill unverified">
                        {d.anchors.needsReverify} anchor{d.anchors.needsReverify === 1 ? "" : "s"} need reverify
                      </span>
                    ) : (
                      <span>
                        {d.anchors.total} anchor{d.anchors.total === 1 ? "" : "s"} healthy
                      </span>
                    )}
                    {d.lastSyncedAt && <span>synced {timeAgo(d.lastSyncedAt)}</span>}
                  </div>
                </div>
                {d.stateAuthority === "mirrored" ? (
                  <span className="tip" data-tip="Managed in Notion">
                    <StatusPill status={d.state} />
                  </span>
                ) : (
                  <StatusPill status={d.state} />
                )}
                {d.url && (
                  <a href={d.url} target="_blank" rel="noreferrer" className="btn ghost">
                    Open ↗
                  </a>
                )}
                <form action={resyncDocumentAction}>
                  <input type="hidden" name="orgId" value={orgId} />
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="docId" value={d.id} />
                  <button className="btn ghost">Re-sync</button>
                </form>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
