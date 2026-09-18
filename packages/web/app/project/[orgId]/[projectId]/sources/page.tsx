import Link from "next/link";
import { FileText, ExternalLink, RefreshCw } from "lucide-react";
import { getDocuments } from "@/lib/data";
import { PageHeader } from "@/components/PageHeader";
import { ListRow } from "@/components/ListRow";
import { StatusBadge } from "@/components/StatusBadge";
import { RefChip } from "@/components/RefChip";
import { When } from "@/components/When";
import { Section } from "@/components/Section";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  resyncDocumentAction,
  registerDocumentAction,
  setDocumentStateAction,
  unregisterDocumentAction,
} from "@/actions";

export const dynamic = "force-dynamic";

const NATIVE_STATES = ["review", "active", "archived"] as const;

export default async function Page({ params }: { params: { orgId: string; projectId: string } }) {
  const { orgId, projectId } = params;
  const data = await getDocuments(orgId, projectId);
  const docs = data?.documents ?? [];
  const pending = data?.pendingStatusValues ?? [];
  const base = `/project/${orgId}/${projectId}`;
  const hidden = (docId: string) => (
    <>
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="docId" value={docId} />
    </>
  );

  return (
    <>
      <PageHeader
        title="Sources"
        description="PRDs mirrored from Notion or Google Docs. Constraints extracted here land in the Review queue for ratification."
      />

      {pending.length > 0 && (
        <Card className="mb-6 border-warning-edge bg-warning-soft shadow-none">
          <CardContent className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm">
            <span>
              {pending.length} unmapped status value{pending.length === 1 ? "" : "s"} found in Notion — documents keep
              their last known state until you map them.
            </span>
            <Link href={`${base}/connections`} className="font-medium hover:underline">
              Map them in Connections →
            </Link>
          </CardContent>
        </Card>
      )}

      <Card className="mb-6 shadow-none">
        <CardContent className="p-4">
          <form action={registerDocumentAction} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="orgId" value={orgId} />
            <input type="hidden" name="projectId" value={projectId} />
            <Input
              name="url"
              placeholder="Paste a Notion page or Google Doc URL"
              className="min-w-72 flex-1"
              required
              aria-label="Document URL"
            />
            <Button>Register document</Button>
          </form>
        </CardContent>
      </Card>

      {docs.length === 0 ? (
        <EmptyState icon={<FileText />} title="No documents yet">
          Register a PRD above, or connect Notion and allowlist a database — swept documents show up here with their
          extracted constraints.
        </EmptyState>
      ) : (
        <Section label="Documents" count={docs.length}>
          {docs.map((d) => (
            <ListRow
              key={d.id}
              href={`${base}/sources/${d.id}`}
              leading={<FileText />}
              title={d.title ?? "Untitled document"}
              meta={
                <>
                  <span>
                    {d.constraintCounts.binding}/{d.constraintCounts.total} binding
                  </span>
                  {d.openConflicts > 0 && <StatusBadge status="conflict" />}
                  {d.anchors.needsReverify > 0 ? (
                    <RefChip
                      copy={false}
                    >{`${d.anchors.needsReverify} anchor${d.anchors.needsReverify === 1 ? "" : "s"} need reverify`}</RefChip>
                  ) : (
                    <span>
                      {d.anchors.total} anchor{d.anchors.total === 1 ? "" : "s"} healthy
                    </span>
                  )}
                  {d.lastSyncedAt && (
                    <span className="inline-flex items-center gap-1">
                      synced <When at={d.lastSyncedAt} />
                    </span>
                  )}
                </>
              }
              status={
                d.stateAuthority === "mirrored" ? (
                  <span title="Managed in the source tool">
                    <StatusBadge status={d.state} />
                  </span>
                ) : (
                  <form action={setDocumentStateAction} className="flex items-center gap-1">
                    {hidden(d.id)}
                    <select
                      name="state"
                      defaultValue={d.state}
                      className="h-8 rounded-md border bg-card px-2 text-sm"
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
                )
              }
              action={
                <>
                  {d.url && (
                    <Button asChild size="icon" variant="ghost" aria-label="Open in source tool">
                      <a href={d.url} target="_blank" rel="noreferrer">
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </Button>
                  )}
                  <form action={resyncDocumentAction}>
                    {hidden(d.id)}
                    <Button size="icon" variant="ghost" aria-label="Re-sync" title="Re-sync">
                      <RefreshCw className="h-4 w-4" />
                    </Button>
                  </form>
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button size="sm" variant="ghost">
                        Unregister
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Unregister this document?</DialogTitle>
                        <DialogDescription>
                          Removes the document and retires its constraints. History is kept; you can register it again.
                        </DialogDescription>
                      </DialogHeader>
                      <DialogFooter>
                        <form action={unregisterDocumentAction}>
                          {hidden(d.id)}
                          <Button variant="destructive">Remove document</Button>
                        </form>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </>
              }
            />
          ))}
        </Section>
      )}
    </>
  );
}
