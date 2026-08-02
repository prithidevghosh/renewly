import { and, eq } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import {
  subscriptions,
  type ApprovalRequest,
  type ConversationThread,
  type DecisionPackageRow,
  type Subscription,
} from "../../db/schema.js";
import { getLlmClient, type ChatReplyContext } from "../../lib/llm.js";
import { logger } from "../../lib/logger.js";
import type { AuthContext } from "../../types/context.js";
import { decisionPackageSchema, isPayingAction } from "../decisions/engine.js";
import { composeHelp } from "./composer.js";
import { listMessages } from "./service.js";

/**
 * The reply for a message the rules could not read.
 *
 * `parseIntent` decides what a message *does* and stays the only thing that
 * can. This decides what we *say* when that parser returned UNKNOWN — which
 * previously meant printing the command list, so "hi" and "what am I paying
 * for?" both got the same six-line menu.
 *
 * The model is never in the consent path. It is called only after the rules
 * have declined to act, its answer is discarded for anything that would move
 * money, and the caller performs no action on the back of it. The worst a bad
 * generation can do is say something unhelpful.
 */

/** Turns of history to give the model. Enough for "what about the other one?". */
const HISTORY_TURNS = 6;

export interface ComposeFallbackInput {
  auth: AuthContext;
  thread: ConversationThread;
  text: string;
  /** The proposal in front of the user, when one is open. */
  open: {
    approval: ApprovalRequest;
    subscription: Subscription;
    decision: DecisionPackageRow;
  } | null;
  db?: Database;
}

/**
 * Returns the reply to send. Falls back to the command list whenever the model
 * is unavailable, fails, or produces something we will not send — so this
 * function always returns something sendable.
 */
export async function composeFallbackReply(
  input: ComposeFallbackInput,
): Promise<{ body: string; source: "llm" | "static" }> {
  const llm = getLlmClient();
  if (!llm.available) return { body: composeHelp(), source: "static" };

  const db = input.db ?? getDb();

  try {
    const context = await buildContext(input, db);
    const written = await llm.chatReply(context);

    if (!written) return { body: composeHelp(), source: "static" };

    const body = written.reply.trim();
    if (!body) return { body: composeHelp(), source: "static" };

    /*
     * A model that has decided the user approved something will happily write
     * "done, I've approved that". It has not been approved — nothing here acts
     * — so sending that text would be a lie the user then relies on. When the
     * model reads the message as an instruction to do something, we send the
     * command list instead, which is the one reply that is always true.
     */
    if (ACTING_INTENTS.has(written.intent)) {
      return { body: needsExactWord(written.intent, input.open !== null), source: "static" };
    }

    if (claimsToHaveActed(body)) {
      logger.warn({ threadId: input.thread.id }, "discarded an llm reply that claimed an action");
      return { body: composeHelp(), source: "static" };
    }

    return { body, source: "llm" };
  } catch (error) {
    logger.error({ err: error, threadId: input.thread.id }, "chat reply failed");
    return { body: composeHelp(), source: "static" };
  }
}

/** Intents that would move something, and so must be typed by the user exactly. */
const ACTING_INTENTS = new Set(["approve", "keep", "later", "done", "stop"]);

function needsExactWord(intent: string, hasOpenProposal: boolean): string {
  if (!hasOpenProposal) {
    return "There is nothing waiting on you right now. I will text you when a renewal is close.";
  }
  const word = intent === "later" ? "LATER" : intent.toUpperCase();
  return `Reply ${word} on its own and I will act on it.`;
}

/**
 * Phrases that assert an action has already happened. The model is told not to
 * write these; this is the check that they never reach the user anyway.
 */
const CLAIMED_ACTION_RE =
  /\b(i(?:'ve| have)?\s+(?:now\s+)?(?:approved|cancelled|canceled|paid|charged|switched|scheduled|snoozed|stopped|done)|has been (?:approved|cancelled|canceled|paid|charged)|payment (?:sent|made|complete)|all done|consider it done)\b/i;

function claimsToHaveActed(body: string): boolean {
  return CLAIMED_ACTION_RE.test(body);
}

async function buildContext(
  input: ComposeFallbackInput,
  db: Database,
): Promise<ChatReplyContext> {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.workspaceId, input.auth.workspace.id),
        eq(subscriptions.status, "active"),
      ),
    );

  const messages = await listMessages(input.thread.id, db);
  const history = messages.slice(-HISTORY_TURNS).map((message) => ({
    role: message.direction === "inbound" ? ("user" as const) : ("agent" as const),
    text: message.body.slice(0, 400),
  }));

  return {
    message: input.text.slice(0, 1_000),
    proposal: input.open ? describeProposal(input.open) : null,
    subscriptions: rows.map((row) => ({
      merchant: row.merchantName,
      amount: row.amount,
      currency: row.currency,
      cycle: row.billingCycle,
    })),
    history,
  };
}

function describeProposal(open: NonNullable<ComposeFallbackInput["open"]>) {
  const packaged = decisionPackageSchema.parse(open.decision.payload);
  return {
    merchant: open.subscription.merchantName,
    amount: open.subscription.amount,
    currency: open.subscription.currency,
    billingCycle: open.subscription.billingCycle,
    recommendation: packaged.recommendation,
    headline: packaged.headline,
    savingsAnnual: packaged.counterfactuals.recommended.savings_vs_do_nothing,
    doNothingAnnual: packaged.counterfactuals.do_nothing.annual_cost,
    recommendedAnnual: packaged.counterfactuals.recommended.annual_cost,
    movesMoney: isPayingAction(packaged.recommendation),
  };
}
