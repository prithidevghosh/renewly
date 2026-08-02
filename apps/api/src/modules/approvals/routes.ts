import { Hono, type Context } from "hono";
import { z } from "zod";
import { isTest } from "../../env.js";
import { AppError } from "../../lib/errors.js";
import { decimalString, paginationSchema, readJson, readQuery } from "../../lib/http.js";
import { requireAuth } from "../../middleware/auth.js";
import type { AppEnv, AuthContext } from "../../types/context.js";
import { confirmAttestedAction, startAttestedAction } from "../actions/attestedActions.js";
import { getThread } from "../conversations/service.js";
import { handleInbound, notifyApproval } from "../conversations/runtime.js";
import { executeApproval } from "../payments/executor.js";
import { serializeSubscription } from "../subscriptions/service.js";
import {
  assertNotExpired,
  authorizeByPayToken,
  listApprovals,
  loadApprovalContext,
  serializeApproval,
  transition,
  verifyPayToken,
} from "./service.js";

export const approvalRoutes = new Hono<AppEnv>();

approvalRoutes.use("*", requireAuth());

const approvalState = z.enum([
  "drafted",
  "notified",
  "awaiting_intent",
  "awaiting_payment_auth",
  "executing",
  "proved",
  "failed",
  "expired",
  "cancelled_by_user",
]);

approvalRoutes.get("/", async (c) => {
  const { workspace } = c.get("auth");
  const query = readQuery(c, paginationSchema.extend({ state: approvalState.optional() }));
  const page = await listApprovals(workspace.id, query);
  return c.json({
    approvals: page.data.map(serializeApproval),
    nextCursor: page.nextCursor,
  });
});

approvalRoutes.get("/:id", async (c) => {
  const auth = c.get("auth");
  const context = await loadApprovalContext(auth.workspace.id, c.req.param("id"));
  return c.json({
    approval: serializeApproval(context.approval),
    subscription: serializeSubscription(context.subscription),
  });
});

/**
 * Web and test fallback for the intent that would normally arrive over a
 * channel. It runs the same runtime path as an inbound webhook, so behaviour
 * cannot drift between the two entry points.
 */
approvalRoutes.post("/:id/intent", async (c) => {
  const auth = c.get("auth");
  const body = await readJson(
    c,
    z.object({
      intent: z.enum([
        "APPROVE",
        "KEEP",
        "CANCEL",
        "SNOOZE",
        "WHY",
        "STOP",
        "HELP",
        "RETRY",
        "DONE",
      ]),
    }),
  );

  const context = await loadApprovalContext(auth.workspace.id, c.req.param("id"));
  if (!context.approval.threadId) {
    throw new AppError("CHANNEL_NOT_CONNECTED", "This approval has not been sent to a thread yet", {
      approvalId: context.approval.id,
    });
  }

  const thread = await getThread(auth.workspace.id, context.approval.threadId);
  const result = await handleInbound({
    auth,
    thread,
    text: body.intent,
    externalMessageId: `web_${context.approval.id}_${Date.now()}`,
  });

  const refreshed = await loadApprovalContext(auth.workspace.id, context.approval.id);
  return c.json({
    approval: serializeApproval(refreshed.approval),
    intent: result.intent,
    reply: result.reply,
    acted: result.acted,
  });
});

/** Re-sends the proposal for an approval still sitting in drafted. */
approvalRoutes.post("/:id/notify", async (c) => {
  const auth = c.get("auth");
  const context = await loadApprovalContext(auth.workspace.id, c.req.param("id"));

  if (context.approval.state !== "drafted") {
    throw new AppError(
      "INVALID_STATE_TRANSITION",
      `Approval is already ${context.approval.state}`,
      { state: context.approval.state },
    );
  }

  const result = await notifyApproval({
    auth,
    approval: context.approval,
    subscription: context.subscription,
    decision: context.decision,
  });

  return c.json({ approval: serializeApproval(result.approval), body: result.body }, 201);
});

/**
 * What the pay page needs to mount the Prava iframe. Requires the single-use
 * token from the link, so possession of the approval id alone is not enough.
 */
approvalRoutes.get("/:id/pay-bootstrap", async (c) => {
  const auth = c.get("auth");
  const context = await loadApprovalContext(auth.workspace.id, c.req.param("id"));
  const token = c.req.query("token");

  if (context.approval.payTokenHash) {
    if (!token || !verifyPayToken(context.approval, token)) {
      throw new AppError("UNAUTHORIZED", "Invalid or missing pay token", {
        approvalId: context.approval.id,
      });
    }
  }

  return respondPayBootstrap(c, auth, c.req.param("id"));
});

approvalRoutes.post("/:id/prava/complete", async (c) => {
  return respondPravaComplete(c, c.get("auth"), c.req.param("id"));
});

async function respondPayBootstrap(
  c: Context<AppEnv>,
  auth: AuthContext,
  approvalId: string,
): Promise<Response> {
  const context = await loadApprovalContext(auth.workspace.id, approvalId);

  assertNotExpired(context.approval);

  if (!context.approval.pravaPaymentSessionId) {
    throw new AppError(
      "INVALID_STATE_TRANSITION",
      "No payment session yet; approve the proposal first",
      { state: context.approval.state },
    );
  }

  const { getPaymentSession } = await import("../payments/service.js");
  const session = await getPaymentSession(auth.workspace.id, context.approval.pravaPaymentSessionId);

  return c.json({
    approvalId: context.approval.id,
    sessionId: session.pravaSessionId,
    hostedUrl: context.approval.pravaHostedUrl ?? session.iframeUrl,
    amount: session.amount,
    currency: session.currency,
    merchantName: session.merchantName,
    expiresAt: context.approval.expiresAt.toISOString(),
  });
}

async function respondPravaComplete(
  c: Context<AppEnv>,
  auth: AuthContext,
  approvalId: string,
): Promise<Response> {
  const body = await readJson(
    c,
    z.object({ forceDecline: z.boolean().optional() }).default({}),
  );

  const result = await executeApproval({
    auth,
    approvalId,
    ...(body.forceDecline && isTest() ? { forceDecline: true } : {}),
  });

  const context = await loadApprovalContext(auth.workspace.id, approvalId);
  return c.json({
    approval: serializeApproval(context.approval),
    transactionId: result.transactionId,
    receiptId: result.receiptId,
    executed: result.executed,
  });
}

/**
 * The unauthenticated pay-link surface. The texted link is opened on whatever
 * device received it — no cookie, no bearer token — so these two routes accept
 * the single-use token as the whole credential.
 *
 * Mounted at the same prefix as `approvalRoutes`, but registered first: a
 * request carrying a token is handled here, and one without falls through via
 * `next()` to the session-authenticated router (which is how the dashboard,
 * already signed in, keeps calling the same paths without a token).
 */
export const payLinkRoutes = new Hono<AppEnv>();

payLinkRoutes.get("/:id/pay-bootstrap", async (c, next) => {
  const token = c.req.query("token");
  if (!token) return next();

  const { auth } = await authorizeByPayToken(c.req.param("id"), token);
  return respondPayBootstrap(c, auth, c.req.param("id"));
});

payLinkRoutes.post("/:id/prava/complete", async (c, next) => {
  const token = c.req.query("token");
  if (!token) return next();

  const { auth } = await authorizeByPayToken(c.req.param("id"), token);
  return respondPravaComplete(c, auth, c.req.param("id"));
});

/** Starts an attested action and returns the checklist. */
approvalRoutes.post("/:id/cancel/start", async (c) => {
  const auth = c.get("auth");
  const context = await loadApprovalContext(auth.workspace.id, c.req.param("id"));

  const result = await startAttestedAction({
    auth,
    subscription: context.subscription,
    decision: context.decision,
  });

  return c.json(
    { plan: result.plan, subscription: serializeSubscription(result.subscription) },
    201,
  );
});

approvalRoutes.post("/:id/cancel/confirm", async (c) => {
  const auth = c.get("auth");
  const body = await readJson(
    c,
    z
      .object({
        note: z.string().max(1000).optional(),
        actualAnnualSaving: decimalString.optional(),
      })
      .default({}),
  );

  const context = await loadApprovalContext(auth.workspace.id, c.req.param("id"));

  // Walk the approval to proved alongside the attestation, so the thread and
  // the ledger tell the same story.
  let approval = context.approval;
  if (approval.state === "notified" || approval.state === "awaiting_intent") {
    approval = await transition({
      approval,
      to: "executing",
      actorUserId: auth.user.id,
      data: { attested: true },
    });
  }

  const result = await confirmAttestedAction({
    auth,
    subscription: context.subscription,
    decision: context.decision,
    approvalRequestId: approval.id,
    ...(body.note !== undefined ? { note: body.note } : {}),
    ...(body.actualAnnualSaving !== undefined
      ? { actualAnnualSaving: body.actualAnnualSaving }
      : {}),
  });

  if (approval.state === "executing") {
    approval = await transition({
      approval,
      to: "proved",
      actorUserId: auth.user.id,
      patch: {
        resultPayload: {
          savingsEntryId: result.savingsEntryId,
          amountSaved: result.amountSaved,
          actionType: result.actionType,
        },
      },
      data: { savingsEntryId: result.savingsEntryId },
    });
  }

  return c.json({
    approval: serializeApproval(approval),
    subscription: serializeSubscription(result.subscription),
    savingsEntryId: result.savingsEntryId,
    amountSaved: result.amountSaved,
  });
});
