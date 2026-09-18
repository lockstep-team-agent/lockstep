import { notFound } from "next/navigation";
import { FileText, ExternalLink, RefreshCw, History, Send } from "lucide-react";
import { getDocument, constraintKindLabel } from "@/lib/data";
import { PageHeader } from "@/components/PageHeader";
import { ListRow } from "@/components/ListRow";
import { StatusBadge } from "@/components/StatusBadge";
import { RefChip } from "@/components/RefChip";
import { When } from "@/components/When";
import { Section } from "@/components/Section";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { resyncDocumentAction, setDocumentStateAction, unregisterDocumentAction } from "@/actions";

export const dynamic = "force-dynamic";

const NATIVE_STATES = ["review", "active", "archived"] as const;

export default async function Page({ params }: { params: { orgId: string; projectId: string; docId: string } }) {
  const { orgId, projectId, docId } = params;
  const doc = await getDocument(orgId, projectId, docId);
  const base = `/project/${orgId}/${projectId}`;
  if (!doc) notFound();

  const constraints = doc.constraints ?? [];
  const history = doc.extractionHistory ?? [];
  const writebacks = doc.writeBackLog ?? [];
  const hidden = (
    <>
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="docId" value={doc.id} />
    </>
  );

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Sources", href: `${base}/sources` }, { label: doc.title ?? "Untitled document" }]}
        title={doc.title ?? "Untitled document"}
        description={
          <div className="flex flex-wrap items-center gap-2">
            <RefChip copy={false}>{doc.tool}</RefChip>
            {doc.stateAuthority === "mirrored" ? (
              <span title="Managed in the source tool">
                <StatusBadge status={doc.state} />
              </span>
            ) : (
              <form action={setDocumentStateAction} className="flex items-center gap-1">
                {hidden}
                <select
                  name="state"
                  defaultValue={doc.state}
                  className="h-7 rounded-md border bg-card px-2 text-xs"
                  aria-label="Document state"
                >
                  {NATIVE_STATES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <Button size="sm" variant="secondary">
                  Set
                </Button>
              </form>
            )}
            <span>
              {doc.constraintCounts.binding}/{doc.constraintCounts.total} binding
            </span>
            {doc.openConflicts > 0 && <StatusBadge status="conflict" />}
            {doc.anchors.needsReverify > 0 ? (
              <RefChip
                copy={false}
              >{`${doc.anchors.needsReverify} anchor${doc.anchors.needsReverify === 1 ? "" : "s"} need reverify`}</RefChip>
            ) : (
              <span>
                {doc.anchors.total} anchor{doc.anchors.total === 1 ? "" : "s"} healthy
              </span>
            )}
            {doc.lastSyncedAt && (
              <span className="inline-flex items-center gap-1">
                synced <When at={doc.lastSyncedAt} />
              </span>
            )}
          </div>
        }
        actions={
          <>
            {doc.url && (
              <Button asChild size="sm" variant="ghost">
                <a href={doc.url} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-4 w-4" /> Open
                </a>
              </Button>
            )}
            <form action={resyncDocumentAction}>
              {hidden}
              <Button size="sm" variant="secondary">
                <RefreshCw className="h-4 w-4" /> Re-sync
              </Button>
            </form>
            <Dialog>
              <DialogTrigger asChild>
                <Button size="sm" variant="destructive">
                  Unregister
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Unregister this document?</DialogTitle>
                  <DialogDescription>
                    Removes the document and retires its constraints. History is kept.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <form action={unregisterDocumentAction}>
                    {hidden}
                    <Button variant="destructive">Remove document</Button>
                  </form>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        }
      />

      <Section label="Constraints" count={constraints.length}>
        {constraints.length === 0 ? (
          <EmptyState icon={<FileText />} title="No constraints extracted yet">
            Once a sweep extracts binding rules from this document, they appear here with the section they anchor to.
          </EmptyState>
        ) : (
          constraints.map((c) => (
            <ListRow
              key={c.id}
              href={`${base}/decisions/${c.id}`}
              title={c.ruleText}
              meta={
                <>
                  <RefChip>{c.scopeRef}</RefChip>
                  {c.constraintKind && <RefChip copy={false}>{constraintKindLabel(c.constraintKind)}</RefChip>}
                  {c.anchor.heading && <span>§ {c.anchor.heading}</span>}
                  {!c.anchor.healthy && <RefChip copy={false}>anchor needs reverify</RefChip>}
                </>
              }
              status={<StatusBadge status={c.status} origin="document" />}
              action={
                c.anchor.url ? (
                  <Button asChild size="icon" variant="ghost" aria-label="View in source">
                    <a href={c.anchor.url} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </Button>
                ) : undefined
              }
            />
          ))
        )}
      </Section>

      <Section label="Extraction history" count={history.length}>
        {history.length === 0 ? (
          <EmptyState icon={<History />} title="No extraction runs yet">
            Each sweep that reads this document is recorded here.
          </EmptyState>
        ) : (
          history.map((h) => (
            <ListRow
              key={h.id}
              leading={<History />}
              title={<When at={h.at} />}
              meta={
                typeof h.confidence === "number" ? <span>confidence {Math.round(h.confidence * 100)}%</span> : undefined
              }
              status={<StatusBadge status={h.status} />}
            />
          ))
        )}
      </Section>

      <Section label="Write-back log" count={writebacks.length}>
        {writebacks.length === 0 ? (
          <EmptyState icon={<Send />} title="No write-backs yet">
            Conflict comments and Slack digests sent for this document are logged here.
          </EmptyState>
        ) : (
          writebacks.map((w) => (
            <ListRow
              key={w.id}
              leading={<Send />}
              title={w.kind.replace(/_/g, " ")}
              meta={<When at={w.at} />}
              status={<StatusBadge status={w.status} />}
              action={
                w.url ? (
                  <Button asChild size="icon" variant="ghost" aria-label="Open">
                    <a href={w.url} target="_blank" rel="noreferrer">
                      <ExternalLink className="h-4 w-4" />
                    </a>
                  </Button>
                ) : undefined
              }
            />
          ))
        )}
      </Section>
    </>
  );
}
