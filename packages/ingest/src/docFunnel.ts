import { createHash } from "node:crypto";
import type { DocumentConnector, DocSection } from "./connectors/SourceConnector.js";
import { redactSecrets } from "./funnel.js";
import { recallDoc as defaultRecallDoc } from "./distill/recall.js";
import { extractDoc as defaultExtractDoc, extractDocBatch } from "./distill/extract.js";
import { gateDoc } from "./distill/gate.js";
import { resolveDocScope, capabilitySlug, canonicalizeSurface } from "./distill/scope.js";
import { parseExpiresHint } from "./distill/expiry.js";
import type { DocExtraction } from "./distill/rubric-doc.js";

export interface DocFunnelStats {
  sections: number;
  skipped: number;
  recalled: number;
  proposed: number;
  lowConfidence: number;
  discarded: number;
}

/** A proposed product constraint — filed to core as a document-origin decision candidate. */
export interface ProposedDocItem {
  scopeKind: string;
  scopeRef: string;
  ruleText: string;
  constraintKind: string;
  expiresAt: string | null; // resolved from expiresHint; null for event-relative hints (D13)
  expiresHint: string;
  lowConfidence: boolean;
  confidence: number; // 0..100
  externalId: string; // `${docExternalId}#${anchorKey}` — idempotency key with contentHash
  contentHash: string; // sha256 of the raw section text
  anchor: { type: "notion_block"; pageId: string; blockId: string; headingPath: string[]; snippet: string };
  evidence: Array<{ externalId: string; quote: string }>;
  rationale: string;
  // Canonicalized surface candidates the extraction named — seed PROPOSED capability→surface governs
  // edges at ratification (F5). Empty for a constraint that named no recognizable surface.
  surfaceCandidates: string[];
}

export interface DocFunnelResult {
  items: ProposedDocItem[];
  stats: DocFunnelStats;
  /** sha256 over ALL section hashes (skipped included) — the doc's overall change fingerprint. */
  docContentHash: string;
}

/** Sections whose heading can never yield a constraint — dropped before any LLM spend (A-4). */
const NEVER_EXTRACT_HEADING =
  /^(background|context|research|appendix|personas?|open questions?|competitors?|timeline|roadmap)/i;

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * The v3 doc funnel over one PRD — mirrors funnel.ts's two-phase shape (inline or Batch API extraction).
 * Per section: hash skip (unchanged since last extraction, per knownSectionHashes — the A-lite re-extraction
 * diff, D11) → never-extract heading skip → redact → recall → extract → gate → scope. Idempotency is
 * enforced server-side on (externalId, contentHash) by fileProposedDecision, same as conversations.
 */
export async function runDocFunnel(opts: {
  connector: DocumentConnector;
  doc: { externalId: string; title: string; url: string | null };
  capabilityRef?: string; // default: capabilitySlug(doc.title)
  knownSectionHashes?: string[];
  useHaiku?: boolean;
  batch?: boolean;
  log?: (msg: string) => void;
  now?: Date;
  // Injectable for tests — default to the real connector/Haiku/Sonnet stages.
  fetchSectionsFn?: (pageId: string) => Promise<DocSection[]>;
  recallFn?: (text: string, useHaiku: boolean) => Promise<boolean>;
  extractFn?: (anchorKey: string, text: string) => Promise<DocExtraction>;
  batchExtractFn?: (items: Array<{ anchorKey: string; text: string }>) => Promise<Map<string, DocExtraction>>;
}): Promise<DocFunnelResult> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();
  const capabilityRef = opts.capabilityRef ?? capabilitySlug(opts.doc.title);
  const known = new Set(opts.knownSectionHashes ?? []);
  const recall = opts.recallFn ?? defaultRecallDoc;
  const extract = opts.extractFn ?? defaultExtractDoc;
  const batchExtract = opts.batchExtractFn ?? extractDocBatch;
  const fetchSections = opts.fetchSectionsFn ?? ((pageId: string) => opts.connector.fetchDocumentSections(pageId));
  const stats: DocFunnelStats = { sections: 0, skipped: 0, recalled: 0, proposed: 0, lowConfidence: 0, discarded: 0 };

  const sections = await fetchSections(opts.doc.externalId);
  log(`  ${opts.doc.externalId}: ${sections.length} section(s)`);

  // Phase 1 — hash skip → never-extract heading skip → redact → cheap recall filter.
  type Survivor = { section: DocSection; text: string; hash: string };
  const survivors: Survivor[] = [];
  const sectionHashes: string[] = [];
  for (const s of sections) {
    stats.sections++;
    const hash = sha256(s.text);
    sectionHashes.push(hash);
    if (known.has(hash)) {
      // Unchanged since the last extraction — skip before ANY LLM call.
      stats.skipped++;
      continue;
    }
    const heading = s.headingPath[s.headingPath.length - 1] ?? "";
    if (NEVER_EXTRACT_HEADING.test(heading)) {
      stats.discarded++;
      continue;
    }
    const text = redactSecrets(s.text);
    if (!(await recall(text, opts.useHaiku ?? true))) {
      stats.discarded++;
      continue;
    }
    stats.recalled++;
    survivors.push({ section: s, text, hash });
  }

  // Phase 2 — extraction (batch or inline).
  const extractions = new Map<string, DocExtraction>();
  if (opts.batch) {
    log(`  batch-extracting ${survivors.length} survivor(s)…`);
    const res = await batchExtract(survivors.map((s) => ({ anchorKey: s.section.anchorKey, text: s.text })));
    for (const [k, v] of res) extractions.set(k, v);
  } else {
    for (const s of survivors) extractions.set(s.section.anchorKey, await extract(s.section.anchorKey, s.text));
  }

  // Phase 3 — gate → scope → build proposed items.
  const items: ProposedDocItem[] = [];
  for (const s of survivors) {
    const x = extractions.get(s.section.anchorKey);
    if (!x) {
      stats.discarded++;
      continue;
    }
    const action = gateDoc(x);
    if (action === "discard") {
      stats.discarded++;
      continue;
    }
    const scope = resolveDocScope(x.surface_candidates, capabilityRef);
    const surfaceCandidates = [
      ...new Set(x.surface_candidates.map((c) => canonicalizeSurface(c)).filter((s): s is string => Boolean(s))),
    ];
    const externalId = `${opts.doc.externalId}#${s.section.anchorKey}`;
    const expiresAt = parseExpiresHint(x.expires_hint, now);
    items.push({
      scopeKind: scope.scopeKind,
      scopeRef: scope.scopeRef,
      ruleText: x.rule_text,
      constraintKind: x.constraint_kind,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      expiresHint: x.expires_hint,
      lowConfidence: action === "propose_low",
      confidence: Math.round(x.confidence * 100),
      externalId,
      contentHash: s.hash,
      anchor: {
        type: "notion_block",
        pageId: opts.doc.externalId,
        blockId: s.section.anchorKey,
        headingPath: s.section.headingPath,
        snippet: s.section.snippet,
      },
      evidence: x.evidence.map((e) => ({ externalId, quote: e.quote })),
      rationale: x.rationale,
      surfaceCandidates,
    });
    if (action === "propose_low") stats.lowConfidence++;
    else stats.proposed++;
    log(`    ${action === "propose" ? "✓ proposed" : "~ low-confidence"} [${scope.scopeRef}] ${x.rule_text.slice(0, 80)}`);
  }
  return { items, stats, docContentHash: sha256(sectionHashes.join("\n")) };
}
