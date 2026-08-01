import { z } from "zod";
import {
  annualize,
  cmp,
  deannualize,
  fromMinor,
  mul,
  normalizeAmount,
  percentOf,
  sub,
  sum,
  toMinor,
  type BillingCycle,
} from "../../lib/money.js";
import {
  catalogAnnualCost,
  cheaperAlternatives,
  findCatalogTool,
  type CatalogTool,
} from "./catalog.js";

/**
 * The six things the agent can propose. `snooze` is a real answer, not a
 * fallback: recommending action on a renewal that is months away and behaving
 * itself is how an agent trains its user to ignore it.
 */
export type Recommendation =
  | "renew"
  | "rightsize_seats"
  | "switch_term"
  | "switch_vendor"
  | "cancel"
  | "snooze";

/** Actions that move money and therefore need a Prava session. */
export const PAYING_ACTIONS: readonly Recommendation[] = [
  "renew",
  "switch_term",
  "switch_vendor",
] as const;

/** Actions completed by the user in the merchant's own UI, then attested. */
export const ATTESTED_ACTIONS: readonly Recommendation[] = [
  "cancel",
  "rightsize_seats",
] as const;

export const isPayingAction = (action: Recommendation): boolean =>
  PAYING_ACTIONS.includes(action);

export const isAttestedAction = (action: Recommendation): boolean =>
  ATTESTED_ACTIONS.includes(action);

export const decisionPackageSchema = z.object({
  recommendation: z.enum([
    "renew",
    "rightsize_seats",
    "switch_term",
    "switch_vendor",
    "cancel",
    "snooze",
  ]),
  confidence: z.number().min(0).max(1),
  headline: z.string().min(1),
  narrative: z.string().min(1),
  diagnosis: z.string().min(1),
  counterfactuals: z.object({
    do_nothing: z.object({ annual_cost: z.string(), summary: z.string() }),
    recommended: z.object({
      annual_cost: z.string(),
      savings_vs_do_nothing: z.string(),
      summary: z.string(),
    }),
  }),
  alternatives: z.array(
    z.object({
      name: z.string(),
      annual_cost: z.string(),
      pros: z.array(z.string()),
      cons: z.array(z.string()),
      switch_friction: z.enum(["low", "medium", "high"]),
    }),
  ),
  inputs_used: z.array(z.string()),
  policy_flags: z.array(z.string()),
  policy_version: z.number().int(),
  amount_due: z.string(),
  currency: z.string(),
  /** Set when the action is rightsize_seats. */
  seats_target: z.number().int().positive().nullable(),
  /** Set when the action is switch_term. */
  term_target: z.enum(["monthly", "yearly", "weekly", "unknown"]).nullable(),
  /** Set when the action is switch_vendor. */
  vendor_target: z.string().nullable(),
  narrative_source: z.enum(["llm", "deterministic"]),
});

export type DecisionPackage = z.infer<typeof decisionPackageSchema>;

export interface EngineSubscription {
  id: string;
  merchantName: string;
  planName: string | null;
  amount: string;
  currency: string;
  billingCycle: BillingCycle;
  criticality: "must_keep" | "nice_to_have" | "experimental";
  jobCategory: string | null;
  usageNote: string | null;
  seatsTotal: number;
  seatsActive: number | null;
  nextRenewalAt: Date | null;
  status: "active" | "pending_cancel" | "cancelled" | "paused";
}

export interface EnginePolicy {
  killSwitch: boolean;
  approvalMode: "always_ask" | "ask_above_ceiling" | "auto_within_envelope";
  spendCeiling: string | null;
  aiMonthlyBudget: string | null;
  categoryCeilings: Record<string, string>;
  currency: string;
  policyVersion: number;
}

export interface EngineInput {
  subscription: EngineSubscription;
  policy: EnginePolicy;
  /** Other active subscriptions, used for budget and duplicate reasoning. */
  peers: Array<
    Pick<EngineSubscription, "id" | "amount" | "billingCycle" | "jobCategory" | "merchantName">
  >;
  now?: Date;
}

export interface EngineOutcome {
  recommendation: Recommendation;
  confidence: number;
  diagnosis: string;
  reasons: string[];
  inputsUsed: string[];
  policyFlags: string[];
  doNothingAnnual: string;
  recommendedAnnual: string;
  savingsAnnual: string;
  /** The amount a pay action would move, in the subscription's own cycle. */
  amountDue: string;
  seatsTarget: number | null;
  termTarget: BillingCycle | null;
  vendorTarget: string | null;
  catalogTool: CatalogTool | null;
  candidates: CatalogTool[];
  switchTarget: CatalogTool | null;
}

const UNUSED_RE =
  /\b(unused|not used|never used|no usage|haven'?t used|hasn'?t been used|idle|dormant|zero usage|nobody uses|no one uses)\b/i;
const DAYS_UNUSED_RE =
  /\b(?:unused|idle|no usage|not (?:been )?used|dormant)\b[^.\n]{0,40}?(\d{1,4})\s*(day|week|month)s?/i;
const DAYS_UNUSED_RE_ALT =
  /(\d{1,4})\s*(day|week|month)s?[^.\n]{0,30}?\b(?:unused|idle|no usage|without (?:any )?use|since (?:anyone |we )?(?:last )?(?:used|logged))/i;

/** Days of inactivity implied by the free-text usage note, if any. */
export function inferUnusedDays(usageNote: string | null): number | null {
  if (!usageNote) return null;

  for (const re of [DAYS_UNUSED_RE, DAYS_UNUSED_RE_ALT]) {
    const match = usageNote.match(re);
    if (match?.[1] && match[2]) {
      const value = Number(match[1]);
      const unit = match[2].toLowerCase();
      const multiplier = unit === "day" ? 1 : unit === "week" ? 7 : 30;
      return value * multiplier;
    }
  }

  // A bare "unused" with no duration still means unused; treat it as at the
  // threshold rather than guessing a larger number.
  if (UNUSED_RE.test(usageNote)) return 30;
  return null;
}

/** "only 2 of 5 seats are used" -> 2. Complements the structured seatsActive. */
const SEATS_USED_RE =
  /\b(?:only\s+)?(\d{1,4})\s*(?:of|out of|\/)\s*(\d{1,4})\s*(?:seats?|licen[sc]es?|users?)\b/i;

export function inferActiveSeats(usageNote: string | null): number | null {
  if (!usageNote) return null;
  const match = usageNote.match(SEATS_USED_RE);
  if (match?.[1]) {
    const used = Number(match[1]);
    return Number.isFinite(used) && used > 0 ? used : null;
  }
  return null;
}

const UNUSED_THRESHOLD_DAYS = 30;
/** A renewal further out than this with nothing wrong is worth deferring. */
const SNOOZE_HORIZON_DAYS = 60;

/**
 * Deterministic core of the decision agent. Rules are evaluated in a fixed
 * order and every one that fires is recorded in `reasons`, so the narrative the
 * LLM writes can never claim a rationale the engine did not actually use.
 */
export function decide(input: EngineInput): EngineOutcome {
  const { subscription: sub_, policy } = input;
  const now = input.now ?? new Date();
  const currency = sub_.currency;
  const seatsTotal = Math.max(1, sub_.seatsTotal);

  const amount = normalizeAmount(sub_.amount, currency);
  const doNothingAnnual = annualize(amount, sub_.billingCycle, currency);

  const catalogTool = findCatalogTool(sub_.merchantName);
  const candidates = cheaperAlternatives(catalogTool, doNothingAnnual, seatsTotal);

  const reasons: string[] = [];
  const policyFlags: string[] = [];
  const inputsUsed: string[] = [
    `subscription.amount=${amount} ${currency}`,
    `subscription.billing_cycle=${sub_.billingCycle}`,
    `subscription.criticality=${sub_.criticality}`,
    `subscription.seats_total=${seatsTotal}`,
    `policy.approval_mode=${policy.approvalMode}`,
    `policy.version=${policy.policyVersion}`,
  ];

  if (policy.spendCeiling) {
    inputsUsed.push(`policy.spend_ceiling=${normalizeAmount(policy.spendCeiling, currency)}`);
  }
  if (sub_.usageNote) inputsUsed.push(`subscription.usage_note="${truncate(sub_.usageNote, 120)}"`);
  if (sub_.jobCategory) inputsUsed.push(`subscription.job_category=${sub_.jobCategory}`);
  if (catalogTool) inputsUsed.push(`catalog.match=${catalogTool.slug}`);

  /* Rule 1 — kill switch. Decisions still generate; only paying is blocked. */
  if (policy.killSwitch) {
    policyFlags.push("KILL_SWITCH_ENABLED");
    reasons.push("Agent spend is disabled by the workspace kill switch, so no payment can run.");
    inputsUsed.push("policy.kill_switch=true");
  }

  /* Budget context — monthly AI budget and per-category ceiling. */
  const monthlySpend = monthlyRunRate(
    [
      { amount, billingCycle: sub_.billingCycle },
      ...input.peers.map((p) => ({ amount: p.amount, billingCycle: p.billingCycle })),
    ],
    currency,
  );

  let budgetExceeded = false;
  if (policy.aiMonthlyBudget) {
    const budget = normalizeAmount(policy.aiMonthlyBudget, currency);
    inputsUsed.push(`policy.ai_monthly_budget=${budget}`);
    if (cmp(monthlySpend, budget, currency) > 0) {
      budgetExceeded = true;
      policyFlags.push("BUDGET_EXCEEDED");
      reasons.push(
        `Workspace monthly run rate ${monthlySpend} ${currency} exceeds the ${budget} ${currency} budget.`,
      );
    }
  }

  let categoryBudgetExceeded = false;
  const categoryCeiling = sub_.jobCategory ? policy.categoryCeilings[sub_.jobCategory] : undefined;
  if (categoryCeiling && sub_.jobCategory) {
    const categorySpend = monthlyRunRate(
      [
        { amount, billingCycle: sub_.billingCycle },
        ...input.peers
          .filter((p) => p.jobCategory === sub_.jobCategory)
          .map((p) => ({ amount: p.amount, billingCycle: p.billingCycle })),
      ],
      currency,
    );
    inputsUsed.push(`policy.category_ceiling.${sub_.jobCategory}=${categoryCeiling}`);
    if (cmp(categorySpend, categoryCeiling, currency) > 0) {
      categoryBudgetExceeded = true;
      policyFlags.push("CATEGORY_CEILING_EXCEEDED");
      reasons.push(
        `Category "${sub_.jobCategory}" run rate ${categorySpend} ${currency} exceeds its ${normalizeAmount(categoryCeiling, currency)} ${currency} ceiling.`,
      );
    }
  }

  const unusedDays = inferUnusedDays(sub_.usageNote);
  const staleUsage = unusedDays !== null && unusedDays >= UNUSED_THRESHOLD_DAYS;
  if (staleUsage) {
    reasons.push(`Usage note indicates roughly ${unusedDays} days without use.`);
    inputsUsed.push(`derived.unused_days=${unusedDays}`);
  }

  // Structured seat data wins over the free-text note when both are present.
  const activeSeats = sub_.seatsActive ?? inferActiveSeats(sub_.usageNote);
  const idleSeats = activeSeats !== null ? seatsTotal - activeSeats : 0;
  const hasIdleSeats = activeSeats !== null && idleSeats > 0 && activeSeats >= 1;
  if (activeSeats !== null) {
    inputsUsed.push(`subscription.seats_active=${activeSeats}`);
  }

  const aboveCeiling = policy.spendCeiling
    ? cmp(amount, policy.spendCeiling, currency) > 0
    : false;
  if (aboveCeiling) {
    policyFlags.push("ABOVE_SPEND_CEILING");
    inputsUsed.push("derived.above_spend_ceiling=true");
  }

  const daysToRenewal =
    sub_.nextRenewalAt !== null
      ? Math.round((sub_.nextRenewalAt.getTime() - now.getTime()) / 86_400_000)
      : null;
  if (daysToRenewal !== null) inputsUsed.push(`derived.days_to_renewal=${daysToRenewal}`);

  const cheapest = candidates[0] ?? null;
  const annualBillingSaving =
    catalogTool?.annualMonthlyPrice && sub_.billingCycle === "monthly"
      ? sub(doNothingAnnual, catalogAnnualCost(catalogTool, seatsTotal, true), currency)
      : "0.00";
  const hasTermDiscount = cmp(annualBillingSaving, "0.00", currency) > 0;
  if (hasTermDiscount && catalogTool) {
    inputsUsed.push(`catalog.term_switch_saving=${annualBillingSaving}`);
  }

  /* Rule ordering: cancel beats rightsize beats switch beats term beats renew. */
  let recommendation: Recommendation;
  let recommendedAnnual: string;
  let switchTarget: CatalogTool | null = null;
  let seatsTarget: number | null = null;
  let termTarget: BillingCycle | null = null;
  let confidence: number;

  if (staleUsage) {
    /* Rule 5 — unused for 30+ days leans cancel, regardless of criticality. */
    recommendation = "cancel";
    recommendedAnnual = "0.00";
    confidence = sub_.criticality === "experimental" ? 0.88 : 0.76;
    reasons.push(
      `Unused for ${unusedDays} days at ${doNothingAnnual} ${currency} a year, so cancel is the default.`,
    );
  } else if (hasIdleSeats) {
    /* Rule 6 — paying for seats nobody occupies is the cleanest win available. */
    recommendation = "rightsize_seats";
    seatsTarget = activeSeats;
    recommendedAnnual = perSeatAnnual(doNothingAnnual, seatsTotal, activeSeats!, currency);
    confidence = sub_.seatsActive !== null ? 0.86 : 0.72;
    reasons.push(
      `${idleSeats} of ${seatsTotal} seats are unused; dropping to ${activeSeats} keeps everyone working.`,
    );
  } else if (sub_.criticality === "must_keep") {
    /* Rule 2 — must_keep: never cancel, but a cheaper term is still fair game. */
    if (cheapest && (budgetExceeded || categoryBudgetExceeded)) {
      recommendation = "switch_vendor";
      switchTarget = cheapest;
      recommendedAnnual = catalogAnnualCost(cheapest, seatsTotal);
      confidence = 0.62;
      reasons.push(
        `Marked must_keep, but budget pressure and a cheaper equivalent (${cheapest.name}) make switching worth reviewing.`,
      );
    } else if (hasTermDiscount && catalogTool) {
      recommendation = "switch_term";
      termTarget = "yearly";
      recommendedAnnual = catalogAnnualCost(catalogTool, seatsTotal, true);
      confidence = 0.8;
      reasons.push(
        `Marked must_keep. Moving to annual billing saves ${annualBillingSaving} ${currency} a year at the same tier.`,
      );
    } else {
      recommendation = "renew";
      recommendedAnnual = doNothingAnnual;
      confidence = 0.85;
      reasons.push("Marked must_keep with no cheaper equivalent in the catalog, so renew.");
    }
  } else if (sub_.criticality === "experimental" && aboveCeiling) {
    /* Rule 3 — an experimental tool above the spend ceiling. */
    if (cheapest) {
      recommendation = "switch_vendor";
      switchTarget = cheapest;
      recommendedAnnual = catalogAnnualCost(cheapest, seatsTotal);
      confidence = 0.72;
      reasons.push(
        `Experimental spend of ${amount} ${currency} is above the ${normalizeAmount(policy.spendCeiling!, currency)} ${currency} ceiling; ${cheapest.name} covers the same job for less.`,
      );
    } else {
      recommendation = "cancel";
      recommendedAnnual = "0.00";
      confidence = 0.7;
      reasons.push(
        `Experimental spend of ${amount} ${currency} is above the ${normalizeAmount(policy.spendCeiling!, currency)} ${currency} ceiling with no cheaper equivalent, so cancel until it proves itself.`,
      );
    }
  } else if (budgetExceeded || categoryBudgetExceeded) {
    /* Rule 4 — budget pressure prefers a switch, then cancel, then a lower tier. */
    if (cheapest) {
      recommendation = "switch_vendor";
      switchTarget = cheapest;
      recommendedAnnual = catalogAnnualCost(cheapest, seatsTotal);
      confidence = 0.74;
      reasons.push(
        `Switching to ${cheapest.name} brings the category back under budget at ${recommendedAnnual} ${currency} a year.`,
      );
    } else if (sub_.criticality === "nice_to_have") {
      recommendation = "cancel";
      recommendedAnnual = "0.00";
      confidence = 0.66;
      reasons.push("Over budget with no cheaper equivalent and the tool is only nice to have.");
    } else {
      recommendation = "rightsize_seats";
      seatsTarget = Math.max(1, seatsTotal - 1);
      recommendedAnnual = percentOf(doNothingAnnual, 60, currency);
      confidence = 0.55;
      reasons.push(
        "Over budget with no cheaper equivalent; trimming the plan is the least disruptive lever.",
      );
    }
  } else if (hasTermDiscount && catalogTool) {
    recommendation = "switch_term";
    termTarget = "yearly";
    recommendedAnnual = catalogAnnualCost(catalogTool, seatsTotal, true);
    confidence = 0.78;
    reasons.push(
      `Move to annual billing: ${annualBillingSaving} ${currency} a year cheaper at the same tier.`,
    );
  } else if (daysToRenewal !== null && daysToRenewal > SNOOZE_HORIZON_DAYS) {
    /* Nothing is wrong and the renewal is far off. Say so and go quiet. */
    recommendation = "snooze";
    recommendedAnnual = doNothingAnnual;
    confidence = 0.8;
    reasons.push(
      `Nothing to act on and the renewal is ${daysToRenewal} days away, so revisit closer to the date.`,
    );
  } else {
    recommendation = "renew";
    recommendedAnnual = doNothingAnnual;
    confidence = 0.7;
    reasons.push("In use, within budget and no cheaper equivalent, so renew as is.");
  }

  // Never report a negative saving; if the "recommended" path costs more, the
  // recommendation is simply to keep paying what you pay now.
  if (cmp(recommendedAnnual, doNothingAnnual, currency) > 0) {
    recommendedAnnual = doNothingAnnual;
  }
  const savingsAnnual = sub(doNothingAnnual, recommendedAnnual, currency);

  return {
    recommendation,
    confidence: Number(confidence.toFixed(2)),
    diagnosis: buildDiagnosis(recommendation, sub_, {
      unusedDays,
      idleSeats,
      seatsTotal,
      annualBillingSaving,
      daysToRenewal,
      doNothingAnnual,
    }),
    reasons,
    inputsUsed,
    policyFlags,
    doNothingAnnual,
    recommendedAnnual,
    savingsAnnual,
    amountDue: amountDueFor(recommendation, amount, recommendedAnnual, sub_.billingCycle, currency),
    seatsTarget,
    termTarget,
    vendorTarget: switchTarget?.name ?? null,
    catalogTool,
    candidates: candidates.slice(0, 3),
    switchTarget,
  };
}

/** Cost of the same plan at a reduced seat count. */
function perSeatAnnual(
  currentAnnual: string,
  seatsTotal: number,
  seatsTarget: number,
  currency: string,
): string {
  const perSeat = divideBySeats(currentAnnual, seatsTotal, currency);
  return mul(perSeat, seatsTarget, currency);
}

/** Per-seat share of an annual cost, rounded half-up. */
function divideBySeats(annual: string, seats: number, currency: string): string {
  if (seats <= 1) return normalizeAmount(annual, currency);
  const divisor = BigInt(seats);
  const minor = toMinor(annual, currency);
  const quotient = minor / divisor;
  const remainder = minor % divisor;
  return fromMinor(remainder * 2n >= divisor ? quotient + 1n : quotient, currency);
}

/** One line the user reads before the recommendation. Facts, not adjectives. */
function buildDiagnosis(
  recommendation: Recommendation,
  sub_: EngineSubscription,
  facts: {
    unusedDays: number | null;
    idleSeats: number;
    seatsTotal: number;
    annualBillingSaving: string;
    daysToRenewal: number | null;
    doNothingAnnual: string;
  },
): string {
  const currency = sub_.currency;
  switch (recommendation) {
    case "cancel":
      return `No recorded use for about ${facts.unusedDays} days at ${facts.doNothingAnnual} ${currency} a year.`;
    case "rightsize_seats":
      return facts.idleSeats > 0
        ? `${facts.idleSeats} of ${facts.seatsTotal} seats are sitting idle.`
        : `The plan is larger than the team is using.`;
    case "switch_term":
      return `Billed monthly; the annual term is ${facts.annualBillingSaving} ${currency} a year cheaper for the same tier.`;
    case "switch_vendor":
      return `A cheaper tool covers the same job at this seat count.`;
    case "snooze":
      return `In use and priced correctly, and the renewal is ${facts.daysToRenewal} days out.`;
    case "renew":
      return `In use, within budget, and nothing cheaper covers the same job.`;
  }
}

/** What a pay action would actually move for this recommendation. */
function amountDueFor(
  recommendation: Recommendation,
  amount: string,
  recommendedAnnual: string,
  cycle: BillingCycle,
  currency: string,
): string {
  // Attested actions and snooze move no money; the pay routes refuse them.
  if (!isPayingAction(recommendation)) return "0.00";
  if (recommendation === "renew") return amount;
  if (recommendation === "switch_term") return recommendedAnnual;
  return deannualize(recommendedAnnual, cycle, currency);
}

/** Monthly-equivalent run rate across a set of per-cycle amounts. */
export function monthlyRunRate(
  items: Array<{ amount: string; billingCycle: BillingCycle }>,
  currency: string,
): string {
  const annualTotal = sum(
    items.map((item) => annualize(item.amount, item.billingCycle, currency)),
    currency,
  );
  return deannualize(annualTotal, "monthly", currency);
}

/** Deterministic narrative, used when the LLM is unavailable or fails. */
export function deterministicNarrative(
  outcome: EngineOutcome,
  subscription: EngineSubscription,
): { headline: string; narrative: string } {
  const currency = subscription.currency;
  const verb: Record<Recommendation, string> = {
    renew: "Renew",
    rightsize_seats: "Rightsize",
    switch_term: "Switch to annual billing for",
    switch_vendor: "Switch",
    cancel: "Cancel",
    snooze: "Leave",
  };

  const target = outcome.switchTarget ? ` to ${outcome.switchTarget.name}` : "";
  const headline =
    outcome.savingsAnnual === "0.00"
      ? `${verb[outcome.recommendation]} ${subscription.merchantName} at ${outcome.doNothingAnnual} ${currency} a year`
      : `${verb[outcome.recommendation]} ${subscription.merchantName}${target} and save ${outcome.savingsAnnual} ${currency} a year`;

  const lines = [
    `${verb[outcome.recommendation]} ${subscription.merchantName}${target}.`,
    `Doing nothing costs ${outcome.doNothingAnnual} ${currency} a year; the recommended path costs ${outcome.recommendedAnnual} ${currency}, a difference of ${outcome.savingsAnnual} ${currency}.`,
    ...outcome.reasons,
  ];

  return { headline: truncate(headline, 160), narrative: lines.join(" ") };
}

export function buildCounterfactuals(
  outcome: EngineOutcome,
  subscription: EngineSubscription,
): DecisionPackage["counterfactuals"] {
  const currency = subscription.currency;
  return {
    do_nothing: {
      annual_cost: outcome.doNothingAnnual,
      summary: `Keep ${subscription.merchantName} exactly as it is: ${outcome.doNothingAnnual} ${currency} a year at ${normalizeAmount(subscription.amount, currency)} ${currency} per ${cycleWord(subscription.billingCycle)}.`,
    },
    recommended: {
      annual_cost: outcome.recommendedAnnual,
      savings_vs_do_nothing: outcome.savingsAnnual,
      summary: recommendedSummary(outcome, subscription),
    },
  };
}

function recommendedSummary(outcome: EngineOutcome, subscription: EngineSubscription): string {
  const currency = subscription.currency;
  switch (outcome.recommendation) {
    case "cancel":
      return `Cancel ${subscription.merchantName} and stop the ${outcome.doNothingAnnual} ${currency} annual spend entirely.`;
    case "rightsize_seats":
      return `Drop from ${subscription.seatsTotal} seats to ${outcome.seatsTarget}, an estimated ${outcome.recommendedAnnual} ${currency} a year, saving ${outcome.savingsAnnual} ${currency}.`;
    case "switch_term":
      return `Move to annual billing at ${outcome.recommendedAnnual} ${currency} a year, saving ${outcome.savingsAnnual} ${currency} for the same tier.`;
    case "switch_vendor":
      return `Move to ${outcome.switchTarget?.name ?? "a cheaper equivalent"} at ${outcome.recommendedAnnual} ${currency} a year, saving ${outcome.savingsAnnual} ${currency}.`;
    case "snooze":
      return `Leave it alone for now at ${outcome.doNothingAnnual} ${currency} a year and revisit nearer the renewal.`;
    case "renew":
      return `Renew at ${outcome.recommendedAnnual} ${currency} a year; nothing cheaper covers the same job.`;
  }
}

function cycleWord(cycle: BillingCycle): string {
  return cycle === "yearly" ? "year" : cycle === "weekly" ? "week" : "month";
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}
