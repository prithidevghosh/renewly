import { z } from "zod";
import {
  annualize,
  cmp,
  deannualize,
  fromMinor,
  mul,
  normalizeAmount,
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
  /**
   * Seats the workspace actually needs. Optional so callers that predate the
   * field still work; absent means the solo-founder default of one.
   */
  teamSize?: number;
}

/** The solo-founder assumption, applied whenever nothing better is known. */
export const DEFAULT_TEAM_SIZE = 1;

export const effectiveTeamSize = (policy: EnginePolicy): number =>
  Math.max(1, policy.teamSize ?? DEFAULT_TEAM_SIZE);

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

/* -------------------------------------------------------------------------- */
/* Overspend predicates                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every way V1 is allowed to call something overspend. All four read the
 * invoice, the policy and the catalog — never usage — so a decision can be made
 * on the day a receipt arrives, with nobody interviewed about anything.
 *
 * `decide` routes through these rather than repeating the arithmetic, so a test
 * that pins a predicate pins the behaviour that follows from it.
 */

export type EnginePeer = Pick<
  EngineSubscription,
  "id" | "amount" | "billingCycle" | "jobCategory" | "merchantName"
>;

/** The category this subscription belongs to is spending past its ceiling. */
export function isOverCategoryCeiling(
  sub_: Pick<EngineSubscription, "amount" | "currency" | "billingCycle" | "jobCategory">,
  policy: EnginePolicy,
  peers: readonly EnginePeer[] = [],
): boolean {
  if (!sub_.jobCategory) return false;
  const ceiling = policy.categoryCeilings[sub_.jobCategory];
  if (!ceiling) return false;

  const spend = monthlyRunRate(
    [
      { amount: sub_.amount, billingCycle: sub_.billingCycle },
      ...peers
        .filter((peer) => peer.jobCategory === sub_.jobCategory)
        .map((peer) => ({ amount: peer.amount, billingCycle: peer.billingCycle })),
    ],
    sub_.currency,
  );
  return cmp(spend, ceiling, sub_.currency) > 0;
}

/**
 * A cheaper tool in the catalog covers the same job at this seat count.
 * `diff` is the annual difference, "0.00" when there is nothing cheaper.
 */
export function isExpensivePlanVsCatalog(
  sub_: Pick<
    EngineSubscription,
    "merchantName" | "amount" | "currency" | "billingCycle" | "seatsTotal"
  >,
  catalog: CatalogTool | null = findCatalogTool(sub_.merchantName),
): { cheaper: boolean; diff: string } {
  const currency = sub_.currency;
  const seats = Math.max(1, sub_.seatsTotal);
  const currentAnnual = annualize(
    normalizeAmount(sub_.amount, currency),
    sub_.billingCycle,
    currency,
  );

  const [cheapest] = cheaperAlternatives(catalog, currentAnnual, seats);
  if (!cheapest) return { cheaper: false, diff: "0.00" };

  return {
    cheaper: true,
    diff: sub(currentAnnual, catalogAnnualCost(cheapest, seats), currency),
  };
}

/**
 * Billed monthly when the same tier has a cheaper annual term. Pure plan maths:
 * it says nothing about whether the tool is used.
 */
export function isAnnualCheaperThanMonthly(
  sub_: Pick<
    EngineSubscription,
    "merchantName" | "amount" | "currency" | "billingCycle" | "seatsTotal"
  >,
  catalog: CatalogTool | null = findCatalogTool(sub_.merchantName),
): boolean {
  return cmp(annualTermSaving(sub_, catalog), "0.00", sub_.currency) > 0;
}

/** Annual money saved by moving to the annual term, "0.00" when there is none. */
export function annualTermSaving(
  sub_: Pick<
    EngineSubscription,
    "merchantName" | "amount" | "currency" | "billingCycle" | "seatsTotal"
  >,
  catalog: CatalogTool | null = findCatalogTool(sub_.merchantName),
): string {
  const currency = sub_.currency;
  if (sub_.billingCycle !== "monthly" || !catalog?.annualMonthlyPrice) return "0.00";

  const seats = Math.max(1, sub_.seatsTotal);
  const currentAnnual = annualize(
    normalizeAmount(sub_.amount, currency),
    sub_.billingCycle,
    currency,
  );
  const saving = sub(currentAnnual, catalogAnnualCost(catalog, seats, true), currency);
  return cmp(saving, "0.00", currency) > 0 ? saving : "0.00";
}

/** Tagged experimental and priced above the per-action ceiling. */
export function isMarkedExperimentalAndExpensive(
  sub_: Pick<EngineSubscription, "criticality" | "amount" | "currency">,
  policy: EnginePolicy,
): boolean {
  if (sub_.criticality !== "experimental") return false;
  if (!policy.spendCeiling) return false;
  return cmp(normalizeAmount(sub_.amount, sub_.currency), policy.spendCeiling, sub_.currency) > 0;
}

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

  const categoryCeiling = sub_.jobCategory ? policy.categoryCeilings[sub_.jobCategory] : undefined;
  const categoryBudgetExceeded = isOverCategoryCeiling(sub_, policy, input.peers);
  if (categoryCeiling && sub_.jobCategory) {
    inputsUsed.push(`policy.category_ceiling.${sub_.jobCategory}=${categoryCeiling}`);
    if (categoryBudgetExceeded) {
      const categorySpend = monthlyRunRate(
        [
          { amount, billingCycle: sub_.billingCycle },
          ...input.peers
            .filter((p) => p.jobCategory === sub_.jobCategory)
            .map((p) => ({ amount: p.amount, billingCycle: p.billingCycle })),
        ],
        currency,
      );
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

  /*
   * No activity data at all, but the invoice itself bills more seats than the
   * workspace says it has people. That is a claim about the invoice and the
   * policy, not about anybody's login history, so it is fair to act on — and it
   * is deliberately never expressed as "seat X is dead".
   */
  const teamSize = effectiveTeamSize(policy);
  inputsUsed.push(`policy.team_size=${teamSize}`);
  const oversizedVsTeam =
    activeSeats === null && seatsTotal > teamSize && sub_.criticality !== "must_keep";
  if (oversizedVsTeam) {
    inputsUsed.push("derived.seats_exceed_team_size=true");
  }

  const aboveCeiling = policy.spendCeiling
    ? cmp(amount, policy.spendCeiling, currency) > 0
    : false;
  if (aboveCeiling) {
    policyFlags.push("ABOVE_SPEND_CEILING");
    inputsUsed.push("derived.above_spend_ceiling=true");
  }
  const experimentalAndExpensive = isMarkedExperimentalAndExpensive(sub_, policy);

  const daysToRenewal =
    sub_.nextRenewalAt !== null
      ? Math.round((sub_.nextRenewalAt.getTime() - now.getTime()) / 86_400_000)
      : null;
  if (daysToRenewal !== null) inputsUsed.push(`derived.days_to_renewal=${daysToRenewal}`);

  const cheapest = candidates[0] ?? null;
  const annualBillingSaving = annualTermSaving({ ...sub_, seatsTotal }, catalogTool);
  const hasTermDiscount = isAnnualCheaperThanMonthly({ ...sub_, seatsTotal }, catalogTool);
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
  } else if (oversizedVsTeam) {
    /*
     * Rule 6b — the invoice bills more seats than the workspace has people, and
     * nothing tells us who logs in. The claim is arithmetic on the invoice, so
     * confidence stays low and the message asks rather than asserts.
     */
    recommendation = "rightsize_seats";
    seatsTarget = teamSize;
    recommendedAnnual = perSeatAnnual(doNothingAnnual, seatsTotal, teamSize, currency);
    confidence = 0.6;
    reasons.push(
      `The invoice bills ${seatsTotal} seats and this workspace is set to ${teamSize}. Dropping to ${teamSize} matches the plan to the team on record.`,
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
  } else if (experimentalAndExpensive) {
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
    } else if (seatsTotal > teamSize) {
      /*
       * Surplus seats are the least disruptive lever, and the saving is the
       * per-seat arithmetic rather than a guessed percentage — a decision that
       * quotes a number the maths does not support is worse than no decision.
       */
      recommendation = "rightsize_seats";
      seatsTarget = teamSize;
      recommendedAnnual = perSeatAnnual(doNothingAnnual, seatsTotal, teamSize, currency);
      confidence = 0.55;
      reasons.push(
        `Over budget with no cheaper equivalent; the invoice bills ${seatsTotal} seats against a team of ${teamSize}.`,
      );
    } else {
      /* Over budget, nothing cheaper and no seats to trim. Experimental spend is
       * the category the user already said they were least committed to. */
      recommendation = "cancel";
      recommendedAnnual = "0.00";
      confidence = 0.58;
      reasons.push(
        `Over budget at ${doNothingAnnual} ${currency} a year with no cheaper equivalent and no surplus seats, on a tool you marked experimental.`,
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
      seatsTarget,
      teamSize,
      annualBillingSaving,
      daysToRenewal,
      doNothingAnnual,
      experimentalAndExpensive: isMarkedExperimentalAndExpensive(sub_, policy),
      overBudget: budgetExceeded || categoryBudgetExceeded,
      spendCeiling: policy.spendCeiling,
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
    seatsTarget: number | null;
    teamSize: number;
    annualBillingSaving: string;
    daysToRenewal: number | null;
    doNothingAnnual: string;
    experimentalAndExpensive: boolean;
    overBudget: boolean;
    spendCeiling: string | null;
  },
): string {
  const currency = sub_.currency;
  const annual = `${facts.doNothingAnnual} ${currency} a year`;

  switch (recommendation) {
    case "cancel":
      if (facts.unusedDays !== null) {
        return `Your note says no use for about ${facts.unusedDays} days, at ${annual}.`;
      }
      if (facts.experimentalAndExpensive && facts.spendCeiling) {
        return `You marked this experimental and it is above your ${normalizeAmount(facts.spendCeiling, currency)} ${currency} ceiling, at ${annual}.`;
      }
      if (facts.overBudget) {
        return `Over your budget at ${annual}, with nothing cheaper covering the same job.`;
      }
      return `You marked this experimental, at ${annual}.`;
    case "rightsize_seats":
      // Idle-seat wording requires activity data. Without it, say what the
      // invoice says and what the workspace is set to, and nothing more.
      return facts.idleSeats > 0
        ? `${facts.idleSeats} of ${facts.seatsTotal} seats are sitting idle.`
        : `The invoice bills ${facts.seatsTotal} seats; this workspace is set to ${facts.teamSize}.`;
    case "switch_term":
      return `Billed monthly; the annual term is ${facts.annualBillingSaving} ${currency} a year cheaper for the same tier.`;
    case "switch_vendor":
      return `A cheaper tool covers the same job at this seat count.`;
    case "snooze":
      return `Nothing in the invoice or your policy flags this, and the renewal is ${facts.daysToRenewal} days out.`;
    case "renew":
      return facts.overBudget
        ? `Over your budget at ${annual}, but nothing cheaper covers the same job.`
        : `Within your policy at ${annual}, and nothing cheaper covers the same job.`;
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
