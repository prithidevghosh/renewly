import type { BillingCycle } from "../../lib/money.js";
import type { Recommendation } from "../decisions/engine.js";

/**
 * Every string the agent sends. Kept as pure functions so the wording is
 * unit-tested and cannot drift: these messages are the entire product surface
 * on a phone, and a vague one costs the user money.
 *
 * No emoji, no exclamation marks, no filler. The user is reading this on a lock
 * screen and needs the merchant, the amount and the ask.
 */

export interface ProposalInput {
  merchant: string;
  amount: string;
  currency: string;
  cycle: BillingCycle;
  renewalDate: Date | null;
  diagnosis: string;
  recommendation: Recommendation;
  savingsAnnual: string;
}

const CYCLE_WORD: Record<BillingCycle, string> = {
  monthly: "mo",
  yearly: "yr",
  weekly: "wk",
  unknown: "mo",
};

const ACTION_LABEL: Record<Recommendation, string> = {
  renew: "Renew",
  rightsize_seats: "Rightsize seats",
  switch_term: "Switch to annual",
  switch_vendor: "Switch vendor",
  cancel: "Cancel",
  snooze: "Leave as is",
};

/** "12 Aug" — short enough for a lock screen, unambiguous in a thread. */
export function shortDate(date: Date | null): string {
  if (!date) return "soon";
  return `${date.getUTCDate()} ${
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
      date.getUTCMonth()
    ]
  }`;
}

export function composeProposal(input: ProposalInput): string {
  const money = `${input.currency === "USD" ? "$" : ""}${input.amount}${input.currency === "USD" ? "" : ` ${input.currency}`}`;
  const line1 = `${input.merchant} renews ${shortDate(input.renewalDate)} — ${money}/${CYCLE_WORD[input.cycle]}`;
  const line2 = input.diagnosis;

  const saves = input.savingsAnnual !== "0.00";
  const line3 = saves
    ? `Recommended: ${ACTION_LABEL[input.recommendation]} · save ${input.savingsAnnual} ${input.currency}/yr`
    : `Recommended: ${ACTION_LABEL[input.recommendation]} · keep access for ${money}/${CYCLE_WORD[input.cycle]}`;

  const line4 = "Reply APPROVE · KEEP · LATER · WHY";

  return [line1, line2, line3, line4].join("\n");
}

export interface AuthLinkInput {
  merchant: string;
  amount: string;
  currency: string;
  payLink: string;
  expiresInMinutes: number;
}

export function composeAuthLink(input: AuthLinkInput): string {
  const money = `${input.currency === "USD" ? "$" : ""}${input.amount}${input.currency === "USD" ? "" : ` ${input.currency}`}`;
  return [
    `Approve ${money} to ${input.merchant} with passkey:`,
    input.payLink,
    `Expires in ${input.expiresInMinutes} minutes.`,
  ].join("\n");
}

export interface PayProofInput {
  merchant: string;
  amount: string;
  currency: string;
  receiptId: string;
  nextRenewalAt: Date | null;
}

export function composePayProof(input: PayProofInput): string {
  const money = `${input.currency === "USD" ? "$" : ""}${input.amount}${input.currency === "USD" ? "" : ` ${input.currency}`}`;
  return [
    `Done. Paid ${money} to ${input.merchant}.`,
    `Receipt ${input.receiptId}. Next renewal ${shortDate(input.nextRenewalAt)}.`,
  ].join("\n");
}

export interface ActionProofInput {
  actionSummary: string;
  amountSaved: string;
  currency: string;
}

export function composeActionProof(input: ActionProofInput): string {
  return [
    `Done. ${input.actionSummary}.`,
    `Realized savings ${input.amountSaved} ${input.currency}/yr. Logged for your books.`,
  ].join("\n");
}

export type BlockedReason =
  | "KILL_SWITCH_ENABLED"
  | "ABOVE_SPEND_CEILING"
  | "CONFIRMATION_REQUIRED"
  | "APPROVAL_REQUIRED"
  | "INVALID_DECISION_STATE"
  | "APPROVAL_EXPIRED"
  | "CHANNEL_NOT_CONNECTED";

const BLOCKED_TEXT: Record<BlockedReason, string> = {
  KILL_SWITCH_ENABLED: "kill switch is on",
  ABOVE_SPEND_CEILING: "over your spend ceiling",
  CONFIRMATION_REQUIRED: "the parsed details need confirming first",
  APPROVAL_REQUIRED: "this needs your explicit approval",
  INVALID_DECISION_STATE: "the proposal is no longer current",
  APPROVAL_EXPIRED: "the approval window closed",
  CHANNEL_NOT_CONNECTED: "no messaging channel is connected",
};

export function composeBlocked(reason: BlockedReason, detail?: string): string {
  const base = `Paused: ${BLOCKED_TEXT[reason]}.`;
  return detail ? `${base} ${detail}` : base;
}

export interface FailureInput {
  merchant: string;
  reason: string;
  canRetry: boolean;
}

export function composeFailure(input: FailureInput): string {
  const lines = [`Could not complete ${input.merchant}: ${input.reason}.`];
  lines.push(
    input.canRetry
      ? "Nothing was charged. Reply RETRY to try again."
      : "Nothing was charged.",
  );
  return lines.join(" ");
}

export interface WhyInput {
  merchant: string;
  doNothingAnnual: string;
  recommendedAnnual: string;
  savingsAnnual: string;
  currency: string;
  inputsUsed: string[];
}

/** The WHY reply. Shows the counterfactual, not a restatement of the pitch. */
export function composeWhy(input: WhyInput): string {
  const lines = [
    `${input.merchant}: doing nothing costs ${input.doNothingAnnual} ${input.currency}/yr.`,
    `The recommended path costs ${input.recommendedAnnual} ${input.currency}/yr, a difference of ${input.savingsAnnual} ${input.currency}.`,
  ];

  // Show what the decision actually consulted, capped so it stays a message.
  const shown = input.inputsUsed.slice(0, 4);
  if (shown.length > 0) lines.push(`Based on: ${shown.join(", ")}.`);
  lines.push("Reply APPROVE to go ahead, or KEEP to leave it.");
  return lines.join("\n");
}

export function composeKeepAck(merchant: string): string {
  return `Understood. Leaving ${merchant} as it is. Nothing was charged.`;
}

export function composeSnoozeAck(merchant: string, days: number): string {
  return `Fine. I will come back to ${merchant} in ${days} days.`;
}

export function composeStopAck(): string {
  return "Stopped. I will not message you again until you turn this channel back on.";
}

export function composeHelp(): string {
  return [
    "Renewly commands:",
    "APPROVE — go ahead with the proposal",
    "KEEP — leave the subscription alone",
    "LATER — remind me closer to the renewal",
    "WHY — show the numbers behind it",
    "DONE — I finished the cancellation myself",
    "STOP — stop messaging me",
  ].join("\n");
}

export function composeAttestationAsk(input: {
  merchant: string;
  actionType: Recommendation;
  portalUrl: string | null;
  savingsAnnual: string;
  currency: string;
}): string {
  const verb = input.actionType === "cancel" ? "Cancel" : "Reduce the seats on";
  const lines = [
    `${verb} ${input.merchant} to save ${input.savingsAnnual} ${input.currency}/yr.`,
    // Renewly cannot do this leg itself, and the message must not pretend it can.
    input.portalUrl
      ? `I cannot do this one for you — there is no API. Open ${input.portalUrl} and complete it.`
      : `I cannot do this one for you — there is no API. Complete it in the ${input.merchant} billing settings.`,
    "Reply DONE when it is finished and I will log the saving.",
  ];
  return lines.join("\n");
}
