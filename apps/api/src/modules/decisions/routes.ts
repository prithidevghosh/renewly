import { Hono } from "hono";
import { z } from "zod";
import { isTest } from "../../env.js";
import { notFound } from "../../lib/errors.js";
import { decimalString, readJson } from "../../lib/http.js";
import { requireAuth } from "../../middleware/auth.js";
import type { AppEnv } from "../../types/context.js";
import { confirmAttestedAction, startAttestedAction } from "../actions/attestedActions.js";
import { createApproval, serializeApproval } from "../approvals/service.js";
import { notifyApproval } from "../conversations/runtime.js";
import {
  completePayment,
  createPaymentSession,
  findLatestSessionForDecision,
  getPaymentSession,
  serializePaymentSession,
  serializeTransaction,
} from "../payments/service.js";
import { getSubscription, serializeSubscription } from "../subscriptions/service.js";
import { getDecision, serializeDecision } from "./service.js";

export const decisionRoutes = new Hono<AppEnv>();

decisionRoutes.use("*", requireAuth());

decisionRoutes.get("/:id", async (c) => {
  const { workspace } = c.get("auth");
  const decision = await getDecision(workspace.id, c.req.param("id"));
  return c.json({ decision: serializeDecision(decision) });
});

/* -------------------------------------------------------------------------- */
/* Approvals — the messaging spine                                            */
/* -------------------------------------------------------------------------- */

/**
 * Creates the approval for a decision and sends the proposal to the user's
 * primary channel. This is the normal way a decision reaches a human.
 */
decisionRoutes.post("/:id/approvals", async (c) => {
  const auth = c.get("auth");
  const decision = await getDecision(auth.workspace.id, c.req.param("id"));
  const subscription = await getSubscription(auth.workspace.id, decision.subscriptionId);

  const body = await readJson(
    c,
    z
      .object({
        channel: z.enum(["imessage", "whatsapp", "simulator"]).optional(),
        notify: z.boolean().default(true),
      })
      .default({ notify: true }),
  );

  const { approval, created } = await createApproval({
    auth,
    subscription,
    decision,
    ...(body.channel ? { channel: body.channel } : {}),
  });

  if (body.notify && approval.state === "drafted") {
    const result = await notifyApproval({ auth, approval, subscription, decision });
    return c.json({ approval: serializeApproval(result.approval), body: result.body }, 201);
  }

  return c.json({ approval: serializeApproval(approval) }, created ? 201 : 200);
});

/* -------------------------------------------------------------------------- */
/* Direct pay — web fallback for the same pipeline the thread drives           */
/* -------------------------------------------------------------------------- */

decisionRoutes.post("/:id/pay/session", async (c) => {
  const auth = c.get("auth");
  const decision = await getDecision(auth.workspace.id, c.req.param("id"));
  const subscription = await getSubscription(auth.workspace.id, decision.subscriptionId);

  const body = await readJson(c, z.object({ amount: decimalString.optional() }).default({}));

  const result = await createPaymentSession({
    auth,
    subscription,
    decision,
    ...(body.amount !== undefined ? { requestedAmount: body.amount } : {}),
  });

  return c.json(
    {
      paymentSession: serializePaymentSession(result.session),
      // The session token is what the browser SDK needs to mount the iframe. It
      // is short-lived and scoped to this session only.
      sessionId: result.session.pravaSessionId,
      sessionToken: result.sessionToken,
      iframeUrl: result.iframeUrl,
      publishableKey: result.publishableKey,
    },
    201,
  );
});

decisionRoutes.post("/:id/pay/complete", async (c) => {
  const auth = c.get("auth");
  const decision = await getDecision(auth.workspace.id, c.req.param("id"));
  const subscription = await getSubscription(auth.workspace.id, decision.subscriptionId);

  const body = await readJson(
    c,
    z
      .object({ paymentSessionId: z.string().optional(), forceDecline: z.boolean().optional() })
      .default({}),
  );

  const session = body.paymentSessionId
    ? await getPaymentSession(auth.workspace.id, body.paymentSessionId)
    : await findLatestSessionForDecision(auth.workspace.id, decision.id);
  if (!session) throw notFound("Payment session for this decision");

  const result = await completePayment({
    auth,
    session,
    subscription,
    decision,
    // Honoured only under NODE_ENV=test; the service ignores it otherwise.
    ...(body.forceDecline && isTest() ? { forceDecline: true } : {}),
  });

  return c.json({
    paymentSession: serializePaymentSession(result.session),
    transaction: serializeTransaction(result.transaction),
    receiptId: result.receiptId,
  });
});

/* -------------------------------------------------------------------------- */
/* Attested actions — cancel and rightsize                                    */
/* -------------------------------------------------------------------------- */

decisionRoutes.post("/:id/cancel/start", async (c) => {
  const auth = c.get("auth");
  const decision = await getDecision(auth.workspace.id, c.req.param("id"));
  const subscription = await getSubscription(auth.workspace.id, decision.subscriptionId);

  const result = await startAttestedAction({ auth, subscription, decision });
  return c.json(
    { plan: result.plan, subscription: serializeSubscription(result.subscription) },
    201,
  );
});

decisionRoutes.post("/:id/cancel/confirm", async (c) => {
  const auth = c.get("auth");
  const decision = await getDecision(auth.workspace.id, c.req.param("id"));
  const subscription = await getSubscription(auth.workspace.id, decision.subscriptionId);

  const body = await readJson(
    c,
    z
      .object({
        note: z.string().max(1000).optional(),
        actualAnnualSaving: decimalString.optional(),
      })
      .default({}),
  );

  const result = await confirmAttestedAction({
    auth,
    subscription,
    decision,
    ...(body.note !== undefined ? { note: body.note } : {}),
    ...(body.actualAnnualSaving !== undefined
      ? { actualAnnualSaving: body.actualAnnualSaving }
      : {}),
  });

  return c.json({
    subscription: serializeSubscription(result.subscription),
    savingsEntryId: result.savingsEntryId,
    amountSaved: result.amountSaved,
    actionType: result.actionType,
  });
});
