import type { ReactNode } from "react";
import { logoutAction } from "@/actions";
import { ProjectSwitcher } from "@/components/ProjectSwitcher";
import { UserMenu } from "@/components/shell/UserMenu";
import { NavLinks } from "./NavLinks";
import { ThemeToggle } from "./ThemeToggle";
import { CommandPalette } from "./CommandPalette";
import { Shortcuts } from "./Shortcuts";
import { PaletteButton } from "./PaletteButton";

/**
 * The concept-ledger shell: one quiet sidebar (same surface as the canvas, a hairline between),
 * four destinations, and ⌘K for everything else. Pages own their own headers and density.
 */
export function Shell({
  orgId,
  projectId,
  projects,
  login,
  role,
  inboxCount,
  children,
}: {
  orgId: string;
  projectId: string;
  projects: Array<{ id: string; name: string }>;
  login: string;
  role: string;
  inboxCount: number;
  children: ReactNode;
}) {
  const base = `/project/${orgId}/${projectId}`;
  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-[232px] shrink-0 flex-col border-r">
        <div className="flex h-12 items-center gap-2 px-3">
          <span aria-hidden className="h-3.5 w-3.5 rounded-[3px] bg-primary shadow-[inset_0_0_0_1px_rgba(0,0,0,.2)]" />
          <span className="text-[13px] font-semibold tracking-[-0.01em]">Lockstep</span>
        </div>
        <div className="px-2 pb-2 [&_button]:h-8 [&_button]:text-[13px]">
          <ProjectSwitcher orgId={orgId} projectId={projectId} projects={projects} />
        </div>
        <div className="px-2 pb-3">
          <PaletteButton />
        </div>
        <NavLinks base={base} inboxCount={inboxCount} />
        <div className="mt-auto flex items-center gap-1 border-t px-2 py-2">
          <UserMenu login={login} role={role} onSignOut={logoutAction} />
          <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">@{login}</span>
          <ThemeToggle />
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="shell-page">{children}</div>
      </main>
      <CommandPalette orgId={orgId} projectId={projectId} base={base} />
      <Shortcuts base={base} />
    </div>
  );
}
