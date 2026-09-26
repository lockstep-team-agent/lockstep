"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { createItemAction, proposeAction, publishAction, saveDraftAction, type FileInput } from "@/org-actions";
import type { Kind, Requirement } from "@/lib/org-data";
import { btn } from "@/components/next/bits";
import { cn } from "@/lib/utils";

export interface PinOption {
  itemId: string;
  versionId: string;
  label: string;
}

const field =
  "w-full rounded-md border bg-muted px-2.5 py-1.5 text-[13px] leading-5 outline-none placeholder:text-faint focus:border-border-strong focus-visible:ring-0 focus-visible:ring-offset-0";
const label = "mb-1 block text-[11px] font-semibold uppercase tracking-[0.04em] text-faint";

const DEFAULT_SKILL = `---
name: my-skill
description: One line on what this skill does and when to use it
---

# Instructions

Describe, step by step, what the agent should do.
`;

export function ItemEditor({
  orgId,
  kind,
  itemId,
  initialName = "",
  initialContent,
  initialFiles,
  packageLocked = false,
  workingVersionId,
  workingState,
  canPublish,
  skillOptions = [],
  checkOptions = [],
  requirementOptions = [],
  shownVersion,
}: {
  orgId: string;
  kind: Kind;
  itemId?: string;
  initialName?: string;
  initialContent: Record<string, unknown>;
  initialFiles?: FileInput[];
  /** Imported packages are snapshots: their files can't be edited here. */
  packageLocked?: boolean;
  workingVersionId?: string | null;
  workingState?: string | null;
  canPublish: boolean;
  skillOptions?: PinOption[];
  checkOptions?: PinOption[];
  /** Published standards' requirements a check can link to (no raw req_ keys to copy). */
  requirementOptions?: Array<{ key: string; text: string; standard: string }>;
  /** The version this editor was opened on — saves are refused if the item moved on since. */
  shownVersion?: { versionId: string; reviewHash: string } | null;
}) {
  const basis = useRef(shownVersion ?? undefined);
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState(initialName);
  const c = initialContent as Record<string, unknown>;
  // standard
  const [purpose, setPurpose] = useState(String(c.purpose ?? ""));
  const [taskTypes, setTaskTypes] = useState<string[]>((c.taskTypes as string[]) ?? []);
  const [reqs, setReqs] = useState<Requirement[]>(
    ((c.requirements as Requirement[]) ?? []).map((r) => ({ ...r, rationale: r.rationale ?? "" })),
  );
  const [skills, setSkills] = useState<string[]>(
    ((c.skills as Array<{ versionId: string }>) ?? []).map((p) => p.versionId),
  );
  const [checks, setChecks] = useState<string[]>(
    ((c.checks as Array<{ versionId: string }>) ?? []).map((p) => p.versionId),
  );
  // skill
  const [whenToUse, setWhenToUse] = useState(String(c.whenToUse ?? ""));
  const [files, setFiles] = useState<FileInput[]>(
    initialFiles?.length ? initialFiles : [{ path: "SKILL.md", content: DEFAULT_SKILL }],
  );
  // check
  const [artifactType, setArtifactType] = useState(String(c.artifactType ?? "prd"));
  const [method, setMethod] = useState(String(c.method ?? "structural"));
  const [sections, setSections] = useState(((c.requiredSections as string[]) ?? []).join("\n"));
  const [instructions, setInstructions] = useState(String(c.instructions ?? ""));
  const [reqKeys, setReqKeys] = useState<string[]>((c.requirementKeys as string[]) ?? []);
  const [examples, setExamples] = useState(String(c.examples ?? ""));
  const [links, setLinks] = useState(((c.sourceLinks as string[]) ?? []).join("\n"));

  const content = (): Record<string, unknown> => {
    const pins = (ids: string[], opts: PinOption[]) =>
      ids
        .map((v) => opts.find((o) => o.versionId === v))
        .filter((o): o is PinOption => Boolean(o))
        .map((o) => ({ itemId: o.itemId, versionId: o.versionId }));
    if (kind === "standard")
      return {
        ...c,
        purpose,
        taskTypes,
        requirements: reqs
          .filter((r) => r.text.trim())
          .map((r) => ({ ...(r.key ? { key: r.key } : {}), text: r.text, rationale: r.rationale, level: r.level })),
        skills: pins(skills, skillOptions),
        checks: pins(checks, checkOptions),
        examples,
        sourceLinks: links
          .split("\n")
          .map((x) => x.trim())
          .filter((x) => /^https?:\/\//.test(x)),
      };
    if (kind === "skill") return { ...c, purpose, whenToUse };
    const lines = (s: string) =>
      s
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
    return {
      ...c,
      artifactType,
      method: artifactType === "code_diff" ? "rubric" : method,
      requiredSections: lines(sections),
      instructions,
      requirementKeys: reqKeys,
    };
  };

  const act = (fn: () => Promise<void>) =>
    start(async () => {
      setError(null);
      setNotice(null);
      await fn();
    });

  const save = (then?: "propose" | "publish") =>
    act(async () => {
      const sendFiles = kind === "skill" && !packageLocked ? files : undefined;
      if (!itemId) {
        const r = await createItemAction(orgId, kind, name, content(), sendFiles);
        if (!r.ok) return setError(r.error);
        router.push(`/org/${orgId}/standards/${r.data.itemId}`);
        return;
      }
      const r = await saveDraftAction(orgId, itemId, content(), sendFiles, basis.current);
      if (!r.ok) return setError(r.error);
      basis.current = { versionId: r.data.versionId, reviewHash: r.data.reviewHash }; // what we now show
      if (then === "propose") {
        const p = await proposeAction(orgId, r.data.versionId);
        if (!p.ok) return setError(p.error);
        setNotice(`v${r.data.version} proposed — an org admin can publish it.`);
      } else if (then === "publish") {
        const p = await publishAction(orgId, r.data.versionId, r.data.reviewHash);
        if (!p.ok) return setError(p.error);
        setNotice(`v${r.data.version} published. Existing assignments are unchanged until a rollout targets it.`);
      } else setNotice(`Saved as draft v${r.data.version}.`);
      router.refresh();
    });

  return (
    <div className="space-y-5">
      {!itemId && (
        <div>
          <label className={label} htmlFor="item-name">
            Name
          </label>
          <input
            id="item-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={field}
            placeholder={
              kind === "standard"
                ? "Public API changes"
                : kind === "skill"
                  ? "api-change-review"
                  : "PRD sections present"
            }
          />
        </div>
      )}

      {(kind === "standard" || kind === "skill") && (
        <div>
          <label className={label} htmlFor="purpose">
            Purpose
          </label>
          <textarea
            id="purpose"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            rows={2}
            className={field}
            placeholder="Why this exists, in one or two sentences"
          />
        </div>
      )}

      {kind === "standard" && (
        <>
          <fieldset>
            <legend className={label}>Task types</legend>
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
                    checked={taskTypes.includes(v)}
                    onChange={(e) => setTaskTypes((t) => (e.target.checked ? [...t, v] : t.filter((x) => x !== v)))}
                    className="accent-[var(--primary)]"
                  />
                  {l}
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <span className={label}>Requirements</span>
            <ul className="space-y-2">
              {reqs.map((r, i) => (
                <li
                  key={r.key ?? `new-${i}`}
                  className={cn(
                    "rail rounded-md border py-2 pl-4 pr-2",
                    r.level === "required" ? "rail-binding" : "rail-proposed",
                  )}
                >
                  <div className="flex items-start gap-2">
                    <textarea
                      value={r.text}
                      onChange={(e) =>
                        setReqs((xs) => xs.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))
                      }
                      rows={2}
                      aria-label={`Requirement ${i + 1}`}
                      placeholder="What must be true"
                      className={cn(field, "flex-1")}
                    />
                    <select
                      value={r.level}
                      onChange={(e) =>
                        setReqs((xs) =>
                          xs.map((x, j) => (j === i ? { ...x, level: e.target.value as Requirement["level"] } : x)),
                        )
                      }
                      aria-label="Requirement level"
                      className="h-8 rounded-md border bg-muted px-2 text-[12px]"
                    >
                      <option value="required">Required</option>
                      <option value="recommended">Recommended</option>
                    </select>
                    <button
                      type="button"
                      aria-label="Remove requirement"
                      onClick={() => setReqs((xs) => xs.filter((_, j) => j !== i))}
                      className={btn.ghost}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <input
                    value={r.rationale}
                    onChange={(e) =>
                      setReqs((xs) => xs.map((x, j) => (j === i ? { ...x, rationale: e.target.value } : x)))
                    }
                    placeholder="Rationale (optional)"
                    aria-label={`Rationale ${i + 1}`}
                    className={cn(field, "mt-1.5 text-[12px]")}
                  />
                  {r.key && <div className="mt-1 font-mono text-[10px] text-faint">{r.key}</div>}
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setReqs((xs) => [...xs, { text: "", rationale: "", level: "required" }])}
              className={cn(btn.outline, "mt-2")}
            >
              <Plus className="h-3.5 w-3.5" /> Add requirement
            </button>
            <p className="mt-1.5 text-[11px] text-faint">
              “Required” is organizational policy — it doesn’t change agent permissions or add a merge gate.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className={label} htmlFor="examples">
                Examples
              </label>
              <textarea
                id="examples"
                value={examples}
                onChange={(e) => setExamples(e.target.value)}
                rows={4}
                className={field}
                placeholder="What following this looks like in practice (and what it doesn’t)"
              />
            </div>
            <div>
              <label className={label} htmlFor="links">
                Source links (one URL per line)
              </label>
              <textarea
                id="links"
                value={links}
                onChange={(e) => setLinks(e.target.value)}
                rows={4}
                className={cn(field, "font-mono text-[12px]")}
                placeholder="https://…"
              />
            </div>
          </div>
          {(skillOptions.length > 0 || checkOptions.length > 0) && (
            <div className="grid gap-4 md:grid-cols-2">
              {(
                [
                  ["Linked skills", skillOptions, skills, setSkills],
                  ["Linked checks", checkOptions, checks, setChecks],
                ] as const
              ).map(([title, opts, sel, set]) => (
                <fieldset key={title}>
                  <legend className={label}>{title}</legend>
                  {opts.length === 0 ? (
                    <p className="text-[12px] text-faint">None published yet.</p>
                  ) : (
                    <ul className="space-y-1">
                      {opts.map((o) => (
                        <li key={o.versionId}>
                          <label className="flex items-center gap-1.5 text-[13px]">
                            <input
                              type="checkbox"
                              checked={sel.includes(o.versionId)}
                              onChange={(e) =>
                                set((xs: string[]) =>
                                  e.target.checked ? [...xs, o.versionId] : xs.filter((x) => x !== o.versionId),
                                )
                              }
                              className="accent-[var(--primary)]"
                            />
                            {o.label}
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </fieldset>
              ))}
            </div>
          )}
        </>
      )}

      {kind === "skill" && (
        <>
          <div>
            <label className={label} htmlFor="when">
              When to use
            </label>
            <textarea
              id="when"
              value={whenToUse}
              onChange={(e) => setWhenToUse(e.target.value)}
              rows={2}
              className={field}
              placeholder="The situations where an agent should reach for this skill"
            />
          </div>
          <div>
            <span className={label}>Package files</span>
            {packageLocked ? (
              <p className="text-[12px] text-faint">
                This package is an imported snapshot of an upstream commit — every file is readable in the panel on the
                right. To change it, check for an upstream update to open a new draft.
              </p>
            ) : (
              <ul className="space-y-3">
                {files.map((f, i) => (
                  <li key={i} className="rounded-md border p-2">
                    <div className="mb-1.5 flex items-center gap-2">
                      <input
                        value={f.path}
                        disabled={f.path === "SKILL.md" || Boolean(f.keepSha)}
                        onChange={(e) =>
                          setFiles((xs) => xs.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))
                        }
                        aria-label="File path"
                        className={cn(field, "font-mono text-[12px]")}
                      />
                      {f.path !== "SKILL.md" && (
                        <button
                          type="button"
                          aria-label="Remove file"
                          onClick={() => setFiles((xs) => xs.filter((_, j) => j !== i))}
                          className={btn.ghost}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    {f.keepSha ? (
                      <p className="text-[12px] text-faint">Binary file — kept exactly as it is.</p>
                    ) : (
                      <textarea
                        value={f.content}
                        onChange={(e) =>
                          setFiles((xs) => xs.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))
                        }
                        rows={f.path === "SKILL.md" ? 14 : 6}
                        aria-label={`Contents of ${f.path}`}
                        className={cn(field, "font-mono text-[12px]")}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
            {!packageLocked && (
              <button
                type="button"
                onClick={() => setFiles((xs) => [...xs, { path: "reference.md", content: "" }])}
                className={cn(btn.outline, "mt-2")}
              >
                <Plus className="h-3.5 w-3.5" /> Add file
              </button>
            )}
            <p className="mt-1.5 text-[11px] text-faint">
              Nothing in a package is ever run by Lockstep. Scripts are flagged for review.
            </p>
          </div>
        </>
      )}

      {kind === "check" && (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className={label} htmlFor="artifact">
              Artifact
            </label>
            <select
              id="artifact"
              value={artifactType}
              onChange={(e) => setArtifactType(e.target.value)}
              className={cn(field, "h-8")}
            >
              <option value="prd">PRD / product document</option>
              <option value="code_diff">Code change (diff)</option>
            </select>
          </div>
          <div>
            <label className={label} htmlFor="method">
              Method
            </label>
            <select
              id="method"
              value={artifactType === "code_diff" ? "rubric" : method}
              onChange={(e) => setMethod(e.target.value)}
              disabled={artifactType === "code_diff"}
              className={cn(field, "h-8")}
            >
              {artifactType !== "code_diff" && <option value="structural">Structural — required sections</option>}
              <option value="rubric">Rubric — advisory semantic review</option>
            </select>
            {artifactType === "code_diff" && (
              <p className="mt-1 text-[11px] text-faint">
                Code changes are reviewed with a rubric against the linked requirements.
              </p>
            )}
          </div>
          <div className={artifactType === "code_diff" || method !== "structural" ? "hidden" : ""}>
            <label className={label} htmlFor="sections">
              Required sections (one per line)
            </label>
            <textarea
              id="sections"
              value={sections}
              onChange={(e) => setSections(e.target.value)}
              rows={5}
              className={field}
              placeholder={"Success metrics\nNon-goals\nAssumptions\nAcceptance criteria"}
            />
          </div>
          <div>
            <label className={label} htmlFor="instructions">
              Evaluation instructions
            </label>
            <textarea
              id="instructions"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              rows={5}
              className={field}
              placeholder="What the reviewer should look for, and what counts as evidence"
            />
          </div>
          <fieldset className="md:col-span-2">
            <legend className={label}>Requirements this check evaluates</legend>
            {requirementOptions.length === 0 && reqKeys.length === 0 ? (
              <p className="text-[12px] text-faint">
                No published standards yet. A check linked to no requirement evaluates the requirements of every
                standard that attaches it.
              </p>
            ) : (
              <ul className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border px-2 py-1.5">
                {requirementOptions.map((r) => (
                  <li key={r.key}>
                    <label className="flex items-start gap-2 text-[13px]">
                      <input
                        type="checkbox"
                        checked={reqKeys.includes(r.key)}
                        onChange={(e) =>
                          setReqKeys((ks) => (e.target.checked ? [...ks, r.key] : ks.filter((k) => k !== r.key)))
                        }
                        className="mt-1 accent-[var(--primary)]"
                      />
                      <span>
                        <span className="text-faint">{r.standard}:</span> {r.text}
                      </span>
                    </label>
                  </li>
                ))}
                {reqKeys
                  .filter((k) => !requirementOptions.some((r) => r.key === k))
                  .map((k) => (
                    <li key={k} className="flex items-center gap-2 text-[12px] text-faint">
                      <button
                        type="button"
                        className={btn.ghost}
                        onClick={() => setReqKeys((ks) => ks.filter((x) => x !== k))}
                      >
                        Remove
                      </button>
                      <span className="font-mono">{k}</span> — no longer in a published standard
                    </li>
                  ))}
              </ul>
            )}
            {method === "structural" && artifactType !== "code_diff" ? (
              <p className={cn("mt-1 text-[11px]", reqKeys.length > 1 ? "text-destructive" : "text-faint")}>
                A section check links at most one requirement — its findings are attributed to it.
              </p>
            ) : (
              <p className="mt-1 text-[11px] text-faint">
                Leave all unticked to evaluate the requirements of whichever standards attach this check.
              </p>
            )}
          </fieldset>
        </div>
      )}

      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-2 border-t bg-background px-1 py-3">
        <button
          type="button"
          disabled={pending || (!itemId && !name.trim())}
          onClick={() => save()}
          className={btn.outline}
        >
          {itemId ? "Save draft" : `Create ${kind}`}
        </button>
        {itemId && (
          <>
            <button type="button" disabled={pending} onClick={() => save("propose")} className={btn.ghost}>
              Save & propose
            </button>
            {canPublish && (
              <button type="button" disabled={pending} onClick={() => save("publish")} className={btn.primary}>
                Save & publish
              </button>
            )}
          </>
        )}
        {workingVersionId && workingState && (
          <span className="text-[11px] text-faint">Working copy is {workingState}.</span>
        )}
        {pending && <span className="text-[12px] text-faint">Working…</span>}
        {notice && <span className="text-[12px] text-primary-ink">{notice}</span>}
        {error && (
          <span role="alert" className="text-[12px] text-destructive">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
