import { getExceptions, type ExceptionRow } from "@/lib/org-data";
import { Empty, LoadError, PageHead } from "@/components/next/bits";
import { When } from "@/components/When";
import { DecideException } from "@/components/org/CheckControls";
import { rolloutOptions } from "@/components/org/rollout-options";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const ORDER: ExceptionRow["state"][] = ["requested", "needs_review", "approved", "expired", "rejected"];
const LABEL: Record<ExceptionRow["state"], string> = {
  requested: "Awaiting decision",
  needs_review: "Needs review — the covered content changed",
  approved: "Approved",
  expired: "Expired — the requirement applies again",
  rejected: "Rejected",
};

export default async function ExceptionsPage({ params }: { params: { orgId: string } }) {
  const [data, o] = await Promise.all([getExceptions(params.orgId), rolloutOptions(params.orgId)]);
  const rows = data?.exceptions ?? [];
  const scope = (x: ExceptionRow) =>
    [
      x.scope.projectId ? `project ${o.names.project.get(x.scope.projectId) ?? "—"}` : "org-wide",
      x.scope.repoId ? `repo ${o.names.repo.get(x.scope.repoId) ?? "—"}` : "",
      x.scope.taskType ? `${x.scope.taskType} work` : "",
      x.scope.memberId ? `for ${o.names.person.get(x.scope.memberId) ?? "one person"}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <div data-full className="flex h-full flex-col">
      <PageHead
        title="Exceptions"
        meta={data?.canDecide ? "Approve or reject requests; every decision is audited" : "Your requests"}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!data ? (
          <LoadError what="exceptions" />
        ) : rows.length === 0 ? (
          <Empty
            title="No exceptions"
            hint="Members request exceptions from a project’s Standards tab or from a check finding."
          />
        ) : (
          ORDER.filter((st) => rows.some((x) => x.state === st)).map((st) => (
            <section key={st}>
              <h2 className="px-5 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.04em] text-faint">
                {LABEL[st]}
              </h2>
              <ul className="divide-y">
                {rows
                  .filter((x) => x.state === st)
                  .map((x) => (
                    <li key={x.id} className="px-5 py-2.5">
                      <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                        <span className="font-medium">
                          {x.itemName}
                          {x.version ? ` v${x.version}` : ""}
                        </span>
                        <span className="text-[12px] text-faint">{scope(x)}</span>
                        <When at={x.createdAt} className="ml-auto text-[11px] text-faint" />
                      </div>
                      {x.requirementText && (
                        <div className="text-[12px] text-muted-foreground">{x.requirementText}</div>
                      )}
                      <div className="text-[12px]">
                        <span className="text-faint">{x.requestedBy ?? "someone"}:</span> {x.reason}
                        {x.expiresAt && (
                          <span className="text-faint"> · until {new Date(x.expiresAt).toLocaleDateString()}</span>
                        )}
                      </div>
                      {x.decidedBy && (
                        <div className={cn("text-[11px]", "text-faint")}>
                          {x.state === "rejected" ? "Rejected" : "Approved"} by {x.decidedBy}
                          {x.decisionNote ? ` — ${x.decisionNote}` : ""}
                        </div>
                      )}
                      {data?.canDecide && x.state === "requested" && (
                        <div className="mt-1.5">
                          <DecideException orgId={params.orgId} exceptionId={x.id} />
                        </div>
                      )}
                    </li>
                  ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
