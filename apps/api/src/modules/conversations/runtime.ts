import { eq } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import {
  approvalRequests,
  subscriptions,
  type ApprovalRequest,
  type ChannelName,
  type ConversationThread,
  type DecisionPackageRow,
  type Subscription,
} from "../../db/schema.js";
import { env } from "../../env.js";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import type { AuthContext } from "../../types/context.js";
import { recordAudit } from "../audit/service.js";
import {
  assertNotExpired,
  findOpenApprovalForThread,
  loadApprovalContext,
  mintPayLink,
  transition,
} from "../approvals/service.js";
import { getChannelAdapter } from "../channels/registry.js";
import { PROPOSAL_ACTIONS } from "../channels/types.js";
import { decisionPackageSchema, isPayingAction } from "../decisions/engine.js";
import {
  composeActionProof,
  composeAttestationAsk,
  composeAuthLink,
  composeBlocked,
  composeFailure,
  composeHelp,
  composeKeepAck,
  composeProposal,
  composeSnoozeAck,
  composeStopAck,
  composeWhy,
} from "./composer.js";
import { parseIntent, type Intent } from "./intentParser.js";
import { acceptsIntent } from "./stateMachine.js";
import {
  ensureThread,
  enqueueOutbound,
  getActiveConnection,
  recordMessage,
} from "./service.js";

/**
 * The conversation runtime. Everything the agent says or reacts to passes
 * through here, so the rules about what may be said — and what an APPROVE is
 * allowed to trigger — live in exactly one place.
 */

export interface NotifyInput {
  auth: AuthContext;
  approval: ApprovalRequest;
  subscription: Subscription;
  decision: DecisionPackageRow;
  db?: Database;
}

export interface NotifyResult {
  approval: ApprovalRequest;
  thread: ConversationThread;
  body: string;
  outboxId: string;
}

/** Sends the proposal and moves the approval to awaiting_intent. */
export async function notifyApproval(input: NotifyInput): Promise<NotifyResult> {
  const db = input.db ?? getDb();
  const { auth, subscription, decision } = input;
  let approval = input.approval;

  const channel = approval.channel;
  const connection = await getActiveConnection(auth.workspace.id, channel, db);
  const packaged = decisionPackageSchema.parse(decision.payload);

  const thread = await ensureThread(
    {
      workspaceId: auth.workspace.id,
      channel,
      channelThreadId: threadIdFor(channel, connection.externalId),
      participantExternalId: connection.externalId,
    },
    db,
  );

  const body =
    isPayingAction(packaged.recommendation) || packaged.recommendation === "snooze"
      ? composeProposal({
          merchant: subscription.merchantName,
          // The first line describes the status quo: what renews, when, and what
          // it costs today. Using amount_due here would print the annual switch
          // price against the current monthly cycle and read as a price rise.
          amount: subscription.amount,
          currency: subscription.currency,
          cycle: subscription.billingCycle,
          renewalDate: subscription.nextRenewalAt,
          diagnosis: packaged.diagnosis,
          recommendation: packaged.recommendation,
          savingsAnnual: packaged.counterfactuals.recommended.savings_vs_do_nothing,
        })
      : composeAttestationAsk({
          merchant: subscription.merchantName,
          actionType: packaged.recommendation,
          portalUrl: null,
          savingsAnnual: packaged.counterfactuals.recommended.savings_vs_do_nothing,
          currency: subscription.currency,
        });

  approval = await transition({
    approval,
    to: "notified",
    actorUserId: auth.user.id,
    patch: { threadId: thread.id },
    data: { channel, threadId: thread.id },
    db,
  });

  const queued = await enqueueOutbound(
    {
      workspaceId: auth.workspace.id,
      threadId: thread.id,
      approvalRequestId: approval.id,
      channel,
      destination: connection.externalId,
      body,
      payload: { kind: "proposal", approvalId: approval.id, actions: PROPOSAL_ACTIONS },
      // One proposal per approval, however many times notify is called.
      dedupeKey: `proposal:${approval.id}`,
      quietHours: auth.settings.quietHoursJson,
    },
    db,
  );

  // The proposal is out; from here the user's reply is what moves it.
  approval = await transition({
    approval,
    to: "awaiting_intent",
    actorUserId: auth.user.id,
    data: { outboxId: queued.id },
    db,
  });

  return { approval, thread, body, outboxId: queued.id };
}

function threadIdFor(channel: ChannelName, externalId: string): string {
  const prefix = channel === "imessage" ? "linq" : channel === "whatsapp" ? "wa" : "sim";
  return `${prefix}_thread_${externalId}`;
}

/* -------------------------------------------------------------------------- */
/* Inbound                                                                    */
/* -------------------------------------------------------------------------- */

export interface HandleInboundInput {
  auth: AuthContext;
  thread: ConversationThread;
  text: string;
  tapback?: string | null;
  externalMessageId: string;
  db?: Database;
}

export interface HandleInboundResult {
  intent: Intent;
  approvalId: string | null;
  state: ApprovalRequest["state"] | null;
  reply: string | null;
  /** True when this intent started a payment or an execution. */
  acted: boolean;
}

/**
 * Interprets one inbound message and applies it. Intents that do not map to an
 * open approval still get an answer — an agent that goes silent on "why" is
 * worse than one that says it does not know.
 */
export async function handleInbound(
  input: HandleInboundInput,
): Promise<HandleInboundResult> {
  const db = input.db ?? getDb();
  const { auth, thread } = input;

  const parsed = parseIntent({ text: input.text, tapback: input.tapback ?? null });

  await recordAudit(
    {
      workspaceId: auth.workspace.id,
      actorUserId: auth.user.id,
      type: "intent.parsed",
      entityType: "conversation_thread",
      entityId: thread.id,
      data: { intent: parsed.intent, confidence: parsed.confidence, matchedOn: parsed.matchedOn },
    },
    db,
  );

  const open = await findOpenApprovalForThread(thread.id, db);

  // Channel-level intents work with or without an open proposal.
  if (parsed.intent === "STOP") {
    await reply(auth, thread, composeStopAck(), db, { urgent: true });
    if (open) {
      await transition({
        approval: open,
        to: "cancelled_by_user",
        actorUserId: auth.user.id,
        data: { intent: "STOP" },
        db,
      });
    }
    return {
      intent: "STOP",
      approvalId: open?.id ?? null,
      state: "cancelled_by_user",
      reply: composeStopAck(),
      acted: false,
    };
  }

  if (parsed.intent === "HELP" || !open) {
    const body = parsed.intent === "HELP" ? composeHelp() : noOpenApprovalReply(parsed.intent);
    await reply(auth, thread, body, db, { urgent: true });
    return {
      intent: parsed.intent,
      approvalId: null,
      state: null,
      reply: body,
      acted: false,
    };
  }

  const context = await loadApprovalContext(auth.workspace.id, open.id, db);
  const packaged = decisionPackageSchema.parse(context.decision.payload);

  // WHY is informational and must not consume the approval.
  if (parsed.intent === "WHY") {
    const body = composeWhy({
      merchant: context.subscription.merchantName,
      doNothingAnnual: packaged.counterfactuals.do_nothing.annual_cost,
      recommendedAnnual: packaged.counterfactuals.recommended.annual_cost,
      savingsAnnual: packaged.counterfactuals.recommended.savings_vs_do_nothing,
      currency: context.subscription.currency,
      inputsUsed: packaged.inputs_used,
    });
    await reply(auth, thread, body, db, { urgent: true });
    return { intent: "WHY", approvalId: open.id, state: open.state, reply: body, acted: false };
  }

  if (!acceptsIntent(open.state)) {
    // Mid-execution. Say so rather than silently dropping the message.
    const body = `That is already in progress (${open.state}). I will report back when it finishes.`;
    await reply(auth, thread, body, db, { urgent: true });
    return { intent: parsed.intent, approvalId: open.id, state: open.state, reply: body, acted: false };
  }

  if (parsed.intent === "KEEP") {
    const updated = await transition({
      approval: open,
      to: "cancelled_by_user",
      actorUserId: auth.user.id,
      data: { intent: "KEEP" },
      db,
    });
    const body = composeKeepAck(context.subscription.merchantName);
    await reply(auth, thread, body, db, { urgent: true });
    return { intent: "KEEP", approvalId: open.id, state: updated.state, reply: body, acted: false };
  }

  if (parsed.intent === "SNOOZE") {
    const updated = await transition({
      approval: open,
      to: "cancelled_by_user",
      actorUserId: auth.user.id,
      data: { intent: "SNOOZE", snoozedDays: 14 },
      db,
    });
    const body = composeSnoozeAck(context.subscription.merchantName, 14);
    await reply(auth, thread, body, db, { urgent: true });
    return { intent: "SNOOZE", approvalId: open.id, state: updated.state, reply: body, acted: false };
  }

  if (parsed.intent === "APPROVE" || parsed.intent === "DONE") {
    return applyApprove(auth, thread, open, context.subscription, context.decision, parsed.intent, db);
  }

  // RETRY and UNKNOWN both mean "we did not act"; give the user the commands.
  const body =
    parsed.intent === "RETRY"
      ? "Nothing to retry on this proposal. Reply APPROVE to go ahead."
      : composeHelp();
  await reply(auth, thread, body, db, { urgent: true });
  return { intent: parsed.intent, approvalId: open.id, state: open.state, reply: body, acted: false };
}

function noOpenApprovalReply(intent: Intent): string {
  if (intent === "APPROVE") return "There is nothing waiting for approval right now.";
  if (intent === "WHY") return "There is no open proposal to explain right now.";
  return composeHelp();
}

/**
 * The consent moment. A paying action gets a Prava session and a passkey link;
 * an attested action goes straight to executing because there is no money leg.
 */
async function applyApprove(
  auth: AuthContext,
  thread: ConversationThread,
  approval: ApprovalRequest,
  subscription: Subscription,
  decision: DecisionPackageRow,
  intent: Intent,
  db: Database,
): Promise<HandleInboundResult> {
  try {
    assertNotExpired(approval);
  } catch (error) {
    if (error instanceof AppError && error.code === "APPROVAL_EXPIRED") {
      const body = composeBlocked("APPROVAL_EXPIRED", "Ask me to look at it again.");
      await reply(auth, thread, body, db, { urgent: true });
      await transition({
        approval,
        to: "expired",
        actorUserId: auth.user.id,
        data: { reason: "expired_on_intent" },
        db,
      }).catch(() => undefined);
      return { intent, approvalId: approval.id, state: "expired", reply: body, acted: false };
    }
    throw error;
  }

  if (auth.settings.killSwitch) {
    const body = composeBlocked("KILL_SWITCH_ENABLED", "Turn it off in settings and reply again.");
    await reply(auth, thread, body, db, { urgent: true });
    await recordAudit(
      {
        workspaceId: auth.workspace.id,
        actorUserId: auth.user.id,
        type: "payment.blocked",
        entityType: "approval_request",
        entityId: approval.id,
        data: { reason: "KILL_SWITCH_ENABLED", intent },
      },
      db,
    );
    return { intent, approvalId: approval.id, state: approval.state, reply: body, acted: false };
  }

  const needsPayment = isPayingAction(decision.recommendation);

  if (!needsPayment) {
    // cancel / rightsize: the user does it, we log it. Executing here means
    // "recording the attestation", not "charging a card".
    const { confirmAttestedAction } = await import("../actions/attestedActions.js");

    const executing = await transition({
      approval,
      to: "executing",
      actorUserId: auth.user.id,
      data: { intent, attested: true },
      db,
    });

    const result = await confirmAttestedAction({
      auth,
      subscription,
      decision,
      approvalRequestId: approval.id,
      db,
    });

    const body = composeActionProof({
      actionSummary:
        result.actionType === "cancel"
          ? `Cancelled ${subscription.merchantName}`
          : `Rightsized ${subscription.merchantName}`,
      amountSaved: result.amountSaved,
      currency: subscription.currency,
    });

    const proved = await transition({
      approval: executing,
      to: "proved",
      actorUserId: auth.user.id,
      patch: {
        resultPayload: {
          savingsEntryId: result.savingsEntryId,
          amountSaved: result.amountSaved,
          actionType: result.actionType,
        },
      },
      data: { savingsEntryId: result.savingsEntryId, amountSaved: result.amountSaved },
      db,
    });

    await reply(auth, thread, body, db, { urgent: true, approvalId: approval.id });
    return { intent, approvalId: approval.id, state: proved.state, reply: body, acted: true };
  }

  // Paying action: open a Prava session and hand the user a passkey link.
  const { createPaymentSession } = await import("../payments/service.js");

  let session;
  try {
    session = await createPaymentSession({ auth, subscription, decision, db });
  } catch (error) {
    const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
    const body =
      code === "KILL_SWITCH_ENABLED" ||
      code === "CONFIRMATION_REQUIRED" ||
      code === "APPROVAL_REQUIRED" ||
      code === "INVALID_DECISION_STATE"
        ? composeBlocked(code)
        : composeFailure({
            merchant: subscription.merchantName,
            reason: error instanceof Error ? error.message : "the payment rail refused",
            canRetry: true,
          });

    await reply(auth, thread, body, db, { urgent: true, approvalId: approval.id });
    await transition({
      approval,
      to: "failed",
      actorUserId: auth.user.id,
      patch: { failureCode: code },
      data: { stage: "session", code },
      db,
    }).catch(() => undefined);

    return { intent, approvalId: approval.id, state: "failed", reply: body, acted: false };
  }

  const payLink = mintPayLink(approval.id);

  const updated = await transition({
    approval,
    to: "awaiting_payment_auth",
    actorUserId: auth.user.id,
    patch: {
      pravaPaymentSessionId: session.session.id,
      pravaHostedUrl: session.iframeUrl,
      payTokenHash: payLink.tokenHash,
    },
    data: { paymentSessionId: session.session.id, pravaSessionId: session.session.pravaSessionId },
    db,
  });

  const body = composeAuthLink({
    merchant: subscription.merchantName,
    amount: session.session.amount,
    currency: session.session.currency,
    payLink: payLink.url,
    expiresInMinutes: env.APPROVAL_TTL_MINUTES,
  });

  await reply(auth, thread, body, db, { urgent: true, approvalId: approval.id });

  return { intent, approvalId: approval.id, state: updated.state, reply: body, acted: true };
}

/** Queues an outbound reply on the thread. */
async function reply(
  auth: AuthContext,
  thread: ConversationThread,
  body: string,
  db: Database,
  options: { urgent?: boolean; approvalId?: string } = {},
): Promise<void> {
  await enqueueOutbound(
    {
      workspaceId: auth.workspace.id,
      threadId: thread.id,
      approvalRequestId: options.approvalId ?? null,
      channel: thread.channel,
      destination: thread.participantExternalId,
      body,
      payload: { kind: "reply" },
      quietHours: auth.settings.quietHoursJson,
      // A reply to something the user just typed is never deferred.
      urgent: options.urgent ?? true,
    },
    db,
  );
}

/**
 * Delivers one queued outbound message through its channel adapter and records
 * it on the thread. Called by the worker; safe to call repeatedly.
 */
export async function deliverOutbound(
  outbox: {
    id: string;
    workspaceId: string;
    threadId: string | null;
    channel: ChannelName;
    destination: string;
    body: string;
    payload: Record<string, unknown>;
  },
  db: Database = getDb(),
): Promise<{ externalMessageId: string }> {
  const adapter = getChannelAdapter(outbox.channel);
  const isProposal = outbox.payload.kind === "proposal";

  const result = isProposal
    ? await adapter.sendProposal({
        to: outbox.destination,
        proposal: { body: outbox.body },
        actions: PROPOSAL_ACTIONS,
        threadId: undefined,
      })
    : await adapter.sendText({ to: outbox.destination, body: outbox.body });

  if (outbox.threadId) {
    const message = await recordMessage(
      {
        threadId: outbox.threadId,
        workspaceId: outbox.workspaceId,
        direction: "outbound",
        role: "agent",
        body: outbox.body,
        payload: outbox.payload,
        externalMessageId: result.externalMessageId,
      },
      db,
    );

    // The proposal message id is what a channel reply threads back to.
    if (isProposal && typeof outbox.payload.approvalId === "string") {
      await db
        .update(approvalRequests)
        .set({ outboundMessageId: message.id })
        .where(eq(approvalRequests.id, outbox.payload.approvalId));
    }
  }

  await recordAudit(
    {
      workspaceId: outbox.workspaceId,
      type: "message.outbound",
      entityType: "outbox_message",
      entityId: outbox.id,
      data: { channel: outbox.channel, kind: outbox.payload.kind ?? "text" },
    },
    db,
  );

  logger.debug({ outboxId: outbox.id, channel: outbox.channel }, "outbound delivered");
  return { externalMessageId: result.externalMessageId };
}

/** Sends the in-thread proof after a payment settles. */
export async function sendPayProof(
  input: {
    auth: AuthContext;
    approval: ApprovalRequest;
    body: string;
    db?: Database;
  },
): Promise<void> {
  const db = input.db ?? getDb();
  if (!input.approval.threadId) return;

  const [subscription] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, input.approval.subscriptionId));

  await enqueueOutbound(
    {
      workspaceId: input.auth.workspace.id,
      threadId: input.approval.threadId,
      approvalRequestId: input.approval.id,
      channel: input.approval.channel,
      destination: await destinationForApproval(input.approval, db),
      body: input.body,
      payload: { kind: "proof", merchant: subscription?.merchantName ?? null },
      dedupeKey: `proof:${input.approval.id}`,
      urgent: true,
    },
    db,
  );
}

async function destinationForApproval(
  approval: ApprovalRequest,
  db: Database,
): Promise<string> {
  if (!approval.threadId) throw new AppError("CHANNEL_NOT_CONNECTED", "Approval has no thread");
  const { getThread } = await import("./service.js");
  const thread = await getThread(approval.workspaceId, approval.threadId, db);
  return thread.participantExternalId;
}
