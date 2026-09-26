import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getDiff,
  getItem,
  getOrgMe,
  getPreview,
  type Preview,
  type VersionDiff,
  type VersionRow,
} from "@/lib/org-data";
import { btn, PageHead } from "@/components/next/bits";
import { ItemEditor } from "@/components/org/ItemEditor";
import { ItemActions } from "@/components/org/ItemActions";
import { pinOptions, requirementOptions } from "@/components/org/pin-options";
import { When } from "@/components/When";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const h = "mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-faint";

export default async function ItemPage({
  params,
  searchParams,
}: {
  params: { orgId: string; itemId: string };
  searchParams: { diff?: string };
}) {
  const { orgId, itemId } = params;
  const [detail, me] = await Promise.all([getItem(orgId, itemId), getOrgMe(orgId)]);
  if (!detail) notFound();
  const { item, versions } = detail;
  const admin = me?.role === "owner" || me?.role === "admin";
  const latest = versions[0] ?? null;
  const published = versions.find((v) => v.state === "published") ?? null;
  const working = latest && latest.state !== "published" ? latest : null;
  const shown = working ?? published;
  const [preview, opts] = await Promise.all([
    shown ? getPreview(orgId, shown.id) : null,
    item.kind === "standard" ? pinOptions(orgId) : null,
  ]);

  // Keep currently pinned versions selectable even after their item moved on.
  const skills = [...(opts?.skills ?? [])];
  const checks = [...(opts?.checks ?? [])];
  for (const l of preview?.linked ?? []) {
    const list = l.kind === "skill" ? skills : checks;
    if (!list.some((o) => o.versionId === l.versionId))
      list.push({
        itemId: l.itemId,
        versionId: l.versionId,
        label: `${l.name} · v${l.version}${l.state === "published" ? "" : ` (${l.state})`}`,
      });
  }

  const imported = Boolean(shown?.provenance);
  // Authored packages are editable file by file (binaries are kept as they are); imported ones are
  // snapshots of an upstream commit — change them by drafting from upstream.
  const packageLocked = imported;
  const shaOf = new Map((preview?.package?.files ?? []).map((f) => [f.path, f.sha256]));
  const initialFiles = preview?.fileTexts?.length
    ? [...preview.fileTexts]
        .sort((a, b) => Number(b.path === "SKILL.md") - Number(a.path === "SKILL.md"))
        .map((f) =>
          f.text !== null
            ? { path: f.path, content: f.text }
            : { path: f.path, content: "", keepSha: shaOf.get(f.path) },
        )
    : undefined;

  const diffTo = versions.find((v) => v.id === searchParams.diff);
  const diffFrom = diffTo ? versions.find((v) => v.version < diffTo.version) : undefined;
  const diff = diffTo && diffFrom ? await getDiff(orgId, diffFrom.id, diffTo.id) : null;

  return (
    <div data-full className="flex h-full flex-col">
      <PageHead
        title={item.name}
        meta={
          <span className="font-mono">
            {item.kind} · {item.slug}
            {published ? ` · published v${published.version}` : " · never published"}
            {item.archivedAt ? " · archived" : ""}
          </span>
        }
        actions={
          <>
            {admin && published && !item.archivedAt && (
              <Link href={`/org/${orgId}/rollouts/new?version=${published.id}`} className={btn.primary}>
                Roll out v{published.version}
              </Link>
            )}
            <ItemActions
              orgId={orgId}
              itemId={itemId}
              archived={Boolean(item.archivedAt)}
              admin={admin}
              proposedVersionId={working?.state === "proposed" ? working.id : null}
              proposedReviewHash={
                working?.state === "proposed" && preview?.version.id === working.id ? preview.version.reviewHash : null
              }
              importedVersionId={imported && shown ? shown.id : null}
            />
          </>
        }
      />
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_380px] lg:overflow-hidden">
        <div className="min-w-0 px-5 py-4 lg:overflow-y-auto">
          <ItemEditor
            key={shown?.id ?? "none"}
            orgId={orgId}
            kind={item.kind}
            itemId={itemId}
            initialContent={shown?.content ?? {}}
            initialFiles={initialFiles}
            shownVersion={preview ? { versionId: preview.version.id, reviewHash: preview.version.reviewHash } : null}
            packageLocked={packageLocked}
            workingVersionId={working?.id ?? null}
            workingState={working?.state ?? null}
            canPublish={admin}
            skillOptions={skills}
            checkOptions={checks}
            requirementOptions={item.kind === "check" ? await requirementOptions(orgId) : []}
          />
        </div>
        <aside className="min-w-0 space-y-6 border-t px-5 py-4 lg:overflow-y-auto lg:border-l lg:border-t-0">
          {preview && <PreviewPanel p={preview} />}
          <section>
            <h2 className={h}>Versions</h2>
            <ol className="space-y-1">
              {versions.map((v) => (
                <VersionLine
                  key={v.id}
                  v={v}
                  base={`/org/${orgId}/standards/${itemId}`}
                  active={v.id === diffTo?.id}
                  hasPrev={versions.some((x) => x.version < v.version)}
                />
              ))}
            </ol>
          </section>
          {diff && <DiffPanel d={diff} />}
        </aside>
      </div>
    </div>
  );
}

function VersionLine({ v, base, active, hasPrev }: { v: VersionRow; base: string; active: boolean; hasPrev: boolean }) {
  return (
    <li className={cn("flex items-center gap-2 rounded-md px-2 py-1 text-[12px]", active && "bg-muted")}>
      <span className="tnum w-8 font-medium">v{v.version}</span>
      <span className={cn("w-20", v.state === "published" ? "text-primary-ink" : "text-faint")}>{v.state}</span>
      <When at={v.publishedAt ?? v.updatedAt} className="tnum text-faint" />
      {hasPrev && (
        <Link href={active ? base : `${base}?diff=${v.id}`} className="ml-auto text-faint hover:text-foreground">
          {active ? "hide diff" : "diff"}
        </Link>
      )}
    </li>
  );
}

/** Exactly what an employee's agent receives for this version. */
function PreviewPanel({ p }: { p: Preview }) {
  const prov = p.version.provenance as {
    owner?: string;
    repo?: string;
    commit?: string;
    path?: string;
    license?: string | null;
    url?: string;
  } | null;
  return (
    <section className="space-y-3">
      <h2 className={h}>What agents receive · v{p.version.version}</h2>
      {p.blockers.length > 0 && (
        <ul className="rounded-md border border-destructive/30 bg-destructive-soft px-3 py-2 text-[12px] text-destructive">
          {p.blockers.map((b) => (
            <li key={b}>Can’t publish: {b}</li>
          ))}
        </ul>
      )}
      {p.brief && (
        <pre className="whitespace-pre-wrap rounded-md border bg-muted px-3 py-2 font-mono text-[11px] leading-5">
          {p.brief}
        </pre>
      )}
      {p.linked.length > 0 && (
        <ul className="space-y-0.5 text-[12px]">
          {p.linked.map((l) => (
            <li key={l.versionId}>
              <span className="text-faint">{l.kind}</span> {l.name} v{l.version}
              {l.state !== "published" && <span className="text-destructive"> · {l.state}</span>}
            </li>
          ))}
        </ul>
      )}
      {prov && (
        <dl className="grid grid-cols-[70px_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[12px]">
          <dt className="text-faint">Source</dt>
          <dd className="truncate font-mono">
            <a href={prov.url} target="_blank" rel="noreferrer" className="hover:underline">
              {prov.owner}/{prov.repo}/{prov.path}
            </a>
          </dd>
          <dt className="text-faint">Commit</dt>
          <dd className="font-mono">{prov.commit?.slice(0, 12)}</dd>
          <dt className="text-faint">License</dt>
          <dd>{prov.license ?? <span className="text-destructive">none found</span>}</dd>
          <dt className="text-faint">Verified</dt>
          <dd>
            {p.verified == null ? (
              "—"
            ) : p.verified ? (
              "blob hashes match"
            ) : (
              <span className="text-destructive">mismatch</span>
            )}
          </dd>
        </dl>
      )}
      {p.package && (
        <div>
          <div className="mb-1 text-[12px] text-faint">
            {p.package.files.length} file{p.package.files.length === 1 ? "" : "s"} ·{" "}
            {(p.package.totalBytes / 1024).toFixed(1)} KB
          </div>
          <ul className="space-y-0.5 font-mono text-[11px]">
            {p.package.files.map((f) => {
              const t = p.fileTexts?.find((x) => x.path === f.path);
              return (
                <li key={f.path}>
                  <details>
                    <summary className="flex cursor-pointer gap-2">
                      <span className="truncate">{f.path}</span>
                      <span className="shrink-0 text-faint">{(f.size / 1024).toFixed(1)} KB</span>
                      {f.isScript && <span className="shrink-0 text-destructive">script · never run</span>}
                    </summary>
                    {t?.text != null ? (
                      <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded border bg-muted px-2 py-1.5 text-[11px] leading-4">
                        {t.text}
                      </pre>
                    ) : (
                      <p className="mt-1 text-faint">
                        {t?.unavailable ? "Storage unavailable — contents can’t be shown." : "Binary file — not shown."}
                      </p>
                    )}
                  </details>
                </li>
              );
            })}
          </ul>
          {p.package.declared && Object.keys(p.package.declared).length > 0 && <Declared d={p.package.declared} />}
        </div>
      )}
    </section>
  );
}

function DiffPanel({ d }: { d: VersionDiff }) {
  const show = (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x));
  const empty = !d.fields.length && !d.requirements.length && !d.files.length;
  return (
    <section>
      <h2 className={h}>
        v{d.from.version} → v{d.to.version}
      </h2>
      {empty && <p className="text-[12px] text-faint">No changes.</p>}
      <ul className="space-y-2 text-[12px]">
        {d.requirements.map((r) => (
          <li key={r.key} className="rounded-md border px-2 py-1.5">
            <div className="mb-0.5 font-mono text-[10px] text-faint">
              {r.key} · {r.change}
            </div>
            {r.from && r.change !== "added" && (
              <div className="text-destructive line-through">
                {r.from.text} ({r.from.level})
              </div>
            )}
            {r.to && r.change !== "removed" && (
              <div className="text-primary-ink">
                {r.to.text} ({r.to.level})
              </div>
            )}
          </li>
        ))}
        {d.fields.map((f) => (
          <li key={f.field} className="rounded-md border px-2 py-1.5">
            <div className="mb-0.5 font-mono text-[10px] text-faint">{f.field}</div>
            <div className="break-words text-destructive line-through">{show(f.from)}</div>
            <div className="break-words text-primary-ink">{show(f.to)}</div>
          </li>
        ))}
        {d.files.map((f) => (
          <li key={f.path} className="text-[11px]">
            <div className="font-mono">
              {f.change} {f.path}
            </div>
            {f.diff === null ? (
              <p className="text-faint">Binary or too large to diff.</p>
            ) : (
              f.diff && (
                <pre className="mt-1 max-h-72 overflow-auto rounded border bg-muted px-2 py-1 font-mono leading-4">
                  {f.diff.map((l, i) => (
                    <div
                      key={i}
                      className={l.op === "+" ? "text-primary-ink" : l.op === "-" ? "text-destructive" : "text-faint"}
                    >
                      {l.op} {l.line}
                    </div>
                  ))}
                </pre>
              )
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Declared tools / dependencies / compatibility, readable; raw detail on demand. */
function Declared({ d }: { d: Record<string, unknown> }) {
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).join(", ") : typeof v === "string" ? v : null);
  const rows = [
    ["Tools it expects", list(d.tools)],
    ["Dependencies", list(d.dependencies)],
    ["Compatibility", list(d.compatibility)],
    ["Notes", list(d.notes)],
  ].filter(([, v]) => v);
  return (
    <div className="mt-2 space-y-0.5 text-[11px]">
      {rows.map(([k, v]) => (
        <div key={k}>
          <span className="text-faint">{k}:</span> {v}
        </div>
      ))}
      <p className="text-faint">
        Lockstep doesn’t check these on machines yet — reviewers should confirm teams have them.
      </p>
      <details>
        <summary className="cursor-pointer text-faint">Technical detail</summary>
        <pre className="whitespace-pre-wrap text-faint">{JSON.stringify(d, null, 1)}</pre>
      </details>
    </div>
  );
}
