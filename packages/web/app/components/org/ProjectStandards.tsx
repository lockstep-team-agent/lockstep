import {
  getExceptions,
  getProjectChecks,
  getProjectStandards,
  getWhy,
  type ArtifactCheck,
  type Reason,
} from "@/lib/org-data";
import { btn, Empty } from "@/components/next/bits";
import { When } from "@/components/When";
import { CheckDocumentForm, FindingActions, RequestException } from "./CheckControls";
import { cn } from "@/lib/utils";

const VERDICT = { satisfied: "Satisfied", possible_violation: "Possible issue", inconclusive: "Inconclusive" } as const;
const EXEC_TONE: Record<string, string> = {
  completed: "text-primary-ink",
  partial: "text-foreground",
  skipped: "text-faint",
  unavailable: "text-destructive",
  error: "text-destructive",
};

const h = "mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-faint";

/** Read-only: which assignments reach this project, and "why this applies" for a concrete context. */
export async function ProjectStandards({
  orgId,
  projectId,
  base,
  why,
}: {
  orgId: string;
  projectId: string;
  base: string;
  why: { repoId?: string; taskType?: string; paths?: string };
}) {
  const asked = Boolean(why.repoId || why.taskType || why.paths);
  const [ps, w, checks, ex] = await Promise.all([
    getProjectStandards(orgId, projectId),
    asked ? getWhy(orgId, projectId, why) : null,
    getProjectChecks(orgId, projectId),
    getExceptions(orgId, projectId),
  ]);
  if (!ps) return <Empty title="Standards unavailable" hint="The API didn't return this project's standards." />;
  const repoName = (id: string) =>
    ps.repos.find((r) => r.id === id)?.gitRemote.replace(/^.*[:/]([^/]+\/[^/]+?)(\.git)?$/, "$1") ?? id.slice(0, 8);
  return (
    <div className="grid gap-6 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section className="min-w-0">
        <h2 className={h}>Assignments reaching this project</h2>
        {ps.assignments.length === 0 ? (
          <p className="text-[13px] text-faint">No standards or skills are assigned here yet.</p>
        ) : (
          <ul className="space-y-3">
            {ps.assignments.map((a) => (
              <li key={a.assignmentId} className="rounded-md border px-3 py-2.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[13px] font-medium">{a.name}</span>
                  <span className="text-[11px] text-faint">
                    rev {a.revision} · {a.level}
                    {a.scope.pilot && " · pilot"}
                  </span>
                </div>
                <div className="mt-0.5 text-[12px] text-muted-foreground">
                  {[
                    a.scope.baseline
                      ? "Org-wide"
                      : a.scope.repos.length
                        ? a.scope.repos.map(repoName).join(", ")
                        : "all repos",
                    a.scope.pathGlobs.join(", "),
                    a.scope.taskTypes.length ? `${a.scope.taskTypes.join("/")} work` : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  {a.scope.audience.kind !== "all" &&
                    ` · ${a.scope.audience.kind} (${a.scope.audience.ids?.length ?? 0})`}
                </div>
                <ul className="mt-2 space-y-1.5">
                  {a.items.map((i) => (
                    <li key={i.versionId} className="text-[12px]">
                      <span className="text-faint">{i.kind}</span> <span className="font-medium">{i.name}</span>{" "}
                      <span className="tnum text-faint">v{i.version}</span>
                      {i.requirements && (
                        <ul className="ml-3 mt-1 space-y-0.5 text-muted-foreground">
                          {i.requirements.map((r) => (
                            <li key={r.key}>
                              <span className={r.level === "required" ? "text-foreground" : "text-faint"}>
                                {r.level === "required" ? "Must" : "Should"}
                              </span>{" "}
                              {r.text}
                              {a.exceptions.some(
                                (e) => e.versionId === i.versionId && (!e.requirementKey || e.requirementKey === r.key),
                              ) ? (
                                <span className="ml-1 text-faint">· exempt here</span>
                              ) : (
                                <span className="ml-2">
                                  <RequestException
                                    orgId={orgId}
                                    projectId={projectId}
                                    versionId={i.versionId}
                                    requirementKey={r.key}
                                  />
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="min-w-0">
        <h2 className={h}>Why does this apply?</h2>
        <form action={`${base}/ledger`} className="space-y-2">
          <input type="hidden" name="tab" value="standards" />
          <select
            name="repo"
            defaultValue={why.repoId ?? ""}
            aria-label="Repository"
            className="h-8 w-full rounded-md border bg-muted px-2 text-[12px]"
          >
            <option value="">No repository (repo-free work)</option>
            {ps.repos.map((r) => (
              <option key={r.id} value={r.id}>
                {repoName(r.id)}
              </option>
            ))}
          </select>
          <select
            name="task"
            defaultValue={why.taskType ?? ""}
            aria-label="Task type"
            className="h-8 w-full rounded-md border bg-muted px-2 text-[12px]"
          >
            <option value="">Task type unknown</option>
            <option value="code">Code change</option>
            <option value="prd">PRD work</option>
          </select>
          <input
            name="paths"
            defaultValue={why.paths}
            aria-label="Paths"
            placeholder="Paths, comma-separated (src/api/users.ts)"
            className="h-8 w-full rounded-md border bg-muted px-2.5 font-mono text-[12px] outline-none placeholder:text-faint"
          />
          <button type="submit" className={btn.outline}>
            Explain
          </button>
        </form>
        {w && (
          <div className="mt-4 space-y-3 text-[12px]">
            {[...w.standards, ...w.skills, ...w.checks].length === 0 && !w.blocked.length && (
              <p className="text-faint">Nothing applies in this context.</p>
            )}
            {w.standards.map((s) => (
              <Hit key={s.versionId} title={`Standard · ${s.name} v${s.version}`} reasons={s.reasons} />
            ))}
            {w.skills.map((s) => (
              <Hit
                key={s.versionId}
                title={`Skill · ${s.name} v${s.version} · ${s.level}${s.exempt ? " · exempt" : ""}`}
                reasons={s.reasons}
              />
            ))}
            {w.checks.map((s) => (
              <Hit key={s.versionId} title={`Check · ${s.name} v${s.version}`} reasons={s.reasons} />
            ))}
            {w.blocked.map((b) => (
              <div key={b.itemId} className="rounded-md border border-destructive/30 px-2.5 py-2 text-destructive">
                Blocked: {b.name} is assigned at {b.versions.map((v) => `v${v.version}`).join(" and ")} in this context.
                Resolve the overlap — nothing is installed until then.
              </div>
            ))}
            {w.unknown.map((u) => (
              <p key={u.assignmentId} className="text-faint">
                “{u.name}” might apply — unknown: {u.missing.join(", ")}.
              </p>
            ))}
            {w.limitations.map((l) => (
              <p key={l} className="text-faint">
                {l}
              </p>
            ))}
          </div>
        )}
      </section>

      <section className="min-w-0 lg:col-span-2">
        <h2 className={h}>Checks</h2>
        <CheckDocumentForm orgId={orgId} projectId={projectId} documents={checks?.documents ?? []} />
        <ul className="mt-4 space-y-3">
          {(checks?.checks ?? []).map((c) => (
            <CheckResult key={c.id} c={c} orgId={orgId} projectId={projectId} />
          ))}
          {checks && checks.checks.length === 0 && (
            <li className="text-[12px] text-faint">No checks have run in this project yet.</li>
          )}
        </ul>
      </section>

      {ex && ex.exceptions.length > 0 && (
        <section className="min-w-0 lg:col-span-2">
          <h2 className={h}>Exceptions in this project</h2>
          <ul className="space-y-1 text-[12px]">
            {ex.exceptions.map((x) => (
              <li key={x.id}>
                <span
                  className={cn(
                    "mr-2 font-medium",
                    x.state === "approved"
                      ? "text-primary-ink"
                      : x.state === "needs_review" || x.state === "expired"
                        ? "text-destructive"
                        : "text-faint",
                  )}
                >
                  {x.state.replace("_", " ")}
                </span>
                {x.itemName}
                {x.requirementText ? ` — ${x.requirementText}` : ""} <span className="text-faint">· {x.reason}</span>
                {x.expiresAt && (
                  <span className="text-faint"> · until {new Date(x.expiresAt).toLocaleDateString()}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** One result: execution first, then findings — a skipped or unavailable check is never a pass. */
function CheckResult({ c, orgId, projectId }: { c: ArtifactCheck; orgId: string; projectId: string }) {
  const target =
    c.artifactKind === "prd"
      ? `“${c.artifactRef.title}” v${c.artifactRef.version}`
      : `code change · ${(c.artifactRef.files ?? []).slice(0, 3).join(", ")}`;
  return (
    <li className={cn("rounded-md border px-3 py-2.5", c.stale && "opacity-70")}>
      <div className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
        <span className="font-medium">{c.name ?? (c.artifactKind === "prd" ? "PRD checks" : "Standards")}</span>
        <span className="text-faint">on {target}</span>
        <span className={EXEC_TONE[c.execution]}>{c.execution}</span>
        {c.stale && <span className="rounded border px-1 text-[11px] text-destructive">stale — {c.stale}</span>}
        <When at={c.createdAt} className="ml-auto text-[11px] text-faint" />
      </div>
      {c.executionDetail && <p className="text-[12px] text-muted-foreground">{c.executionDetail}</p>}
      {c.findings.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {c.findings.map((f) => (
            <li key={f.key} className="text-[12px]">
              <span
                className={cn(
                  "mr-1.5",
                  f.verdict === "possible_violation"
                    ? "text-destructive"
                    : f.verdict === "satisfied"
                      ? "text-primary-ink"
                      : "text-faint",
                )}
              >
                {VERDICT[f.verdict]}
              </span>
              {f.criterion}
              {f.evidence[0] && (
                <span className="text-faint">
                  {" "}
                  · {f.evidence[0].location}: “{f.evidence[0].quote.slice(0, 120)}”
                </span>
              )}
              {f.note && <span className="block text-[11px] text-faint">{f.note}</span>}
              {f.action ? (
                <span className="block text-[11px] text-faint">
                  {f.action.action === "dismiss" ? "Dismissed" : "Exception requested"}: {f.action.rationale}
                </span>
              ) : (
                f.verdict === "possible_violation" &&
                !c.stale && (
                  <FindingActions
                    orgId={orgId}
                    projectId={projectId}
                    checkId={c.id}
                    findingKey={f.key}
                    canRequest={Boolean(f.requirementKey)}
                  />
                )
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-[11px] text-faint">
        {c.evaluator} · artifact {c.artifactHash.slice(0, 10)} · {c.releaseIds.length} release
        {c.releaseIds.length === 1 ? "" : "s"}
        {c.findings.some((f) => f.verdict !== "inconclusive") &&
          c.evaluator !== "lockstep-structural@1" &&
          " · advisory assessment"}
      </p>
    </li>
  );
}

function Hit({ title, reasons }: { title: string; reasons: Reason[] }) {
  return (
    <div className="rounded-md border px-2.5 py-2">
      <div className="font-medium">{title}</div>
      {reasons.map((r) => (
        <div key={`${r.assignmentId}-${r.revision}`} className="text-muted-foreground">
          via {r.name} rev {r.revision}: {r.matched.join(", ")}
        </div>
      ))}
    </div>
  );
}
