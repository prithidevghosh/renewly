import { eq } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { subscriptions, type DecisionPackageRow, type Subscription } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { annualize, cmp, fromMinor, normalizeAmount, toMinor } from "../../lib/money.js";
import type { AuthContext } from "../../types/context.js";
import { recordAudit } from "../audit/service.js";
import { decisionPackageSchema, isAttestedAction } from "../decisions/engine.js";
import { toSavingsActionType } from "../decisions/service.js";
import { recordSavings, retireIdentifiedForSubscription } from "../ledger/service.js";
import { assertAttestedActionAllowed } from "../payments/policyGuard.js";
import { resolveCancelUrl } from "../merchants/service.js";

/**
 * Actions Renewly cannot perform itself, stated honestly.
 *
 * There is no cancellation API for Claude, Midjourney or Figma, and V1 does not
 * drive their billing portals with a browser. So this flow does what it can
 * actually do: assemble the checklist, point at the right page, and wait for the
 * user to attest that it is done. Nothing reaches the savings ledger as
 * `realized` on the strength of an intention.
 */

export interface ChecklistItem {
  step: number;
  label: string;
  detail: string;
}

export interface ActionPlan {
  subscriptionId: string;
  decisionId: string;
  actionType: DecisionPackageRow["recommendation"];
  status: "pending_user_confirmation";
  merchantName: string;
  portalUrl: string | null;
  /** True when the URL came from the curated merchant graph rather than a guess. */
  portalUrlVerified: boolean;
  cancelByAt: string | null;
  projectedAnnualSaving: string;
  currency: string;
  seatsTarget: number | null;
  checklist: ChecklistItem[];
  disclaimer: string;
}

const CANCEL_DISCLAIMER =
  "Renewly cannot cancel this subscription on your behalf. There is no cancellation API for this merchant and V1 does not automate their billing portal. Complete the steps below, then confirm so the savings are recorded.";

const RIGHTSIZE_DISCLAIMER =
  "Renewly cannot change your seat count on your behalf. Seat administration is behind the merchant's own admin UI. Complete the steps below, then confirm so the savings are recorded.";

export async function buildActionPlan(
  subscription: Subscription,
  decision: DecisionPackageRow,
  db: Database = getDb(),
): Promise<ActionPlan> {
  const currency = subscription.currency;
  const annual = annualize(
    normalizeAmount(subscription.amount, currency),
    subscription.billingCycle,
    currency,
  );
  const parsed = decisionPackageSchema.safeParse(decision.payload);
  const seatsTarget = parsed.success ? parsed.data.seats_target : null;
  const isCancel = decision.recommendation === "cancel";

  const portal = await resolveCancelUrl(
    subscription.workspaceId,
    subscription.merchantCanonical,
    db,
  );

  const checklist: ChecklistItem[] = [];

  if (subscription.cancelByAt) {
    checklist.push({
      step: 0,
      label: "Mind the deadline",
      detail: `Act before ${subscription.cancelByAt.toISOString()} or the next period is charged.`,
    });
  }

  checklist.push({
    step: 0,
    label: `Open the ${subscription.merchantName} billing settings`,
    detail: portal.url
      ? `Go to ${portal.url} and sign in as the account owner.`
      : `Sign in to ${subscription.merchantName} and find billing or subscription settings.`,
  });

  if (isCancel) {
    checklist.push(
      {
        step: 0,
        label: "Cancel the plan",
        detail: subscription.planName
          ? `Cancel the ${subscription.planName} plan. Decline any retention offer unless it beats ${annual} ${currency} a year.`
          : `Cancel the subscription. Decline any retention offer unless it beats ${annual} ${currency} a year.`,
      },
      {
        step: 0,
        label: "Export anything you need first",
        detail: "Download files, history or exports before access ends at the period boundary.",
      },
    );
  } else {
    checklist.push(
      {
        step: 0,
        label: `Reduce to ${seatsTarget ?? "the used"} seats`,
        detail: `Remove the ${Math.max(0, subscription.seatsTotal - (seatsTarget ?? subscription.seatsTotal))} unused seats. Most vendors credit the unused portion to your next invoice.`,
      },
      {
        step: 0,
        label: "Check who you are removing",
        detail: "Confirm the seats you drop are not someone's only access before you remove them.",
      },
    );
  }

  checklist.push(
    {
      step: 0,
      label: "Keep the confirmation email",
      detail: "The merchant's confirmation is your evidence if you are billed at the old rate.",
    },
    {
      step: 0,
      label: "Confirm here",
      detail:
        "Reply DONE in the thread, or call the confirm endpoint, so the saving is written to the ledger.",
    },
  );

  return {
    subscriptionId: subscription.id,
    decisionId: decision.id,
    actionType: decision.recommendation,
    status: "pending_user_confirmation",
    merchantName: subscription.merchantName,
    portalUrl: portal.url,
    portalUrlVerified: portal.verified,
    cancelByAt: subscription.cancelByAt?.toISOString() ?? null,
    projectedAnnualSaving: parsed.success
      ? parsed.data.counterfactuals.recommended.savings_vs_do_nothing
      : annual,
    currency,
    seatsTarget,
    checklist: checklist.map((item, index) => ({ ...item, step: index + 1 })),
    disclaimer: isCancel ? CANCEL_DISCLAIMER : RIGHTSIZE_DISCLAIMER,
  };
}

export async function startAttestedAction(input: {
  auth: AuthContext;
  subscription: Subscription;
  decision: DecisionPackageRow;
  db?: Database;
}): Promise<{ plan: ActionPlan; subscription: Subscription }> {
  const db = input.db ?? getDb();

  if (!isAttestedAction(input.decision.recommendation)) {
    throw new AppError(
      "INVALID_DECISION_STATE",
      `A ${input.decision.recommendation} decision is not completed by attestation`,
      { decisionId: input.decision.id },
    );
  }

  assertAttestedActionAllowed({
    settings: input.auth.settings,
    subscription: input.subscription,
    decision: input.decision,
  });

  const plan = await buildActionPlan(input.subscription, input.decision, db);

  // Only a cancellation parks the subscription; a seat change leaves it active.
  const nextStatus =
    input.decision.recommendation === "cancel" ? ("pending_cancel" as const) : undefined;

  const [updated] = await db
    .update(subscriptions)
    .set({ ...(nextStatus ? { status: nextStatus } : {}), updatedAt: new Date() })
    .where(eq(subscriptions.id, input.subscription.id))
    .returning();
  if (!updated) throw new Error("subscription update returned no row");

  await recordAudit(
    {
      workspaceId: input.auth.workspace.id,
      actorUserId: input.auth.user.id,
      type: "cancel.started",
      entityType: "subscription",
      entityId: input.subscription.id,
      data: {
        decisionId: input.decision.id,
        actionType: input.decision.recommendation,
        merchantName: input.subscription.merchantName,
        projectedAnnualSaving: plan.projectedAnnualSaving,
        portalUrl: plan.portalUrl,
        // The audit must record that no automation ran on the merchant's side.
        automated: false,
      },
    },
    db,
  );

  return { plan, subscription: updated };
}

export interface ConfirmResult {
  subscription: Subscription;
  savingsEntryId: string;
  amountSaved: string;
  actionType: DecisionPackageRow["recommendation"];
}

export async function confirmAttestedAction(input: {
  auth: AuthContext;
  subscription: Subscription;
  decision: DecisionPackageRow;
  note?: string;
  /** Correction when the user negotiated a partial reduction instead. */
  actualAnnualSaving?: string;
  approvalRequestId?: string | null;
  db?: Database;
}): Promise<ConfirmResult> {
  const db = input.db ?? getDb();

  assertAttestedActionAllowed({
    settings: input.auth.settings,
    subscription: input.subscription,
    decision: input.decision,
  });

  const currency = input.subscription.currency;
  const annual = annualize(
    normalizeAmount(input.subscription.amount, currency),
    input.subscription.billingCycle,
    currency,
  );
  const parsed = decisionPackageSchema.safeParse(input.decision.payload);
  const isCancel = input.decision.recommendation === "cancel";

  const projected = parsed.success
    ? normalizeAmount(parsed.data.counterfactuals.recommended.savings_vs_do_nothing, currency)
    : annual;

  const amountSaved =
    input.actualAnnualSaving !== undefined
      ? normalizeAmount(input.actualAnnualSaving, currency)
      : isCancel
        ? annual
        : projected;

  const now = new Date();
  const seatsTarget = parsed.success ? parsed.data.seats_target : null;

  const patch: Partial<typeof subscriptions.$inferInsert> = { updatedAt: now };
  if (isCancel) {
    patch.status = "cancelled";
    patch.cancelledAt = now;
  } else if (seatsTarget !== null) {
    // The plan really is smaller now, so the inventory has to say so or the next
    // decision will re-propose the same change.
    patch.seatsTotal = seatsTarget;
    patch.seatsActive = seatsTarget;
    patch.amount = perSeatAmount(input.subscription, seatsTarget, currency);
  }

  const [updated] = await db
    .update(subscriptions)
    .set(patch)
    .where(eq(subscriptions.id, input.subscription.id))
    .returning();
  if (!updated) throw new Error("subscription update returned no row");

  logger.info(
    {
      subscriptionId: input.subscription.id,
      merchant: input.subscription.merchantName,
      action: isCancel ? "cancel" : "rightsize",
      amountSaved,
      currency,
      ...(seatsTarget !== null ? { seatsTarget } : {}),
    },
    `attested ${isCancel ? "cancel" : "rightsize"} — ${input.subscription.merchantName}, ${amountSaved} ${currency}/yr realized`,
  );

  // The opportunity has been banked, so it is no longer merely identified.
  await retireIdentifiedForSubscription(input.subscription.id, db);

  const entry = await recordSavings(
    {
      workspaceId: input.auth.workspace.id,
      actorUserId: input.auth.user.id,
      subscriptionId: input.subscription.id,
      decisionId: input.decision.id,
      approvalRequestId: input.approvalRequestId ?? null,
      actionType: toSavingsActionType(input.decision.recommendation),
      recognition: "realized",
      amountSaved,
      currency,
      periodMonths: 12,
      note:
        input.note ??
        `${isCancel ? "Cancelled" : "Rightsized"} ${input.subscription.merchantName}, attested by the user`,
    },
    db,
  );

  await recordAudit(
    {
      workspaceId: input.auth.workspace.id,
      actorUserId: input.auth.user.id,
      type: "cancel.confirmed",
      entityType: "subscription",
      entityId: input.subscription.id,
      data: {
        decisionId: input.decision.id,
        actionType: input.decision.recommendation,
        savingsEntryId: entry.id,
        amountSaved,
        currency,
        attestedByUser: true,
      },
    },
    db,
  );

  if (isCancel) {
    await recordAudit(
      {
        workspaceId: input.auth.workspace.id,
        actorUserId: input.auth.user.id,
        type: "subscription.cancelled",
        entityType: "subscription",
        entityId: input.subscription.id,
        data: { merchantName: input.subscription.merchantName, status: updated.status },
      },
      db,
    );
  }

  return {
    subscription: updated,
    savingsEntryId: entry.id,
    amountSaved,
    actionType: input.decision.recommendation,
  };
}

/** Recurring charge after dropping to `seatsTarget`, rounded half-up. */
function perSeatAmount(
  subscription: Subscription,
  seatsTarget: number,
  currency: string,
): string {
  const seats = Math.max(1, subscription.seatsTotal);
  if (seats <= 1 || seatsTarget >= seats) return normalizeAmount(subscription.amount, currency);

  const total = normalizeAmount(subscription.amount, currency);
  const perSeatShare = divide(total, seats, currency);
  const next = multiply(perSeatShare, seatsTarget, currency);
  return cmp(next, total, currency) > 0 ? total : next;
}

/** Per-seat share, rounded half-up. */
function divide(amount: string, by: number, currency: string): string {
  const minor = toMinor(amount, currency);
  const divisor = BigInt(by);
  const quotient = minor / divisor;
  const remainder = minor % divisor;
  return fromMinor(remainder * 2n >= divisor ? quotient + 1n : quotient, currency);
}

function multiply(amount: string, by: number, currency: string): string {
  return fromMinor(toMinor(amount, currency) * BigInt(by), currency);
}
