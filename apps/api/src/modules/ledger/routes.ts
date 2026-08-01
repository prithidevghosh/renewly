import { Hono } from "hono";
import { z } from "zod";
import { paginationSchema, readQuery } from "../../lib/http.js";
import { requireAuth } from "../../middleware/auth.js";
import type { AppEnv } from "../../types/context.js";
import { listAudit } from "../audit/service.js";
import {
  getPaymentSession,
  serializePaymentSession,
  serializeTransaction,
} from "../payments/service.js";
import {
  getReceipt,
  listReceipts,
  listSavings,
  savingsSummary,
  serializeReceipt,
  serializeSavings,
} from "./service.js";

export const receiptRoutes = new Hono<AppEnv>();
receiptRoutes.use("*", requireAuth());

receiptRoutes.get("/", async (c) => {
  const { workspace } = c.get("auth");
  const query = readQuery(c, paginationSchema);
  const page = await listReceipts(workspace.id, query);
  return c.json({ receipts: page.data.map(serializeReceipt), nextCursor: page.nextCursor });
});

receiptRoutes.get("/:id", async (c) => {
  const { workspace } = c.get("auth");
  const { receipt, transaction } = await getReceipt(workspace.id, c.req.param("id"));
  return c.json({
    receipt: serializeReceipt(receipt),
    transaction: transaction ? serializeTransaction(transaction) : null,
  });
});

export const savingsRoutes = new Hono<AppEnv>();
savingsRoutes.use("*", requireAuth());

// Registered before "/" so the literal path wins over the list handler.
savingsRoutes.get("/summary", async (c) => {
  const { workspace, settings } = c.get("auth");
  const summary = await savingsSummary(workspace.id, settings.currency);
  return c.json(summary);
});

savingsRoutes.get("/", async (c) => {
  const { workspace } = c.get("auth");
  const query = readQuery(
    c,
    paginationSchema.extend({ recognition: z.enum(["identified", "realized"]).optional() }),
  );
  const page = await listSavings(workspace.id, query);
  return c.json({ savings: page.data.map(serializeSavings), nextCursor: page.nextCursor });
});

export const auditRoutes = new Hono<AppEnv>();
auditRoutes.use("*", requireAuth());

auditRoutes.get("/", async (c) => {
  const { workspace } = c.get("auth");
  const query = readQuery(c, paginationSchema.extend({ type: z.string().max(80).optional() }));
  const page = await listAudit(workspace.id, query);
  return c.json({
    events: page.data.map((event) => ({
      id: event.id,
      workspaceId: event.workspaceId,
      actorUserId: event.actorUserId,
      type: event.type,
      entityType: event.entityType,
      entityId: event.entityId,
      data: event.data,
      createdAt: event.createdAt.toISOString(),
    })),
    nextCursor: page.nextCursor,
  });
});

export const paymentSessionRoutes = new Hono<AppEnv>();
paymentSessionRoutes.use("*", requireAuth());

paymentSessionRoutes.get("/:id", async (c) => {
  const { workspace } = c.get("auth");
  const session = await getPaymentSession(workspace.id, c.req.param("id"));
  return c.json({ paymentSession: serializePaymentSession(session) });
});
