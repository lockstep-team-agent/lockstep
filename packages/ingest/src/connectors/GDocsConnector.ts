import type { DocumentConnector, DocMeta, DocSection } from "./SourceConnector.js";

/**
 * Composio slugs for the Google Docs doc layer. Slug NAMES, input keys, AND response shapes verified against
 * Composio's public toolkit docs (docs.composio.dev/toolkits/googledocs, .../googledrive).
 *   - GOOGLEDOCS_GET_DOCUMENT_BY_ID: input `id` (44-char doc id), optional `includeTabsContent`. Returns the
 *     RAW Google Docs API object (body.content[] → paragraph.elements[].textRun.content +
 *     paragraphStyle.namedStyleType) — exactly what paragraphs() below walks. We omit includeTabsContent, so
 *     Google returns legacy first-tab content; a multi-tab doc would need includeTabsContent:true (future).
 *   - There is NO googledocs comment tool — comments are a Drive feature, so writeComment uses
 *     GOOGLEDRIVE_CREATE_COMMENT (app "googledrive", input `file_id`/`content`). This requires the connected
 *     account to carry Drive scope; a docs-only connection can't post the comment (degrades to a failed
 *     writeback, retried — never silent).
 */
const GDOCS_GET_DOCUMENT_SLUG = "GOOGLEDOCS_GET_DOCUMENT_BY_ID";
const GDRIVE_CREATE_COMMENT_SLUG = "GOOGLEDRIVE_CREATE_COMMENT";

/**
 * Google Docs document connector — parallel to ComposioConnector (NOT a subclass), because GDocs is a
 * native-registered doc source (registered by URL, not folder-swept). Sections are anchored on a synthetic
 * key derived from the heading path (the GDocs export gives no stable per-heading block id), so relocation
 * is fuzzy: core re-verifies the anchor against `snippet` on each sweep (anchor type "gdoc_fuzzy").
 *
 * The @composio/core SDK loads via a computed dynamic import so this file typechecks / the worker builds
 * even without the package (CI runs only StubConnector). `exec()` is the one place the SDK call shape lives.
 */
export class GDocsConnector implements DocumentConnector {
  private client: unknown;

  constructor(
    private readonly apiKey: string,
    private readonly entity: string,
  ) {}

  private async getClient(): Promise<Record<string, unknown>> {
    if (!this.client) {
      const spec = "@composio/core";
      const mod: Record<string, unknown> = await import(spec);
      const Composio = mod.Composio as new (opts: { apiKey: string }) => unknown;
      this.client = new Composio({ apiKey: this.apiKey });
    }
    return this.client as Record<string, unknown>;
  }

  private async exec(slug: string, input: Record<string, unknown>, app = "googledocs"): Promise<Record<string, unknown>> {
    const client = (await this.getClient()) as { tools: { execute: (args: unknown) => Promise<unknown> } };
    const res = (await client.tools.execute({
      entity: this.entity,
      app,
      tool: slug,
      input,
    })) as { data?: Record<string, unknown>; successful?: boolean; error?: string };
    if (res && res.successful === false) throw new Error(`composio ${slug} failed: ${res.error ?? "unknown"}`);
    return (res?.data ?? {}) as Record<string, unknown>;
  }

  /* ── DocumentConnector ── */

  /** GDocs is native-registered (by URL), never folder-swept in Phase D — nothing to list. */
  async listDocuments(): Promise<DocMeta[]> {
    return [];
  }

  async fetchDocumentSections(fileId: string): Promise<DocSection[]> {
    const d = await this.exec(GDOCS_GET_DOCUMENT_SLUG, { id: fileId });
    // Composio may wrap the document under `document`, or hand back the raw Docs API object.
    const doc = (d.document ?? d) as Record<string, unknown>;
    return sectionize(fileId, paragraphs(doc));
  }

  async writeComment(fileId: string, body: string, _anchor?: string | null): Promise<{ commentRef: string }> {
    // Comments are a Drive feature (no googledocs tool exists) — post via the Drive slug on the googledrive
    // app. The fuzzy anchor rides in the body's deep link (there's no stable block id to attach to), so the
    // comment lands at document level — same trade-off as the Notion writeComment.
    const d = await this.exec(GDRIVE_CREATE_COMMENT_SLUG, { file_id: fileId, content: body }, "googledrive");
    return { commentRef: str(d.id) || fileId };
  }
}

/* helpers — defensive against varying Composio/Docs export shapes */
function arr(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}
function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
/** A stable-ish anchor key from a heading path — same path ⇒ same key across sweeps. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
function headingLevel(namedStyleType: string): number | null {
  const m = namedStyleType.match(/^HEADING_([123])$/);
  return m ? Number(m[1]) : null;
}
/** Flatten the Docs body into a paragraph list: heading level (null for body text) + plain text. */
function paragraphs(doc: Record<string, unknown>): Array<{ level: number | null; text: string }> {
  const content = arr((doc.body as Record<string, unknown> | undefined)?.content);
  const out: Array<{ level: number | null; text: string }> = [];
  for (const el of content) {
    const para = el.paragraph as Record<string, unknown> | undefined;
    if (!para) continue; // tables/sectionBreaks/tableOfContents — not extractable prose
    const style = str((para.paragraphStyle as Record<string, unknown> | undefined)?.namedStyleType);
    const text = arr(para.elements)
      .map((e) => str((e.textRun as Record<string, unknown> | undefined)?.content))
      .join("")
      .replace(/\n+$/, ""); // Docs terminates every paragraph with a newline run
    out.push({ level: headingLevel(style), text });
  }
  return out;
}
function snippetOf(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 120);
}
/**
 * Split the paragraph list into heading-anchored sections. The pre-heading preamble anchors on the doc id;
 * each heading anchors on slug(headingPath.join(">")) — synthetic but stable while the heading path holds.
 * A heading's section runs until the next same-or-higher-level heading (so an H2 includes its H3 bodies,
 * and each H3 also anchors its own finer section) — identical shape to ComposioConnector's Notion sectionize.
 */
function sectionize(docId: string, paras: Array<{ level: number | null; text: string }>): DocSection[] {
  const sections: DocSection[] = [];
  const stack: Array<{ level: number; text: string }> = [];
  let i = 0;
  const preamble: string[] = [];
  while (i < paras.length && paras[i]!.level === null) {
    const t = paras[i]!.text;
    if (t) preamble.push(t);
    i++;
  }
  if (preamble.length) {
    const body = preamble.join("\n");
    sections.push({ anchorKey: docId, headingPath: [], text: body, snippet: snippetOf(body) });
  }
  for (; i < paras.length; i++) {
    const level = paras[i]!.level;
    if (level === null) continue;
    const headingText = paras[i]!.text;
    while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
    stack.push({ level, text: headingText });
    const bodyParts: string[] = [];
    for (let j = i + 1; j < paras.length; j++) {
      const l = paras[j]!.level;
      if (l !== null && l <= level) break;
      const t = paras[j]!.text;
      if (t) bodyParts.push(t);
    }
    const body = bodyParts.join("\n");
    const headingPath = stack.map((h) => h.text);
    sections.push({
      anchorKey: slug(headingPath.join(">")),
      headingPath,
      text: [headingText, body].filter(Boolean).join("\n"),
      snippet: snippetOf(body || headingText),
    });
  }
  return sections;
}
