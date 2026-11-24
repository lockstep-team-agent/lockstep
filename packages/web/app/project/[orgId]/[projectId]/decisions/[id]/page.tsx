import Link from "next/link";
import { ApprovalBrief } from "@/components/next/ApprovalBrief";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: { orgId: string; projectId: string; id: string } }) {
  const { orgId, projectId, id } = params;
  const base = `/project/${orgId}/${projectId}`;
  return (
    <div data-full className="h-full">
      <div className="mx-auto max-w-4xl py-4">
        <Link href={`${base}/ledger`} className="px-5 text-[12px] text-faint hover:text-foreground">
          ← Rules
        </Link>
        <ApprovalBrief orgId={orgId} projectId={projectId} decisionId={id} mode="page" />
      </div>
    </div>
  );
}
