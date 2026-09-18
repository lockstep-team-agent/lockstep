import Link from "next/link";
import { apiGet } from "@/lib/api";
import { Section } from "@/components/Section";
import { When } from "@/components/When";
import { CheckFeedback } from "@/components/CheckFeedback";

interface Check { id: string; status: string; checked: number; total: number; partial: boolean; createdAt: string; findings: Array<{ decisionId: string; version: number; file: string; line: number; reason: string }> }
export async function CheckHistory({ orgId, projectId, filters = {} }: { orgId: string; projectId: string; filters?: Record<string, string> }) {
  const data = await apiGet<{ checks: Check[]; feedback: Array<{ checkId: string; decisionId: string; verdict: string }> }>(`/orgs/${orgId}/projects/${projectId}/checks?${new URLSearchParams(filters)}`);
  return <Section label="Advisory checks" count={data?.checks.length ?? 0}>
    <p className="text-sm text-muted-foreground p-4">Checks cover submitted changes only. Context delivery and no recorded concerns do not establish feature completion.</p>
    {!data ? <p className="p-4 text-sm">Check history unavailable.</p> : data.checks.length === 0 ? <p className="p-4 text-sm">No code checks recorded yet.</p> : data.checks.map((c) => <div key={c.id} className="border-t p-4 text-sm">
      <p className="font-medium">{c.status} · {c.checked}/{c.total} rules · <When at={c.createdAt} /></p>
      {c.partial && <p className="text-muted-foreground">Some changes or rules were not checked.</p>}
      {c.findings.map((f, i) => <div key={i} className="mt-3"><Link className="underline" href={`/project/${orgId}/${projectId}/decisions/${f.decisionId}`}>{f.file}:{f.line} · decision v{f.version}</Link><p>{f.reason}</p>
        {data.feedback.filter((v) => v.checkId === c.id && v.decisionId === f.decisionId).map((v, n) => <span key={n} className="mr-2 text-xs text-muted-foreground">Recorded: {v.verdict.replace(/_/g, " ")}</span>)}
        <CheckFeedback orgId={orgId} projectId={projectId} checkId={c.id} decisionId={f.decisionId} />
      </div>)}
      {!c.findings.length && <p className="text-muted-foreground">No concerns recorded for this check.</p>}
    </div>)}
  </Section>;
}
