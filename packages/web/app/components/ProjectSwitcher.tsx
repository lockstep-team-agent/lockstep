"use client";
import { useRouter } from "next/navigation";

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
    <select
      value={projectId}
      onChange={(e) => router.push(`/project/${orgId}/${e.target.value}`)}
      aria-label="Switch project"
    >
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
