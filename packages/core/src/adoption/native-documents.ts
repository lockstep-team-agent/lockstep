import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { withOrg } from "../db/rls.js";
import { nativeDocumentVersions, sourceDocuments } from "../db/schema.js";
import { canManageDocTx } from "../auth/permissions.js";
import { writeAudit } from "../audit/audit-service.js";
import { fileDocCandidates, type DocCandidateItem } from "../documents/document-service.js";
import { listDecisions } from "../ledger/ledger-service.js";
import { digest, fail, usage } from "./service.js";
import { extractRules, type Extractor, type Section, type ExtractedRule } from "./providers.js";

export interface NativeInput { documentId?: string; baseVersion?: number; title: string; content: string; featureRef?: string; manualRules?: string[] }

/** Preserve code fences and complete paragraphs. Caps are visible in the response, never implicit approval. */
export function nativeSections(content: string): { sections: Section[]; partial: boolean } {
  const blocks = content.split(/\n(?=#{1,6} )/);
  const sections = blocks.slice(0, 60).map((text, i) => ({
    anchorKey: `section-${i}`, headingPath: [text.match(/^#{1,6}\s+(.+)/)?.[1] ?? "Brief"],
    text: Buffer.from(text.trim()).subarray(0, 4000).toString("utf8"),
  })).filter((s) => s.text.length > 0);
  return { sections, partial: blocks.length > 60 || blocks.some((b) => Buffer.byteLength(b) > 4000) };
}

export async function nativeHistory(orgId: string, projectId: string, documentId: string) {
  return withOrg(orgId, async (tx) => {
    const doc = (await tx.select().from(sourceDocuments).where(and(eq(sourceDocuments.id, documentId), eq(sourceDocuments.projectId, projectId))).limit(1))[0];
    if (!doc || doc.tool !== "native") throw fail("native document not found", 404);
    const versions = await tx.select().from(nativeDocumentVersions).where(eq(nativeDocumentVersions.documentId, documentId)).orderBy(desc(nativeDocumentVersions.version));
    return { document: doc, versions };
  });
}

export async function saveNativeBrief(orgId: string, projectId: string, memberId: string, input: NativeInput, extractor: Extractor = extractRules) {
  const id = input.documentId ?? randomUUID();
  const featureRef = input.featureRef || `feature:${input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 190) || id.slice(0, 8)}`;
  const contentHash = digest({ title: input.title, content: input.content, featureRef });
  const saved = await withOrg(orgId, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`);
    const doc = (await tx.select().from(sourceDocuments).where(eq(sourceDocuments.id, id)).limit(1))[0];
    if (input.documentId && (!doc || doc.projectId !== projectId || doc.tool !== "native")) throw fail("native document not found", 404);
    if (doc && !(await canManageDocTx(tx, { projectId, memberId, doc }))) throw fail("document edit requires owner, PM or author", 403);
    const prior = (await tx.select().from(nativeDocumentVersions).where(eq(nativeDocumentVersions.documentId, id)).orderBy(desc(nativeDocumentVersions.version)).limit(1))[0];
    if (prior?.contentHash === contentHash) return { ...prior, unchanged: true };
    if (prior && input.baseVersion !== prior.version) throw fail("brief changed; reload before saving", 409);
    if (prior && featureRef !== prior.featureRef) throw fail("feature reference is fixed; create another brief for a different feature");
    if (!doc) await tx.insert(sourceDocuments).values({ id, orgId, projectId, tool: "native", externalId: id, title: input.title, state: "review", stateAuthority: "native", registeredBy: memberId, ownerMemberId: memberId, contentHash });
    else await tx.update(sourceDocuments).set({ title: input.title, state: "review", contentHash, updatedAt: new Date() }).where(eq(sourceDocuments.id, id));
    const row = (await tx.insert(nativeDocumentVersions).values({ orgId, projectId, documentId: id, version: (prior?.version ?? 0) + 1, title: input.title, content: input.content, featureRef, contentHash, createdBy: memberId }).returning())[0]!;
    await writeAudit(tx, { orgId, projectId, actorMemberId: memberId, action: "document.revised", entityKind: "document", entityId: id, entityVersion: row.version });
    return row;
  });
  const { sections, partial } = nativeSections(input.content);
  let rules: ExtractedRule[] | null;
  if (input.manualRules?.length) {
    if (input.manualRules.some((text) => !input.content.includes(text))) throw fail("manual requirements must quote the pasted source");
    rules = input.manualRules.map((text) => ({ anchorKey: sections.find((s) => s.text.includes(text))?.anchorKey ?? "manual", evidence: text, ruleText: text, rationale: "Selected from source by the author; awaiting ratification.", confidence: 1, decisionType: "rule", constraintKind: "behavioral" }));
  } else rules = await extractor(sections, "product");
  const unchanged = "unchanged" in saved && saved.unchanged === true;
  if (rules === null) return { documentId: id, version: saved.version, unchanged, featureRef, status: "unavailable", partial, proposals: 0 };

  const items: DocCandidateItem[] = [];
  const counts = new Map<string, number>();
  for (const rule of rules) {
    if (!input.content.includes(rule.evidence)) continue;
    const n = counts.get(rule.anchorKey) ?? 0;
    counts.set(rule.anchorKey, n + 1);
    const anchorKey = `${rule.anchorKey}/rule-${n}`;
    items.push({ scopeKind: "capability", scopeRef: featureRef, ruleText: rule.ruleText, constraintKind: rule.constraintKind, expiresAt: null, expiresHint: "", lowConfidence: rule.confidence < 0.8, confidence: Math.round(rule.confidence * 100), externalId: `${id}#${anchorKey}`, contentHash: digest({ rule: rule.ruleText, source: rule.evidence, revision: saved.version }),
      anchor: { type: "native", pageId: id, blockId: anchorKey, headingPath: sections.find((s) => s.anchorKey === rule.anchorKey)?.headingPath ?? [input.title], snippet: rule.evidence },
      evidence: [{ externalId: `${id}#${anchorKey}`, quote: rule.evidence }], rationale: rule.rationale,
    });
  }
  await withOrg(orgId, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`);
    const latest = (await tx.select().from(nativeDocumentVersions).where(eq(nativeDocumentVersions.documentId, id)).orderBy(desc(nativeDocumentVersions.version)).limit(1))[0];
    if (latest?.version !== saved.version) throw fail("a newer brief revision exists; retry extraction on that revision", 409);
    const existing = (await listDecisions(orgId, projectId)).filter((d) => (d.provenance as { documentId?: string })?.documentId === id);
    const oldAnchors = existing.map((d) => (d.provenance as { anchorKey?: string })?.anchorKey).filter((a): a is string => !!a);
    // A partial extraction must never retire requirements outside the inspected source.
    await fileDocCandidates(id, items, contentHash, partial ? [] : [...oldAnchors, ...items.map((it) => it.anchor.blockId)], items.map((it) => ({ anchorKey: it.anchor.blockId, headingPath: it.anchor.headingPath, snippet: it.anchor.snippet })));
  });
  await usage({ orgId, projectId, memberId }, "brief_imported", `${id}:${saved.version}`, { proposals: items.length });
  return { documentId: id, version: saved.version, unchanged, featureRef, status: partial ? "partial" : "completed", partial, proposals: items.length };
}
