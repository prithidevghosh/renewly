/**
 * Renewly domain model.
 *
 * These types are the contract between the UI and the (not-yet-existing) API.
 * They intentionally mirror the PRD entities 1:1 so that swapping
 * `lib/mock/mockApi.ts` for real `fetch` calls requires no component changes.
 *
 * All money is stored in **integer cents** and only formatted at the edge
 * (`lib/format.ts`). Never store money as a float.
 * All timestamps are ISO-8601 strings.
 */

export type ISODate = string;
export type Cents = number;

/* -------------------------------------------------------------------------- */
/* User                                                                        */
/* -------------------------------------------------------------------------- */

export interface User {
  id: string;
  name: string;
  email: string;
  company: string;
  /** Simulated passkey enrolment — drives the biometric approval affordance. */
  passkey: {
    enrolled: boolean;
    deviceLabel: string;
    /** "face" renders Face ID language, "touch" renders Touch ID. */
    modality: "face" | "touch";
    enrolledAt: ISODate | null;
  };
  guardrails: Guardrails;
}

/** User-set limits the agent must respect before it may move money. */
export interface Guardrails {
  /** Hard ceiling for a single action, in cents. */
  perActionCapCents: Cents;
  /** Rolling 30-day ceiling across all actions, in cents. */
  monthlyCapCents: Cents;
  /** If true, every action needs a passkey — even below the cap. */
  approvalAlways: boolean;
  /** Vendors the agent may act on without further prompting. */
  allowVendors: string[];
  /** Vendors the agent must never touch. */
  denyVendors: string[];
  /** Agent may cancel subscriptions, not just downgrade/renew. */
  allowCancellation: boolean;
}

/* -------------------------------------------------------------------------- */
/* Sources — where inventory is discovered                                     */
/* -------------------------------------------------------------------------- */

export type SourceKind = "email_alias" | "gmail" | "card" | "statement";
export type SourceStatus = "disconnected" | "connecting" | "syncing" | "connected" | "error";

export interface Source {
  id: string;
  kind: SourceKind;
  label: string;
  /** e.g. the forwarding address, the masked card, the connected mailbox. */
  detail: string;
  status: SourceStatus;
  connectedAt: ISODate | null;
  lastSyncAt: ISODate | null;
  /** How many subscriptions this source is currently the evidence for. */
  discoveredCount: number;
}

/* -------------------------------------------------------------------------- */
/* Subscriptions — the inventory                                               */
/* -------------------------------------------------------------------------- */

export type Cadence = "monthly" | "annual" | "quarterly";

/**
 * `active`    — used, priced correctly, leave it alone
 * `underused` — paying for more seats/tier than the team touches
 * `zombie`    — no measurable usage; a candidate for cancellation
 * `duplicate` — overlaps functionally with another tracked tool
 */
export type SubscriptionStatus = "active" | "underused" | "zombie" | "duplicate";

export interface Subscription {
  id: string;
  vendor: string;
  /** Two-letter mark used by the vendor glyph. */
  initials: string;
  plan: string;
  category: string;
  amountCents: Cents;
  cadence: Cadence;
  nextRenewal: ISODate;
  seats: number | null;
  activeSeats: number | null;
  status: SubscriptionStatus;
  /** 0–1. How sure the agent is that this row is real and correctly parsed. */
  confidence: number;
  sourceId: string;
  /** Human-readable provenance, shown on hover/expand. Builds trust. */
  evidence: string;
  /** 12 months of spend in cents, oldest first — drives the row sparkline. */
  trail: Cents[];
  cancelledAt?: ISODate | null;
}

/* -------------------------------------------------------------------------- */
/* Opportunities — what the agent proposes to do                               */
/* -------------------------------------------------------------------------- */

export type OpportunityKind =
  | "switch_to_annual"
  | "cut_seats"
  | "cancel_zombie"
  | "consolidate_duplicate"
  | "downgrade_tier"
  | "renegotiate_renewal";

export type OpportunityStatus = "open" | "in_flight" | "done" | "dismissed";

export interface Opportunity {
  id: string;
  kind: OpportunityKind;
  subscriptionId: string;
  vendor: string;
  /** One-line imperative: "Switch Figma to annual billing". */
  headline: string;
  /** The agent's reasoning, in its own voice. Shown in the proposal card. */
  rationale: string;
  /** Annualised saving if executed, in cents. The number that matters. */
  savingCentsPerYear: Cents;
  /** What the line item costs today, per year. */
  currentAnnualCents: Cents;
  /** What it would cost after the action, per year. */
  proposedAnnualCents: Cents;
  /** 0–1 — how confident the agent is that this executes cleanly. */
  confidence: number;
  /** Higher runs first in the ranked list. */
  priority: number;
  /** True when a renewal deadline makes this time-critical. */
  urgent: boolean;
  deadline: ISODate | null;
  status: OpportunityStatus;
  /** Ordered steps the agent will run during execution. */
  steps: string[];
}

/* -------------------------------------------------------------------------- */
/* Actions — a money-moving unit of work                                       */
/* -------------------------------------------------------------------------- */

/**
 * The lifecycle the entire product dramatises:
 *   proposed → approved → executing → executed
 *                                  ↘ failed
 */
export type ActionState = "proposed" | "approved" | "executing" | "executed" | "failed";

export interface ActionStep {
  label: string;
  state: "pending" | "running" | "done" | "failed";
  /** Machine detail shown in the execution trace, e.g. a card token. */
  detail?: string;
}

export interface Action {
  id: string;
  opportunityId: string;
  subscriptionId: string;
  vendor: string;
  headline: string;
  state: ActionState;
  /** Annualised impact of this action, in cents. */
  savingCentsPerYear: Cents;
  /** Amount actually charged through the rail, in cents. 0 for cancellations. */
  chargedCents: Cents;
  proposedAt: ISODate;
  approvedAt: ISODate | null;
  executedAt: ISODate | null;
  /** How the human approved. Every money-moving action requires a passkey. */
  approval: {
    method: "passkey" | "none";
    device: string | null;
  } | null;
  steps: ActionStep[];
  /** Scoped single-use credential minted for this action only. */
  railToken: string | null;
  failureReason?: string;
}

/* -------------------------------------------------------------------------- */
/* Ledger — the proof                                                          */
/* -------------------------------------------------------------------------- */

export type LedgerEventType =
  | "detected"
  | "proposed"
  | "approved"
  | "executed"
  | "failed"
  | "saved";

export interface LedgerEntry {
  id: string;
  /** Monotonic sequence number. The ledger is append-only. */
  seq: number;
  at: ISODate;
  type: LedgerEventType;
  vendor: string;
  summary: string;
  /** Positive = money saved. Negative = money spent. Zero = informational. */
  deltaCentsPerYear: Cents;
  /** Cash actually moved through the rail for this entry, in cents. */
  chargedCents: Cents;
  actionId: string | null;
  /** Verifiable provenance — the receipt. */
  evidence: string;
  /** Content hash, so the row reads as tamper-evident. */
  hash: string;
}

/* -------------------------------------------------------------------------- */
/* Chat                                                                        */
/* -------------------------------------------------------------------------- */

export type ChatRole = "agent" | "user" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  /** Plain text body. Agent messages stream a character at a time. */
  body: string;
  at: ISODate;
  /** Attaches a rich proposal card beneath the message. */
  opportunityId?: string;
  /** Attaches a live execution trace beneath the message. */
  actionId?: string;
  /** Renders the "detected" scan result strip. */
  detection?: {
    vendor: string;
    daysToRenewal: number;
    amountCents: Cents;
  };
  /** Skips the streaming reveal (used for replayed history). */
  instant?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Aggregates                                                                  */
/* -------------------------------------------------------------------------- */

export interface SpendSummary {
  monthlyCents: Cents;
  annualCents: Cents;
  /** Realised, executed savings this year. */
  realisedSavingsCents: Cents;
  /** Open opportunities not yet executed. */
  projectedSavingsCents: Cents;
  subscriptionCount: number;
  zombieCount: number;
  renewalsNext30: number;
}
