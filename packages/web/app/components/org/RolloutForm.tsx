"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyRolloutAction, previewRolloutAction, type RolloutChange } from "@/org-actions";
import type { RolloutPreview, SelectorsIn } from "@/lib/org-data";
import { btn } from "@/components/next/bits";
import { cn } from "@/lib/utils";
import { PreviewPanel } from "./RolloutPreview";

export interface Pickable {
  itemId: string;
  versionId: string;
  kind: "standard" | "skill" | "check";
  name: string;
  version: number;
}
type Opt = { id: string; label: string };

const label = "mb-1 block text-[11px] font-semibold uppercase tracking-[0.04em] text-faint";
const field =
  "w-full rounded-md border bg-muted px-2.5 py-1.5 text-[13px] outline-none placeholder:text-faint focus:border-border-strong";

function Checks({
  opts,
  value,
  onChange,
  empty,
}: {
  opts: Opt[];
  value: string[];
  onChange: (v: string[]) => void;
  empty: string;
}) {
  if (!opts.length) return <p className="text-[12px] text-faint">{empty}</p>;
  return (
    <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border px-2 py-1.5">
      {opts.map((o) => (
        <li key={o.id}>
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={value.includes(o.id)}
              onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((x) => x !== o.id))}
              className="accent-[var(--primary)]"
            />
            <span className="truncate">{o.label}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

/**
 * Create a rollout (or revise one): what to release, to whom, how strongly. Preview is required
 * before apply, and any edit invalidates the preview — the admin always applies what they saw.
 */
export function RolloutForm({
  orgId,
  assignmentId,
  items,
  projects,
  repos,
  teams,
  people,
  initial,
}: {
  orgId: string;
  assignmentId?: string;
  items: Pickable[];
  projects: Opt[];
  repos: Opt[];
  teams: Opt[];
  people: Opt[];
  initial?: {
    name?: string;
    versionIds?: string[];
    level?: "required" | "recommended";
    selectors?: SelectorsIn | null;
    pilot?: SelectorsIn | null;
  };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const s0 = initial?.selectors ?? {};
  const [name, setName] = useState(initial?.name ?? "");
  const [versionIds, setVersionIds] = useState<string[]>(initial?.versionIds ?? []);
  const [level, setLevel] = useState<"required" | "recommended">(initial?.level ?? "required");
  const [projectIds, setProjectIds] = useState<string[]>(s0.projects ?? []);
  const [repoIds, setRepoIds] = useState<string[]>(s0.repos ?? []);
  const [audKind, setAudKind] = useState<"all" | "teams" | "members">(s0.audience?.kind ?? "all");
  const [audIds, setAudIds] = useState<string[]>(s0.audience && s0.audience.kind !== "all" ? s0.audience.ids : []);
  const [globs, setGlobs] = useState((s0.pathGlobs ?? []).join("\n"));
  const [tasks, setTasks] = useState<string[]>(s0.taskTypes ?? []);
  const p0 = initial?.pilot;
  const [pilotOn, setPilotOn] = useState(Boolean(p0));
  const [pilotKind, setPilotKind] = useState<"teams" | "members">(
    p0?.audience?.kind === "members" ? "members" : "teams",
  );
  const [pilotIds, setPilotIds] = useState<string[]>(p0?.audience && p0.audience.kind !== "all" ? p0.audience.ids : []);
  const [preview, setPreview] = useState<RolloutPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const change = useMemo((): RolloutChange => {
    const selectors: SelectorsIn = {
      projects: projectIds,
      repos: repoIds,
      pathGlobs: globs
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean),
      taskTypes: tasks,
      audience: audKind === "all" ? { kind: "all" } : { kind: audKind, ids: audIds },
    };
    const pilot = pilotOn ? { audience: { kind: pilotKind, ids: pilotIds } } : null;
    return assignmentId
      ? { kind: "revise", assignmentId, versionIds, selectors, level, pilot }
      : { kind: "create", name, versionIds, selectors, level, pilot };
  }, [
    assignmentId,
    name,
    versionIds,
    level,
    projectIds,
    repoIds,
    audKind,
    audIds,
    globs,
    tasks,
    pilotOn,
    pilotKind,
    pilotIds,
  ]);

  // Every edit invalidates the preview, so what's applied is always what was previewed.
  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPreview(null);
    };

  const byKind = (k: Pickable["kind"]) =>
    items.filter((i) => i.kind === k).map((i) => ({ id: i.versionId, label: `${i.name} · v${i.version}` }));
  const hasSkills = items.some((i) => i.kind === "skill" && versionIds.includes(i.versionId));

  return (
    <div className="max-w-3xl space-y-6">
      {!assignmentId && (
        <div>
          <label htmlFor="rollout-name" className={label}>
            Name
          </label>
          <input
            id="rollout-name"
            value={name}
            onChange={(e) => edit(setName)(e.target.value)}
            className={field}
            placeholder="API baseline"
          />
        </div>
      )}

      <fieldset>
        <legend className={label}>What to roll out (published versions)</legend>
        <p className="mb-2 text-[12px] text-faint">
          A standard applies only to the task types it was written for, even where this rollout’s scope is broader. Skills and
          checks a standard attaches are included at the versions it pins.
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          {(
            [
              ["standard", "Standards"],
              ["skill", "Skills"],
              ["check", "Checks"],
            ] as const
          ).map(([k, t]) => (
            <div key={k}>
              <div className="mb-1 text-[12px] text-muted-foreground">{t}</div>
              <Checks opts={byKind(k)} value={versionIds} onChange={edit(setVersionIds)} empty="None published." />
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className={label}>Level</legend>
        <div className="flex gap-4 text-[13px]">
          {(["required", "recommended"] as const).map((l) => (
            <label key={l} className="flex items-center gap-1.5">
              <input
                type="radio"
                name="level"
                checked={level === l}
                onChange={() => edit(setLevel)(l)}
                className="accent-[var(--primary)]"
              />
              {l === "required"
                ? "Required — installs in every checkout in scope"
                : "Recommended — offered; people opt in"}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className={label}>Scope — empty means the whole organization</legend>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <div className="mb-1 text-[12px] text-muted-foreground">Projects</div>
            <Checks opts={projects} value={projectIds} onChange={edit(setProjectIds)} empty="No projects." />
          </div>
          <div>
            <div className="mb-1 text-[12px] text-muted-foreground">Repositories</div>
            <Checks opts={repos} value={repoIds} onChange={edit(setRepoIds)} empty="No repositories." />
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <div className="mb-1 text-[12px] text-muted-foreground">People</div>
            <select
              value={audKind}
              onChange={(e) => (edit(setAudKind)(e.target.value as "all"), setAudIds([]))}
              className={cn(field, "mb-2 h-8")}
              aria-label="Audience"
            >
              <option value="all">Everyone in scope</option>
              <option value="teams">Specific teams</option>
              <option value="members">Specific people</option>
            </select>
            {audKind !== "all" && (
              <Checks
                opts={audKind === "teams" ? teams : people}
                value={audIds}
                onChange={edit(setAudIds)}
                empty="None yet."
              />
            )}
          </div>
          <div className="space-y-3">
            <div>
              <div className="mb-1 text-[12px] text-muted-foreground">Task types (guidance only)</div>
              <div className="flex gap-4 text-[13px]">
                {(
                  [
                    ["code", "Code changes"],
                    ["prd", "PRD work"],
                  ] as const
                ).map(([v, l]) => (
                  <label key={v} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={tasks.includes(v)}
                      onChange={(e) => edit(setTasks)(e.target.checked ? [...tasks, v] : tasks.filter((x) => x !== v))}
                      className="accent-[var(--primary)]"
                    />
                    {l}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label htmlFor="globs" className="mb-1 block text-[12px] text-muted-foreground">
                Path patterns (guidance only, one per line)
              </label>
              <textarea
                id="globs"
                rows={3}
                value={globs}
                onChange={(e) => edit(setGlobs)(e.target.value)}
                className={cn(field, "font-mono text-[12px]")}
                placeholder="src/api/**"
              />
            </div>
            {hasSkills && (
              <p className="text-[11px] text-faint">
                Skills install for the whole checkout; task types and paths narrow when a standard applies, not where a
                skill is installed.
              </p>
            )}
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend className={label}>Pilot</legend>
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={pilotOn}
            onChange={(e) => edit(setPilotOn)(e.target.checked)}
            className="accent-[var(--primary)]"
          />
          Start with a pilot group inside the scope
        </label>
        {pilotOn && (
          <div className="mt-2 max-w-sm">
            <select
              value={pilotKind}
              onChange={(e) => (edit(setPilotKind)(e.target.value as "teams"), setPilotIds([]))}
              className={cn(field, "mb-2 h-8")}
              aria-label="Pilot group"
            >
              <option value="teams">Teams</option>
              <option value="members">People</option>
            </select>
            <Checks
              opts={pilotKind === "teams" ? teams : people}
              value={pilotIds}
              onChange={edit(setPilotIds)}
              empty="None yet."
            />
            <p className="mt-1 text-[11px] text-faint">Expand later by revising the rollout without the pilot.</p>
          </div>
        )}
      </fieldset>

      <div className="flex items-center gap-2 border-t pt-4">
        <button
          type="button"
          disabled={pending || versionIds.length === 0}
          className={btn.outline}
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await previewRolloutAction(orgId, change);
              if (r.ok) setPreview(r.data);
              else setError(r.error);
            })
          }
        >
          Preview impact
        </button>
        <button
          type="button"
          disabled={pending || !preview}
          title={preview ? undefined : "Preview first"}
          className={btn.primary}
          onClick={() =>
            start(async () => {
              const r = await applyRolloutAction(orgId, change, preview!.basis);
              if (!r.ok) return setError(r.error);
              router.push(`/org/${orgId}/rollouts/${r.data.assignmentId ?? assignmentId}`);
            })
          }
        >
          {assignmentId ? "Apply revision" : "Start rollout"}
        </button>
        {pending && <span className="text-[12px] text-faint">Working…</span>}
        {error && (
          <span role="alert" className="text-[12px] text-destructive">
            {error}
          </span>
        )}
      </div>
      {preview && <PreviewPanel p={preview} />}
    </div>
  );
}
