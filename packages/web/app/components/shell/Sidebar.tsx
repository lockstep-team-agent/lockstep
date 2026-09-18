import { ScrollArea } from "@/components/ui/scroll-area";
import { ProjectSwitcher } from "@/components/ProjectSwitcher";
import { Brand } from "./Brand";
import { Nav, type NavCounts } from "./Nav";

export function Sidebar({
  orgId,
  projectId,
  projects,
  base,
  counts,
}: {
  orgId: string;
  projectId: string;
  projects: Array<{ id: string; name: string }>;
  base: string;
  counts: NavCounts;
}) {
  return (
    <aside className="sticky top-0 hidden h-screen w-[var(--sidebar-w)] shrink-0 flex-col border-r bg-card lg:flex">
      <div className="flex h-14 items-center px-4">
        <Brand />
      </div>
      <div className="px-3 pb-2">
        <div className="mb-1 px-1 text-2xs font-semibold uppercase text-muted-foreground">Project</div>
        <ProjectSwitcher orgId={orgId} projectId={projectId} projects={projects} />
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <Nav base={base} counts={counts} />
      </ScrollArea>
      <div className="border-t px-4 py-3 text-2xs text-muted-foreground">
        v{process.env.NEXT_PUBLIC_LOCKSTEP_VERSION ?? "0.3"} ·{" "}
        <a href="https://www.getlockstep.dev" className="hover:text-foreground" target="_blank" rel="noreferrer">
          docs
        </a>
      </div>
    </aside>
  );
}
