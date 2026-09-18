# Lockstep Dashboard: Design System and Product Pass

**Date:** 2026-09-18
**Status:** Approved for planning
**Scope:** `packages/web` (all routes), `packages/core` (two read-model changes)

## 1. Why

The dashboard has a coherent dark theme and a real token layer, yet reads as unfinished. A rendered audit of all 16 routes with seeded data (three developers, three repos, eight decisions, ten surfaces, seven dependency edges) found the cause is information design and navigation, not styling:

1. **Rows don't say who, what, or so-what.** Activity and Home feeds show "Task delegated · task · just now" with no actor or object. Questions hide their answers. Tasks show no assignee and two status pills for one state.
2. **Navigation is broken twice.** The sidebar clips: the Graph group has no visible item and the whole Admin group is unreachable. The "Review →" action on Decisions lands on a Review queue that says "Nothing to review".
3. **Three inboxes, no shared vocabulary.** Review, Notifications, and Decisions' "Awaiting review" all mean "a human must act", each with its own words: open, proposed, binding, queued, awaiting.
4. **No detail layer.** Everything is a list. No decision page, no surface page, and blast radius appears only as "impact 1" on Notifications.
5. **Flat action hierarchy and polish bugs.** The gradient primary button is used for Search, Register, Create connection, and two Enable toggles. The dependency graph minimap overlays nodes and the first node hides under the filter. Insights shows "0%" four times. The topbar repeats the project name and does nothing else. Members leaks `GITHUB_APP_SLUG`.

What to protect: the dark theme, the token approach, mono treatment for surface IDs, the row and pill grammar, the empty-state pattern, and grouped navigation.

## 2. Decisions taken

| Question | Decision |
| --- | --- |
| Primary users | Engineers and product teams together. Role-aware Home, one shared language. |
| Visual identity | Calm workspace, dark default. One accent. Gradient survives only in the logo mark. Light theme prepared as a token swap, not tuned in this pass. |
| Scope | Design system, information architecture, row enrichment, role-aware Home, one new detail page (Decision). Surface and Person detail pages deferred. |
| Implementation approach | Tailwind 3.4 and shadcn/ui in v3 form on the existing Next 14.2 / React 18.3 stack. No framework upgrade. |

## 3. Foundations

### 3.1 Stack

- Tailwind CSS 3.4 with `tailwind.config.ts`, PostCSS.
- shadcn/ui, style `new-york`, CSS-variable theming, components vendored into `app/components/ui/`.
- Radix UI primitives (installed transitively by shadcn).
- `lucide-react` for icons, replacing `app/components/icons.tsx`.
- `clsx`, `tailwind-merge`, `class-variance-authority` (shadcn requirements).
- Fonts via `next/font/google`: Inter (UI), JetBrains Mono (surface IDs, code refs).

### 3.2 Colour tokens

Dark is `:root`. Light is a `.light` class on `<html>` that overrides the same variables; no component references a raw colour. Values are hex in the token block. `tailwind.config.ts` maps each Tailwind colour name to `var(--token)` directly (not shadcn's default `hsl(var(--x))` form), so the vendored shadcn components work unchanged and alpha variants come from explicit `--x-soft` (12%) and `--x-edge` (30%) tokens rather than Tailwind opacity modifiers.

| Token | Dark | Role |
| --- | --- | --- |
| `--background` | `#0b0d12` | page |
| `--card` | `#12151c` | cards, sidebar, topbar |
| `--muted` | `#181c25` | hover rows, inputs, code refs |
| `--border` | `#242a37` | every hairline |
| `--foreground` | `#e6eaf2` | primary text |
| `--muted-foreground` | `#8b95a9` | meta text, labels |
| `--primary` | `#8b7cf6` | the one accent: primary button, active nav, focus ring, binding/ratified status |
| `--primary-foreground` | `#0b0d12` | text on primary |
| `--success` | `#3fb950` | verified, answered, completed |
| `--warning` | `#e3b341` | proposed, awaiting ack, queued, open question |
| `--destructive` | `#f8717a` | urgent, conflict, due for review, drift, destructive buttons |
| `--info` | `#5b9dff` | informational only, rarely used |
| `--ring` | same as `--primary` | focus |
| `--radius` | `10px` | cards; controls derive `calc(var(--radius) - 2px)` |

Semantic pills use the semantic colour at 12% alpha for background, 30% alpha for border, and full colour for the dot and text.

Removed: the violet-to-teal gradient on any control, the fixed ambient body gradient, card drop shadows. Shadows remain only on popovers, menus, dialogs, and sheets.

### 3.3 Status vocabulary

`StatusBadge` is the only component that maps status to colour and word. Unknown statuses render muted with the raw word; they never receive colour.

| Meaning | Words shown | Colour |
| --- | --- | --- |
| Settled truth | binding, ratified | primary |
| Settled truth | verified, answered, completed | success |
| Needs a human | proposed, awaiting ack, queued, open | warning |
| Attention now | urgent, conflict, due for review, drift | destructive |
| History | superseded, rejected, dismissed, closed | muted, no dot |
| Neutral facts | scope kinds, origins, HTTP methods, versions | muted outline chip (`RefChip`), never a `StatusBadge` |

API-to-display mapping:

| Object | API value | Displayed |
| --- | --- | --- |
| Decision with impact > 0 and no ack yet | `open` | awaiting ack |
| Decision from a connected tool, unconfirmed | `proposed` | proposed |
| Decision bound | `binding` | binding |
| Decision bound with `origin = document` | `binding` | ratified |
| Task | `runState` while not `done`, otherwise `status` | one badge only |
| Question | `open` / `answered` / `closed` | same words |
| Contract | `verificationStatus` | extracted / verified; `version` is shown as `v2` only when > 1 |

### 3.4 Typography

Six sizes, no others. Weights 400, 500, 600.

| Use | Size / line-height | Weight |
| --- | --- | --- |
| Section labels | 11px / 16px, uppercase, `tracking-wider` | 600 |
| Meta line, badges | 12px / 16px | 500 |
| Dense list body | 13px / 20px | 400 |
| Default body | 14px / 20px | 400 |
| Row titles, card headings | 16px / 24px | 500 |
| Page titles | 20px / 28px | 600 |

Mono: JetBrains Mono at 12px or 13px for `RefChip` and code.

### 3.5 Geometry, density, motion, icons

- 4px spacing grid. Radii: 8px controls, 10px cards, full pills.
- Rows: 48px minimum height, 12px vertical padding, 16px horizontal. Borders separate rows; no nested cards.
- Sidebar 240px. Content max-width 1200px, 24px gutter.
- Motion: 150ms ease-out on hover and focus, 200ms on overlays. The page-load fade-up stagger is removed. `prefers-reduced-motion: reduce` disables transitions.
- Icons: Lucide, 16px, stroke 1.75, `currentColor`. One icon per meaning across the app.

## 4. Component set

Two layers under `app/components/`: vendored shadcn primitives in `ui/`, Lockstep composites beside them. Pages compose only these. ESLint `react/forbid-dom-props` with `style` makes inline styles an error.

### 4.1 shadcn primitives to install

Button, Badge, Card, Tabs, Input, Select, Textarea, Label, Separator, Tooltip, DropdownMenu, Dialog, Sheet, Skeleton, Avatar, ScrollArea. Nothing else until a page needs it.

### 4.2 Lockstep composites

| Composite | Replaces | Contract |
| --- | --- | --- |
| `PageHeader` | `PageHead` and ad-hoc buttons | `title`, `description?`, `actions?` (right-aligned slot), `tabs?` (slot rendered below). One per page. |
| `ListRow` | `.row` plus inline styles | Fixed grammar left to right: optional `leading` (icon or `Who`), `title`, `meta` (children rendered on one line), trailing `status` (`StatusBadge`) and optional `action`. Whole row becomes a link when `href` is set. |
| `StatusBadge` | `StatusPill`, `.pill.*` | `status: string`, applies §3.3. |
| `RefChip` | `.code-ref`, `.pill.plain` | Mono chip for surface IDs, scope refs, repo names, kinds. Click copies text; Tooltip shows `kind` when given. |
| `Who` | nothing | `login`, `role?`, `size?`. Avatar initial plus `@login`. Links to Members. |
| `When` | inline `timeAgo()` | `at: string`. Relative text, absolute in Tooltip. |
| `StatGrid`, `Stat` | `.stats`, `Stat` | `n`, `label`, `href?`, `delta?`. A grid whose stats are all zero renders an `EmptyState` instead. |
| `EmptyState` | `.empty` | `icon`, `title`, `children` (one sentence), `action?`. Dashed border retained. |
| `Section` | `.section-title` and `.card` | `label`, `count?`, `href?` ("View all"), wraps a `Card`. |
| `EvidenceQuote` | `blockquote.evidence` | `quote`, `source`, `url?`, `confidence?`. Shared by Review queue and Decision detail. |
| `Field` | none | Wraps Input/Select/Textarea with `label`, `hint?`, `error?`. |

### 4.3 Button rationing

| Variant | Use |
| --- | --- |
| `default` (primary) | The one action that advances state on a page: Acknowledge, Confirm, Ratify, Invite, Register. At most one visible per view region. |
| `secondary` | Reversible or setup actions: Enable, Update, Filter, Propose new version. |
| `ghost` | Navigation and per-row actions: View, Review, Disconnect. |
| `destructive` | Reject, Dismiss, Archive. Always behind a Dialog confirmation. |

Icon-only buttons carry a Tooltip and `aria-label`.

### 4.4 Deletions

`app/components/ui.tsx`, `app/components/icons.tsx`, `app/components/review/Tabs.tsx`, all `.pill.*` classes, all `style={{}}` props, `.stagger` and `.animate-in`. `globals.css` shrinks to: Tailwind directives, the token block (dark and `.light`), base resets, React Flow overrides, print styles.

## 5. Information architecture

### 5.1 One inbox

Review, Notifications, and the "Awaiting review" block on Decisions collapse into the **Review queue**. Home summarises it. The Notifications route is removed and `/project/[o]/[p]/notifications` redirects to Home. Cross-cutting decisions (impact > 0) become a filter on Decisions and a card on Home.

### 5.2 Sidebar

Fixed brand and project switcher at top, `ScrollArea` for groups, fixed footer (version, docs link). Sign out moves to the topbar user menu.

| Group | Items |
| --- | --- |
| (ungrouped) | Home · Review `n` |
| Ledger | Decisions · Questions · Tasks · Contracts · Dependencies |
| Product | Sources · Features · Org graph |
| Admin | Connections · Members & Repos · Activity · Insights |

Counts stay on Review, Decisions, Questions, Tasks, Contracts, Dependencies, Sources, Features. Search leaves the sidebar.

### 5.3 Topbar

Left: breadcrumb `Org › Project › Page`. Centre: search Input, `⌘K` focuses, Enter navigates to `/search?q=`. Right: Review bell with count linking to the Review queue, avatar `DropdownMenu` with login, role, Switch project, Sign out.

### 5.4 Closing the dead end

On Decisions, a proposed agent decision's action is **View**, linking to Decision detail where acknowledging lives. Only tool-ingested proposals route to the Review queue. The Review queue opens on the first tab with items; every tab shows its count.

### 5.5 Routes

| Route | Change |
| --- | --- |
| `/project/[o]/[p]` | Home (was Overview) |
| `/project/[o]/[p]/decisions/[id]` | new |
| `/project/[o]/[p]/notifications` | redirect to Home |
| all others | unchanged paths, rebuilt pages |

## 6. Home and row grammar

### 6.1 Home

Role-aware via the existing `viewer.role` in the overview payload.

1. **Needs you.** One list, max 8, sorted by impact descending then age ascending. Members: decisions awaiting their ack, tasks delegated to them, urgent open questions, their own decisions due for review. PMs: ratification candidates and open conflicts first, then the member items. Primary action inline per row. Empty: "You're in lockstep. Nothing needs you." with a link to Activity.
2. **Stat strip.** Binding decisions · Awaiting ack · Open questions · Surfaces with consumers. Each links to its filtered list. All-zero renders a first-run `EmptyState` with the three onboarding commands.
3. **Two columns.** Left: recent shared-risk changes (`riskTier = shared`, newest first: surface, summary, who, when). Right: latest decisions.

### 6.2 Row grammar

Line one: title. Line two: meta in fixed order: scope `RefChip` → `Who` → `When` → qualifying chips. Trailing: `StatusBadge` → one optional action. A third line is allowed only on Decisions for a one-line, muted, truncated rationale.

| List | Title | Meta | Trailing |
| --- | --- | --- | --- |
| Activity | Humanised action with object: "alice-chen proposed *Auth tokens are JWT…*" | entity chip · when | none; row links to the entity |
| Decisions | rule text | scope · proposed by @who · when · `impact n` if > 0 · `vN` if > 1 | status · View |
| Questions | body | scope · asked by @who · when · urgent chip | status; when answered, the answer with @who renders below the meta line |
| Tasks | title | delegated to @who by @who · when | one status badge |
| Contracts | surface | repo chip · consumers n · verified against | extracted / verified |
| Dependencies | consumer → surface | producer repo or project chip · source | none |
| Review queue | rule text | source chip · confidence · when | primary action · Reject |

### 6.3 Folded-in fixes

- Dependencies graph: remove the minimap; add a 48px top inset to the canvas so the filter field no longer covers the first node.
- Insights: any stat with a zero denominator renders an `EmptyState` for the grid.
- Members: replace the raw `GITHUB_APP_SLUG` sentence with "Ask an admin to enable the GitHub App"; the env var name moves to an owner-only Tooltip.
- Search results and Overview "Latest decisions" use `ListRow` with the Decisions grammar.

## 7. Decision detail

### 7.1 Route and entry points

`/project/[o]/[p]/decisions/[id]`. Linked from every decision row, Home item, search result, and Activity entry.

### 7.2 Layout

1. **Header.** Breadcrumb `Decisions › <scopeRef>`. Rule text as the 20px title. Meta line: scope `RefChip`, type chip, origin chip, `StatusBadge`, `impact n`, `vN · proposed by @who · when`. Right-aligned action bar showing only the actions the viewer can take now: Acknowledge (status awaiting ack and viewer is an affected member), Confirm and Reject (tool-ingested proposal, owner or PM), Ratify (document constraint, PM), Propose new version (binding decisions, any member). Ineligible actions are absent, not disabled.
2. **Rationale and alternatives.** Rationale as body text; alternatives as a list under an 11px label. Review-at date with a "due for review" badge when past.
3. **Blast radius.** "Consumed by N repos": one row per consumer repo (`RefChip`, project chip when cross-project) and the count of binding decisions on the same surface. Empty: "No declared consumers. Own-area decision, bound on assertion."
4. **Agreement.** Acks as `Who` rows with verdict and comment. Required reviewers still pending shown muted with "awaiting". For ratified constraints, who ratified and when.
5. **Provenance.** One `EvidenceQuote` per provenance row.
6. **History.** Versions newest first: `vN`, rule text, proposed by, when, status. Supersedes / superseded-by links resolve to the other decision's rule text. Related conflicts listed with status and a link to the Review queue's Conflicts tab.

### 7.3 Propose new version

A `Sheet` from the action bar: rule text prefilled, rationale, optional review date. Submits via a server action to `POST /decisions` with the current `baseVersion`. A CAS conflict from the API renders inline: "This decision changed while you were editing. Reload to see vN."

## 8. Core API changes

Both are read models, RLS-scoped through `withOrg` like the existing overview. Member ids resolve to `githubLogin` server-side; the web never joins.

### 8.1 `projectOverview` enrichment

| Field | Source |
| --- | --- |
| `audit[].actor` (login or null) | `audit_events.actor_member_id` → `members.github_login` |
| `audit[].entityId`, `audit[].summary` | `audit_events.entity_id`, a short string derived from `payload` (rule text, question body, task title, change summary) |
| `decisions[].impact`, `decisions[].createdAt` | `decisions` |
| `decisions[].proposedBy` | `decision_versions.proposed_by` for the current version |
| `questions[].askedBy`, `questions[].createdAt` | `questions` |
| `questions[].answer { body, by, at }` | latest `answers` row |
| `tasks[].delegatedTo`, `tasks[].delegatedBy`, `tasks[].createdAt` | `tasks` |
| `contracts[].consumerCount` | count of active `dependency_edges` on the surface |
| `changes[]` (new, latest 20) | `change_feed_entries`: `id, surface, summary, riskTier, impact, createdBy, createdAt, repoId` |

### 8.2 New read: `GET /orgs/:orgId/projects/:projectId/decisions/:id`

Returns: the decision row; all `versions` with `proposedBy` resolved; `approvals` with reviewer logins; `requiredReviewers`; `provenances`; `consumers` (active dependency edges on the scope surface with consumer repo remote and project; empty for topic and capability scopes); `lineage` (`supersedes[]`, `supersededBy` with rule texts); `conflicts` referencing the decision. 404 when not in project; same auth as the overview.

All writes reuse existing endpoints: `/decisions/:id/ack`, `/orgs/:orgId/decisions/:id/confirm|reject|ratify`, `POST /decisions`.

## 9. States, accessibility, responsiveness

- Every route segment gets `loading.tsx` (Skeleton rows shaped like the real row) and `error.tsx` (API status, one-line reason, Retry).
- Empty states carry one action where an action exists, else one explanatory sentence.
- Icon-only controls have Tooltip and `aria-label`. Focus ring 2px `--ring`, never removed. Colour is never the only status carrier; every badge shows its word. `--muted-foreground` on `--card` is 5.9:1 (AA). `prefers-reduced-motion` respected. `⌘K` focuses search; `Esc` closes overlays.
- Graph pages keep a text alternative (the existing "All edges" list).
- Responsive: below 1024px the sidebar becomes a `Sheet` from a topbar menu button, stat grids drop to two columns, row actions wrap under the meta line. Below 640px must not break; it is not a target.

## 10. Verification

1. `npm run typecheck`, `npm run lint` with `react/forbid-dom-props` for `style`.
2. Playwright screenshot suite in `packages/web/e2e/`: seeds the local core (script from this audit, made repeatable), captures every route at 1440 and 1024 in populated and empty states. Reviewed by eye per task; not pixel-diffed.
3. Core e2e tests against Postgres: one asserting the enriched overview fields (resolved logins, impact, answer, consumerCount, changes), one asserting consumers and lineage on the detail read.

## 11. Out of scope

Light theme values (swap prepared, not tuned). Surface detail and Person detail pages. Review queue side-by-side evidence redesign. Mobile below 640px. Marketing site. Framework upgrades (Next 15+, React 19, Tailwind 4).

## Appendix: audit artefacts

Rendered before-screenshots for all routes at 1440px live in the session scratchpad (`shots/*.png`). Seed data: org "Acme Commerce", project "Checkout Platform", members alice-chen (owner), bob-okafor (member), priya-nair (pm), repos checkout-api, mobile-app, billing-service.
