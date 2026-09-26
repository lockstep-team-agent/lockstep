"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookCheck, FileWarning, Laptop, PlugZap, Send, ShieldCheck, Users, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const ITEMS: Array<{ seg: string; label: string; icon: LucideIcon; admin?: boolean }> = [
  { seg: "standards", label: "Standards & Skills", icon: BookCheck },
  { seg: "rollouts", label: "Rollouts & Adoption", icon: Send, admin: true },
  { seg: "exceptions", label: "Exceptions", icon: FileWarning },
  { seg: "me", label: "My environments", icon: Laptop },
  { seg: "teams", label: "Teams", icon: Users },
  { seg: "roles", label: "Roles", icon: ShieldCheck },
  { seg: "support", label: "Agent support", icon: PlugZap },
];

export function OrgNav({ orgId, admin }: { orgId: string; admin: boolean }) {
  const path = usePathname();
  const base = `/org/${orgId}`;
  return (
    <nav aria-label="Organization" className="flex flex-col gap-px px-2">
      {ITEMS.filter((i) => admin || !i.admin).map(({ seg, label, icon: Icon }) => {
        const active = path.startsWith(`${base}/${seg}`);
        return (
          <Link
            key={seg}
            href={`${base}/${seg}`}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground",
              active && "bg-muted text-foreground",
            )}
          >
            <Icon
              className={cn("h-4 w-4", active ? "text-foreground" : "text-faint group-hover:text-muted-foreground")}
            />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
