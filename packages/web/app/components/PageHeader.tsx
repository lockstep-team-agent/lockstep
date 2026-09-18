import Link from "next/link";
import type { ReactNode } from "react";

/** One per page: optional crumbs, title, description, right-aligned actions, tabs below. */
export function PageHeader({
  title,
  description,
  actions,
  tabs,
  crumbs,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  crumbs?: Array<{ label: string; href?: string }>;
}) {
  return (
    <header className="mb-6">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          {crumbs.map((c, i) => (
            <span key={i} className="flex min-w-0 items-center gap-1">
              {i > 0 && <span aria-hidden>›</span>}
              {c.href ? (
                <Link href={c.href} className="truncate hover:text-foreground">
                  {c.label}
                </Link>
              ) : (
                <span className="truncate">{c.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold leading-7 text-foreground">{title}</h1>
          {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {tabs && <div className="mt-4">{tabs}</div>}
    </header>
  );
}
