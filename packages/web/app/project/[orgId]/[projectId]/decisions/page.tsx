import { redirect } from "next/navigation";

export default function Decisions({ params }: { params: { orgId: string; projectId: string } }) {
  redirect(`/project/${params.orgId}/${params.projectId}/ledger`);
}
