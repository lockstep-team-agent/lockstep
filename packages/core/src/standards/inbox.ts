/**
 * Standards items for the project Inbox (PRD §5): actionable check findings and exception
 * requests at normal severity; expired-exception reminders for the requester; installation
 * failures as housekeeping, aggregated per rollout rather than one row per machine.
 */
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { withOrg } from "../db/rls.js";
import { artifactChecks, catalogItems, environments, exceptions, findingActions } from "../db/schema.js";
import { stalenessTx } from "./checks.js";
import { env } from "../env.js";
import { getOrgRoleTx } from "./org-authority.js";
import { itemState, latestReceiptsTx, resolutionInputsTx, resolveEnv } from "./environments.js";
import { teamIdsForMemberTx } from "./org-authority.js";

export interface StdInboxItem {
  kind: "check_finding" | "exception_request" | "rollout_failure";
  id: string;
  severity: 0 | 1 | 2;
  title: string;
  detail: string | null;
  createdAt: string;
  meta: Record<string, unknown>;
}

export async function standardsInboxItems(orgId: string, projectId: string, memberId: string, housekeeping: boolean): Promise<StdInboxItem[]> {
  if (!env.LOCKSTEP_STANDARDS) return [];
  return withOrg(orgId, async (tx) => {
    const out: StdInboxItem[] = [];
    const since = new Date(Date.now() - 30 * 86_400_000);
    // Findings: possible violations on the CURRENT revision nobody has dismissed.
    const checks = await tx.select().from(artifactChecks).where(and(eq(artifactChecks.projectId, projectId), gte(artifactChecks.createdAt, since))).orderBy(desc(artifactChecks.createdAt)).limit(100);
    const stale = await stalenessTx(tx, orgId, checks);
    const acted = checks.length ? await tx.select().from(findingActions).where(inArray(findingActions.checkId, checks.map((c) => c.id))) : [];
    const seen = new Set<string>();
    for (const c of checks) {
      const ref = c.artifactRef as { documentId?: string; version?: number; title?: string; files?: string[] };
      if (stale.get(c.id)) continue; // stale results aren't actionable
      const open = c.findings.filter((f) => f.verdict === "possible_violation" && !acted.some((a) => a.checkId === c.id && a.findingKey === f.key));
      const dedupe = `${c.artifactKind}:${ref.documentId ?? c.artifactHash}:${c.checkVersionId ?? c.standardVersionId}`;
      if (!open.length || seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({
        kind: "check_finding",
        id: c.id,
        severity: 2,
        title: `${open.length} possible issue${open.length === 1 ? "" : "s"} in ${ref.title ? `“${ref.title}” v${ref.version}` : `a code change (${(ref.files ?? []).slice(0, 2).join(", ")})`}`,
        detail: open.slice(0, 2).map((f) => f.criterion).join(" · "),
        createdAt: c.createdAt.toISOString(),
        meta: { artifactKind: c.artifactKind },
      });
    }
    // Exception requests: owners/admins decide; requesters get expiry reminders.
    const admin = Boolean(await getOrgRoleTx(tx, orgId, memberId));
    const xs = await tx.select().from(exceptions).where(eq(exceptions.orgId, orgId)).orderBy(desc(exceptions.createdAt)).limit(200);
    const names = new Map((await tx.select({ id: catalogItems.id, n: catalogItems.name }).from(catalogItems).where(eq(catalogItems.orgId, orgId))).map((x) => [x.id, x.n]));
    for (const x of xs) {
      if (x.scope.projectId && x.scope.projectId !== projectId) continue;
      if (admin && x.state === "requested")
        out.push({ kind: "exception_request", id: x.id, severity: 2, title: `Exception requested: ${names.get(x.itemId) ?? "standard"}${x.requirementKey ? ` · ${x.requirementKey}` : ""}`, detail: x.reason, createdAt: x.createdAt.toISOString(), meta: { state: x.state } });
      const expired = x.state === "expired" || (x.state === "approved" && x.expiresAt && +x.expiresAt <= Date.now());
      if (x.requestedBy === memberId && expired && x.expiresAt && +x.expiresAt > Date.now() - 14 * 86_400_000)
        out.push({ kind: "exception_request", id: x.id, severity: 1, title: `Your exception expired: ${names.get(x.itemId) ?? "standard"} applies again`, detail: x.reason, createdAt: x.expiresAt.toISOString(), meta: { state: "expired" } });
    }
    // Housekeeping: environments in this project whose installs failed or need the user.
    if (housekeeping) {
      const envs = await tx.select().from(environments).where(and(eq(environments.orgId, orgId), eq(environments.projectId, projectId), isNull(environments.unenrolledAt)));
      if (envs.length) {
        const inp = await resolutionInputsTx(tx, orgId);
        const latestR = await latestReceiptsTx(tx, envs.map((e) => e.id));
        const byAssignment = new Map<string, { name: string; n: number; codes: Set<string> }>();
        for (const e of envs) {
          const r = resolveEnv(e, await teamIdsForMemberTx(tx, e.memberId), inp.assignments, inp.exceptions, inp.packages);
          for (const d of r.desired) {
            const st = itemState(e, d, latestR.get(e.id) ?? []);
            if (st.state !== "failed" && st.state !== "user_action_required") continue;
            for (const reason of d.reasons) {
              const g = byAssignment.get(reason.assignmentId) ?? byAssignment.set(reason.assignmentId, { name: reason.name, n: 0, codes: new Set() }).get(reason.assignmentId)!;
              g.n++;
              g.codes.add(st.state === "failed" ? "install failed" : "local edits");
            }
          }
        }
        for (const [id, g] of byAssignment)
          out.push({ kind: "rollout_failure", id, severity: 0, title: `Rollout “${g.name}”: ${g.n} skill install${g.n === 1 ? "" : "s"} need attention`, detail: [...g.codes].join(", "), createdAt: new Date().toISOString(), meta: { assignmentId: id } });
      }
    }
    return out;
  });
}
