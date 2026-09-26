import Link from "next/link";
import { Download, Plus } from "lucide-react";
import { getCatalog, getOrgMe, type Kind } from "@/lib/org-data";
import { btn, Empty, LoadError, PageHead, StateTag } from "@/components/next/bits";
import { When } from "@/components/When";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const TABS: Array<{ kind: Kind; label: string; hint: string }> = [
  { kind: "standard", label: "Standards", hint: "Named expectations with requirements, optional skills and checks." },
  { kind: "skill", label: "Skills", hint: "Reusable agent instructions and files — authored here or imported." },
  { kind: "check", label: "Checks", hint: "Structural or rubric evaluations linked to requirements." },
];

export default async function CatalogPage({
  params,
  searchParams,
}: {
  params: { orgId: string };
  searchParams: { kind?: string; archived?: string };
}) {
  const kind = TABS.find((t) => t.kind === searchParams.kind)?.kind ?? "standard";
  const archived = searchParams.archived === "1";
  const [cat, me] = await Promise.all([getCatalog(params.orgId, kind, archived), getOrgMe(params.orgId)]);
  const base = `/org/${params.orgId}/standards`;
  const admin = me?.role === "owner" || me?.role === "admin";
  const items = cat?.items ?? [];
  const proposed = items.filter((i) => i.working?.state === "proposed").length;
  return (
    <div data-full className="flex h-full flex-col">
      <PageHead
        title="Standards & Skills"
        meta={
          admin
            ? proposed
              ? `${proposed} proposed change${proposed === 1 ? "" : "s"} to review`
              : "What your agents should follow"
            : "Draft or propose changes; admins publish"
        }
        actions={
          <>
            {kind === "skill" && (
              <Link href={`${base}/import`} className={btn.outline}>
                <Download className="h-3.5 w-3.5" /> Import from GitHub
              </Link>
            )}
            <Link href={`${base}/new?kind=${kind}`} className={btn.primary}>
              <Plus className="h-3.5 w-3.5" /> New {kind}
            </Link>
          </>
        }
      />
      <div className="flex items-center gap-5 border-b px-5">
        {TABS.map((t) => (
          <Link
            key={t.kind}
            href={`${base}?kind=${t.kind}`}
            aria-current={kind === t.kind ? "page" : undefined}
            className={cn(
              "-mb-px flex h-10 items-center border-b-2 text-[13px] font-medium transition-colors duration-150",
              kind === t.kind
                ? "border-foreground text-foreground"
                : "border-transparent text-faint hover:text-muted-foreground",
            )}
          >
            {t.label}
          </Link>
        ))}
        <Link
          href={`${base}?kind=${kind}${archived ? "" : "&archived=1"}`}
          className="ml-auto text-[12px] text-faint hover:text-foreground"
        >
          {archived ? "Hide archived" : "Show archived"}
        </Link>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!cat ? (
          <LoadError what="the catalog" />
        ) : items.length === 0 ? (
          <Empty
            title={`No ${TABS.find((t) => t.kind === kind)!.label.toLowerCase()} yet`}
            hint={TABS.find((t) => t.kind === kind)!.hint}
          />
        ) : (
          <>
            <div className="grid grid-cols-[minmax(0,1fr)_120px_140px_90px] gap-4 border-b px-5 py-1.5 text-[11px] font-medium text-faint">
              <span>Name</span>
              <span>Published</span>
              <span>Working copy</span>
              <span className="text-right">Updated</span>
            </div>
            {items.map((i) => (
              <Link
                key={i.id}
                href={`${base}/${i.id}`}
                data-row=""
                data-row-link=""
                className="grid grid-cols-[minmax(0,1fr)_120px_140px_90px] items-center gap-4 px-5 py-2 outline-none hover:bg-muted focus-visible:bg-muted"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[13px]">{i.name}</span>
                  <span className="font-mono text-[11px] text-faint">{i.slug}</span>
                </span>
                <span className="text-[12px]">
                  {i.published ? (
                    <span className="tnum text-primary-ink">v{i.published.version}</span>
                  ) : (
                    <span className="text-faint">never</span>
                  )}
                </span>
                <span className="text-[12px]">
                  {i.working ? (
                    <>
                      <StateTag state={i.working.state === "proposed" ? "suggested" : "pending"} />{" "}
                      <span className="text-faint">
                        v{i.working.version} {i.working.state}
                      </span>
                    </>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                  {i.archived && <span className="ml-1 text-faint">· archived</span>}
                </span>
                <When
                  at={i.working?.updatedAt ?? i.published?.publishedAt ?? null}
                  className="tnum text-right text-[11px] text-faint"
                />
              </Link>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
