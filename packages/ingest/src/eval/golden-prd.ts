import type { DocMeta, DocSection } from "../connectors/SourceConnector.js";

/**
 * The guest-checkout PRD golden fixture (v3 ship gate) — single source of truth for the doc eval
 * (run-docs.ts) and StubConnector's DocumentConnector methods. Grow it from ratification rejects/edits,
 * the way golden.ts grows from review-queue rejects. Each expected constraint gets its own heading-anchored
 * section (incl. the "should ideally" aspiration) so section-level precision/recall scoring stays clean.
 */

export interface GoldenPrdSection {
  anchorKey: string;
  headingPath: string[];
  text: string;
  expect: {
    extracted: boolean;
    constraintKind?: string;
    scopeKind?: string;
    scopeRef?: string;
    expiresHint?: boolean;
  };
}

export const GOLDEN_PRD_TITLE = "PRD-142 · Guest Checkout";

export const GOLDEN_PRD: GoldenPrdSection[] = [
  {
    anchorKey: "blk-bg-1",
    headingPath: ["Background"],
    text:
      "Background\n" +
      "Cart abandonment on mobile sits at 61%, with the steepest drop-off at the account-creation step. " +
      "Competitor Shopline shipped guest checkout in Q1 and reported a 9-point conversion lift within two months. " +
      "Our funnel analysis shows the pre-payment OTP step alone loses 18% of first-time buyers.",
    expect: { extracted: false },
  },
  {
    anchorKey: "blk-personas-1",
    headingPath: ["Personas"],
    text:
      "Personas\n" +
      'Priya, 28, first-time buyer: "I just want to pay and go — why do I need yet another account?" ' +
      "Rohan, 35, repeat customer, stays logged in and is unaffected by this change.",
    expect: { extracted: false },
  },
  {
    anchorKey: "blk-c1",
    headingPath: ["Requirements", "Guest flow", "C-1 Account-free checkout"],
    text:
      "C-1 Account-free checkout\n" +
      "Guests must be able to complete checkout without creating an account. " +
      "An email address is collected at payment for the receipt only and creates no login.",
    expect: { extracted: true, constraintKind: "behavioral", scopeKind: "capability", scopeRef: "feature:guest-checkout" },
  },
  {
    anchorKey: "blk-c2",
    headingPath: ["Requirements", "Guest flow", "C-2 No pre-payment OTP"],
    text:
      "C-2 No pre-payment OTP\n" +
      "The guest flow must not present an OTP challenge before payment (POST /payments/init). " +
      "Verification, if any, happens after the payment succeeds.",
    expect: { extracted: true, constraintKind: "behavioral", scopeKind: "surface", scopeRef: "http:POST /payments/init" },
  },
  {
    anchorKey: "blk-c3",
    headingPath: ["Requirements", "Guest flow", "C-3 Post-purchase claiming"],
    text:
      "C-3 Post-purchase claiming\n" +
      "Guest orders must be claimable post-purchase via the phone number used at checkout. " +
      "Claiming attaches the order to a new or existing account.",
    expect: { extracted: true, constraintKind: "behavioral", scopeKind: "capability", scopeRef: "feature:guest-checkout" },
  },
  {
    anchorKey: "blk-aspiration",
    headingPath: ["Requirements", "Guest flow", "Future ideas"],
    text:
      "Future ideas\n" +
      "We should ideally support social login (Google, Apple) later, and we hope to explore one-tap address " +
      "autofill after the guest flow ships. Neither is a commitment for this release.",
    expect: { extracted: false },
  },
  {
    anchorKey: "blk-c4",
    headingPath: ["Launch criteria"],
    text:
      "Launch criteria\n" +
      "C-4. Guest checkout conversion must be at least 92% of the logged-in baseline, measured for 30 days post-launch. " +
      "If the gate fails we roll back to mandatory accounts and revisit.",
    expect: {
      extracted: true,
      constraintKind: "launch_gate",
      scopeKind: "capability",
      scopeRef: "feature:guest-checkout",
      expiresHint: true,
    },
  },
  {
    anchorKey: "blk-oq-1",
    headingPath: ["Open questions"],
    text:
      "Open questions\n" +
      "Do we dedupe guest orders against existing accounts by email? Legal review of storing phone numbers " +
      "for unclaimed orders is still pending. GA timing lives in the roadmap table, not here.",
    expect: { extracted: false },
  },
];

/** DocMeta for the fixture PRD — rawStateValue injectable so tests can exercise state transitions. */
export function goldenPrdMeta(rawStateValue: string | null = "In review"): DocMeta {
  return {
    externalId: "prd-142",
    containerRef: "db-prd-fixtures",
    title: GOLDEN_PRD_TITLE,
    url: "https://notion.example.com/prd-142",
    rawStateValue,
    ownerRef: "user-pm-priya",
    lastEditedTime: "2026-07-01T09:00:00.000Z",
  };
}

/** The fixture as connector-shaped sections (snippet = first ~120 chars of the section body). */
export function goldenPrdSections(): DocSection[] {
  return GOLDEN_PRD.map((s) => {
    const body = s.text.split("\n").slice(1).join("\n");
    return {
      anchorKey: s.anchorKey,
      headingPath: s.headingPath,
      text: s.text,
      snippet: body.replace(/\s+/g, " ").trim().slice(0, 120),
    };
  });
}
