import Link from "next/link";

export interface TabDef {
  key: string;
  label: string;
  href: string;
  count?: number;
}

/** Link-based tab row — server-rendered, active tab picked via a query param. */
export function Tabs({ tabs, active }: { tabs: TabDef[]; active: string }) {
  return (
    <div className="tabs animate-in">
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} className={`tab${t.key === active ? " active" : ""}`}>
          {t.label}
          {t.count ? <span className="badge">{t.count}</span> : null}
        </Link>
      ))}
    </div>
  );
}
