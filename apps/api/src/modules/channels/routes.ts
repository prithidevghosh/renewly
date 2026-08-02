import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { getDb } from "../../db/client.js";
import { conversationMessages, type ChannelName } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import { readJson } from "../../lib/http.js";
import { logger } from "../../lib/logger.js";
import { requireAuth } from "../../middleware/auth.js";
import type { AppEnv } from "../../types/context.js";
import { recordAudit } from "../audit/service.js";
import { resolveAuthContext } from "../auth/service.js";
import { handleInbound } from "../conversations/runtime.js";
import {
  connectChannel,
  ensureThread,
  findConnectionByExternalId,
  getThread,
  isDuplicateInbound,
  listConnections,
  listMessages,
  recordMessage,
  revokeChannel,
} from "../conversations/service.js";
import { getChannelAdapter } from "./registry.js";

/**
 * WhatsApp is removed. The simulator stays nameable because the registry is the
 * authority on what can actually send: it refuses the simulator at runtime and
 * serves it only when a test has installed the double. Rejecting the name here
 * as well would report a validation problem for what is really an availability
 * one, and would say it before the request reached the component that knows.
 */
const channelName = z.enum(["imessage", "simulator"]);

/* -------------------------------------------------------------------------- */
/* Authenticated channel management                                           */
/* -------------------------------------------------------------------------- */

export const channelRoutes = new Hono<AppEnv>();

channelRoutes.use("*", requireAuth());

channelRoutes.get("/", async (c) => {
  const { workspace } = c.get("auth");
  const rows = await listConnections(workspace.id);
  return c.json({
    channels: rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      externalId: row.externalId,
      status: row.status,
      metadata: row.metadata,
      createdAt: row.createdAt.toISOString(),
    })),
  });
});

channelRoutes.post("/connect", async (c) => {
  const { user, workspace } = c.get("auth");
  const input = await readJson(
    c,
    z.object({
      channel: channelName,
      external_id: z.string().min(1).max(120).optional(),
      externalId: z.string().min(1).max(120).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  );

  const externalId = input.externalId ?? input.external_id;
  if (!externalId) {
    throw new AppError("VALIDATION_ERROR", "externalId is required", {});
  }

  const row = await connectChannel({
    workspaceId: workspace.id,
    userId: user.id,
    channel: input.channel,
    externalId,
    ...(input.metadata ? { metadata: input.metadata as Record<string, unknown> } : {}),
  });

  await recordAudit({
    workspaceId: workspace.id,
    actorUserId: user.id,
    type: "channel.connected",
    entityType: "channel_connection",
    entityId: row.id,
    data: { channel: row.channel },
  });

  c.get("log").info(
    { channelId: row.id, channel: row.channel, status: row.status },
    `channel connected — ${row.channel}`,
  );

  return c.json(
    {
      channel: {
        id: row.id,
        channel: row.channel,
        externalId: row.externalId,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      },
    },
    201,
  );
});

channelRoutes.delete("/:id", async (c) => {
  const { user, workspace } = c.get("auth");
  const row = await revokeChannel(workspace.id, c.req.param("id"));

  await recordAudit({
    workspaceId: workspace.id,
    actorUserId: user.id,
    type: "channel.revoked",
    entityType: "channel_connection",
    entityId: row.id,
    data: { channel: row.channel },
  });

  return c.json({ ok: true, id: row.id, status: row.status });
});

/** Reads the simulator thread so tests and demos can see what was sent. */
channelRoutes.get("/simulator/threads/:id/messages", async (c) => {
  const { workspace } = c.get("auth");
  const thread = await getThread(workspace.id, c.req.param("id"));
  const messages = await listMessages(thread.id);

  return c.json({
    thread: {
      id: thread.id,
      channel: thread.channel,
      channelThreadId: thread.channelThreadId,
      participantExternalId: thread.participantExternalId,
    },
    messages: messages.map(serializeMessage),
  });
});

/** All simulator messages for the workspace, newest last. */
channelRoutes.get("/simulator/messages", async (c) => {
  const { workspace } = c.get("auth");
  const rows = await getDb()
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.workspaceId, workspace.id));

  return c.json({
    messages: rows.sort((a, b) => a.id.localeCompare(b.id)).map(serializeMessage),
  });
});

function serializeMessage(row: typeof conversationMessages.$inferSelect) {
  return {
    id: row.id,
    threadId: row.threadId,
    direction: row.direction,
    role: row.role,
    body: row.body,
    payload: row.payload,
    externalMessageId: row.externalMessageId,
    createdAt: row.createdAt.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Webhooks — unauthenticated, verified by signature                          */
/* -------------------------------------------------------------------------- */

export const channelWebhookRoutes = new Hono<AppEnv>();

channelWebhookRoutes.post("/linq", (c) => handleChannelWebhook(c, "imessage"));
channelWebhookRoutes.post("/simulator", (c) => handleChannelWebhook(c, "simulator"));

async function handleChannelWebhook(c: Context<AppEnv>, channel: ChannelName) {
  const rawBody = await c.req.text();
  const adapter = getChannelAdapter(channel);

  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(c.req.header())) {
    if (typeof value === "string") headers[key.toLowerCase()] = value;
  }

  // Throws WEBHOOK_INVALID_SIGNATURE on a payload we cannot attribute.
  const payload = adapter.verifyWebhook({ rawBody, headers });
  const inbound = adapter.parseInbound(payload);

  // Delivery receipts and status callbacks are acknowledged, not processed.
  if (!inbound) return c.json({ ok: true, ignored: true });

  const connection = await findConnectionByExternalId(channel, inbound.from);
  if (!connection) {
    // An unknown sender is not an error the provider can fix, so 200 and drop.
    logger.warn(
      { channel, from: inbound.from },
      `inbound message from an unconnected handle on ${channel} — dropped`,
    );
    return c.json({ ok: true, ignored: true, reason: "CHANNEL_NOT_CONNECTED" });
  }

  // At-least-once delivery is normal; a replayed message must not act twice.
  if (await isDuplicateInbound(inbound.externalMessageId)) {
    return c.json({ ok: true, duplicate: true });
  }

  const auth = await resolveAuthContext(connection.userId, connection.workspaceId);

  const thread = await ensureThread({
    workspaceId: connection.workspaceId,
    channel,
    channelThreadId: inbound.externalThreadId,
    participantExternalId: inbound.from,
  });

  await recordMessage({
    threadId: thread.id,
    workspaceId: connection.workspaceId,
    direction: "inbound",
    role: "user",
    body: inbound.text || `[${inbound.tapback}]`,
    payload: { tapback: inbound.tapback ?? null },
    externalMessageId: inbound.externalMessageId,
  });

  await recordAudit({
    workspaceId: connection.workspaceId,
    actorUserId: connection.userId,
    type: "message.inbound",
    entityType: "conversation_thread",
    entityId: thread.id,
    data: { channel, externalMessageId: inbound.externalMessageId },
  });

  logger.info(
    { channel, threadId: thread.id, externalMessageId: inbound.externalMessageId },
    `inbound ${channel} message — "${(inbound.text || inbound.tapback || "").slice(0, 60)}"`,
  );

  const result = await handleInbound({
    auth,
    thread,
    text: inbound.text,
    tapback: inbound.tapback ?? null,
    externalMessageId: inbound.externalMessageId,
  });

  return c.json({
    ok: true,
    intent: result.intent,
    approvalId: result.approvalId,
    state: result.state,
    acted: result.acted,
  });
}
