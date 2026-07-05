import type { DocumentConnector, DocMeta, DocSection } from "./SourceConnector.js";
import { slug } from "./GDocsConnector.js";

/**
 * Composio slugs for the Confluence doc layer — plausible picks from Composio's Confluence action list
 * but NOT yet verified against live Composio (mirrors GDocsConnector's UNVERIFIED consts). Each is
 * referenced exactly once, so a rename is a one-line fix once verified. VERIFY BEFORE THE FIRST REAL SWEEP.
 */
const CONFLUENCE_GET_PAGE_SLUG = "CONFLUENCE_GET_PAGE_BY_ID"; // input { id, expand: "body.storage,version" } — matches ComposioConnector.confluenceUnits
const CONFLUENCE_CREATE_COMMENT_SLUG = "CONFLUENCE_CREATE_FOOTER_COMMENT"; // VERIFY — alternates: CONFLUENCE_CREATE_COMMENT, CONFLUENCE_ADD_COMMENT (input { id/pageId, body })

/**
 * Confluence document connector — parallel to GDocsConnector (NOT a subclass), because Confluence is a
 * native-registered doc source (registered by URL, not folder-swept). Confluence storage format is
 * XHTML with no stable per-heading block id, so anchoring is synthetic (slug of the heading path) and
 * relocation is fuzzy: core re-verifies the anchor against `snippet` each sweep (anchor type
 * "confluence_xpath" — reuses the GDocs `gdoc_fuzzy` relocation, just a distinct label for the source).
 *
 * The @composio/core SDK loads via a computed dynamic import so this file typechecks / the worker builds
 * even without the package (CI runs only StubConnector). `exec()` is the one place the SDK call shape lives.
 */
export class ConfluenceConnector implements DocumentConnector {
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

  private async exec(slug: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const client = (await this.getClient()) as { tools: { execute: (args: unknown) => Promise<unknown> } };
    const res = (await client.tools.execute({
      entity: this.entity,
      app: "confluence",
      tool: slug,
      input,
    })) as { data?: Record<string, unknown>; successful?: boolean; error?: string };
    if (res && res.successful === false) throw new Error(`composio ${slug} failed: ${res.error ?? "unknown"}`);
    return (res?.data ?? {}) as Record<string, unknown>;
  }

  /* ── DocumentConnector ── */

  /** Confluence is native-registered (by URL), never folder-swept in Phase E — nothing to list. */
  async listDocuments(): Promise<DocMeta[]> {
    return [];
  }

  async fetchDocumentSections(pageId: string): Promise<DocSection[]> {
    const d = await this.exec(CONFLUENCE_GET_PAGE_SLUG, { id: pageId, expand: "body.storage,version" });
    // Composio may wrap the page under `page`, or hand back the raw Confluence REST object.
    const page = (d.page ?? d) as Record<string, unknown>;
    const storage = ((page.body as Record<string, unknown> | undefined)?.storage ?? {}) as Record<string, unknown>;
    return sectionize(pageId, parseConfluenceXhtml(str(storage.value)));
  }

  async writeComment(pageId: string, body: string, _anchor?: string | null): Promise<{ commentRef: string }> {
    // Footer comments attach at page level (no stable block id to anchor on), so the fuzzy anchor rides
    // in the body's deep link — same trade-off as the GDocs/Notion writeComment.
    const d = await this.exec(CONFLUENCE_CREATE_COMMENT_SLUG, { id: pageId, pageId, body });
    return { commentRef: str(d.id) || pageId };
  }
}

/* helpers — defensive against varying Composio/Confluence response shapes */
function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
/** Decode the handful of XML entities Confluence emits. `&amp;` is decoded LAST to avoid double-decoding. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}
/** Strip every tag (incl. `<ac:…>`/`<ri:…>` macros) to a space, decode entities, collapse whitespace. */
function stripTags(inner: string): string {
  return decodeEntities(inner.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
/**
 * Parse Confluence storage-format XHTML into a flat paragraph list: heading level (1–6, null for body
 * `<p>` text) + plain text, in document order. A dependency-free block scanner — matches `<h1>…</h1>`
 * .. `<h6>` and `<p>…</p>`, ignoring everything else (tables, macros standing outside a paragraph, etc.),
 * mirroring GDocsConnector's paragraph flattening. Exported so it's unit-testable without any network.
 */
export function parseConfluenceXhtml(xhtml: string): Array<{ level: number | null; text: string }> {
  const out: Array<{ level: number | null; text: string }> = [];
  const re = /<(h[1-6]|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xhtml)) !== null) {
    const tag = m[1]!.toLowerCase();
    const level = tag[0] === "h" ? Number(tag[1]) : null;
    out.push({ level, text: stripTags(m[2] ?? "") });
  }
  return out;
}
function snippetOf(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 120);
}
/**
 * Split the paragraph list into heading-anchored sections — identical shape to GDocsConnector's
 * sectionize. The pre-heading preamble anchors on the pageId; each heading anchors on
 * slug(headingPath.join(">")) — synthetic but stable while the heading path holds. A heading's section
 * runs until the next same-or-higher-level heading (so an h2 includes its h3 bodies, and each h3 also
 * anchors its own finer section).
 */
function sectionize(pageId: string, paras: Array<{ level: number | null; text: string }>): DocSection[] {
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
    sections.push({ anchorKey: pageId, headingPath: [], text: body, snippet: snippetOf(body) });
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
