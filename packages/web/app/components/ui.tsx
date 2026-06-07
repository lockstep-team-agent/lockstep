import type { ReactNode } from "react";

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill ${status}`}>{status}</span>;
}

export function PageHead({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="page-head animate-in">
      <h2>{title}</h2>
      {subtitle && <p>{subtitle}</p>}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty animate-in">
      <div className="ico">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Stat({ n, label, icon }: { n: number | string; label: string; icon: ReactNode }) {
  return (
    <div className="stat">
      <div className="n">{n}</div>
      <div className="k">
        {icon}
        {label}
      </div>
    </div>
  );
}
