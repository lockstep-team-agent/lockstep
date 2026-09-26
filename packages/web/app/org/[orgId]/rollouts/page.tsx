import Link from "next/link";
import { Plus } from "lucide-react";
import { getAssignments, getOrgMe } from "@/lib/org-data";
import { btn, Empty, LoadError, PageHead } from "@/components/next/bits";
import { When } from "@/components/When";
import { rolloutOptions, scopeLine } from "@/components/org/rollout-options";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function RolloutsPage({ params }: { params: { orgId: string } }) {
  const [data, me, opts] = await Promise.all([
    getAssignments(params.orgId),
    getOrgMe(params.orgId),
    rolloutOptions(params.orgId),
  ]);
  const admin = me?.role === "owner" || me?.role === "admin";
  if (!admin)
    return <Empty title="Rollouts are visible to org owners and admins" hint="Your own checkouts and their skills are under My environments." />;
  if (!data) return <LoadError what="rollouts" />;
  const base = `/org/${params.orgId}/rollouts`;
  const rows = data?.assignments ?? [];
  const names = new Map(opts.items.map((i) => [i.versionId, `${i.name} v${i.version}`]));
  return (
    <div data-full className="flex h-full flex-col">
      <PageHead
        title="Rollouts & Adoption"
        meta="Who receives which versions, and what actually arrived"
        actions={
          admin ? (
            <Link href={`${base}/new`} className={btn.primary}>
              <Plus className="h-3.5 w-3.5" /> New rollout
            </Link>
          ) : undefined
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <Empty
            title="Nothing rolled out yet"
            hint="Publish a standard or skill, then start a rollout to send it to the right checkouts."
          />
        ) : (
          <ul className="divide-y">
            {rows.map((a) => (
              <li key={a.id}>
                <Link
                  href={`${base}/${a.id}`}
                  className={cn("block px-5 py-3 hover:bg-muted", a.state === "retired" && "opacity-60")}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] font-medium">{a.name}</span>
                    <span className="text-[11px] text-faint">
                      rev {a.revision} · {a.level}
                      {a.pilot && " · pilot"}
                      {a.state !== "active" && ` · ${a.state}`}
                      {a.release?.withdrawn && " · release withdrawn"}
                    </span>
                    <When at={a.createdAt} className="ml-auto text-[11px] text-faint" />
                  </div>
                  <div className="mt-0.5 text-[12px] text-muted-foreground">{scopeLine(a.selectors, opts.names)}</div>
                  <div className="mt-0.5 truncate text-[12px] text-faint">
                    {(a.release?.items ?? [])
                      .map((i) => names.get(i.versionId) ?? `${i.kind} (older version)`)
                      .join(" · ")}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
