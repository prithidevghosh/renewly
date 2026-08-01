import { and, asc, desc, eq } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import {
  channelConnections,
  conversationMessages,
  conversationThreads,
  outboxMessages,
  type ChannelConnection,
  type ChannelName,
  type ConversationMessage,
  type ConversationThread,
} from "../../db/schema.js";
import { env } from "../../env.js";
import { AppError, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/id.js";
import type { QuietHours } from "../../db/schema.js";

/**
 * Threads, messages and the outbound queue. Outbound sends go through the
 * outbox rather than straight to the adapter so a transient provider failure
 * cannot lose a proposal, and so quiet hours can defer a message without
 * dropping it.
 */

export async function getActiveConnection(
  workspaceId: string,
  channel: ChannelName,
  db: Database = getDb(),
): Promise<ChannelConnection> {
  const [row] = await db
    .select()
    .from(channelConnections)
    .where(
      and(
        eq(channelConnections.workspaceId, workspaceId),
        eq(channelConnections.channel, channel),
        eq(channelConnections.status, "active"),
      ),
    );
  if (!row) {
    throw new AppError("CHANNEL_NOT_CONNECTED", `No active ${channel} channel for this workspace`, {
      channel,
    });
  }
  return row;
}

export async function findConnectionByExternalId(
  channel: ChannelName,
  externalId: string,
  db: Database = getDb(),
): Promise<ChannelConnection | null> {
  const [row] = await db
    .select()
    .from(channelConnections)
    .where(
      and(
        eq(channelConnections.channel, channel),
        eq(channelConnections.externalId, externalId),
        eq(channelConnections.status, "active"),
      ),
    );
  return row ?? null;
}

export async function listConnections(
  workspaceId: string,
  db: Database = getDb(),
): Promise<ChannelConnection[]> {
  return db
    .select()
    .from(channelConnections)
    .where(eq(channelConnections.workspaceId, workspaceId))
    .orderBy(desc(channelConnections.id));
}

export async function connectChannel(
  input: {
    workspaceId: string;
    userId: string;
    channel: ChannelName;
    externalId: string;
    metadata?: Record<string, unknown>;
  },
  db: Database = getDb(),
): Promise<ChannelConnection> {
  const existing = await db
    .select()
    .from(channelConnections)
    .where(
      and(
        eq(channelConnections.workspaceId, input.workspaceId),
        eq(channelConnections.channel, input.channel),
        eq(channelConnections.externalId, input.externalId),
      ),
    );

  const found = existing[0];
  if (found) {
    const [updated] = await db
      .update(channelConnections)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(channelConnections.id, found.id))
      .returning();
    return updated ?? found;
  }

  // The simulator has nothing to verify, so it is active immediately. Real
  // channels would confirm ownership of the handle before going active; V1
  // trusts the authenticated workspace owner.
  const [row] = await db
    .insert(channelConnections)
    .values({
      id: newId("chn"),
      workspaceId: input.workspaceId,
      userId: input.userId,
      channel: input.channel,
      externalId: input.externalId,
      status: "active",
      metadata: input.metadata ?? {},
    })
    .returning();
  if (!row) throw new Error("channel connection insert returned no row");
  return row;
}

export async function revokeChannel(
  workspaceId: string,
  id: string,
  db: Database = getDb(),
): Promise<ChannelConnection> {
  const [row] = await db
    .update(channelConnections)
    .set({ status: "revoked", updatedAt: new Date() })
    .where(
      and(eq(channelConnections.id, id), eq(channelConnections.workspaceId, workspaceId)),
    )
    .returning();
  if (!row) throw notFound("Channel connection");
  return row;
}

/* -------------------------------------------------------------------------- */
/* Threads                                                                    */
/* -------------------------------------------------------------------------- */

export async function ensureThread(
  input: {
    workspaceId: string;
    channel: ChannelName;
    channelThreadId: string;
    participantExternalId: string;
  },
  db: Database = getDb(),
): Promise<ConversationThread> {
  const [existing] = await db
    .select()
    .from(conversationThreads)
    .where(
      and(
        eq(conversationThreads.channel, input.channel),
        eq(conversationThreads.channelThreadId, input.channelThreadId),
      ),
    );
  if (existing) return existing;

  const [row] = await db
    .insert(conversationThreads)
    .values({
      id: newId("thr"),
      workspaceId: input.workspaceId,
      channel: input.channel,
      channelThreadId: input.channelThreadId,
      participantExternalId: input.participantExternalId,
    })
    .returning();
  if (!row) throw new Error("thread insert returned no row");
  return row;
}

export async function getThread(
  workspaceId: string,
  id: string,
  db: Database = getDb(),
): Promise<ConversationThread> {
  const [row] = await db
    .select()
    .from(conversationThreads)
    .where(
      and(eq(conversationThreads.id, id), eq(conversationThreads.workspaceId, workspaceId)),
    );
  if (!row) throw notFound("Conversation thread");
  return row;
}

export async function listMessages(
  threadId: string,
  db: Database = getDb(),
): Promise<ConversationMessage[]> {
  return db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.threadId, threadId))
    .orderBy(asc(conversationMessages.id));
}

export async function recordMessage(
  input: {
    threadId: string;
    workspaceId: string;
    direction: ConversationMessage["direction"];
    role: ConversationMessage["role"];
    body: string;
    payload?: Record<string, unknown>;
    externalMessageId?: string | null;
  },
  db: Database = getDb(),
): Promise<ConversationMessage> {
  const [row] = await db
    .insert(conversationMessages)
    .values({
      id: newId("msg"),
      threadId: input.threadId,
      workspaceId: input.workspaceId,
      direction: input.direction,
      role: input.role,
      body: input.body,
      payload: input.payload ?? {},
      externalMessageId: input.externalMessageId ?? null,
    })
    .returning();
  if (!row) throw new Error("message insert returned no row");
  return row;
}

/** True when this provider message id has already been processed. */
export async function isDuplicateInbound(
  externalMessageId: string,
  db: Database = getDb(),
): Promise<boolean> {
  const [row] = await db
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(eq(conversationMessages.externalMessageId, externalMessageId));
  return row !== undefined;
}

/* -------------------------------------------------------------------------- */
/* Outbox                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Quiet hours defer a message rather than drop it. Windows that cross midnight
 * ("22:00" to "08:00") are the normal case, hence the wrap-aware comparison.
 */
export function nextSendableTime(
  now: Date,
  quietHours: QuietHours | null | undefined,
): Date {
  if (!quietHours) return now;

  const [startH, startM] = quietHours.start.split(":").map(Number);
  const [endH, endM] = quietHours.end.split(":").map(Number);
  if (
    startH === undefined ||
    startM === undefined ||
    endH === undefined ||
    endM === undefined ||
    Number.isNaN(startH) ||
    Number.isNaN(endH)
  ) {
    return now;
  }

  const minutesNow = now.getUTCHours() * 60 + now.getUTCMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  const crossesMidnight = startMinutes > endMinutes;
  const inQuiet = crossesMidnight
    ? minutesNow >= startMinutes || minutesNow < endMinutes
    : minutesNow >= startMinutes && minutesNow < endMinutes;

  if (!inQuiet) return now;

  const send = new Date(now.getTime());
  send.setUTCSeconds(0, 0);
  send.setUTCHours(endH, endM);
  // If the window ends tomorrow, push the send to tomorrow's end time.
  if (send.getTime() <= now.getTime()) send.setUTCDate(send.getUTCDate() + 1);
  return send;
}

export interface EnqueueOutboundInput {
  workspaceId: string;
  threadId: string | null;
  approvalRequestId?: string | null;
  channel: ChannelName;
  destination: string;
  body: string;
  payload?: Record<string, unknown>;
  /** Collapses a repeated enqueue of the same logical message. */
  dedupeKey?: string | null;
  quietHours?: QuietHours | null;
  /** Proof and failure messages ignore quiet hours: the user is mid-flow. */
  urgent?: boolean;
}

export async function enqueueOutbound(
  input: EnqueueOutboundInput,
  db: Database = getDb(),
): Promise<{ id: string; deduped: boolean; scheduledFor: Date }> {
  const now = new Date();
  const scheduledFor = input.urgent ? now : nextSendableTime(now, input.quietHours);

  if (input.dedupeKey) {
    const [existing] = await db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.dedupeKey, input.dedupeKey));
    if (existing) return { id: existing.id, deduped: true, scheduledFor: existing.nextAttemptAt };
  }

  const [row] = await db
    .insert(outboxMessages)
    .values({
      id: newId("obx"),
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      approvalRequestId: input.approvalRequestId ?? null,
      channel: input.channel,
      destination: input.destination,
      body: input.body,
      payload: input.payload ?? {},
      status: "pending",
      nextAttemptAt: scheduledFor,
      dedupeKey: input.dedupeKey ?? null,
    })
    .returning();
  if (!row) throw new Error("outbox insert returned no row");

  return { id: row.id, deduped: false, scheduledFor };
}

export const WORKER_APPROVAL_TTL_MS = () => env.APPROVAL_TTL_MINUTES * 60 * 1000;
