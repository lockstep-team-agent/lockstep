import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>;
}

export function Stat({ n, label, href, hint }: { n: number | string; label: string; href?: string; hint?: string }) {
  const inner = (
    <Card className="h-full px-4 py-3 shadow-none transition-colors hover:bg-muted/60">
      <div className="text-xl font-semibold leading-7">{n}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {hint && <div className="mt-1 font-mono text-2xs tracking-normal text-muted-foreground">{hint}</div>}
    </Card>
  );
  return href ? (
    <Link href={href} className="block rounded-lg outline-none">
      {inner}
    </Link>
  ) : (
    inner
  );
}
