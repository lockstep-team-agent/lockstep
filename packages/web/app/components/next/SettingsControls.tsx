"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Plus, RotateCw, Trash2 } from "lucide-react";
import {
  createDomainAction,
  deleteDomainAction,
  rebuildConceptsAction,
  setHttpRulesAction,
  updateDomainAction,
  type ActionResult,
} from "@/next-actions";
import type { ConceptSettings } from "@/lib/next-data";
import { btn } from "./bits";

type Ids = { orgId: string; projectId: string };

function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error ?? "failed");
      router.refresh();
    });
  return { pending, error, run };
}

export function DomainsEditor({
  ids,
  domains,
  canEdit,
}: {
  ids: Ids;
  domains: ConceptSettings["domains"];
  canEdit: boolean;
}) {
  const { pending, error, run } = useAct();
  const [adding, setAdding] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const swap = (i: number, j: number) => {
    const a = domains[i]!;
    const b = domains[j]!;
    run(async () => {
      const r1 = await updateDomainAction(ids.orgId, ids.projectId, a.id, {
        position: b.position === a.position ? j : b.position,
      });
      if (!r1.ok) return r1;
      return updateDomainAction(ids.orgId, ids.projectId, b.id, {
        position: b.position === a.position ? i : a.position,
      });
    });
  };
  return (
    <div>
      <ul className="divide-y rounded-md border">
        {domains.map((d, i) => (
          <li key={d.id} className="group flex h-10 items-center gap-3 px-3">
            {editing === d.id ? (
              <form
                className="flex flex-1 items-center gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  setEditing(null);
                  if (label.trim() && label !== d.label)
                    run(() => updateDomainAction(ids.orgId, ids.projectId, d.id, { label }));
                }}
              >
                <input
                  autoFocus
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
                  aria-label="Domain name"
                  className="h-7 flex-1 rounded-md border bg-muted px-2 text-[13px] outline-none focus:border-border-strong"
                />
                <button type="submit" className={btn.outline}>
                  Save
                </button>
              </form>
            ) : (
              <button
                type="button"
                disabled={!canEdit}
                onClick={() => {
                  setEditing(d.id);
                  setLabel(d.label);
                }}
                className="flex-1 text-left text-[13px] disabled:cursor-default"
              >
                {d.label}
              </button>
            )}
            <span className="tnum text-[12px] text-faint">{d.concepts} concepts</span>
            {canEdit && (
              <span className="flex items-center opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                <button
                  type="button"
                  aria-label="Move up"
                  disabled={i === 0 || pending}
                  onClick={() => swap(i, i - 1)}
                  className={btn.ghost}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Move down"
                  disabled={i === domains.length - 1 || pending}
                  onClick={() => swap(i, i + 1)}
                  className={btn.ghost}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${d.label}`}
                  disabled={pending}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete “${d.label}”? Its ${d.concepts} concepts become unassigned and are re-filed.`,
                      )
                    ) {
                      run(() => deleteDomainAction(ids.orgId, ids.projectId, d.id));
                    }
                  }}
                  className={btn.danger}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!adding.trim()) return;
            const v = adding;
            setAdding("");
            run(() => createDomainAction(ids.orgId, ids.projectId, v));
          }}
        >
          <input
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            placeholder="New domain"
            aria-label="New domain name"
            className="h-7 w-64 rounded-md border bg-muted px-2 text-[13px] outline-none placeholder:text-faint focus:border-border-strong"
          />
          <button type="submit" disabled={pending || !adding.trim()} className={btn.outline}>
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
          <span className="text-[12px] text-faint">Editing domains re-files every concept that isn’t pinned.</span>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function HttpRulesEditor({
  ids,
  rules,
  canEdit,
}: {
  ids: Ids;
  rules: ConceptSettings["httpRules"];
  canEdit: boolean;
}) {
  const { pending, error, run } = useAct();
  const [text, setText] = useState(rules.skip.join("\n"));
  const dirty =
    text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n") !== rules.skip.join("\n");
  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={!canEdit}
        rows={Math.min(10, Math.max(4, rules.skip.length + 1))}
        aria-label="Leading path segments to skip"
        className="w-full max-w-md rounded-md border bg-muted px-2.5 py-2 font-mono text-[12px] leading-5 outline-none focus:border-border-strong"
      />
      <p className="mt-1 text-[12px] text-faint">
        One per line: a literal (<code className="font-mono">api</code>) or a <code className="font-mono">/regex/</code>
        . Only leading segments are skipped; path params always are.
      </p>
      {canEdit && (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            disabled={!dirty || pending}
            className={btn.outline}
            onClick={() =>
              run(() =>
                setHttpRulesAction(
                  ids.orgId,
                  ids.projectId,
                  text
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean),
                ),
              )
            }
          >
            Save and rebuild
          </button>
          {!rules.isDefault && (
            <button
              type="button"
              disabled={pending}
              className={btn.ghost}
              onClick={() => setText(rules.defaults.join("\n"))}
            >
              Restore defaults
            </button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function RebuildButton({ ids, disabled }: { ids: Ids; disabled: boolean }) {
  const { pending, error, run } = useAct();
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={disabled || pending}
        className={btn.outline}
        onClick={() => run(() => rebuildConceptsAction(ids.orgId, ids.projectId))}
      >
        <RotateCw className="h-3.5 w-3.5" /> Rebuild
      </button>
      {error && (
        <span role="alert" className="text-[12px] text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}
