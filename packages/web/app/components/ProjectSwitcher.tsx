"use client";
import { useRouter } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function ProjectSwitcher({
  orgId,
  projectId,
  projects,
}: {
  orgId: string;
  projectId: string;
  projects: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  return (
    <Select value={projectId} onValueChange={(v) => router.push(`/project/${orgId}/${v}`)}>
      <SelectTrigger className="h-9" aria-label="Switch project">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
