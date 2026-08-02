import { and, eq } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import {
  mailboxConnections,
  type MailboxConnection,
  type MailboxProvider,
} from "../../db/schema.js";
import { decryptSecret, encryptSecret } from "../../lib/crypto.js";
import { AppError, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/id.js";
import { logger } from "../../lib/logger.js";
import { recordAudit } from "../audit/service.js";
import { getMailboxClient } from "./mock.js";
import { RECEIPT_KEYWORDS, type MailMessage, type MailboxGrant } from "./types.js";

/**
 * Mailbox connections: storing the grant, keeping it alive, and reading mail.
 *
 * Tokens are sealed with the secret box before they touch the database and are
 * opened only in memory. A refresh token is a standing key to somebody's inbox,
 * which is a materially different thing from a session token — a database dump
 * must not be enough to read anyone's mail.
 */

/** Refresh this far before actual expiry, so a long sweep cannot expire mid-run. */
const REFRESH_SKEW_MS = 5 * 60_000;

export interface SaveGrantInput {
  workspaceId: string;
  userId: string;
  provider: MailboxProvider;
  grant: MailboxGrant;
  db?: Database;
}

/**
 * Upserts the connection. Reconnecting the same address updates it in place
 * rather than accumulating rows, and a re-consent that omits the refresh token
 * keeps the stored one — providers routinely issue it only on first consent.
 */
export async function saveGrant(input: SaveGrantInput): Promise<MailboxConnection> {
  const db = input.db ?? getDb();
  const { grant } = input;

  const expiresAt = grant.tokens.expiresIn
    ? new Date(Date.now() + grant.tokens.expiresIn * 1000)
    : null;

  const [existing] = await db
    .select()
    .from(mailboxConnections)
    .where(
      and(
        eq(mailboxConnections.workspaceId, input.workspaceId),
        eq(mailboxConnections.provider, input.provider),
        eq(mailboxConnections.emailAddress, grant.emailAddress),
      ),
    );

  if (existing) {
    const [updated] = await db
      .update(mailboxConnections)
      .set({
        accessToken: encryptSecret(grant.tokens.accessToken),
        ...(grant.tokens.refreshToken
          ? { refreshToken: encryptSecret(grant.tokens.refreshToken) }
          : {}),
        scopes: grant.tokens.scopes,
        expiresAt,
        status: "active",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(mailboxConnections.id, existing.id))
      .returning();
    if (!updated) throw new Error("mailbox connection update returned no row");
    return updated;
  }

  const [row] = await db
    .insert(mailboxConnections)
    .values({
      id: newId("mbx"),
      workspaceId: input.workspaceId,
      userId: input.userId,
      provider: input.provider,
      emailAddress: grant.emailAddress,
      accessToken: encryptSecret(grant.tokens.accessToken),
      refreshToken: grant.tokens.refreshToken ? encryptSecret(grant.tokens.refreshToken) : null,
      scopes: grant.tokens.scopes,
      expiresAt,
      status: "active",
    })
    .returning();
  if (!row) throw new Error("mailbox connection insert returned no row");

  await recordAudit(
    {
      workspaceId: input.workspaceId,
      actorUserId: input.userId,
      type: "mailbox.connected",
      entityType: "mailbox_connection",
      entityId: row.id,
      data: { provider: input.provider, emailAddress: grant.emailAddress },
    },
    db,
  );

  return row;
}

/**
 * Returns a usable access token, refreshing first if it is close to expiry.
 *
 * A connection whose refresh fails is marked `error` rather than left looking
 * healthy: the detect run needs to say "reconnect your mailbox", not fail with
 * a 401 from somewhere deep in the pipeline.
 */
export async function accessTokenFor(
  connection: MailboxConnection,
  db: Database = getDb(),
): Promise<string> {
  const sealed = connection.accessToken;
  const stillFresh =
    connection.expiresAt === null || connection.expiresAt.getTime() - REFRESH_SKEW_MS > Date.now();

  if (sealed && stillFresh) {
    const token = decryptSecret(sealed);
    if (token) return token;
    // Unopenable means AUTH_SECRET rotated. Re-consent is the only way back.
    logger.warn({ connectionId: connection.id }, "stored mailbox token could not be opened");
  }

  const sealedRefresh = connection.refreshToken;
  const refreshToken = sealedRefresh ? decryptSecret(sealedRefresh) : null;
  if (!refreshToken) {
    await markError(connection.id, "No usable refresh token; reconnect the mailbox", db);
    throw new AppError("CHANNEL_NOT_CONNECTED", "This mailbox needs to be reconnected", {
      connectionId: connection.id,
      provider: connection.provider,
    });
  }

  const client = await getMailboxClient(connection.provider);
  try {
    const tokens = await client.refresh(refreshToken);
    await db
      .update(mailboxConnections)
      .set({
        accessToken: encryptSecret(tokens.accessToken),
        ...(tokens.refreshToken ? { refreshToken: encryptSecret(tokens.refreshToken) } : {}),
        expiresAt: tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : null,
        status: "active",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(mailboxConnections.id, connection.id));

    logger.info({ connectionId: connection.id }, "mailbox token refreshed");
    return tokens.accessToken;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markError(connection.id, message, db);
    throw new AppError("CHANNEL_NOT_CONNECTED", "This mailbox needs to be reconnected", {
      connectionId: connection.id,
      cause: message,
    });
  }
}

async function markError(id: string, reason: string, db: Database): Promise<void> {
  await db
    .update(mailboxConnections)
    .set({ status: "error", lastError: reason.slice(0, 500), updatedAt: new Date() })
    .where(eq(mailboxConnections.id, id));
}

export interface FetchReceiptsInput {
  connection: MailboxConnection;
  /** How far back to look. The first sweep uses three months. */
  monthsBack?: number;
  limit?: number;
  now?: Date;
  db?: Database;
}

/** Receipt-shaped mail from the window, newest first. */
export async function fetchReceipts(input: FetchReceiptsInput): Promise<MailMessage[]> {
  const db = input.db ?? getDb();
  const now = input.now ?? new Date();
  const since = new Date(now);
  since.setUTCMonth(since.getUTCMonth() - (input.monthsBack ?? 3));

  const accessToken = await accessTokenFor(input.connection, db);
  const client = await getMailboxClient(input.connection.provider);

  const messages = await client.search({
    accessToken,
    since,
    keywords: RECEIPT_KEYWORDS,
    limit: input.limit ?? 200,
  });

  await db
    .update(mailboxConnections)
    .set({ lastSyncAt: now, updatedAt: now })
    .where(eq(mailboxConnections.id, input.connection.id));

  logger.info(
    {
      connectionId: input.connection.id,
      provider: input.connection.provider,
      found: messages.length,
      since: since.toISOString(),
    },
    "mailbox receipts fetched",
  );

  return messages;
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

export async function listConnections(
  workspaceId: string,
  db: Database = getDb(),
): Promise<MailboxConnection[]> {
  return db
    .select()
    .from(mailboxConnections)
    .where(eq(mailboxConnections.workspaceId, workspaceId));
}

/** The connection a detect run should read from, or null if there is none. */
export async function activeConnection(
  workspaceId: string,
  db: Database = getDb(),
): Promise<MailboxConnection | null> {
  const rows = await db
    .select()
    .from(mailboxConnections)
    .where(
      and(
        eq(mailboxConnections.workspaceId, workspaceId),
        eq(mailboxConnections.status, "active"),
      ),
    );
  if (rows.length === 0) return null;
  // Ids are ULIDs, so the lexicographic maximum is the most recently connected.
  return rows.reduce((latest, row) => (row.id > latest.id ? row : latest));
}

export async function getConnection(
  workspaceId: string,
  id: string,
  db: Database = getDb(),
): Promise<MailboxConnection> {
  const [row] = await db
    .select()
    .from(mailboxConnections)
    .where(and(eq(mailboxConnections.id, id), eq(mailboxConnections.workspaceId, workspaceId)));
  if (!row) throw notFound("Mailbox connection");
  return row;
}

export async function revokeConnection(
  workspaceId: string,
  id: string,
  actorUserId: string,
  db: Database = getDb(),
): Promise<MailboxConnection> {
  const connection = await getConnection(workspaceId, id, db);

  const [row] = await db
    .update(mailboxConnections)
    .set({
      status: "revoked",
      // Drop the keys as well as the flag: a revoked connection that still
      // holds a working refresh token is a revocation in name only.
      accessToken: null,
      refreshToken: null,
      updatedAt: new Date(),
    })
    .where(eq(mailboxConnections.id, connection.id))
    .returning();
  if (!row) throw new Error("mailbox revoke returned no row");

  await recordAudit(
    {
      workspaceId,
      actorUserId,
      type: "mailbox.revoked",
      entityType: "mailbox_connection",
      entityId: row.id,
      data: { provider: row.provider, emailAddress: row.emailAddress },
    },
    db,
  );

  return row;
}

export function serializeConnection(row: MailboxConnection) {
  return {
    id: row.id,
    provider: row.provider,
    emailAddress: row.emailAddress,
    status: row.status,
    scopes: row.scopes,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  };
}
