/**
 * Seed data for a believable seed-stage founder's software stack.
 *
 * ⚠️  ALL OF THIS IS FICTIONAL. No real vendors are contacted, no real accounts
 *     exist, and no real money moves anywhere in this application.
 *
 * The arithmetic is internally consistent and deliberately checkable:
 *
 *   Tracked annual spend ............ $8,633.88   (12 subscriptions)
 *   Open opportunity value .......... $3,078.00   (8 opportunities, 35.7% of spend)
 *   Realised savings YTD ............ $1,235.88   (6 executed actions)
 *
 * Dates are UTC-midnight anchored relative to "today" so the demo never goes
 * stale, and so server and client render identical strings (no hydration drift).
 */

import type {
  Action,
  ChatMessage,
  LedgerEntry,
  Opportunity,
  Source,
  Subscription,
  User,
} from "@/lib/domain/types";

/* -------------------------------------------------------------------------- */
/* Date anchoring                                                              */
/* -------------------------------------------------------------------------- */

function todayUTC(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

/** Midnight-anchored ISO string `n` days from today. Deterministic per day. */
export function dayOffset(n: number, hours = 0, minutes = 0): string {
  const d = todayUTC();
  d.setUTCDate(d.getUTCDate() + n);
  d.setUTCHours(hours, minutes, 0, 0);
  return d.toISOString();
}

/** Deterministic pseudo-random in [0,1) from a string seed — keeps trails stable. */
function seeded(seed: string, i: number): number {
  let h = 2166136261;
  const s = `${seed}:${i}`;
  for (let k = 0; k < s.length; k++) {
    h ^= s.charCodeAt(k);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/** 12 months of spend with light, stable jitter — drives the row sparklines. */
function trail(seed: string, monthlyCents: number, shape: "flat" | "growing" | "dying" = "flat") {
  return Array.from({ length: 12 }, (_, i) => {
    const jitter = 0.94 + seeded(seed, i) * 0.12;
    const curve = shape === "growing" ? 0.62 + (i / 11) * 0.38 : shape === "dying" ? 1 : 1;
    return Math.round(monthlyCents * jitter * curve);
  });
}

/* -------------------------------------------------------------------------- */
/* User                                                                        */
/* -------------------------------------------------------------------------- */

export const user: User = {
  id: "usr_01",
  name: "Ada Reyes",
  email: "ada@northbeam.co",
  company: "Northbeam",
  passkey: {
    enrolled: true,
    deviceLabel: "MacBook Pro · Touch ID",
    modality: "touch",
    enrolledAt: dayOffset(-96, 9, 14),
  },
  guardrails: {
    perActionCapCents: 50_000, // $500 per action
    monthlyCapCents: 200_000, // $2,000 rolling 30 days
    approvalAlways: true,
    allowVendors: ["Figma", "Notion", "Vercel", "Linear"],
    denyVendors: ["Amazon Web Services", "Stripe"],
    allowCancellation: true,
  },
};

/* -------------------------------------------------------------------------- */
/* Sources                                                                     */
/* -------------------------------------------------------------------------- */

export const sources: Source[] = [
  {
    id: "src_alias",
    kind: "email_alias",
    label: "Forwarding alias",
    detail: "northbeam@in.renewly.app",
    status: "connected",
    connectedAt: dayOffset(-96, 9, 2),
    lastSyncAt: dayOffset(0, 6, 12),
    discoveredCount: 5,
  },
  {
    id: "src_gmail",
    kind: "gmail",
    label: "Gmail",
    detail: "ada@northbeam.co",
    status: "connected",
    connectedAt: dayOffset(-96, 9, 6),
    lastSyncAt: dayOffset(0, 6, 12),
    discoveredCount: 6,
  },
  {
    id: "src_card",
    kind: "card",
    label: "Company card",
    detail: "Ramp · •••• 4417",
    status: "connected",
    connectedAt: dayOffset(-95, 11, 40),
    lastSyncAt: dayOffset(0, 5, 55),
    discoveredCount: 1,
  },
  {
    id: "src_statement",
    kind: "statement",
    label: "Bank statements",
    detail: "Not connected",
    status: "disconnected",
    connectedAt: null,
    lastSyncAt: null,
    discoveredCount: 0,
  },
];

/* -------------------------------------------------------------------------- */
/* Subscriptions — $8,633.88 / yr tracked                                      */
/* -------------------------------------------------------------------------- */

export const subscriptions: Subscription[] = [
  {
    id: "sub_figma",
    vendor: "Figma",
    initials: "Fi",
    plan: "Professional · 4 editors",
    category: "Design",
    amountCents: 57_600, // $576.00 / yr
    cadence: "annual",
    nextRenewal: dayOffset(2, 8, 0), // ★ the imminent renewal
    seats: 4,
    activeSeats: 1,
    status: "underused",
    confidence: 0.98,
    sourceId: "src_gmail",
    evidence: "Invoice #FIG-88214 · receipts@figma.com · 12 Aug",
    trail: trail("figma", 4800),
  },
  {
    id: "sub_adobe",
    vendor: "Adobe",
    initials: "Ad",
    plan: "Creative Cloud · All Apps",
    category: "Design",
    amountCents: 5_999, // $59.99 / mo
    cadence: "monthly",
    nextRenewal: dayOffset(9, 8, 0),
    seats: 1,
    activeSeats: 1,
    status: "underused",
    confidence: 0.96,
    sourceId: "src_card",
    evidence: "Card auth · ADOBE INC · •••• 4417 · recurring 9th",
    trail: trail("adobe", 5999),
  },
  {
    id: "sub_canva",
    vendor: "Canva",
    initials: "Cv",
    plan: "Teams · 5 people",
    category: "Design",
    amountCents: 6_000, // $60.00 / mo
    cadence: "monthly",
    nextRenewal: dayOffset(16, 8, 0),
    seats: 5,
    activeSeats: 2,
    status: "duplicate",
    confidence: 0.91,
    sourceId: "src_alias",
    evidence: "Receipt · no-reply@canva.com · overlaps Figma (Design)",
    trail: trail("canva", 6000),
  },
  {
    id: "sub_notion",
    vendor: "Notion",
    initials: "No",
    plan: "Plus · 5 members",
    category: "Docs & wiki",
    amountCents: 4_000, // $40.00 / mo
    cadence: "monthly",
    nextRenewal: dayOffset(11, 8, 0),
    seats: 5,
    activeSeats: 5,
    status: "active",
    confidence: 0.99,
    sourceId: "src_gmail",
    evidence: "Invoice · team@makenotion.com · billed monthly",
    trail: trail("notion", 4000, "growing"),
  },
  {
    id: "sub_retool",
    vendor: "Retool",
    initials: "Re",
    plan: "Team · 3 builders",
    category: "Internal tools",
    amountCents: 15_000, // $150.00 / mo
    cadence: "monthly",
    nextRenewal: dayOffset(6, 8, 0),
    seats: 3,
    activeSeats: 2,
    status: "underused",
    confidence: 0.94,
    sourceId: "src_gmail",
    evidence: "Invoice #RT-4471 · billing@retool.com · 1 builder idle 74d",
    trail: trail("retool", 15000),
  },
  {
    id: "sub_openai",
    vendor: "OpenAI",
    initials: "Oa",
    plan: "ChatGPT Team · 4 seats",
    category: "AI",
    amountCents: 10_000, // $100.00 / mo
    cadence: "monthly",
    nextRenewal: dayOffset(21, 8, 0),
    seats: 4,
    activeSeats: 4,
    status: "active",
    confidence: 0.99,
    sourceId: "src_card",
    evidence: "Card auth · OPENAI *CHATGPT · •••• 4417",
    trail: trail("openai", 10000, "growing"),
  },
  {
    id: "sub_slack",
    vendor: "Slack",
    initials: "Sl",
    plan: "Pro · 8 members",
    category: "Comms",
    amountCents: 5_800, // $58.00 / mo
    cadence: "monthly",
    nextRenewal: dayOffset(19, 8, 0),
    seats: 8,
    activeSeats: 8,
    status: "active",
    confidence: 0.97,
    sourceId: "src_alias",
    evidence: "Receipt · feedback@slack.com · pro-rated 8 seats",
    trail: trail("slack", 5800),
  },
  {
    id: "sub_vercel",
    vendor: "Vercel",
    initials: "Ve",
    plan: "Pro · 3 members",
    category: "Infrastructure",
    amountCents: 6_000, // $60.00 / mo
    cadence: "monthly",
    nextRenewal: dayOffset(13, 8, 0),
    seats: 3,
    activeSeats: 3,
    status: "active",
    confidence: 0.99,
    sourceId: "src_gmail",
    evidence: "Invoice · invoice+statements@vercel.com",
    trail: trail("vercel", 6000, "growing"),
  },
  {
    id: "sub_linear",
    vendor: "Linear",
    initials: "Li",
    plan: "Standard · 6 users",
    category: "Product",
    amountCents: 4_800, // $48.00 / mo
    cadence: "monthly",
    nextRenewal: dayOffset(24, 8, 0),
    seats: 6,
    activeSeats: 5,
    status: "active",
    confidence: 0.98,
    sourceId: "src_gmail",
    evidence: "Invoice · billing@linear.app",
    trail: trail("linear", 4800),
  },
  {
    id: "sub_superhuman",
    vendor: "Superhuman",
    initials: "Su",
    plan: "Starter · 2 seats",
    category: "Comms",
    amountCents: 6_000, // $60.00 / mo
    cadence: "monthly",
    nextRenewal: dayOffset(4, 8, 0),
    seats: 2,
    activeSeats: 1,
    status: "underused",
    confidence: 0.93,
    sourceId: "src_card",
    evidence: "Card auth · SUPERHUMAN LABS · 1 seat unopened 61d",
    trail: trail("superhuman", 6000),
  },
  {
    id: "sub_webflow",
    vendor: "Webflow",
    initials: "Wf",
    plan: "Site plan · Basic",
    category: "Marketing",
    amountCents: 2_300, // $23.00 / mo
    cadence: "monthly",
    nextRenewal: dayOffset(7, 8, 0),
    seats: null,
    activeSeats: null,
    status: "zombie",
    confidence: 0.89,
    sourceId: "src_alias",
    evidence: "No publish event in 168d · site replaced by Vercel Feb 14",
    trail: trail("webflow", 2300, "dying"),
  },
  {
    id: "sub_loom",
    vendor: "Loom",
    initials: "Lo",
    plan: "Business · 3 creators",
    category: "Comms",
    amountCents: 15_000, // $150.00 / yr
    cadence: "annual",
    nextRenewal: dayOffset(34, 8, 0),
    seats: 3,
    activeSeats: 0,
    status: "zombie",
    confidence: 0.86,
    sourceId: "src_gmail",
    evidence: "0 recordings in 142d · last login 4 Feb",
    trail: trail("loom", 1250, "dying"),
  },
];

/* -------------------------------------------------------------------------- */
/* Opportunities — $3,078.00 / yr open                                         */
/* -------------------------------------------------------------------------- */

export const opportunities: Opportunity[] = [
  {
    id: "opp_figma_seats",
    kind: "cut_seats",
    subscriptionId: "sub_figma",
    vendor: "Figma",
    headline: "Renew Figma on 1 editor instead of 4",
    rationale:
      "Figma auto-renews in 2 days at $576 for 4 editor seats. Three of those seats haven't opened a file in 90+ days — Marco and Priya moved to view-only in April, and the fourth was never claimed. I can complete the renewal on a single editor seat and keep everyone else on free viewer access, which loses you nothing.",
    savingCentsPerYear: 43_200, // $432.00
    currentAnnualCents: 57_600,
    proposedAnnualCents: 14_400,
    confidence: 0.96,
    priority: 100,
    urgent: true,
    deadline: dayOffset(2, 8, 0),
    status: "open",
    steps: [
      "Verify seat activity across the last 90 days",
      "Downgrade 3 editor seats to viewer",
      "Mint single-use card, capped at $144.00",
      "Complete renewal on 1 editor seat",
      "Capture receipt and write the ledger entry",
    ],
  },
  {
    id: "opp_canva_dupe",
    kind: "consolidate_duplicate",
    subscriptionId: "sub_canva",
    vendor: "Canva",
    headline: "Cancel Canva Teams — Figma already covers it",
    rationale:
      "Canva Teams and Figma are both billed as design tools and 2 of 5 Canva seats are active. Everything the team makes in Canva is a social asset that Figma templates already cover. Cancelling removes $60/mo with no capability lost.",
    savingCentsPerYear: 72_000, // $720.00
    currentAnnualCents: 72_000,
    proposedAnnualCents: 0,
    confidence: 0.84,
    priority: 90,
    urgent: false,
    deadline: dayOffset(16, 8, 0),
    status: "open",
    steps: [
      "Export brand kit and 41 team designs",
      "Confirm no scheduled publishes remain",
      "Submit cancellation before the 16th",
      "Verify final invoice is $0.00",
    ],
  },
  {
    id: "opp_retool_seats",
    kind: "cut_seats",
    subscriptionId: "sub_retool",
    vendor: "Retool",
    headline: "Drop 1 idle Retool builder seat",
    rationale:
      "Retool bills $50/builder/mo. One of the three builder seats hasn't edited an app in 74 days — that seat can move to end-user access, which is free on your plan.",
    savingCentsPerYear: 60_000, // $600.00
    currentAnnualCents: 180_000,
    proposedAnnualCents: 120_000,
    confidence: 0.92,
    priority: 84,
    urgent: false,
    deadline: dayOffset(6, 8, 0),
    status: "open",
    steps: [
      "Confirm 74-day edit inactivity",
      "Convert builder seat to end user",
      "Apply mid-cycle proration credit",
    ],
  },
  {
    id: "opp_adobe_tier",
    kind: "downgrade_tier",
    subscriptionId: "sub_adobe",
    vendor: "Adobe",
    headline: "Move Adobe from All Apps to Photoshop single-app",
    rationale:
      "Only Photoshop and Acrobat have been opened in the last 6 months, and Acrobat's PDF work is covered by the free tier. All Apps is $59.99/mo; Photoshop single-app is $22.99/mo.",
    savingCentsPerYear: 44_400, // $444.00
    currentAnnualCents: 71_988,
    proposedAnnualCents: 27_588,
    confidence: 0.88,
    priority: 76,
    urgent: false,
    deadline: dayOffset(9, 8, 0),
    status: "open",
    steps: [
      "Audit app-open telemetry for 180 days",
      "Switch plan to Photoshop single-app",
      "Confirm no early-termination fee applies",
    ],
  },
  {
    id: "opp_superhuman_seats",
    kind: "cut_seats",
    subscriptionId: "sub_superhuman",
    vendor: "Superhuman",
    headline: "Release the unopened Superhuman seat",
    rationale:
      "The second Superhuman seat was invited 61 days ago and has never been opened. Releasing it halves the bill immediately.",
    savingCentsPerYear: 36_000, // $360.00
    currentAnnualCents: 72_000,
    proposedAnnualCents: 36_000,
    confidence: 0.95,
    priority: 70,
    urgent: false,
    deadline: dayOffset(4, 8, 0),
    status: "open",
    steps: ["Revoke unaccepted invitation", "Reduce billed seats to 1", "Request proration credit"],
  },
  {
    id: "opp_webflow_zombie",
    kind: "cancel_zombie",
    subscriptionId: "sub_webflow",
    vendor: "Webflow",
    headline: "Cancel Webflow — the site moved to Vercel in February",
    rationale:
      "The Webflow site plan hasn't published in 168 days. Your marketing site has been served from Vercel since 14 Feb, so this is paying for a site nobody reaches.",
    savingCentsPerYear: 27_600, // $276.00
    currentAnnualCents: 27_600,
    proposedAnnualCents: 0,
    confidence: 0.94,
    priority: 64,
    urgent: false,
    deadline: dayOffset(7, 8, 0),
    status: "open",
    steps: [
      "Archive site backup to your Drive",
      "Confirm DNS no longer points to Webflow",
      "Cancel site plan",
    ],
  },
  {
    id: "opp_loom_zombie",
    kind: "cancel_zombie",
    subscriptionId: "sub_loom",
    vendor: "Loom",
    headline: "Cancel Loom Business — zero recordings in 142 days",
    rationale:
      "Nobody on the team has recorded a Loom since February and all 3 creator seats are idle. Existing videos stay viewable on the free tier.",
    savingCentsPerYear: 15_000, // $150.00
    currentAnnualCents: 15_000,
    proposedAnnualCents: 0,
    confidence: 0.9,
    priority: 55,
    urgent: false,
    deadline: dayOffset(34, 8, 0),
    status: "open",
    steps: [
      "Verify 61 existing videos survive on free tier",
      "Downgrade to free before renewal",
      "Confirm no auto-renew remains",
    ],
  },
  {
    id: "opp_notion_annual",
    kind: "switch_to_annual",
    subscriptionId: "sub_notion",
    vendor: "Notion",
    headline: "Switch Notion to annual billing",
    rationale:
      "Notion is the single most-used tool on the account — 5 of 5 seats daily active — so lock-in risk is negligible. Annual prepay is 20% cheaper than month-to-month.",
    savingCentsPerYear: 9_600, // $96.00
    currentAnnualCents: 48_000,
    proposedAnnualCents: 38_400,
    confidence: 0.97,
    priority: 48,
    urgent: false,
    deadline: dayOffset(11, 8, 0),
    status: "open",
    steps: [
      "Confirm 5 active seats over 90 days",
      "Mint single-use card, capped at $384.00",
      "Switch billing term to annual",
      "Capture receipt and write the ledger entry",
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* Executed history — $1,235.88 realised YTD                                   */
/* -------------------------------------------------------------------------- */

export const historicActions: Action[] = [
  {
    id: "act_zoom",
    opportunityId: "opp_zoom",
    subscriptionId: "sub_zoom",
    vendor: "Zoom",
    headline: "Cancelled Zoom Pro — replaced by Slack huddles",
    state: "executed",
    savingCentsPerYear: 17_988,
    chargedCents: 0,
    proposedAt: dayOffset(-74, 9, 12),
    approvedAt: dayOffset(-74, 9, 31),
    executedAt: dayOffset(-74, 9, 33),
    approval: { method: "passkey", device: "MacBook Pro · Touch ID" },
    steps: [],
    railToken: null,
  },
  {
    id: "act_mailchimp",
    opportunityId: "opp_mailchimp",
    subscriptionId: "sub_mailchimp",
    vendor: "Mailchimp",
    headline: "Downgraded Mailchimp Standard → Essentials",
    state: "executed",
    savingCentsPerYear: 24_000,
    chargedCents: 1_300,
    proposedAt: dayOffset(-61, 14, 2),
    approvedAt: dayOffset(-61, 14, 20),
    executedAt: dayOffset(-61, 14, 22),
    approval: { method: "passkey", device: "iPhone 16 Pro · Face ID" },
    steps: [],
    railToken: "vc_a91f…c2",
  },
  {
    id: "act_dropbox",
    opportunityId: "opp_dropbox",
    subscriptionId: "sub_dropbox",
    vendor: "Dropbox",
    headline: "Cut 2 dormant Dropbox seats",
    state: "executed",
    savingCentsPerYear: 24_000,
    chargedCents: 0,
    proposedAt: dayOffset(-47, 11, 5),
    approvedAt: dayOffset(-47, 11, 18),
    executedAt: dayOffset(-47, 11, 19),
    approval: { method: "passkey", device: "MacBook Pro · Touch ID" },
    steps: [],
    railToken: null,
  },
  {
    id: "act_intercom",
    opportunityId: "opp_intercom",
    subscriptionId: "sub_intercom",
    vendor: "Intercom",
    headline: "Renewed Intercom Starter on 12-month terms",
    state: "executed",
    savingCentsPerYear: 28_800,
    chargedCents: 87_600,
    proposedAt: dayOffset(-33, 10, 40),
    approvedAt: dayOffset(-33, 10, 58),
    executedAt: dayOffset(-33, 11, 1),
    approval: { method: "passkey", device: "iPhone 16 Pro · Face ID" },
    steps: [],
    railToken: "vc_77b3…9e",
  },
  {
    id: "act_airtable",
    opportunityId: "opp_airtable",
    subscriptionId: "sub_airtable",
    vendor: "Airtable",
    headline: "Switched Airtable to annual billing",
    state: "executed",
    savingCentsPerYear: 14_400,
    chargedCents: 57_600,
    proposedAt: dayOffset(-19, 15, 22),
    approvedAt: dayOffset(-19, 15, 44),
    executedAt: dayOffset(-19, 15, 46),
    approval: { method: "passkey", device: "MacBook Pro · Touch ID" },
    steps: [],
    railToken: "vc_04de…a7",
  },
  {
    id: "act_calendly",
    opportunityId: "opp_calendly",
    subscriptionId: "sub_calendly",
    vendor: "Calendly",
    headline: "Cancelled Calendly — duplicate of Cal.com",
    state: "executed",
    savingCentsPerYear: 14_400,
    chargedCents: 0,
    proposedAt: dayOffset(-8, 8, 51),
    approvedAt: dayOffset(-8, 9, 3),
    executedAt: dayOffset(-8, 9, 4),
    approval: { method: "passkey", device: "MacBook Pro · Touch ID" },
    steps: [],
    railToken: null,
  },
];

/* -------------------------------------------------------------------------- */
/* Ledger — append-only proof                                                  */
/* -------------------------------------------------------------------------- */

/** Short deterministic content hash. Makes rows read as tamper-evident. */
export function contentHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = (h * 33) ^ input.charCodeAt(i);
  const a = (h >>> 0).toString(16).padStart(8, "0");
  let g = 52711;
  for (let i = input.length - 1; i >= 0; i--) g = (g * 31) ^ input.charCodeAt(i);
  const b = (g >>> 0).toString(16).padStart(8, "0");
  return `${a}${b}`.slice(0, 12);
}

function entry(
  seq: number,
  at: string,
  type: LedgerEntry["type"],
  vendor: string,
  summary: string,
  deltaCentsPerYear: number,
  chargedCents: number,
  actionId: string | null,
  evidence: string,
): LedgerEntry {
  return {
    id: `led_${seq.toString().padStart(3, "0")}`,
    seq,
    at,
    type,
    vendor,
    summary,
    deltaCentsPerYear,
    chargedCents,
    actionId,
    evidence,
    hash: contentHash(`${seq}${at}${vendor}${summary}${deltaCentsPerYear}`),
  };
}

export const ledger: LedgerEntry[] = [
  entry(
    1,
    dayOffset(-96, 9, 8),
    "detected",
    "Renewly",
    "First inventory complete — 18 subscriptions found across 3 sources",
    0,
    0,
    null,
    "Scan #001 · gmail + alias + card",
  ),
  entry(
    2,
    dayOffset(-74, 9, 12),
    "proposed",
    "Zoom",
    "Proposed cancelling Zoom Pro — 0 meetings hosted in 90 days",
    17_988,
    0,
    "act_zoom",
    "Usage signal · 0 host events",
  ),
  entry(
    3,
    dayOffset(-74, 9, 31),
    "approved",
    "Zoom",
    "Approved by Ada Reyes · passkey",
    0,
    0,
    "act_zoom",
    "MacBook Pro · Touch ID",
  ),
  entry(
    4,
    dayOffset(-74, 9, 33),
    "executed",
    "Zoom",
    "Cancelled Zoom Pro effective end of term",
    17_988,
    0,
    "act_zoom",
    "Confirmation ZM-CX-40192",
  ),
  entry(
    5,
    dayOffset(-61, 14, 22),
    "executed",
    "Mailchimp",
    "Downgraded Standard → Essentials",
    24_000,
    1_300,
    "act_mailchimp",
    "Invoice MC-77214 · card vc_a91f…c2",
  ),
  entry(
    6,
    dayOffset(-47, 11, 19),
    "executed",
    "Dropbox",
    "Removed 2 dormant seats from Standard plan",
    24_000,
    0,
    "act_dropbox",
    "Seat audit · 2 × 0 logins / 120d",
  ),
  entry(
    7,
    dayOffset(-38, 7, 30),
    "failed",
    "Atlassian",
    "Downgrade rejected — vendor requires annual term to run out",
    0,
    0,
    null,
    "Vendor policy · retry queued for 12 Nov",
  ),
  entry(
    8,
    dayOffset(-33, 11, 1),
    "executed",
    "Intercom",
    "Renewed Starter on 12-month terms — 24% under list",
    28_800,
    87_600,
    "act_intercom",
    "Invoice IC-2291 · card vc_77b3…9e",
  ),
  entry(
    9,
    dayOffset(-19, 15, 46),
    "executed",
    "Airtable",
    "Switched Team plan to annual billing",
    14_400,
    57_600,
    "act_airtable",
    "Invoice AT-5518 · card vc_04de…a7",
  ),
  entry(
    10,
    dayOffset(-8, 9, 4),
    "executed",
    "Calendly",
    "Cancelled — functional duplicate of Cal.com",
    14_400,
    0,
    "act_calendly",
    "Overlap score 0.91 · Cal.com active",
  ),
  entry(
    11,
    dayOffset(-1, 6, 12),
    "detected",
    "Figma",
    "Renewal detected — $576.00 in 3 days, 3 of 4 editor seats idle 90d+",
    0,
    0,
    null,
    "Invoice #FIG-88214 · receipts@figma.com",
  ),
];

/* -------------------------------------------------------------------------- */
/* Chat — the opening state of the agent surface                               */
/* -------------------------------------------------------------------------- */

export const initialChat: ChatMessage[] = [
  {
    id: "msg_001",
    role: "agent",
    body: "Morning, Ada. I finished the overnight sweep across your inbox, alias and Ramp card at 06:12. Twelve subscriptions tracked, $8,633.88 a year. One thing needs you today.",
    at: dayOffset(0, 6, 14),
    instant: true,
  },
  {
    id: "msg_002",
    role: "agent",
    body: "Figma auto-renews in 2 days at $576.00 for 4 editor seats. Three of those seats haven't opened a file in over 90 days.",
    at: dayOffset(0, 6, 14),
    instant: true,
    detection: { vendor: "Figma", daysToRenewal: 2, amountCents: 57_600 },
  },
];

/** The scripted opening proposal the agent surfaces on the chat screen. */
export const openingProposalId = "opp_figma_seats";
