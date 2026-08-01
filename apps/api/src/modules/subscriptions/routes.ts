import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../../db/client.js";
import { subscriptions } from "../../db/schema.js";
import { conflict } from "../../lib/errors.js";
import { currencyCode, decimalString, paginationSchema, readJson, readQuery } from "../../lib/http.js";
import { newId } from "../../lib/id.js";
import { normalizeAmount } from "../../lib/money.js";
import { requireAuth } from "../../middleware/auth.js";
import type { AppEnv } from "../../types/context.js";
import { recordAudit } from "../audit/service.js";
import { createApproval, serializeApproval } from "../approvals/service.js";
import { notifyApproval } from "../conversations/runtime.js";
import {
  generateDecisionPackage,
  listDecisionsForSubscription,
  serializeDecision,
} from "../decisions/service.js";
import {
  canonicalizeMerchant,
  getSubscription,
  listSubscriptions,
  lowConfidenceFields,
  serializeSubscription,
} from "./service.js";

const billingCycle = z.enum(["monthly", "yearly", "weekly", "unknown"]);
const criticality = z.enum(["must_keep", "nice_to_have", "experimental"]);
const status = z.enum(["active", "pending_cancel", "cancelled", "paused"]);

const createSchema = z.object({
  merchantName: z.string().min(1).max(200),
  planName: z.string().max(200).nullish(),
  amount: decimalString,
  currency: currencyCode.default("USD"),
  billingCycle: billingCycle.default("monthly"),
  nextRenewalAt: z.string().datetime().nullish(),
  cancelByAt: z.string().datetime().nullish(),
  criticality: criticality.default("nice_to_have"),
  jobCategory: z.string().max(120).nullish(),
  usageNote: z.string().max(2000).nullish(),
  seatsTotal: z.number().int().min(1).max(10_000).default(1),
  seatsActive: z.number().int().min(0).max(10_000).nullish(),
  notes: z.string().max(2000).nullish(),
  priceChangeNote: z.string().max(2000).nullish(),
  sourceType: z.enum(["manual", "email", "file", "csv"]).default("manual"),
  fieldConfidence: z.record(z.string(), z.number().min(0).max(1)).default({}),
});

// An empty patch would still bump updatedAt and write an audit event claiming a
// change that did not happen, so it is rejected rather than treated as a no-op.
const patchSchema = createSchema
  .partial()
  .extend({ status: status.optional() })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one field must be provided",
  });

export const subscriptionRoutes = new Hono<AppEnv>();

subscriptionRoutes.use("*", requireAuth());

subscriptionRoutes.get("/", async (c) => {
  const { workspace } = c.get("auth");
  const query = readQuery(c, paginationSchema.extend({ status: status.optional() }));
  const page = await listSubscriptions(workspace.id, query);
  return c.json({
    subscriptions: page.data.map(serializeSubscription),
    nextCursor: page.nextCursor,
  });
});

subscriptionRoutes.post("/", async (c) => {
  const { user, workspace } = c.get("auth");
  const input = await readJson(c, createSchema);
  const currency = input.currency;

  // Manually entered rows are trusted by definition; parsed rows carry the
  // parser's confidence and may need explicit confirmation before payment.
  const fieldConfidence =
    Object.keys(input.fieldConfidence).length > 0
      ? input.fieldConfidence
      : { amount: 1, merchant_name: 1, next_renewal_at: 1 };

  const [row] = await getDb()
    .insert(subscriptions)
    .values({
      id: newId("sub"),
      workspaceId: workspace.id,
      merchantName: input.merchantName,
      merchantCanonical: canonicalizeMerchant(input.merchantName),
      planName: input.planName ?? null,
      amount: normalizeAmount(input.amount, currency),
      currency,
      billingCycle: input.billingCycle,
      nextRenewalAt: input.nextRenewalAt ? new Date(input.nextRenewalAt) : null,
      cancelByAt: input.cancelByAt ? new Date(input.cancelByAt) : null,
      criticality: input.criticality,
      jobCategory: input.jobCategory ?? null,
      usageNote: input.usageNote ?? null,
      seatsTotal: input.seatsTotal,
      seatsActive: input.seatsActive ?? null,
      lastSignalAt: new Date(),
      notes: input.notes ?? null,
      priceChangeNote: input.priceChangeNote ?? null,
      sourceType: input.sourceType,
      fieldConfidence,
      confirmedAt: lowConfidenceFields(fieldConfidence).length === 0 ? new Date() : null,
    })
    .returning();
  if (!row) throw new Error("subscription insert returned no row");

  await recordAudit({
    workspaceId: workspace.id,
    actorUserId: user.id,
    type: "subscription.created",
    entityType: "subscription",
    entityId: row.id,
    data: { merchantName: row.merchantName, amount: row.amount, sourceType: row.sourceType },
  });

  return c.json({ subscription: serializeSubscription(row) }, 201);
});

subscriptionRoutes.get("/:id", async (c) => {
  const { workspace } = c.get("auth");
  const row = await getSubscription(workspace.id, c.req.param("id"));
  return c.json({ subscription: serializeSubscription(row) });
});

subscriptionRoutes.patch("/:id", async (c) => {
  const { user, workspace } = c.get("auth");
  const id = c.req.param("id");
  const existing = await getSubscription(workspace.id, id);
  const input = await readJson(c, patchSchema);

  const currency = input.currency ?? existing.currency;
  const patch: Partial<typeof subscriptions.$inferInsert> = { updatedAt: new Date() };

  if (input.merchantName !== undefined) {
    patch.merchantName = input.merchantName;
    patch.merchantCanonical = canonicalizeMerchant(input.merchantName);
  }
  if (input.planName !== undefined) patch.planName = input.planName ?? null;
  if (input.amount !== undefined) patch.amount = normalizeAmount(input.amount, currency);
  if (input.currency !== undefined) patch.currency = currency;
  if (input.billingCycle !== undefined) patch.billingCycle = input.billingCycle;
  if (input.nextRenewalAt !== undefined) {
    patch.nextRenewalAt = input.nextRenewalAt ? new Date(input.nextRenewalAt) : null;
  }
  if (input.cancelByAt !== undefined) {
    patch.cancelByAt = input.cancelByAt ? new Date(input.cancelByAt) : null;
  }
  if (input.criticality !== undefined) patch.criticality = input.criticality;
  if (input.jobCategory !== undefined) patch.jobCategory = input.jobCategory ?? null;
  if (input.usageNote !== undefined) patch.usageNote = input.usageNote ?? null;
  if (input.seatsTotal !== undefined) patch.seatsTotal = input.seatsTotal;
  if (input.seatsActive !== undefined) patch.seatsActive = input.seatsActive ?? null;
  if (input.notes !== undefined) patch.notes = input.notes ?? null;
  if (input.priceChangeNote !== undefined) patch.priceChangeNote = input.priceChangeNote ?? null;
  if (input.status !== undefined) {
    patch.status = input.status;
    patch.cancelledAt = input.status === "cancelled" ? new Date() : existing.cancelledAt;
  }
  if (input.fieldConfidence !== undefined) patch.fieldConfidence = input.fieldConfidence;

  // Changing a payment-gated field re-opens confirmation: the user approved the
  // old numbers, not these ones.
  const gatedChanged =
    input.amount !== undefined ||
    input.merchantName !== undefined ||
    input.nextRenewalAt !== undefined;
  if (gatedChanged && input.fieldConfidence === undefined) {
    patch.fieldConfidence = { ...existing.fieldConfidence, amount: 1, merchant_name: 1 };
  }

  const [row] = await getDb()
    .update(subscriptions)
    .set(patch)
    .where(and(eq(subscriptions.id, id), eq(subscriptions.workspaceId, workspace.id)))
    .returning();
  if (!row) throw new Error("subscription update returned no row");

  await recordAudit({
    workspaceId: workspace.id,
    actorUserId: user.id,
    type: "subscription.updated",
    entityType: "subscription",
    entityId: row.id,
    data: { changed: Object.keys(input) },
  });

  return c.json({ subscription: serializeSubscription(row) });
});

subscriptionRoutes.delete("/:id", async (c) => {
  const { user, workspace } = c.get("auth");
  const id = c.req.param("id");
  const existing = await getSubscription(workspace.id, id);

  await getDb()
    .delete(subscriptions)
    .where(and(eq(subscriptions.id, id), eq(subscriptions.workspaceId, workspace.id)));

  await recordAudit({
    workspaceId: workspace.id,
    actorUserId: user.id,
    type: "subscription.deleted",
    entityType: "subscription",
    entityId: id,
    data: { merchantName: existing.merchantName },
  });

  return c.json({ ok: true, id });
});

subscriptionRoutes.post("/:id/confirm", async (c) => {
  const { user, workspace } = c.get("auth");
  const id = c.req.param("id");
  const existing = await getSubscription(workspace.id, id);

  const input = await readJson(
    c,
    z
      .object({
        merchantName: z.string().min(1).max(200).optional(),
        amount: decimalString.optional(),
        nextRenewalAt: z.string().datetime().nullish(),
      })
      .default({}),
  );

  if (existing.status === "cancelled") {
    throw conflict("Cannot confirm a cancelled subscription", { subscriptionId: id });
  }

  const currency = existing.currency;
  const patch: Partial<typeof subscriptions.$inferInsert> = {
    confirmedAt: new Date(),
    updatedAt: new Date(),
  };
  if (input.merchantName !== undefined) {
    patch.merchantName = input.merchantName;
    patch.merchantCanonical = canonicalizeMerchant(input.merchantName);
  }
  if (input.amount !== undefined) patch.amount = normalizeAmount(input.amount, currency);
  if (input.nextRenewalAt !== undefined) {
    patch.nextRenewalAt = input.nextRenewalAt ? new Date(input.nextRenewalAt) : null;
  }

  // Confirmation is the user asserting the gated fields are correct, so their
  // confidence becomes 1 regardless of what the parser thought.
  patch.fieldConfidence = {
    ...existing.fieldConfidence,
    amount: 1,
    merchant_name: 1,
    next_renewal_at: 1,
  };

  const [row] = await getDb()
    .update(subscriptions)
    .set(patch)
    .where(and(eq(subscriptions.id, id), eq(subscriptions.workspaceId, workspace.id)))
    .returning();
  if (!row) throw new Error("subscription confirm returned no row");

  await recordAudit({
    workspaceId: workspace.id,
    actorUserId: user.id,
    type: "subscription.confirmed",
    entityType: "subscription",
    entityId: row.id,
    data: { corrected: Object.keys(input) },
  });

  return c.json({ subscription: serializeSubscription(row) });
});

/* -------------------------------------------------------------------------- */
/* Decisions scoped to a subscription                                         */
/* -------------------------------------------------------------------------- */

subscriptionRoutes.post("/:id/decisions", async (c) => {
  const auth = c.get("auth");
  const subscription = await getSubscription(auth.workspace.id, c.req.param("id"));
  const body = await readJson(
    c,
    z
      .object({
        regenerate: z.boolean().default(false),
        /** Creates the approval and puts the proposal in the user's thread. */
        notify: z.boolean().default(false),
        channel: z.enum(["imessage", "whatsapp", "simulator"]).optional(),
      })
      .default({ regenerate: false, notify: false }),
  );

  const decision = await generateDecisionPackage({
    auth,
    subscription,
    regenerate: body.regenerate,
  });

  let approval = null;
  if (body.notify) {
    // A snooze has nothing to ask about, so it is generated but never sent.
    if (decision.recommendation === "snooze") {
      return c.json(
        { decision: serializeDecision(decision), approval: null, notified: false },
        201,
      );
    }

    const created = await createApproval({
      auth,
      subscription,
      decision,
      ...(body.channel ? { channel: body.channel } : {}),
    });

    const notified =
      created.approval.state === "drafted"
        ? await notifyApproval({
            auth,
            approval: created.approval,
            subscription,
            decision,
          })
        : null;

    approval = serializeApproval(notified?.approval ?? created.approval);
  }

  return c.json(
    { decision: serializeDecision(decision), approval, notified: approval !== null },
    201,
  );
});

subscriptionRoutes.get("/:id/decisions", async (c) => {
  const { workspace } = c.get("auth");
  const subscription = await getSubscription(workspace.id, c.req.param("id"));
  const query = readQuery(c, paginationSchema);
  const page = await listDecisionsForSubscription(workspace.id, subscription.id, query);
  return c.json({ decisions: page.data.map(serializeDecision), nextCursor: page.nextCursor });
});
