import { and, desc, eq, lt } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import {
  approvalRequests,
  decisionPackages,
  subscriptions,
  workspaces,
  type ApprovalRequest,
  type ApprovalState,
  type ChannelName,
  type DecisionPackageRow,
  type Subscription,
} from "../../db/schema.js";
import { env } from "../../env.js";
import { AppError, notFound } from "../../lib/errors.js";
import { toPage, type Page } from "../../lib/http.js";
import { newId } from "../../lib/id.js";
import { logger } from "../../lib/logger.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { normalizeAmount } from "../../lib/money.js";
import type { AuthContext } from "../../types/context.js";
import { recordAudit } from "../audit/service.js";
import { resolveAuthContext } from "../auth/service.js";
import { decisionPackageSchema, isPayingAction } from "../decisions/engine.js";
import { assertTransition, isTerminal } from "../conversations/stateMachine.js";

/**
 * An ApprovalRequest is the single object that ties a decision to the message
 * that proposed it and the payment that fulfilled it. Every state change goes
 * through `transition`, which enforces the state machine and writes the audit
 * event, so there is exactly one place a "proved" can be minted.
 */

export interface ApprovalDto {
  id: string;
  workspaceId: string;
  subscriptionId: string;
  decisionId: string;
  threadId: string | null;
  state: ApprovalState;
  channel: ChannelName;
  actionType: DecisionPackageRow["recommendation"];
  amount: string;
  currency: string;
  merchantName: string;
  pravaPaymentSessionId: string | null;
  pravaHostedUrl: string | null;
  expiresAt: string;
  failureCode: string | null;
  resultPayload: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export function serializeApproval(row: ApprovalRequest): ApprovalDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    subscriptionId: row.subscriptionId,
    decisionId: row.decisionId,
    threadId: row.threadId,
    state: row.state,
    channel: row.channel,
    actionType: row.actionType,
    amount: normalizeAmount(row.amount, row.currency),
    currency: row.currency,
    merchantName: row.merchantName,
    pravaPaymentSessionId: row.pravaPaymentSessionId,
    pravaHostedUrl: row.pravaHostedUrl,
    expiresAt: row.expiresAt.toISOString(),
    failureCode: row.failureCode,
    resultPayload: row.resultPayload ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface CreateApprovalInput {
  auth: AuthContext;
  subscription: Subscription;
  decision: DecisionPackageRow;
  channel?: ChannelName;
  db?: Database;
}

export async function createApproval(
  input: CreateApprovalInput,
): Promise<{ approval: ApprovalRequest; created: boolean }> {
  const db = input.db ?? getDb();
  const { auth, subscription, decision } = input;

  const packaged = decisionPackageSchema.parse(decision.payload);
  if (packaged.recommendation === "snooze") {
    throw new AppError(
      "INVALID_DECISION_STATE",
      "A snooze decision has nothing to approve",
      { decisionId: decision.id },
    );
  }
  if (decision.supersededAt) {
    throw new AppError(
      "INVALID_DECISION_STATE",
      "This decision has been superseded; regenerate before requesting approval",
      { decisionId: decision.id },
    );
  }

  const channel = input.channel ?? auth.settings.primaryChannel;

  // One live approval per decision. Asking twice for the same thing is how a
  // user ends up approving a charge they already approved.
  const existing = await findLiveApprovalForDecision(auth.workspace.id, decision.id, db);
  if (existing) return { approval: existing, created: false };

  /*
   * The key has to be unique per *attempt*, not per decision. `findLive…` above
   * already returns any approval still in play, so reaching here means every
   * previous attempt is terminal — expired, failed, or cancelled — and asking
   * again is legitimate. Keying on the decision alone made the unique index
   * refuse that retry forever: a proposal whose send failed could never be sent
   * again, and the notify job failed on every attempt with a constraint
   * violation rather than anything a reader could act on.
   *
   * Counting prior attempts keeps the protection that matters. Two concurrent
   * creates still compute the same ordinal and still collide, so the index goes
   * on doing the one job it was added for.
   */
  const prior = await db
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(eq(approvalRequests.decisionId, decision.id));

  const idempotencyKey = `approval:${decision.id}:${decision.policyVersion}:${prior.length}`;
  const expiresAt = new Date(Date.now() + env.APPROVAL_TTL_MINUTES * 60_000);

  const [row] = await db
    .insert(approvalRequests)
    .values({
      id: newId("apr"),
      workspaceId: auth.workspace.id,
      subscriptionId: subscription.id,
      decisionId: decision.id,
      state: "drafted",
      channel,
      actionType: packaged.recommendation,
      // Attested actions carry the projected saving rather than a charge.
      amount: isPayingAction(packaged.recommendation)
        ? normalizeAmount(packaged.amount_due, subscription.currency)
        : "0.00",
      currency: subscription.currency,
      merchantName: subscription.merchantName,
      expiresAt,
      idempotencyKey,
    })
    .returning();
  if (!row) throw new Error("approval insert returned no row");

  await recordAudit(
    {
      workspaceId: auth.workspace.id,
      actorUserId: auth.user.id,
      type: "approval.created",
      entityType: "approval_request",
      entityId: row.id,
      data: {
        decisionId: decision.id,
        subscriptionId: subscription.id,
        actionType: row.actionType,
        channel,
        amount: row.amount,
      },
    },
    db,
  );

  return { approval: row, created: true };
}

export interface TransitionInput {
  approval: ApprovalRequest;
  to: ApprovalState;
  actorUserId?: string | null;
  patch?: Partial<typeof approvalRequests.$inferInsert>;
  data?: Record<string, unknown>;
  db?: Database;
}

/**
 * The only sanctioned way to move an approval. The compare-and-set on `state`
 * in the WHERE clause is what makes two concurrent webhooks safe: the loser
 * updates zero rows and is told the transition already happened.
 */
export async function transition(input: TransitionInput): Promise<ApprovalRequest> {
  const db = input.db ?? getDb();
  const { approval, to } = input;

  assertTransition(approval.state, to);

  const [updated] = await db
    .update(approvalRequests)
    .set({ ...input.patch, state: to, updatedAt: new Date() })
    .where(
      and(
        eq(approvalRequests.id, approval.id),
        // Compare-and-set: only the caller that observed `approval.state` wins.
        eq(approvalRequests.state, approval.state),
      ),
    )
    .returning();

  if (!updated) {
    const current = await getApprovalById(approval.workspaceId, approval.id, db);
    logger.warn(
      { approvalId: approval.id, from: approval.state, attempted: to, actual: current.state },
      `approval transition lost a race — already ${current.state}`,
    );
    throw new AppError(
      "INVALID_STATE_TRANSITION",
      `Approval already moved to ${current.state}; ${approval.state} to ${to} no longer applies`,
      { from: approval.state, to, actual: current.state, raced: true },
    );
  }

  // The approval state machine is the spine of every money-moving action, so
  // each step it takes is worth a line. Failures are louder than progress.
  const level = to === "failed" ? "warn" : "info";
  logger[level](
    {
      approvalId: approval.id,
      workspaceId: approval.workspaceId,
      subscriptionId: approval.subscriptionId,
      from: approval.state,
      to,
      ...(input.data ?? {}),
    },
    `approval ${approval.state} → ${to}`,
  );

  await recordAudit(
    {
      workspaceId: approval.workspaceId,
      actorUserId: input.actorUserId ?? null,
      type: auditTypeFor(to),
      entityType: "approval_request",
      entityId: approval.id,
      data: { from: approval.state, to, ...(input.data ?? {}) },
    },
    db,
  );

  return updated;
}

function auditTypeFor(state: ApprovalState) {
  switch (state) {
    case "notified":
      return "approval.notified" as const;
    case "awaiting_intent":
      return "approval.awaiting_intent" as const;
    case "awaiting_payment_auth":
      return "approval.awaiting_payment_auth" as const;
    case "executing":
      return "approval.executing" as const;
    case "proved":
      return "approval.proved" as const;
    case "failed":
      return "approval.failed" as const;
    case "expired":
      return "approval.expired" as const;
    case "cancelled_by_user":
      return "approval.cancelled_by_user" as const;
    default:
      return "approval.created" as const;
  }
}

/* -------------------------------------------------------------------------- */
/* Pay links                                                                  */
/* -------------------------------------------------------------------------- */

export interface PayLink {
  url: string;
  token: string;
  tokenHash: string;
}

/**
 * The link sent into the thread. The token is single use and only its hash is
 * stored, so a leaked database row cannot be replayed into a payment page.
 */
export function mintPayLink(approvalId: string): PayLink {
  const token = randomToken(24);
  return {
    url: `${env.APP_URL}/pay/${approvalId}?token=${token}`,
    token,
    tokenHash: sha256(token),
  };
}

export function verifyPayToken(approval: ApprovalRequest, token: string): boolean {
  if (!approval.payTokenHash) return false;
  return approval.payTokenHash === sha256(token);
}

/**
 * The pay link is opened on whatever device received the text, which holds no
 * session — the token in the link is the entire credential. Unlike the authed
 * route, where the token is a second factor on top of a session, here it is
 * mandatory: an approval with no minted link authorizes nobody.
 *
 * The returned auth context belongs to the workspace owner. `approvalRequests`
 * carries no user id, and `resolveAuthContext` asserts ownership, so the owner
 * is the only principal that can stand in for the person who tapped the link.
 */
export async function authorizeByPayToken(
  approvalId: string,
  token: string | undefined,
  db: Database = getDb(),
): Promise<{ approval: ApprovalRequest; auth: AuthContext }> {
  const approval = await getApprovalByIdUnscoped(approvalId, db);

  if (!approval.payTokenHash) {
    throw new AppError("UNAUTHORIZED", "This approval has no pay link", {
      approvalId: approval.id,
    });
  }
  if (!token || !verifyPayToken(approval, token)) {
    throw new AppError("UNAUTHORIZED", "Invalid or missing pay token", {
      approvalId: approval.id,
    });
  }

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, approval.workspaceId));
  if (!workspace) throw notFound("Workspace");

  const auth = await resolveAuthContext(workspace.ownerUserId, approval.workspaceId, db);
  return { approval, auth };
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

export async function getApprovalById(
  workspaceId: string,
  id: string,
  db: Database = getDb(),
): Promise<ApprovalRequest> {
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.workspaceId, workspaceId)));
  if (!row) throw notFound("Approval request");
  return row;
}

/**
 * Lookup by id alone, for the pay-link path where no workspace is known until
 * the token has been verified. Callers must authorize before acting on the row.
 */
export async function getApprovalByIdUnscoped(
  id: string,
  db: Database = getDb(),
): Promise<ApprovalRequest> {
  const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, id));
  if (!row) throw notFound("Approval request");
  return row;
}

export async function findLiveApprovalForDecision(
  workspaceId: string,
  decisionId: string,
  db: Database = getDb(),
): Promise<ApprovalRequest | null> {
  const rows = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.workspaceId, workspaceId),
        eq(approvalRequests.decisionId, decisionId),
      ),
    )
    .orderBy(desc(approvalRequests.id));

  const latest = rows[0];
  if (!latest || isTerminal(latest.state)) return null;
  return latest;
}

/** The approval an inbound message in this thread is answering. */
export async function findOpenApprovalForThread(
  threadId: string,
  db: Database = getDb(),
): Promise<ApprovalRequest | null> {
  const rows = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.threadId, threadId))
    .orderBy(desc(approvalRequests.id));

  return rows.find((row) => !isTerminal(row.state)) ?? null;
}

export async function listApprovals(
  workspaceId: string,
  options: { limit: number; cursor?: string; state?: ApprovalState },
  db: Database = getDb(),
): Promise<Page<ApprovalRequest>> {
  const filters = [eq(approvalRequests.workspaceId, workspaceId)];
  if (options.state) filters.push(eq(approvalRequests.state, options.state));
  if (options.cursor) filters.push(lt(approvalRequests.id, options.cursor));

  const rows = await db
    .select()
    .from(approvalRequests)
    .where(and(...filters))
    .orderBy(desc(approvalRequests.id))
    .limit(options.limit + 1);

  return toPage(rows, options.limit);
}

export interface ApprovalContext {
  approval: ApprovalRequest;
  subscription: Subscription;
  decision: DecisionPackageRow;
}

export async function loadApprovalContext(
  workspaceId: string,
  approvalId: string,
  db: Database = getDb(),
): Promise<ApprovalContext> {
  const approval = await getApprovalById(workspaceId, approvalId, db);

  const [subscription] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, approval.subscriptionId));
  if (!subscription) throw notFound("Subscription");

  const [decision] = await db
    .select()
    .from(decisionPackages)
    .where(eq(decisionPackages.id, approval.decisionId));
  if (!decision) throw notFound("Decision package");

  return { approval, subscription, decision };
}

export function assertNotExpired(approval: ApprovalRequest): void {
  if (isTerminal(approval.state)) {
    throw new AppError("INVALID_STATE_TRANSITION", `Approval is already ${approval.state}`, {
      state: approval.state,
    });
  }
  if (approval.expiresAt.getTime() <= Date.now()) {
    throw new AppError("APPROVAL_EXPIRED", "This approval window has closed", {
      approvalId: approval.id,
      expiresAt: approval.expiresAt.toISOString(),
    });
  }
}
