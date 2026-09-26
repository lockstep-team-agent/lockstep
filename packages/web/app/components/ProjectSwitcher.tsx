"use client";
import { useRouter } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";

const ORG = "__org__";
const HOME = "__home__";

/**
 * Project switcher. With `withOrg`, an explicit "Organization" context sits above the projects
 * (Standards & Skills etc.); pass projectId="__org__" while inside that context.
 */
export function ProjectSwitcher({
  orgId,
  projectId,
  projects,
  withOrg = false,
  orgName,
}: {
  orgId: string;
  projectId: string;
  projects: Array<{ id: string; name: string; archived?: boolean }>;
  withOrg?: boolean;
  /** Shown in the Organization entry — people often belong to several organizations. */
  orgName?: string;
}) {
  const router = useRouter();
  return (
    <Select
      value={projectId}
      onValueChange={(v) =>
        router.push(v === HOME ? "/" : v === ORG ? `/org/${orgId}/standards` : `/project/${orgId}/${v}`)
      }
    >
      <SelectTrigger className="h-9" aria-label="Switch project">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {withOrg && (
          <>
            <SelectItem value={ORG}>{orgName ? `Organization · ${orgName}` : "Organization"}</SelectItem>
            <SelectSeparator />
          </>
        )}
        {projects
          .filter((p) => !p.archived || p.id === projectId)
          .map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        <SelectSeparator />
        <SelectItem value={HOME}>All organizations & projects</SelectItem>
      </SelectContent>
    </Select>
  );
}
