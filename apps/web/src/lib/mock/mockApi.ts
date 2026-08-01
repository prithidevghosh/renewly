/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  THE MOCK SEAM                                                           │
 * │                                                                          │
 * │  This module is the ONLY place the UI talks to "a backend". Every        │
 * │  function is async, returns a Promise, and takes realistic time, so      │
 * │  loading / streaming / pending states in the UI are genuine rather       │
 * │  than decorative.                                                        │
 * │                                                                          │
 * │  To swap in the real API, reimplement these functions as `fetch` calls   │
 * │  against `apps/api`. No component needs to change — they only ever       │
 * │  import from here and from `lib/domain/types`.                           │
 * │                                                                          │
 * │  See apps/web/README.md § "Swapping the mock layer for a real API".      │
 * │                                                                          │
 * │  ⚠️  NOTHING HERE IS REAL. No network requests leave the browser, no     │
 * │      LLM is called, no vendor is contacted, no money moves.              │
 * └──────────────────────────────────────────────────────────────────────────┘
 */

import type {
  Action,
  ActionStep,
  Guardrails,
  LedgerEntry,
  Opportunity,
  Source,
  SpendSummary,
  Subscription,
  User,
} from "@/lib/domain/types";
import { annualise } from "@/lib/format";
import {
  contentHash,
  historicActions,
  initialChat,
  ledger as seedLedger,
  opportunities as seedOpportunities,
  sources as seedSources,
  subscriptions as seedSubscriptions,
  user as seedUser,
} from "./mockData";

/* -------------------------------------------------------------------------- */
/* Latency simulation                                                          */
/* -------------------------------------------------------------------------- */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Jittered latency so repeated calls never feel mechanical. */
function latency(base: number, spread = 0.35) {
  return base * (1 - spread / 2 + Math.random() * spread);
}

/* -------------------------------------------------------------------------- */
/* In-memory store                                                             */
/* -------------------------------------------------------------------------- */

interface Db {
  user: User;
  sources: Source[];
  subscriptions: Subscription[];
  opportunities: Opportunity[];
  actions: Action[];
  ledger: LedgerEntry[];
}

const db: Db = {
  user: structuredClone(seedUser),
  sources: structuredClone(seedSources),
  subscriptions: structuredClone(seedSubscriptions),
  opportunities: structuredClone(seedOpportunities),
  actions: structuredClone(historicActions),
  ledger: structuredClone(seedLedger),
};

let seq = db.ledger.length;

function appendLedger(
  input: Omit<LedgerEntry, "id" | "seq" | "hash">,
): LedgerEntry {
  seq += 1;
  const row: LedgerEntry = {
    ...input,
    id: `led_${seq.toString().padStart(3, "0")}`,
    seq,
    hash: contentHash(`${seq}${input.at}${input.vendor}${input.summary}${input.deltaCentsPerYear}`),
  };
  db.ledger.push(row);
  return row;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export async function getUser(): Promise<User> {
  await sleep(latency(180));
  return structuredClone(db.user);
}

export async function getSources(): Promise<Source[]> {
  await sleep(latency(260));
  return structuredClone(db.sources);
}

export async function getSubscriptions(): Promise<Subscription[]> {
  await sleep(latency(420));
  return structuredClone(db.subscriptions);
}

export async function getOpportunities(): Promise<Opportunity[]> {
  await sleep(latency(380));
  return structuredClone(db.opportunities).sort((a, b) => b.priority - a.priority);
}

export async function getOpportunity(id: string): Promise<Opportunity | undefined> {
  await sleep(latency(120));
  const found = db.opportunities.find((o) => o.id === id);
  return found ? structuredClone(found) : undefined;
}

export async function getActions(): Promise<Action[]> {
  await sleep(latency(240));
  return structuredClone(db.actions);
}

export async function getLedger(): Promise<LedgerEntry[]> {
  await sleep(latency(340));
  return structuredClone(db.ledger).sort((a, b) => b.seq - a.seq);
}

export async function getChatHistory() {
  await sleep(latency(200));
  return structuredClone(initialChat);
}

export async function getSummary(): Promise<SpendSummary> {
  await sleep(latency(300));
  return computeSummary();
}

/** Pure, synchronous aggregate — also used to keep the client store in sync. */
export function computeSummary(
  subs: Subscription[] = db.subscriptions,
  opps: Opportunity[] = db.opportunities,
  entries: LedgerEntry[] = db.ledger,
): SpendSummary {
  const live = subs.filter((s) => !s.cancelledAt);
  const annualCents = live.reduce((t, s) => t + annualise(s.amountCents, s.cadence), 0);

  const realisedSavingsCents = entries
    .filter((e) => e.type === "executed")
    .reduce((t, e) => t + e.deltaCentsPerYear, 0);

  const projectedSavingsCents = opps
    .filter((o) => o.status === "open")
    .reduce((t, o) => t + o.savingCentsPerYear, 0);

  const now = Date.now();
  const in30 = now + 30 * 86_400_000;

  return {
    monthlyCents: Math.round(annualCents / 12),
    annualCents,
    realisedSavingsCents,
    projectedSavingsCents,
    subscriptionCount: live.length,
    zombieCount: live.filter((s) => s.status === "zombie").length,
    renewalsNext30: live.filter((s) => {
      const t = new Date(s.nextRenewal).getTime();
      return t >= now - 86_400_000 && t <= in30;
    }).length,
  };
}

/* -------------------------------------------------------------------------- */
/* Guardrails                                                                  */
/* -------------------------------------------------------------------------- */

export interface GuardrailVerdict {
  ok: boolean;
  /** Human-readable reason, shown in the approval sheet. */
  reason: string;
  requiresPasskey: boolean;
}

/**
 * Pure policy check the UI runs *before* showing the passkey sheet.
 * The real backend must re-run this server-side — never trust the client.
 */
export function checkGuardrails(
  opportunity: Opportunity,
  chargeCents: number,
  guardrails: Guardrails = db.user.guardrails,
): GuardrailVerdict {
  if (guardrails.denyVendors.includes(opportunity.vendor)) {
    return {
      ok: false,
      reason: `${opportunity.vendor} is on your deny list. I can't act on it.`,
      requiresPasskey: false,
    };
  }
  if (chargeCents > guardrails.perActionCapCents) {
    return {
      ok: false,
      reason: `This charge exceeds your $${(guardrails.perActionCapCents / 100).toFixed(0)} per-action cap.`,
      requiresPasskey: false,
    };
  }
  if (opportunity.kind === "cancel_zombie" && !guardrails.allowCancellation) {
    return {
      ok: false,
      reason: "Cancellation is disabled in your guardrails.",
      requiresPasskey: false,
    };
  }
  return {
    ok: true,
    reason: chargeCents > 0 ? "Within your caps." : "No charge — cancellation only.",
    requiresPasskey: guardrails.approvalAlways || chargeCents > 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Writes — the Detect → Propose → Approve → Execute → Prove loop              */
/* -------------------------------------------------------------------------- */

/** What the rail will actually charge for this opportunity, in cents. */
export function chargeForOpportunity(o: Opportunity): number {
  // Cancellations move no money. Everything else charges the new, lower price.
  if (o.kind === "cancel_zombie" || o.kind === "consolidate_duplicate") return 0;
  if (o.kind === "switch_to_annual") return o.proposedAnnualCents;
  if (o.kind === "cut_seats" || o.kind === "renegotiate_renewal") {
    const sub = db.subscriptions.find((s) => s.id === o.subscriptionId);
    // Only an imminent renewal actually charges now; mid-cycle seat cuts credit.
    if (sub?.cadence === "annual") return o.proposedAnnualCents;
    return 0;
  }
  return 0;
}

/** Step 2 → 3. Creates the Action in `proposed` state and logs it. */
export async function proposeAction(opportunityId: string): Promise<Action> {
  await sleep(latency(340));
  const opp = db.opportunities.find((o) => o.id === opportunityId);
  if (!opp) throw new Error(`Unknown opportunity: ${opportunityId}`);

  const existing = db.actions.find(
    (a) => a.opportunityId === opportunityId && a.state !== "failed",
  );
  if (existing) return structuredClone(existing);

  const action: Action = {
    id: `act_${opp.subscriptionId.replace("sub_", "")}_${Date.now().toString(36)}`,
    opportunityId: opp.id,
    subscriptionId: opp.subscriptionId,
    vendor: opp.vendor,
    headline: opp.headline,
    state: "proposed",
    savingCentsPerYear: opp.savingCentsPerYear,
    chargedCents: chargeForOpportunity(opp),
    proposedAt: new Date().toISOString(),
    approvedAt: null,
    executedAt: null,
    approval: null,
    railToken: null,
    steps: opp.steps.map<ActionStep>((label) => ({ label, state: "pending" })),
  };

  db.actions.push(action);
  appendLedger({
    at: action.proposedAt,
    type: "proposed",
    vendor: opp.vendor,
    summary: opp.headline,
    deltaCentsPerYear: opp.savingCentsPerYear,
    chargedCents: 0,
    actionId: action.id,
    evidence: `Opportunity ${opp.id} · confidence ${Math.round(opp.confidence * 100)}%`,
  });

  return structuredClone(action);
}

/**
 * Step 3. Simulates a WebAuthn/passkey assertion.
 *
 * Real implementation: `navigator.credentials.get({ publicKey })`.
 * Here it resolves after a believable biometric delay. Every money-moving
 * action goes through this — that is the product's core safety promise.
 */
export async function requestPasskey(): Promise<{ ok: true; device: string }> {
  await sleep(latency(1250, 0.25));
  return { ok: true, device: db.user.passkey.deviceLabel };
}

/** Step 3 → 4. Marks the action approved and logs the human's assent. */
export async function approveAction(actionId: string): Promise<Action> {
  await sleep(latency(220));
  const action = db.actions.find((a) => a.id === actionId);
  if (!action) throw new Error(`Unknown action: ${actionId}`);

  action.state = "approved";
  action.approvedAt = new Date().toISOString();
  action.approval = { method: "passkey", device: db.user.passkey.deviceLabel };

  appendLedger({
    at: action.approvedAt,
    type: "approved",
    vendor: action.vendor,
    summary: `Approved by ${db.user.name} · passkey`,
    deltaCentsPerYear: 0,
    chargedCents: 0,
    actionId: action.id,
    evidence: db.user.passkey.deviceLabel,
  });

  return structuredClone(action);
}

/**
 * Step 4 → 5. Runs the action's steps one at a time, reporting progress.
 *
 * `onStep` fires after every state change so the UI can render a live trace.
 * Mints a scoped, single-use rail credential when money actually moves.
 */
export async function executeAction(
  actionId: string,
  onStep?: (action: Action) => void,
): Promise<Action> {
  const action = db.actions.find((a) => a.id === actionId);
  if (!action) throw new Error(`Unknown action: ${actionId}`);

  action.state = "executing";
  onStep?.(structuredClone(action));

  for (let i = 0; i < action.steps.length; i++) {
    const step = action.steps[i];
    step.state = "running";
    onStep?.(structuredClone(action));

    await sleep(latency(760, 0.5));

    // The step that mints the card gets a believable token.
    if (/card/i.test(step.label) && action.chargedCents > 0) {
      action.railToken = `vc_${Math.random().toString(16).slice(2, 6)}…${Math.random()
        .toString(16)
        .slice(2, 4)}`;
      step.detail = `${action.railToken} · single-use · capped`;
    } else if (/receipt|ledger/i.test(step.label)) {
      step.detail = `entry #${seq + 1}`;
    }

    step.state = "done";
    onStep?.(structuredClone(action));
  }

  action.state = "executed";
  action.executedAt = new Date().toISOString();

  applyOutcome(action);

  appendLedger({
    at: action.executedAt,
    type: "executed",
    vendor: action.vendor,
    summary: action.headline,
    deltaCentsPerYear: action.savingCentsPerYear,
    chargedCents: action.chargedCents,
    actionId: action.id,
    evidence: action.railToken
      ? `Receipt captured · card ${action.railToken}`
      : "Confirmation captured · no charge",
  });

  onStep?.(structuredClone(action));
  return structuredClone(action);
}

/** Mutates the inventory so the dashboard reflects what the agent just did. */
function applyOutcome(action: Action) {
  const opp = db.opportunities.find((o) => o.id === action.opportunityId);
  const sub = db.subscriptions.find((s) => s.id === action.subscriptionId);
  if (opp) opp.status = "done";
  if (!sub) return;

  switch (opp?.kind) {
    case "cancel_zombie":
    case "consolidate_duplicate":
      sub.cancelledAt = action.executedAt;
      break;
    case "cut_seats":
    case "downgrade_tier":
    case "switch_to_annual": {
      const perYear = opp.proposedAnnualCents;
      sub.amountCents = sub.cadence === "monthly" ? Math.round(perYear / 12) : perYear;
      sub.status = "active";
      if (opp.kind === "cut_seats" && sub.activeSeats != null) sub.seats = sub.activeSeats;
      if (opp.kind === "switch_to_annual") {
        sub.cadence = "annual";
        sub.amountCents = perYear;
        sub.plan = sub.plan.replace("Plus", "Plus · annual");
      }
      break;
    }
    default:
      break;
  }
}

/** Marks an opportunity dismissed without acting. */
export async function dismissOpportunity(opportunityId: string): Promise<Opportunity> {
  await sleep(latency(220));
  const opp = db.opportunities.find((o) => o.id === opportunityId);
  if (!opp) throw new Error(`Unknown opportunity: ${opportunityId}`);
  opp.status = "dismissed";
  appendLedger({
    at: new Date().toISOString(),
    type: "detected",
    vendor: opp.vendor,
    summary: `Declined: ${opp.headline}`,
    deltaCentsPerYear: 0,
    chargedCents: 0,
    actionId: null,
    evidence: "Dismissed by user",
  });
  return structuredClone(opp);
}

/* -------------------------------------------------------------------------- */
/* Onboarding                                                                  */
/* -------------------------------------------------------------------------- */

/** Simulated OAuth / alias verification. Always succeeds, believably slowly. */
export async function connectSource(
  sourceId: string,
  onStatus?: (status: Source["status"]) => void,
): Promise<Source> {
  const source = db.sources.find((s) => s.id === sourceId);
  if (!source) throw new Error(`Unknown source: ${sourceId}`);

  source.status = "connecting";
  onStatus?.("connecting");
  await sleep(latency(1100, 0.3));

  source.status = "syncing";
  onStatus?.("syncing");
  await sleep(latency(1600, 0.3));

  source.status = "connected";
  source.connectedAt = new Date().toISOString();
  source.lastSyncAt = source.connectedAt;
  onStatus?.("connected");

  return structuredClone(source);
}

export async function disconnectSource(sourceId: string): Promise<Source> {
  await sleep(latency(420));
  const source = db.sources.find((s) => s.id === sourceId);
  if (!source) throw new Error(`Unknown source: ${sourceId}`);
  source.status = "disconnected";
  source.connectedAt = null;
  source.lastSyncAt = null;
  return structuredClone(source);
}

/** Simulated passkey enrolment (`navigator.credentials.create` in the real thing). */
export async function registerPasskey(): Promise<User["passkey"]> {
  await sleep(latency(1500, 0.2));
  db.user.passkey = {
    enrolled: true,
    deviceLabel: db.user.passkey.deviceLabel,
    modality: db.user.passkey.modality,
    enrolledAt: new Date().toISOString(),
  };
  return structuredClone(db.user.passkey);
}

/**
 * The "first inventory" scan. Streams discoveries so onboarding can reveal
 * subscriptions one at a time instead of dumping a table.
 */
export async function runFirstScan(
  onFind?: (sub: Subscription, index: number, total: number) => void,
): Promise<Subscription[]> {
  const found = db.subscriptions;
  await sleep(latency(900));
  for (let i = 0; i < found.length; i++) {
    await sleep(latency(230, 0.6));
    onFind?.(structuredClone(found[i]), i, found.length);
  }
  return structuredClone(found);
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

export async function updateGuardrails(patch: Partial<Guardrails>): Promise<Guardrails> {
  await sleep(latency(320));
  db.user.guardrails = { ...db.user.guardrails, ...patch };
  return structuredClone(db.user.guardrails);
}

/** Revokes every agent capability. The nuclear "I'm in control" button. */
export async function revokeAgentAccess(): Promise<void> {
  await sleep(latency(700));
  db.sources.forEach((s) => {
    s.status = "disconnected";
    s.connectedAt = null;
    s.lastSyncAt = null;
  });
  db.user.passkey.enrolled = false;
  appendLedger({
    at: new Date().toISOString(),
    type: "detected",
    vendor: "Renewly",
    summary: "Agent access revoked by user — all sources disconnected",
    deltaCentsPerYear: 0,
    chargedCents: 0,
    actionId: null,
    evidence: "Manual revocation",
  });
}

/** Test-only: restore the seeded world. Used by the landing-page loop demo. */
export function __resetDb() {
  db.user = structuredClone(seedUser);
  db.sources = structuredClone(seedSources);
  db.subscriptions = structuredClone(seedSubscriptions);
  db.opportunities = structuredClone(seedOpportunities);
  db.actions = structuredClone(historicActions);
  db.ledger = structuredClone(seedLedger);
  seq = db.ledger.length;
}
