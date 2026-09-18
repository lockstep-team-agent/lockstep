import { and, desc, eq } from "drizzle-orm";
import { withOrg } from "../db/rls.js";
import { nativeDocumentVersions, projects, questions, decisionChecks, sourceDocuments, checkFeedback } from "../db/schema.js";
import { listDecisions } from "../ledger/ledger-service.js";
import { digest, fail } from "./service.js";

export async function buildBrief(c: { orgId: string; projectId: string }, filters: { decisionId?: string; documentId?: string; featureRef?: string } = {}) {
  const all = await listDecisions(c.orgId, c.projectId);
  const selected = all.filter((d) => (!filters.decisionId || d.id === filters.decisionId) && (!filters.featureRef || d.scopeRef === filters.featureRef) && (!filters.documentId || (d.provenance as { documentId?: string })?.documentId === filters.documentId));
  if (filters.decisionId && !selected.length) throw fail("decision not found", 404);
  const [project, open, versions, checks, docs, feedback] = await Promise.all([
    withOrg(c.orgId, async (tx) => (await tx.select().from(projects).where(eq(projects.id, c.projectId)).limit(1))[0]),
    withOrg(c.orgId, (tx) => tx.select().from(questions).where(and(eq(questions.projectId, c.projectId), eq(questions.status, "open")))),
    filters.documentId ? withOrg(c.orgId, (tx) => tx.select().from(nativeDocumentVersions).where(and(eq(nativeDocumentVersions.projectId, c.projectId), eq(nativeDocumentVersions.documentId, filters.documentId!))).orderBy(desc(nativeDocumentVersions.version)).limit(1)) : Promise.resolve([]),
    withOrg(c.orgId, (tx) => tx.select().from(decisionChecks).where(eq(decisionChecks.projectId, c.projectId)).orderBy(desc(decisionChecks.createdAt)).limit(10)),
    withOrg(c.orgId, (tx) => tx.select().from(sourceDocuments).where(eq(sourceDocuments.projectId, c.projectId))),
    withOrg(c.orgId, (tx) => tx.select().from(checkFeedback).where(eq(checkFeedback.projectId, c.projectId))),
  ]);
  if (filters.documentId && !docs.some((d) => d.id === filters.documentId)) throw fail("document not found", 404);
  const accepted = selected.filter((d) => d.status === "binding" && (d.origin !== "document" || docs.some((doc) => doc.id === (d.provenance as { documentId?: string })?.documentId && doc.state === "active")));
  const proposals = selected.filter((d) => d.status === "proposed" || d.status === "open");
  const out = [`# ${versions[0]?.title ?? project?.name ?? "Project"} — ${filters.documentId ? "implementation" : "decision"} brief`, "", "## Accepted decisions and requirements", ""];
  if (!accepted.length) out.push("No accepted requirements in this selection yet.", "");
  for (const d of accepted) {
    const p = d.provenance as { path?: string; documentId?: string; source?: string } | null;
    out.push(`- ${d.ruleText}`, `  - Decision: ${d.id} · v${d.version} · ${d.scopeRef}`);
    if (d.rationale) out.push(`  - Why: ${d.rationale}`);
    if (p?.path) out.push(`  - Source: ${p.path}`);
    if (p?.documentId) out.push(`  - Source: ${docs.find((doc) => doc.id === p.documentId)?.title ?? "product brief"} (${p.documentId})`);
  }
  out.push("", "## Drafts — not accepted", "", ...proposals.map((d) => `- ${d.ruleText}`));
  if (!proposals.length) out.push("None.");
  out.push("", "## Unresolved questions", "");
  const qs = open.filter((q) => !filters.featureRef || !q.scopeRef || q.scopeRef === filters.featureRef);
  const sourceQuestions = versions[0]?.content.split("\n").filter((line) => /\?\s*$/.test(line)).slice(0, 10) ?? [];
  out.push(...qs.slice(0, 10).map((q) => `- ${q.body}`), ...sourceQuestions.map((q) => `- ${q.replace(/^[-*]\s*/, "")}`));
  if (!qs.length && !sourceQuestions.length) out.push("None recorded. This does not establish that the specification is complete.");
  const ids = new Set(accepted.map((d) => d.id));
  const findings = checks.flatMap((check) => (check.findings as Array<{ decisionId: string; version: number; file: string; line: number }>).filter((f) => ids.has(f.decisionId) && accepted.some((d) => d.id === f.decisionId && d.version === f.version) && !feedback.some((fb) => fb.checkId === check.id && fb.decisionId === f.decisionId && fb.verdict !== "useful")));
  out.push("", "## Recorded code concerns", "", ...findings.slice(0, 10).map((f) => `- Review ${f.file}:${f.line} against decision ${f.decisionId}.`));
  if (!findings.length) out.push("No concerns recorded in this selection. Implementation completeness and compliance have not been established.");
  out.push("", "## Join this project", "", "Ask a project owner for an invitation, then connect your repo:", "", `\`npx lockstep-cli onboard --project-id ${c.projectId}${versions[0] ? ` --feature ${versions[0].featureRef}` : ""}\``, "", "This brief does not grant access. Review its contents before sharing.");
  const markdown = out.join("\n");
  return { markdown, hash: digest(markdown), accepted: accepted.length, ratifiedRequirements: accepted.filter((d) => d.origin === "document").length, proposed: proposals.length };
}
