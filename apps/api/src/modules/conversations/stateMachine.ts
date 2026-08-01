import { AppError } from "../../lib/errors.js";
import type { ApprovalState } from "../../db/schema.js";

/**
 * The approval lifecycle. Every money-moving action walks this graph exactly
 * once, and the graph is the only place a transition is allowed to be decided.
 *
 *   drafted → notified → awaiting_intent → awaiting_payment_auth → executing → proved
 *                                                                           ↘ failed
 *   any non-terminal → expired | cancelled_by_user
 *
 * Attested actions (cancel, rightsize) skip awaiting_payment_auth and go
 * straight from awaiting_intent to executing when the user confirms.
 */

export const APPROVAL_STATES: readonly ApprovalState[] = [
  "drafted",
  "notified",
  "awaiting_intent",
  "awaiting_payment_auth",
  "executing",
  "proved",
  "failed",
  "expired",
  "cancelled_by_user",
] as const;

export const TERMINAL_STATES: readonly ApprovalState[] = [
  "proved",
  "failed",
  "expired",
  "cancelled_by_user",
] as const;

export const isTerminal = (state: ApprovalState): boolean => TERMINAL_STATES.includes(state);

/**
 * Explicit adjacency. A transition absent from this table cannot happen, which
 * is what makes a replayed webhook or a double APPROVE inert rather than
 * dangerous.
 */
const TRANSITIONS: Record<ApprovalState, readonly ApprovalState[]> = {
  drafted: ["notified", "cancelled_by_user", "expired", "failed"],
  // A send can fail, so notified may fall back to failed without user input.
  notified: ["awaiting_intent", "cancelled_by_user", "expired", "failed"],
  awaiting_intent: [
    "awaiting_payment_auth",
    // Attested actions execute without a payment leg.
    "executing",
    "cancelled_by_user",
    "expired",
    "failed",
  ],
  awaiting_payment_auth: ["executing", "cancelled_by_user", "expired", "failed"],
  // Executing may not be cancelled: money is already in flight.
  executing: ["proved", "failed"],
  proved: [],
  failed: [],
  expired: [],
  cancelled_by_user: [],
};

export function canTransition(from: ApprovalState, to: ApprovalState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: ApprovalState): readonly ApprovalState[] {
  return TRANSITIONS[from];
}

/**
 * Throws INVALID_STATE_TRANSITION unless the move is legal. Callers hold a row
 * lock across this check and the write, so two concurrent webhooks cannot both
 * pass it.
 */
export function assertTransition(from: ApprovalState, to: ApprovalState): void {
  if (from === to) {
    throw new AppError("INVALID_STATE_TRANSITION", `Approval is already ${to}`, {
      from,
      to,
      idempotent: true,
    });
  }
  if (!canTransition(from, to)) {
    throw new AppError(
      "INVALID_STATE_TRANSITION",
      `Cannot move an approval from ${from} to ${to}`,
      { from, to, allowed: TRANSITIONS[from] },
    );
  }
}

/** Where an APPROVE should take this approval, given what the action needs. */
export function nextStateForApprove(
  current: ApprovalState,
  needsPayment: boolean,
): ApprovalState {
  assertTransition(current, needsPayment ? "awaiting_payment_auth" : "executing");
  return needsPayment ? "awaiting_payment_auth" : "executing";
}

/** True when an inbound intent should be acted on rather than ignored. */
export function acceptsIntent(state: ApprovalState): boolean {
  return state === "notified" || state === "awaiting_intent";
}

/** True when the expiry worker may retire this approval. */
export function isExpirable(state: ApprovalState): boolean {
  return !isTerminal(state) && state !== "executing";
}
