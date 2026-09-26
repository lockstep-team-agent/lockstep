"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { createTeamAction, deleteTeamAction, setRoleAction, setTeamMemberAction } from "@/org-actions";
import type { RoleRow, TeamRow } from "@/lib/org-data";
import { btn } from "@/components/next/bits";

function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) setError(r.error ?? "Failed");
      router.refresh();
    });
  const alert = error && (
    <p role="alert" className="px-5 py-2 text-[12px] text-destructive">
      {error}
    </p>
  );
  return { pending, act, alert };
}

export function RolesTable({ orgId, rows, canManage }: { orgId: string; rows: RoleRow[]; canManage: boolean }) {
  const { pending, act, alert } = useAct();
  return (
    <>
      {alert}
      <ul className="divide-y">
        {rows.map((r) => (
          <li key={r.memberId} className="flex items-center gap-4 px-5 py-2">
            <span className="flex-1 text-[13px]">{r.login}</span>
            {canManage ? (
              <select
                aria-label={`Role for ${r.login}`}
                disabled={pending}
                value={r.role ?? ""}
                onChange={(e) =>
                  act(() => setRoleAction(orgId, r.memberId, (e.target.value || null) as RoleRow["role"]))
                }
                className="h-7 rounded-md border bg-muted px-2 text-[12px]"
              >
                <option value="">Member</option>
                <option value="admin">Admin</option>
                <option value="owner">Owner</option>
              </select>
            ) : (
              <span className="text-[12px] capitalize text-faint">{r.role ?? "member"}</span>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

export function TeamsManager({
  orgId,
  teams,
  people,
  canManage,
}: {
  orgId: string;
  teams: TeamRow[];
  people: RoleRow[];
  canManage: boolean;
}) {
  const { pending, act, alert } = useAct();
  const [name, setName] = useState("");
  return (
    <>
      {alert}
      {canManage && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act(() => createTeamAction(orgId, name));
            setName("");
          }}
          className="flex gap-2 border-b px-5 py-3"
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Team name"
            placeholder="New team name"
            className="h-7 w-64 rounded-md border bg-muted px-2.5 text-[13px] outline-none focus:border-border-strong"
          />
          <button type="submit" disabled={pending || !name.trim()} className={btn.outline}>
            Create team
          </button>
        </form>
      )}
      {teams.length === 0 && (
        <p className="px-5 py-6 text-[13px] text-faint">
          No teams yet. Teams let you assign standards and skills to a group of people.
        </p>
      )}
      <ul className="divide-y">
        {teams.map((t) => {
          const inTeam = new Set(t.members.map((m) => m.memberId));
          return (
            <li key={t.id} className="px-5 py-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-[13px] font-medium">{t.name}</span>
                <span className="font-mono text-[11px] text-faint">{t.slug}</span>
                <span className="text-[11px] text-faint">
                  · {t.members.length} member{t.members.length === 1 ? "" : "s"}
                </span>
                {canManage && (
                  <button
                    type="button"
                    aria-label={`Delete ${t.name}`}
                    disabled={pending}
                    onClick={() => act(() => deleteTeamAction(orgId, t.id))}
                    className={`${btn.danger} ml-auto`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(canManage ? people : people.filter((p) => inTeam.has(p.memberId))).map((p) => {
                  const on = inTeam.has(p.memberId);
                  return canManage ? (
                    <button
                      key={p.memberId}
                      type="button"
                      aria-pressed={on}
                      disabled={pending}
                      onClick={() => act(() => setTeamMemberAction(orgId, t.id, p.memberId, !on))}
                      className={`rounded-full border px-2 py-0.5 text-[12px] ${on ? "border-primary bg-primary/10 text-primary-ink" : "text-faint hover:text-foreground"}`}
                    >
                      {p.login}
                    </button>
                  ) : (
                    <span key={p.memberId} className="rounded-full border px-2 py-0.5 text-[12px]">
                      {p.login}
                    </span>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
