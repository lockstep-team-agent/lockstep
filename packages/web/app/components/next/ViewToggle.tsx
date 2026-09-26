"use client";
import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

const key = (user: string, projectId: string) => `lockstep:mapView:${user}:${projectId}`;

/**
 * Outline | Graph. An explicit ?view= in the URL always wins; otherwise the viewer's remembered
 * choice for this project (localStorage, per user + project) is restored once.
 */
export function ViewToggle({ user, projectId, view }: { user: string; projectId: string; view: "outline" | "graph" }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const explicit = params.get("view");

  // Restore a remembered choice only when the URL doesn't say which view it wants.
  useEffect(() => {
    if (explicit) return;
    let saved: string | null;
    try {
      saved = localStorage.getItem(key(user, projectId));
    } catch {
      saved = null; // storage unavailable (private mode) — default to the outline
    }
    if (saved === "graph") {
      const next = new URLSearchParams(params);
      next.set("view", "graph");
      router.replace(`${path}?${next}`);
    }
  }, [explicit, user, projectId, params, path, router]);

  // The preference is what the user picks with this toggle — not whatever a link put in the URL.
  const remember = (v: string) => {
    try {
      localStorage.setItem(key(user, projectId), v);
    } catch {
      /* storage unavailable — the URL still carries the view */
    }
  };

  const href = (v: string) => {
    const next = new URLSearchParams(params);
    next.set("view", v);
    return `${path}?${next}`;
  };
  return (
    <div role="tablist" aria-label="Map view" className="flex h-7 items-center rounded-md border p-0.5">
      {(["outline", "graph"] as const).map((v) => (
        <Link
          key={v}
          role="tab"
          aria-selected={view === v}
          href={href(v)}
          onClick={() => remember(v)}
          scroll={false}
          className={cn(
            "flex h-full items-center rounded px-2 text-[12px] font-medium capitalize transition-colors duration-150",
            view === v ? "bg-muted text-foreground" : "text-faint hover:text-muted-foreground",
          )}
        >
          {v}
        </Link>
      ))}
    </div>
  );
}
