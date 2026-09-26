"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { archiveAction, checkUpstreamAction, draftFromUpstreamAction, publishAction } from "@/org-actions";
import { btn } from "@/components/next/bits";

type Upstream = Awaited<ReturnType<typeof checkUpstreamAction>>;

/** Archive, publish a proposed version, and (for imported skills) check upstream. Every outcome is shown. */
export function ItemActions({
  orgId,
  itemId,
  archived,
  admin,
  proposedVersionId,
  proposedReviewHash,
  importedVersionId,
}: {
  orgId: string;
  itemId: string;
  archived: boolean;
  admin: boolean;
  proposedVersionId: string | null;
  /** Hash of the proposed content shown on this page — publish approves exactly that. */
  proposedReviewHash: string | null;
  importedVersionId: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [up, setUp] = useState<Upstream | null>(null);
  const go = (fn: () => Promise<{ ok: boolean; error?: string } | void>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (r && !r.ok) setError(r.error ?? "Failed");
      else router.refresh();
    });
  const data = up?.ok ? up.data : null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {admin && proposedVersionId && (
        <button
          type="button"
          disabled={pending}
          className={btn.primary}
          onClick={() => go(() => publishAction(orgId, proposedVersionId, proposedReviewHash ?? ""))}
        >
          Publish proposed
        </button>
      )}
      {importedVersionId && (
        <button
          type="button"
          disabled={pending}
          className={btn.outline}
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await checkUpstreamAction(orgId, importedVersionId);
              setUp(r);
              if (!r.ok) setError(r.error);
            })
          }
        >
          Check upstream
        </button>
      )}
      {data?.status === "update_available" && data.candidateCommit && (
        <button
          type="button"
          disabled={pending}
          className={btn.outline}
          onClick={() => go(() => draftFromUpstreamAction(orgId, importedVersionId!, data.candidateCommit!))}
        >
          Draft update ({data.files?.length ?? 0} file{data.files?.length === 1 ? "" : "s"} changed)
        </button>
      )}
      {data && data.status !== "update_available" && (
        <span className="text-[12px] text-faint">
          {data.status === "up_to_date"
            ? "Up to date with upstream."
            : `Upstream unavailable${data.reason ? ` — ${data.reason}` : ""}. Captured versions are unaffected.`}
        </span>
      )}
      <button
        type="button"
        disabled={pending}
        className={btn.ghost}
        onClick={() => go(() => archiveAction(orgId, itemId, !archived))}
      >
        {archived ? "Unarchive" : "Archive"}
      </button>
      {error && (
        <span role="alert" className="text-[12px] text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
