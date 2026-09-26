import { redirect } from "next/navigation";

export default function OrgHome({ params }: { params: { orgId: string } }) {
  redirect(`/org/${params.orgId}/standards`);
}
