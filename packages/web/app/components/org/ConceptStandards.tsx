import Link from "next/link";
import { apiGet } from "@/lib/api";
import { standardsEnabled } from "@/lib/org-data";

/** Standards that apply to this concept's surfaces — from assignments only, never from Map placement. */
export async function ConceptStandards({
  orgId,
  projectId,
  conceptId,
}: {
  orgId: string;
  projectId: string;
  conceptId: string;
}) {
  if (!standardsEnabled()) return null;
  const r = await apiGet<{
    standards: Array<{ itemId: string; name: string; version: number; requirements: number; reasons: string[] }>;
  }>(`/orgs/${orgId}/projects/${projectId}/concepts/${conceptId}/standards`);
  if (!r?.standards.length) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12px]">
      <span className="text-faint">Standards:</span>
      {r.standards.map((s) => (
        <Link
          key={s.itemId}
          href={`/project/${orgId}/${projectId}/ledger?tab=standards`}
          title={`Applies via ${s.reasons.join("; ")}`}
          className="rounded border px-1.5 leading-5 text-muted-foreground hover:border-border-strong hover:text-foreground"
        >
          {s.name} v{s.version}
          <span className="text-faint"> · {s.requirements}</span>
        </Link>
      ))}
    </div>
  );
}
