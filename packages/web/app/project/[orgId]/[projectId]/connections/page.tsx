import {
  getOverview,
  getConnections,
  getAllowlist,
  getStateMappings,
  getConnectionSources,
  checkConnectionStatus,
  timeAgo,
} from "@/lib/data";
import type { StateMappingContainer } from "@/lib/data";
import { PageHead, EmptyState, StatusPill } from "@/components/ui";
import { SourcePicker, type Source } from "@/components/SourcePicker";
import { IconMembers } from "@/components/icons";
import {
  createConnectionAction,
  initiateConnectionAction,
  addAllowlistAction,
  setStateMappingAction,
  setStatusPropertyAction,
  setProductLayerAction,
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

export default async function Page({
  params,
  searchParams,
}: {
  params: { orgId: string; projectId: string };
  searchParams?: { connected?: string };
}) {
  const { orgId, projectId } = params;
  // Returning from the Composio authorize page (?connected=<id>) → finalize before we render the list.
  if (searchParams?.connected) await checkConnectionStatus(orgId, projectId, searchParams.connected);
  const [conns, allow, overview] = await Promise.all([
    getConnections(orgId, projectId),
    getAllowlist(orgId, projectId),
    getOverview(orgId, projectId),
  ]);
  const productLayer = overview?.productLayer ?? false;
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

  // Fetch the connectable sources for each active connection so the allowlist form can offer a
  // searchable picker instead of raw-id entry.
  const sourcesByConn = new Map<string, Source[]>();
  await Promise.all(
    connections
      .filter((c) => c.status === "active")
      .map(async (c) => {
        const s = await getConnectionSources(orgId, projectId, c.id);
        sourcesByConn.set(c.id, s?.sources ?? []);
      }),
  );

  return (
    <>
      <PageHead
        title="Connections"
        subtitle="Connect a tool via Composio, then allowlist the exact sources to sweep. Only allowlisted sources are read."
      />

      <div className="card pad animate-in" style={{ marginBottom: 16 }}>
        <div className="row">
          <div className="body">
            <div className="title">Product layer</div>
            <div className="meta">
              Ingest PRDs from Notion → ratified product constraints, with drift detection against engineering
              decisions. {productLayer ? "Enabled." : "Disabled."}
            </div>
          </div>
          {isOwner ? (
            <form action={setProductLayerAction}>
              <input type="hidden" name="orgId" value={orgId} />
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="enabled" value={productLayer ? "false" : "true"} />
              <button className={productLayer ? "btn ghost" : "btn primary"}>
                {productLayer ? "Disable" : "Enable"}
              </button>
            </form>
          ) : (
            <span className="tip" data-tip="Only owners can change this">
              <StatusPill status={productLayer ? "active" : "disabled"} />
            </span>
          )}
        </div>
      </div>

      <form action={createConnectionAction} className="card animate-in" style={{ padding: 16, marginBottom: 16 }}>
        <input type="hidden" name="orgId" value={orgId} />
        <input type="hidden" name="projectId" value={projectId} />
        <div className="title" style={{ marginBottom: 8 }}>
          Connect a tool
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select name="tool" className="input" defaultValue="slack">
            {TOOLS.filter((t) => !connectedTools.has(t)).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button className="btn primary">Create connection</button>
        </div>
      </form>

      {connections.length === 0 ? (
        <EmptyState icon={<IconMembers />} title="No connections yet">
          Connect Slack, Jira, Notion, or Confluence to start distilling decisions from your team&apos;s work.
        </EmptyState>
      ) : (
        connections.map((c) => {
          const entries = allowlist.filter((a) => a.connectionId === c.id);
          const kind = SOURCE_KIND[c.tool] ?? "channel";
          const containers = mappingsByConn.get(c.id) ?? [];
          return (
            <div className="card animate-in" key={c.id} style={{ marginBottom: 16, padding: 16 }}>
              <div className="row" style={{ marginBottom: 8 }}>
                <div className="body">
                  <div className="title" style={{ textTransform: "capitalize" }}>
                    {c.tool}
                  </div>
                  <div className="meta">
                    <span className="code-ref">{c.id}</span>
                    {c.connectedAccountId && <span>account {c.connectedAccountId.slice(0, 12)}…</span>}
                  </div>
                </div>
                <StatusPill status={c.status} />
              </div>

              {c.status !== "active" && (
                <form action={initiateConnectionAction} style={{ margin: "6px 0" }}>
                  <input type="hidden" name="orgId" value={orgId} />
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="connectionId" value={c.id} />
                  <button className="btn primary">Authorize {c.tool} →</button>
                  <span className="meta" style={{ marginLeft: 8 }}>
                    opens {c.tool} to grant access, then returns here
                  </span>
                </form>
              )}

              {entries.length > 0 && (
                <div className="rows" style={{ margin: "8px 0" }}>
                  {entries.map((a) => (
                    <div className="row" key={a.id}>
                      <div className="body">
                        <div className="title">{a.sourceName ?? a.sourceRef}</div>
                        <div className="meta">
                          <span className="code-ref">{a.sourceRef}</span>
                          <span className="pill plain">{a.sourceKind}</span>
                        </div>
                      </div>
                      <StatusPill status={a.enabled ? "enabled" : "disabled"} />
                    </div>
                  ))}
                </div>
              )}

              <form action={addAllowlistAction} style={{ marginTop: 8 }}>
                <input type="hidden" name="orgId" value={orgId} />
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="connectionId" value={c.id} />
                <input type="hidden" name="sourceKind" value={kind} />
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-start" }}>
                  <SourcePicker sources={sourcesByConn.get(c.id) ?? []} hint={SOURCE_HINT[c.tool]} />
                  <button className="btn primary">Add {kind}</button>
                </div>
              </form>

              {c.tool === "notion" && c.status === "active" && (
                <div style={{ marginTop: 18 }}>
                  <div className="section-title" style={{ margin: "0 0 8px" }}>
                    State mappings
                  </div>
                  {containers.length === 0 ? (
                    <p style={{ color: "var(--dim)", margin: 0 }}>
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
                        <div key={ct.containerRef} style={{ marginBottom: 14 }}>
                          <div className="meta" style={{ marginBottom: 6 }}>
                            <span style={{ color: "var(--text)", fontWeight: 600 }}>
                              {ct.containerName ?? ct.containerRef}
                            </span>
                            <span className="code-ref">{ct.containerRef}</span>
                          </div>

                          <form className="inline" action={setStatusPropertyAction}>
                            <input type="hidden" name="orgId" value={orgId} />
                            <input type="hidden" name="projectId" value={projectId} />
                            <input type="hidden" name="connectionId" value={c.id} />
                            <input type="hidden" name="containerRef" value={ct.containerRef} />
                            <input
                              className="input"
                              name="statusProperty"
                              defaultValue={ct.statusProperty ?? ""}
                              placeholder='status property e.g. "Status"'
                              style={{ maxWidth: 220 }}
                              required
                            />
                            <button className="btn">Set status property</button>
                          </form>

                          {values.length > 0 && (
                            <div className="rows" style={{ margin: "8px 0" }}>
                              {values.map((v) => {
                                const firstSeenAt = pendingByValue.get(v);
                                return (
                                  <form className="row" action={setStateMappingAction} key={v}>
                                    <input type="hidden" name="orgId" value={orgId} />
                                    <input type="hidden" name="projectId" value={projectId} />
                                    <input type="hidden" name="connectionId" value={c.id} />
                                    <input type="hidden" name="containerRef" value={ct.containerRef} />
                                    <input type="hidden" name="sourceValue" value={v} />
                                    <div className="body">
                                      <div className="title">{v}</div>
                                      {firstSeenAt && (
                                        <div className="meta">
                                          <span className="pill unverified">unmapped</span>
                                          <span>first seen {timeAgo(firstSeenAt)}</span>
                                        </div>
                                      )}
                                    </div>
                                    <select
                                      name="canonicalState"
                                      className="input"
                                      defaultValue={mapped.get(v) ?? ""}
                                      style={{ maxWidth: 140 }}
                                    >
                                      <option value="">—</option>
                                      {CANONICAL_STATES.map((s) => (
                                        <option key={s} value={s}>
                                          {s}
                                        </option>
                                      ))}
                                    </select>
                                    <button className="btn">Map</button>
                                  </form>
                                );
                              })}
                            </div>
                          )}

                          <form className="inline" action={setStateMappingAction} style={{ marginTop: 8 }}>
                            <input type="hidden" name="orgId" value={orgId} />
                            <input type="hidden" name="projectId" value={projectId} />
                            <input type="hidden" name="connectionId" value={c.id} />
                            <input type="hidden" name="containerRef" value={ct.containerRef} />
                            <input
                              className="input"
                              name="sourceValue"
                              placeholder="source value e.g. In Progress"
                              style={{ maxWidth: 220 }}
                              required
                            />
                            <select
                              name="canonicalState"
                              className="input"
                              defaultValue="draft"
                              style={{ maxWidth: 140 }}
                            >
                              {CANONICAL_STATES.map((s) => (
                                <option key={s} value={s}>
                                  {s}
                                </option>
                              ))}
                            </select>
                            <button className="btn">Add mapping</button>
                          </form>
                        </div>
                      );
                    })
                  )}
                  <p style={{ color: "var(--muted)", marginTop: 10, marginBottom: 0 }}>
                    Lockstep never writes status back to Notion. Mapping is read-only mirroring.
                  </p>
                  <p style={{ color: "var(--dim)", marginTop: 4, marginBottom: 0 }}>
                    Unmapped status values never guess — the document keeps its last known state until you map them.
                  </p>
                </div>
              )}
            </div>
          );
        })
      )}
    </>
  );
}
