import Link from "next/link";
import { Bell, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { logoutAction } from "@/actions";
import { Breadcrumb } from "./Breadcrumb";
import { UserMenu } from "./UserMenu";
import { MobileNav } from "./MobileNav";
import type { NavCounts } from "./Nav";

export function Topbar({
  base,
  orgName,
  projectName,
  login,
  role,
  reviewCount,
  counts,
}: {
  base: string;
  orgName: string;
  projectName: string;
  login: string;
  role: string;
  reviewCount: number;
  counts: NavCounts;
}) {
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur lg:px-6">
      <MobileNav base={base} counts={counts} />
      <Breadcrumb base={base} orgName={orgName} projectName={projectName} />
      <form action={`${base}/search`} method="get" className="ml-auto hidden w-72 md:block">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input
            name="q"
            placeholder="Search decisions…  ⌘K"
            className="h-9 pl-8"
            aria-label="Search decisions"
            data-hotkey="k"
            autoComplete="off"
          />
        </div>
      </form>
      <Link
        href={`${base}/review-queue`}
        className="relative ml-auto inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground md:ml-0"
        aria-label={`Review queue, ${reviewCount} item${reviewCount === 1 ? "" : "s"}`}
      >
        <Bell className="h-4 w-4" strokeWidth={1.75} />
        {reviewCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 rounded-full bg-primary px-1 font-mono text-[10px] leading-4 text-primary-foreground">
            {reviewCount}
          </span>
        )}
      </Link>
      <UserMenu login={login} role={role} onSignOut={logoutAction} />
    </header>
  );
}
