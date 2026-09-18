import { redirect } from "next/navigation";

/** Notifications folded into Home + the Decisions "cross-cutting" filter (spec §5.1). */
export default function Page({ params }: { params: { orgId: string; projectId: string } }) {
  redirect(`/project/${params.orgId}/${params.projectId}`);
}
