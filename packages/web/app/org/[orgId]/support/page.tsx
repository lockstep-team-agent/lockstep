import { PageHead } from "@/components/next/bits";

/**
 * What each agent adapter can do and what it can report — the capability matrix (PRD §7.3, A20).
 * Only versions verified by a real install + session test are listed as supported.
 */
const ROWS = [
  {
    agent: "Claude Code",
    status: "Supported",
    verified: "2.1.281 (real install + session test, 2026-09-25)",
    install: "Yes — .claude/skills/lockstep-org-<slug>/, kept out of git, hash-verified, never executed",
    session: "Yes — records which skill versions a session started with; updates apply to the next session",
    invocation: "Unobservable — shown as unobservable, never as unused",
    checks: "Code diffs through lockstep check (existing consent); PRD revisions checked in the dashboard",
  },
  {
    agent: "Codex",
    status: "Not supported yet",
    verified: "—",
    install: "—",
    session: "—",
    invocation: "—",
    checks: "—",
  },
  {
    agent: "Copied project brief (no agent)",
    status: "Export only",
    verified: "—",
    install: "No — copying is recorded as an export, not an installation",
    session: "No",
    invocation: "No",
    checks: "Submit a saved revision in the dashboard",
  },
];

export default function SupportPage() {
  const th = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-faint";
  return (
    <div data-full className="flex h-full flex-col">
      <PageHead title="Agent support" meta="Claude Code pilot — what each adapter can install and report" />
      <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
        <table className="w-full min-w-[900px] border-collapse text-[12px]">
          <thead className="border-b">
            <tr>
              {["Agent", "Status", "Verified on", "Install", "Session availability", "Invocation", "Checks"].map((h) => (
                <th key={h} className={th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y align-top">
            {ROWS.map((r) => (
              <tr key={r.agent}>
                <td className="px-3 py-2.5 font-medium">{r.agent}</td>
                <td className={`px-3 py-2.5 ${r.status === "Supported" ? "text-primary-ink" : "text-faint"}`}>{r.status}</td>
                <td className="px-3 py-2.5 text-muted-foreground">{r.verified}</td>
                <td className="px-3 py-2.5 text-muted-foreground">{r.install}</td>
                <td className="px-3 py-2.5 text-muted-foreground">{r.session}</td>
                <td className="px-3 py-2.5 text-muted-foreground">{r.invocation}</td>
                <td className="px-3 py-2.5 text-muted-foreground">{r.checks}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-4 max-w-2xl text-[12px] text-muted-foreground">
          Not in this pilot yet: pausing a rollout, Codex, enrolling a workspace without a repository, and checking that a
          skill’s declared tools are present on a machine.
        </p>
        <p className="mt-2 max-w-2xl text-[12px] text-faint">
          Membership revocation stops future sync and downloads immediately. Copies already on a machine can’t be made to vanish; they stop updating and are removed at the next sync if Lockstep still manages them.
        </p>
      </div>
    </div>
  );
}
