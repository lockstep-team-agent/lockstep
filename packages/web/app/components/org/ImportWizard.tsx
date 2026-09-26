"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { discoverAction, importAction } from "@/org-actions";
import { btn } from "@/components/next/bits";
import { cn } from "@/lib/utils";

type Found = Extract<Awaited<ReturnType<typeof discoverAction>>, { ok: true }>["data"];

/** URL → pick exactly one skill → capture at the resolved commit as a draft. Review happens on the draft. */
export function ImportWizard({ orgId }: { orgId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [url, setUrl] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [dir, setDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const discover = () =>
    start(async () => {
      setError(null);
      setFound(null);
      setDir(null);
      const r = await discoverAction(orgId, url.trim());
      if (!r.ok) return setError(r.error);
      setFound(r.data);
      if (r.data.candidates.length === 1) setDir(r.data.candidates[0]!.dir);
    });
  const capture = () =>
    start(async () => {
      if (!found || dir == null) return;
      setError(null);
      const r = await importAction(orgId, { url: url.trim(), commit: found.commit, ref: found.ref, dir });
      if (!r.ok) return setError(r.error);
      router.push(`/org/${orgId}/standards/${r.data.itemId}`);
    });

  return (
    <div className="max-w-2xl space-y-5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          discover();
        }}
        className="flex gap-2"
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-label="GitHub URL"
          placeholder="https://github.com/owner/repo/tree/main/skills/…"
          className="h-8 flex-1 rounded-md border bg-muted px-2.5 font-mono text-[12px] outline-none placeholder:text-faint focus:border-border-strong"
        />
        <button type="submit" disabled={pending || !url.trim()} className={btn.outline}>
          Find skills
        </button>
      </form>
      <p className="text-[12px] text-faint">
        Public repositories only. The exact commit is captured; nothing is executed. The result is a draft you review
        before publishing.
      </p>

      {found && (
        <section>
          <div className="mb-2 text-[12px] text-faint">
            {found.source.owner}/{found.source.repo} @ <span className="font-mono">{found.commit.slice(0, 12)}</span> (
            {found.ref}) · {found.candidates.length} skill
            {found.candidates.length === 1 ? "" : "s"} found
          </div>
          {found.candidates.length === 0 ? (
            <p className="text-[13px]">No SKILL.md found under this path.</p>
          ) : (
            <ul role="radiogroup" aria-label="Skill to import" className="divide-y rounded-md border">
              {found.candidates.map((c) => (
                <li key={c.dir}>
                  <label className={cn("flex cursor-pointer gap-3 px-3 py-2", dir === c.dir && "bg-muted")}>
                    <input
                      type="radio"
                      name="skill"
                      checked={dir === c.dir}
                      onChange={() => setDir(c.dir)}
                      className="mt-1 accent-[var(--primary)]"
                    />
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium">{c.name}</span>
                      {c.description && (
                        <span className="block text-[12px] text-muted-foreground">{c.description}</span>
                      )}
                      <span className="font-mono text-[11px] text-faint">{c.dir || "/"}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <button type="button" disabled={pending || dir == null} onClick={capture} className={cn(btn.primary, "mt-3")}>
            Capture as draft
          </button>
        </section>
      )}
      {pending && <p className="text-[12px] text-faint">Working…</p>}
      {error && (
        <p role="alert" className="text-[12px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
