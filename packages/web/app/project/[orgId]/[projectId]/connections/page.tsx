import { Plug } from "lucide-react";
import {
  getOverview,
  getConnections,
  getAllowlist,
  getStateMappings,
  getConnectionSources,
  checkConnectionStatus,
  type StateMappingContainer,
} from "@/lib/data";
import { PageHeader } from "@/components/PageHeader";
import { ListRow } from "@/components/ListRow";
import { StatusBadge } from "@/components/StatusBadge";
import { RefChip } from "@/components/RefChip";
import { When } from "@/components/When";
import { Section } from "@/components/Section";
import { EmptyState } from "@/components/EmptyState";
import { Field } from "@/components/Field";
import { SourcePicker, type Source } from "@/components/SourcePicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  createConnectionAction,
  initiateConnectionAction,
  addAllowlistAction,
  setStateMappingAction,
  setStatusPropertyAction,
  setProductLayerAction,
  setAutoBindAction,
} from "@/actions";

export const dynamic = "force-dynamic";

const TOOLS = ["slack", "jira", "notion", "gdocs", "confluence"] as const;
const SOURCE_KIND: Record<string, string> = {
  slack: "channel",
  jira: "project",
  notion: "database",
  gdocs: "folder",
  confluence: "space",
};
const SOURCE_HINT: Record<string, string> = {
  slack: "channel id e.g. C0123456789",
  jira: "project key e.g. PLATFORM",
  notion: "database id or search term",
  gdocs: "folder id or search term",
  confluence: "space key e.g. ENG",
};
const CANONICAL_STATES = ["draft", "review", "active", "archived"] as const;
const selectCls = "h-9 rounded-md border bg-card px-3 text-sm";

export default async function Page({
  params,
  searchParams,
}: {
  params: { orgId: string; projectId: string };
  searchParams?: { connected?: string };
}) {
  const { orgId, projectId } = params;
  if (searchParams?.connected) await checkConnectionStatus(orgId, projectId, searchParams.connected);
  const [conns, allow, overview] = await Promise.all([
    getConnections(orgId, projectId),
    getAllowlist(orgId, projectId),
    getOverview(orgId, projectId),
  ]);
  const productLayer = overview?.productLayer ?? false;
  const autoBind = overview?.autoBind ?? false;
  const isOwner = overview?.viewer?.role === "owner";
  const connections = conns?.connections ?? [];
  const allowlist = allow?.allowlist ?? [];
  const connectedTools = new Set(connections.map((c) => c.tool));

  const notionActive = connections.filter((c) => c.tool === "notion" && c.status === "active");
  const mappingsByConn = new Map<string, StateMappingContainer[]>();
  await Promise.all(
    notionActive.map(async (c) => {
      const m = await getStateMappings(orgId, projectId, c.id);
      mappingsByConn.set(c.id, m?.containers ?? []);
    }),
  );
  const sourcesByConn = new Map<string, Source[]>();
  await Promise.all(
    connections
      .filter((c) => c.status === "active")
      .map(async (c) => {
        const s = await getConnectionSources(orgId, projectId, c.id);
        sourcesByConn.set(c.id, s?.sources ?? []);
      }),
  );

  const ids = (
    <>
      <input type="hidden" name="orgId" value={orgId} />
      <input type="hidden" name="projectId" value={projectId} />
    </>
  );

  const Toggle = ({
    title,
    description,
    enabled,
    action,
  }: {
    title: string;
    description: string;
    enabled: boolean;
    action: (fd: FormData) => Promise<void>;
  }) => (
    <ListRow
      title={title}
      extra={description}
      status={!isOwner ? <StatusBadge status={enabled ? "enabled" : "disabled"} /> : undefined}
      action={
        isOwner ? (
          <form action={action}>
            {ids}
            <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
            <Button size="sm" variant={enabled ? "ghost" : "secondary"}>
              {enabled ? "Disable" : "Enable"}
            </Button>
          </form>
        ) : undefined
      }
    />
  );

  return (
    <>
      <PageHeader
        title="Connections"
        description="Tools are connected once for the whole org; the sources you allowlist route into this project. Only allowlisted sources are read."
      />

      <Section label="Project settings">
        <Toggle
          title="Product layer"
          description="Ingest PRDs from Notion into ratified product constraints, with drift detection against engineering decisions."
          enabled={productLayer}
          action={setProductLayerAction}
        />
        <Toggle
          title="Auto-bind low-risk decisions"
          description="Skip the review queue for ingested rules that are own-area (no consumers) and high-confidence (≥ 90%). Cross-cutting rules still wait for a human."
          enabled={autoBind}
          action={setAutoBindAction}
        />
      </Section>

      <Section label="Connect a tool" bare>
        <Card className="shadow-none">
          <CardContent className="p-4">
            <form action={createConnectionAction} className="flex flex-wrap items-center gap-2">
              {ids}
              <select name="tool" defaultValue="slack" className={selectCls} aria-label="Tool">
                {TOOLS.filter((t) => !connectedTools.has(t)).map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <Button variant="secondary">Create connection</Button>
              <span className="text-xs text-muted-foreground">
                Creates the connection; you authorize it in the next step.
              </span>
            </form>
          </CardContent>
        </Card>
      </Section>

      {connections.length === 0 ? (
        <EmptyState icon={<Plug />} title="No connections yet">
          Connect Slack, Jira, Notion, Google Docs, or Confluence to start distilling decisions from your team&apos;s
          work.
        </EmptyState>
      ) : (
        connections.map((c) => {
          const entries = allowlist.filter((a) => a.connectionId === c.id);
          const kind = SOURCE_KIND[c.tool] ?? "channel";
          const containers = mappingsByConn.get(c.id) ?? [];
          return (
            <Section key={c.id} label={c.tool} count={entries.length} bare>
              <Card className="shadow-none">
                <CardContent className="p-0">
                  <ListRow
                    title={<span className="capitalize">{c.tool}</span>}
                    meta={
                      <>
                        <RefChip>{c.id}</RefChip>
                        {c.connectedAccountId && <span>account {c.connectedAccountId.slice(0, 12)}…</span>}
                      </>
                    }
                    status={<StatusBadge status={c.status} />}
                    action={
                      c.status !== "active" ? (
                        <form action={initiateConnectionAction}>
                          {ids}
                          <input type="hidden" name="connectionId" value={c.id} />
                          <Button size="sm">Authorize {c.tool}</Button>
                        </form>
                      ) : undefined
                    }
                  />
                  {entries.map((a) => (
                    <ListRow
                      key={a.id}
                      title={a.sourceName ?? a.sourceRef}
                      meta={
                        <>
                          <RefChip>{a.sourceRef}</RefChip>
                          <RefChip copy={false}>{a.sourceKind}</RefChip>
                        </>
                      }
                      status={<StatusBadge status={a.enabled ? "enabled" : "disabled"} />}
                    />
                  ))}
                  <div className="border-t p-4">
                    <form action={addAllowlistAction} className="flex flex-wrap items-start gap-2">
                      {ids}
                      <input type="hidden" name="connectionId" value={c.id} />
                      <input type="hidden" name="sourceKind" value={kind} />
                      <SourcePicker sources={sourcesByConn.get(c.id) ?? []} hint={SOURCE_HINT[c.tool] ?? ""} />
                      <Button variant="secondary">Add {kind}</Button>
                    </form>
                  </div>

                  {c.tool === "notion" && c.status === "active" && (
                    <div className="border-t p-4">
                      <div className="mb-2 text-2xs font-semibold uppercase text-muted-foreground">State mappings</div>
                      {containers.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          Allowlist a Notion database to configure how its status values map to document states.
                        </p>
                      ) : (
                        containers.map((ct) => {
                          const mapped = new Map(ct.mappings.map((m) => [m.sourceValue, m.canonicalState]));
                          const pendingByValue = new Map(ct.pendingValues.map((p) => [p.value, p.firstSeenAt]));
                          const values = Array.from(
                            new Set([...ct.knownValues, ...mapped.keys(), ...pendingByValue.keys()]),
                          );
                          return (
                            <div key={ct.containerRef} className="mb-4 grid gap-3">
                              <div className="flex flex-wrap items-center gap-2 text-sm">
                                <span className="font-medium">{ct.containerName ?? ct.containerRef}</span>
                                <RefChip>{ct.containerRef}</RefChip>
                              </div>
                              <form action={setStatusPropertyAction} className="flex flex-wrap items-center gap-2">
                                {ids}
                                <input type="hidden" name="connectionId" value={c.id} />
                                <input type="hidden" name="containerRef" value={ct.containerRef} />
                                <Input
                                  name="statusProperty"
                                  defaultValue={ct.statusProperty ?? ""}
                                  placeholder='Status property, e.g. "Status"'
                                  className="w-56"
                                  required
                                  aria-label="Status property"
                                />
                                <Button size="sm" variant="secondary">
                                  Set status property
                                </Button>
                              </form>
                              {values.length > 0 && (
                                <div className="rounded-md border">
                                  {values.map((v) => {
                                    const firstSeenAt = pendingByValue.get(v);
                                    return (
                                      <form
                                        key={v}
                                        action={setStateMappingAction}
                                        className="flex flex-wrap items-center gap-2 border-b px-3 py-2 last:border-b-0"
                                      >
                                        {ids}
                                        <input type="hidden" name="connectionId" value={c.id} />
                                        <input type="hidden" name="containerRef" value={ct.containerRef} />
                                        <input type="hidden" name="sourceValue" value={v} />
                                        <span className="min-w-0 flex-1 truncate text-sm">{v}</span>
                                        {firstSeenAt && (
                                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                            <StatusBadge status="pending" /> first seen <When at={firstSeenAt} />
                                          </span>
                                        )}
                                        <select
                                          name="canonicalState"
                                          defaultValue={mapped.get(v) ?? ""}
                                          className="h-8 rounded-md border bg-card px-2 text-sm"
                                          aria-label={`Map ${v}`}
                                        >
                                          <option value="">—</option>
                                          {CANONICAL_STATES.map((s) => (
                                            <option key={s} value={s}>
                                              {s}
                                            </option>
                                          ))}
                                        </select>
                                        <Button size="sm" variant="secondary">
                                          Map
                                        </Button>
                                      </form>
                                    );
                                  })}
                                </div>
                              )}
                              <form action={setStateMappingAction} className="flex flex-wrap items-end gap-2">
                                {ids}
                                <input type="hidden" name="connectionId" value={c.id} />
                                <input type="hidden" name="containerRef" value={ct.containerRef} />
                                <Field label="Source value" htmlFor={`sv-${ct.containerRef}`}>
                                  <Input
                                    id={`sv-${ct.containerRef}`}
                                    name="sourceValue"
                                    placeholder="e.g. In Progress"
                                    className="w-56"
                                    required
                                  />
                                </Field>
                                <Field label="Maps to" htmlFor={`cs-${ct.containerRef}`}>
                                  <select
                                    id={`cs-${ct.containerRef}`}
                                    name="canonicalState"
                                    defaultValue="draft"
                                    className={selectCls}
                                  >
                                    {CANONICAL_STATES.map((s) => (
                                      <option key={s} value={s}>
                                        {s}
                                      </option>
                                    ))}
                                  </select>
                                </Field>
                                <Button size="sm" variant="secondary">
                                  Add mapping
                                </Button>
                              </form>
                            </div>
                          );
                        })
                      )}
                      <p className="text-xs text-muted-foreground">
                        Lockstep never writes status back to Notion. Unmapped values never guess — a document keeps its
                        last known state until you map them.
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </Section>
          );
        })
      )}
    </>
  );
}
