import Link from "next/link";
import { getProjectEnvironments, getProjectStandards } from "@/lib/org-data";
import { When } from "@/components/When";

/** Project Settings: what's assigned here and which enrolled checkouts hold it (metadata only). */
export async function ProjectEnvironmentsSection({
  orgId,
  projectId,
  base,
}: {
  orgId: string;
  projectId: string;
  base: string;
}) {
  const [envs, ps] = await Promise.all([
    getProjectEnvironments(orgId, projectId),
    getProjectStandards(orgId, projectId),
  ]);
  const list = envs?.environments ?? [];
  return (
    <section>
      <h2 className="mb-1 text-[15px] font-semibold tracking-[-0.01em]">Standards & environments</h2>
      <p className="mb-3 text-[12px] text-faint">
        {ps?.assignments.length ?? 0} rollout{ps?.assignments.length === 1 ? "" : "s"} reach this project —{" "}
        <Link href={`${base}/ledger?tab=standards`} className="underline-offset-2 hover:underline">
          see what applies
        </Link>
        . Publishing and rollouts are managed in the{" "}
        <Link href={`/org/${orgId}/rollouts`} className="underline-offset-2 hover:underline">
          organization workspace
        </Link>
        .
      </p>
      {list.length === 0 ? (
        <p className="text-[12px] text-faint">
          No enrolled checkouts yet. Teammates opt in with <code className="font-mono">lockstep enroll</code>.
        </p>
      ) : (
        <ul className="divide-y rounded-md border text-[12px]">
          {list.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-x-3 px-3 py-2">
              <span className="font-medium">{e.login}</span>
              <span className="truncate font-mono text-[11px] text-faint">{e.repo ?? "workspace"}</span>
              <span className="text-faint">{e.adapter}</span>
              <span className="ml-auto">
                {e.installed}/{e.skills} skills current
                {e.attention > 0 && <span className="text-destructive"> · {e.attention} need attention</span>}
                {e.blocked > 0 && <span className="text-destructive"> · {e.blocked} blocked</span>}
              </span>
              <When at={e.lastContactAt} className="text-[11px] text-faint" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
