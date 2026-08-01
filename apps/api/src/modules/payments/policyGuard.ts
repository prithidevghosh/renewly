import type { DecisionPackageRow, Subscription, WorkspaceSettings } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { cmp, normalizeAmount, toMinor } from "../../lib/money.js";
import { decisionPackageSchema, isPayingAction } from "../decisions/engine.js";
import { lowConfidenceFields } from "../subscriptions/service.js";

/**
 * Everything that must be true before Renewly is allowed to move money. Each
 * check maps to one error code so the client — and the message composer — can
 * render the right remedy.
 */

export interface PolicyContext {
  settings: WorkspaceSettings;
  subscription: Subscription;
  decision: DecisionPackageRow;
  /** Amount the caller wants to charge; defaults to the decision's amount_due. */
  requestedAmount?: string;
}

export interface PolicyDecision {
  amount: string;
  currency: string;
  /** Recorded on the approval so the receipt shows why it was allowed. */
  approvalPath: "explicit_request" | "within_ceiling" | "auto_within_envelope";
  flags: string[];
}

/** Half a cent of drift is fine; anything more means the numbers disagree. */
const AMOUNT_TOLERANCE_MINOR = 1n;

export function assertPayAllowed(context: PolicyContext): PolicyDecision {
  const { settings, subscription, decision } = context;
  const currency = subscription.currency;
  const flags: string[] = [];

  /* 1. Kill switch. Nothing else matters if the user has pulled the cord. */
  if (settings.killSwitch) {
    throw new AppError("KILL_SWITCH_ENABLED", "Agent spend is disabled", {
      workspaceId: settings.workspaceId,
    });
  }

  /* 2. Low-confidence parse must be confirmed before it can be paid. */
  const unconfirmed = lowConfidenceFields(subscription.fieldConfidence);
  if (!subscription.confirmedAt && unconfirmed.length > 0) {
    throw new AppError(
      "CONFIRMATION_REQUIRED",
      "Confirm the parsed renewal details before paying",
      { subscriptionId: subscription.id, fields: unconfirmed },
    );
  }

  /* 3. The decision must still be live and must be a paying action. */
  if (decision.supersededAt) {
    throw new AppError(
      "INVALID_DECISION_STATE",
      "This decision package has been superseded; regenerate before paying",
      { decisionId: decision.id },
    );
  }
  if (decision.expiresAt && decision.expiresAt.getTime() <= Date.now()) {
    throw new AppError("INVALID_DECISION_STATE", "This decision has expired; regenerate it", {
      decisionId: decision.id,
      expiredAt: decision.expiresAt.toISOString(),
    });
  }
  if (decision.subscriptionId !== subscription.id) {
    throw new AppError("INVALID_DECISION_STATE", "Decision does not belong to this subscription", {
      decisionId: decision.id,
    });
  }
  if (!isPayingAction(decision.recommendation)) {
    throw new AppError(
      "INVALID_DECISION_STATE",
      `A ${decision.recommendation} decision does not move money; use the attestation flow`,
      { decisionId: decision.id, recommendation: decision.recommendation },
    );
  }
  if (subscription.status === "cancelled") {
    throw new AppError("INVALID_DECISION_STATE", "Subscription is already cancelled", {
      subscriptionId: subscription.id,
    });
  }

  /* 4. The priced amount must not have moved since the decision was made. */
  if (decision.pricedAmount) {
    const pricedThen = normalizeAmount(decision.pricedAmount, currency);
    const pricedNow = normalizeAmount(subscription.amount, currency);
    if (cmp(pricedThen, pricedNow, currency) !== 0) {
      throw new AppError(
        "INVALID_DECISION_STATE",
        "The subscription price changed after this decision was made; regenerate it",
        { decisionId: decision.id, pricedAt: pricedThen, currentPrice: pricedNow },
      );
    }
  }

  /* 5. The amount must match what the decision package promised. */
  const packaged = decisionPackageSchema.parse(decision.payload);
  const expected = normalizeAmount(packaged.amount_due, currency);
  const requested = context.requestedAmount
    ? normalizeAmount(context.requestedAmount, currency)
    : expected;

  const drift = toMinor(requested, currency) - toMinor(expected, currency);
  if ((drift < 0n ? -drift : drift) > AMOUNT_TOLERANCE_MINOR) {
    throw new AppError("INVALID_DECISION_STATE", "Requested amount does not match the decision", {
      decisionId: decision.id,
      expected,
      requested,
    });
  }
  if (cmp(requested, "0.00", currency) <= 0) {
    throw new AppError("INVALID_DECISION_STATE", "Nothing to pay for this decision", {
      decisionId: decision.id,
      amount: requested,
    });
  }

  /* 6. Spend ceiling and approval mode. */
  const ceiling = settings.spendCeiling ? normalizeAmount(settings.spendCeiling, currency) : null;
  const aboveCeiling = ceiling !== null && cmp(requested, ceiling, currency) > 0;
  if (aboveCeiling) flags.push("ABOVE_SPEND_CEILING");

  let approvalPath: PolicyDecision["approvalPath"];
  switch (settings.approvalMode) {
    case "always_ask":
      // The user's APPROVE in the thread is the approval; the passkey step then
      // happens inside Prava before credentials are ever issued.
      approvalPath = "explicit_request";
      break;
    case "ask_above_ceiling":
      approvalPath = aboveCeiling ? "explicit_request" : "within_ceiling";
      break;
    case "auto_within_envelope":
      if (ceiling === null) {
        throw new AppError(
          "APPROVAL_REQUIRED",
          "auto_within_envelope requires a spend ceiling to be set",
          { approvalMode: settings.approvalMode },
        );
      }
      if (aboveCeiling) {
        throw new AppError(
          "APPROVAL_REQUIRED",
          `Amount ${requested} ${currency} is above the ${ceiling} ${currency} auto-approval ceiling`,
          { amount: requested, ceiling, approvalMode: settings.approvalMode },
        );
      }
      approvalPath = "auto_within_envelope";
      break;
  }

  /* 7. Monthly budget is advisory at pay time, but it is recorded. */
  if (settings.aiMonthlyBudget) {
    const budget = normalizeAmount(settings.aiMonthlyBudget, currency);
    if (cmp(requested, budget, currency) > 0) flags.push("EXCEEDS_MONTHLY_BUDGET");
  }

  return { amount: requested, currency, approvalPath, flags };
}

/**
 * Attested actions (cancel, rightsize) move no money, so only the kill switch
 * and decision state apply.
 */
export function assertAttestedActionAllowed(context: {
  settings: WorkspaceSettings;
  subscription: Subscription;
  decision: DecisionPackageRow;
}): void {
  if (context.settings.killSwitch) {
    throw new AppError("KILL_SWITCH_ENABLED", "Agent actions are disabled", {
      workspaceId: context.settings.workspaceId,
    });
  }
  if (context.decision.subscriptionId !== context.subscription.id) {
    throw new AppError("INVALID_DECISION_STATE", "Decision does not belong to this subscription", {
      decisionId: context.decision.id,
    });
  }
  if (context.subscription.status === "cancelled") {
    throw new AppError("INVALID_DECISION_STATE", "Subscription is already cancelled", {
      subscriptionId: context.subscription.id,
    });
  }
}

/** Retained name for the cancel flow, which is one kind of attested action. */
export const assertCancelAllowed = assertAttestedActionAllowed;

/**
 * Would this decision be auto-approved, or does it need the user? Used by
 * `POST /v1/settings/simulate` to answer "what changes if I loosen policy"
 * without actually running anything.
 */
export function simulateApproval(
  settings: WorkspaceSettings,
  input: { amount: string; currency: string; recommendation: DecisionPackageRow["recommendation"] },
): { outcome: "auto" | "ask" | "blocked"; reason: string } {
  if (settings.killSwitch) {
    return { outcome: "blocked", reason: "KILL_SWITCH_ENABLED" };
  }
  if (!isPayingAction(input.recommendation)) {
    return { outcome: "ask", reason: "ATTESTATION_REQUIRED" };
  }

  const ceiling = settings.spendCeiling
    ? normalizeAmount(settings.spendCeiling, input.currency)
    : null;
  const aboveCeiling = ceiling !== null && cmp(input.amount, ceiling, input.currency) > 0;

  switch (settings.approvalMode) {
    case "always_ask":
      return { outcome: "ask", reason: "APPROVAL_MODE_ALWAYS_ASK" };
    case "ask_above_ceiling":
      return aboveCeiling
        ? { outcome: "ask", reason: "ABOVE_SPEND_CEILING" }
        : { outcome: "auto", reason: "WITHIN_SPEND_CEILING" };
    case "auto_within_envelope":
      if (ceiling === null) return { outcome: "ask", reason: "NO_CEILING_CONFIGURED" };
      return aboveCeiling
        ? { outcome: "blocked", reason: "ABOVE_SPEND_CEILING" }
        : { outcome: "auto", reason: "WITHIN_ENVELOPE" };
  }
}
