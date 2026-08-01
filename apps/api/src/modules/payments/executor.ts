import { eq } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import { paymentSessions, subscriptions, type ApprovalRequest } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { idempotencyKeyFor, once } from "../../lib/idempotency.js";
import { logger } from "../../lib/logger.js";
import type { AuthContext } from "../../types/context.js";
import {
  assertNotExpired,
  loadApprovalContext,
  transition,
} from "../approvals/service.js";
import { composeFailure, composePayProof } from "../conversations/composer.js";
import { sendPayProof } from "../conversations/runtime.js";
import { retireIdentifiedForSubscription } from "../ledger/service.js";
import { completePayment } from "./service.js";

/**
 * The pay pipeline, run once per approval.
 *
 *   assert policy and state
 *     -> poll Prava for the one-time credential
 *     -> charge it through the checkout adapter
 *     -> report the outcome back to the rail
 *     -> write transaction, receipt and realized savings
 *     -> transition proved | failed
 *     -> put the proof in the thread
 *
 * Wrapped in `once`, so a user tapping the pay link twice, a retried webhook and
 * the poller all converge on a single charge.
 */

export interface ExecuteInput {
  auth: AuthContext;
  approvalId: string;
  /** Test-only decline injection; ignored outside NODE_ENV=test. */
  forceDecline?: boolean;
  db?: Database;
}

export interface ExecuteResult {
  approvalId: string;
  state: ApprovalRequest["state"];
  transactionId: string | null;
  receiptId: string | null;
  /** False when a previous call already completed this approval. */
  executed: boolean;
}

export async function executeApproval(input: ExecuteInput): Promise<ExecuteResult> {
  const db = input.db ?? getDb();
  const { auth } = input;

  const context = await loadApprovalContext(auth.workspace.id, input.approvalId, db);

  if (context.approval.state === "proved") {
    return {
      approvalId: context.approval.id,
      state: "proved",
      transactionId: (context.approval.resultPayload?.transactionId as string) ?? null,
      receiptId: (context.approval.resultPayload?.receiptId as string) ?? null,
      executed: false,
    };
  }

  if (context.approval.state !== "awaiting_payment_auth" && context.approval.state !== "executing") {
    throw new AppError(
      "INVALID_STATE_TRANSITION",
      `Cannot execute an approval in state ${context.approval.state}`,
      { state: context.approval.state, approvalId: context.approval.id },
    );
  }

  assertNotExpired(context.approval);

  if (!context.approval.pravaPaymentSessionId) {
    throw new AppError("INVALID_STATE_TRANSITION", "Approval has no payment session", {
      approvalId: context.approval.id,
    });
  }

  const result = await once<Record<string, unknown>>(
    {
      scope: "approval.execute",
      key: idempotencyKeyFor([context.approval.id, context.approval.pravaPaymentSessionId]),
      workspaceId: auth.workspace.id,
    },
    async () => runPipeline({ ...input, db }),
    db,
  );

  const payload = result.value as {
    state?: ApprovalRequest["state"];
    transactionId?: string | null;
    receiptId?: string | null;
  };

  return {
    approvalId: context.approval.id,
    state: payload.state ?? "proved",
    transactionId: payload.transactionId ?? null,
    receiptId: payload.receiptId ?? null,
    executed: result.executed,
  };
}

async function runPipeline(
  input: ExecuteInput & { db: Database },
): Promise<Record<string, unknown>> {
  const db = input.db;
  const { auth } = input;

  const context = await loadApprovalContext(auth.workspace.id, input.approvalId, db);
  let approval = context.approval;

  const [session] = await db
    .select()
    .from(paymentSessions)
    .where(eq(paymentSessions.id, approval.pravaPaymentSessionId!));
  if (!session) {
    throw new AppError("INVALID_STATE_TRANSITION", "Payment session is missing", {
      approvalId: approval.id,
    });
  }

  if (approval.state === "awaiting_payment_auth") {
    approval = await transition({
      approval,
      to: "executing",
      actorUserId: auth.user.id,
      data: { paymentSessionId: session.id },
      db,
    });
  }

  try {
    const completed = await completePayment({
      auth,
      session,
      subscription: context.subscription,
      decision: context.decision,
      ...(input.forceDecline ? { forceDecline: true } : {}),
      db,
    });

    // A renewal that was paid is no longer an identified opportunity.
    await retireIdentifiedForSubscription(context.subscription.id, db);

    // The renewal has moved on by one cycle; the inventory has to agree or the
    // next decision will propose paying it again.
    const nextRenewal = advanceRenewal(
      context.subscription.nextRenewalAt,
      context.subscription.billingCycle,
    );
    await db
      .update(subscriptions)
      .set({ nextRenewalAt: nextRenewal, lastSignalAt: new Date(), updatedAt: new Date() })
      .where(eq(subscriptions.id, context.subscription.id));

    const proved = await transition({
      approval,
      to: "proved",
      actorUserId: auth.user.id,
      patch: {
        resultPayload: {
          transactionId: completed.transaction.id,
          receiptId: completed.receiptId,
          amount: completed.transaction.amount,
          cardLast4: completed.transaction.cardLast4,
        },
      },
      data: {
        transactionId: completed.transaction.id,
        receiptId: completed.receiptId,
      },
      db,
    });

    await sendPayProof({
      auth,
      approval: proved,
      body: composePayProof({
        merchant: context.subscription.merchantName,
        amount: completed.transaction.amount,
        currency: completed.transaction.currency,
        receiptId: completed.receiptId ?? completed.transaction.id,
        nextRenewalAt: nextRenewal,
      }),
      db,
    });

    logger.info(
      { approvalId: approval.id, transactionId: completed.transaction.id },
      "approval proved",
    );

    return {
      state: "proved",
      transactionId: completed.transaction.id,
      receiptId: completed.receiptId,
    };
  } catch (error) {
    const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
    const message = error instanceof Error ? error.message : String(error);

    const failed = await transition({
      approval,
      to: "failed",
      actorUserId: auth.user.id,
      patch: { failureCode: code, resultPayload: { error: message } },
      data: { stage: "execute", code, reason: message },
      db,
    });

    await sendPayProof({
      auth,
      approval: failed,
      body: composeFailure({
        merchant: context.subscription.merchantName,
        reason: friendlyReason(code, message),
        // A decline is worth retrying; a policy block is not, until policy changes.
        canRetry: code === "CHECKOUT_DECLINED" || code === "PRAVA_ERROR",
      }),
      db,
    });

    throw error;
  }
}

function friendlyReason(code: string, message: string): string {
  switch (code) {
    case "CHECKOUT_DECLINED":
      return "the card was declined";
    case "PRAVA_ERROR":
      return "the payment rail did not complete";
    case "KILL_SWITCH_ENABLED":
      return "the kill switch is on";
    default:
      return message;
  }
}

/** Next renewal one cycle on from the last one. */
export function advanceRenewal(
  current: Date | null,
  cycle: "monthly" | "yearly" | "weekly" | "unknown",
): Date | null {
  if (!current) return null;
  const next = new Date(current.getTime());
  if (cycle === "yearly") next.setUTCFullYear(next.getUTCFullYear() + 1);
  else if (cycle === "weekly") next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}
