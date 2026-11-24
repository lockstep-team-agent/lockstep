import { redirect } from "next/navigation";

export default function ReviewQueue({ params }: { params: { orgId: string; projectId: string } }) {
  redirect(`/project/${params.orgId}/${params.projectId}/inbox`);
}
