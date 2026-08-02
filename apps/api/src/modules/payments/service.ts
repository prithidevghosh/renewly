import { and, eq } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import {
  paymentSessions,
  receipts,
  transactions,
  type DecisionPackageRow,
  type PaymentSession,
  type Subscription,
  type Transaction,
} from "../../db/schema.js";
import { env, isTest } from "../../env.js";
import { AppError, notFound } from "../../lib/errors.js";
import { newId } from "../../lib/id.js";
import { normalizeAmount } from "../../lib/money.js";
import type { AuthContext } from "../../types/context.js";
import { recordAudit } from "../audit/service.js";
import { decisionPackageSchema } from "../decisions/engine.js";
import { resolveMerchant } from "../merchants/service.js";
import { getCheckoutAdapter } from "./checkoutAdapter.js";
import { getPravaClient } from "./factory.js";
import { assertPayAllowed } from "./policyGuard.js";
import { brandFromPan, last4, type OneTimeCredentials } from "./pravaClient.js";

export interface PaymentSessionDto {
  id: string;
  workspaceId: string;
  subscriptionId: string;
  decisionId: string;
  pravaSessionId: string;
  pravaOrderId: string | null;
  amount: string;
  currency: string;
  merchantName: string;
  status: PaymentSession["status"];
  mode: string;
  iframeUrl: string | null;
  expiresAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export function serializePaymentSession(row: PaymentSession): PaymentSessionDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    subscriptionId: row.subscriptionId,
    decisionId: row.decisionId,
    pravaSessionId: row.pravaSessionId,
    pravaOrderId: row.pravaOrderId,
    amount: normalizeAmount(row.amount, row.currency),
    currency: row.currency,
    merchantName: row.merchantName,
    status: row.status,
    mode: row.mode,
    iframeUrl: row.iframeUrl,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface TransactionDto {
  id: string;
  workspaceId: string;
  paymentSessionId: string;
  status: Transaction["status"];
  amount: string;
  currency: string;
  merchantName: string;
  pravaTxnRefId: string | null;
  cardLast4: string | null;
  cardBrand: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
  checkoutReference: string | null;
  failureReason: string | null;
  createdAt: string;
}

/** Deliberately has no card number or CVV field: those never leave memory. */
export function serializeTransaction(row: Transaction): TransactionDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    paymentSessionId: row.paymentSessionId,
    status: row.status,
    amount: normalizeAmount(row.amount, row.currency),
    currency: row.currency,
    merchantName: row.merchantName,
    pravaTxnRefId: row.pravaTxnRefId,
    cardLast4: row.cardLast4,
    cardBrand: row.cardBrand,
    cardExpMonth: row.cardExpMonth,
    cardExpYear: row.cardExpYear,
    checkoutReference: row.checkoutReference,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Session creation                                                           */
/* -------------------------------------------------------------------------- */

export interface CreateSessionInput {
  auth: AuthContext;
  subscription: Subscription;
  decision: DecisionPackageRow;
  requestedAmount?: string;
  db?: Database;
}

export interface CreateSessionOutput {
  session: PaymentSession;
  sessionToken: string;
  iframeUrl: string;
  publishableKey: string | null;
}

export async function createPaymentSession(
  input: CreateSessionInput,
): Promise<CreateSessionOutput> {
  const db = input.db ?? getDb();
  const { auth, subscription, decision } = input;

  const policy = assertPayAllowed({
    settings: auth.settings,
    subscription,
    decision,
    ...(input.requestedAmount !== undefined ? { requestedAmount: input.requestedAmount } : {}),
  });

  const packaged = decisionPackageSchema.parse(decision.payload);
  const prava = getPravaClient();
  const localId = newId("pay");
  const merchantUrl = await resolveMerchantUrl(auth.workspace.id, subscription, db);

  let created;
  try {
    created = await prava.createSession({
      userId: auth.user.id,
      userEmail: auth.user.email,
      amount: policy.amount,
      currency: policy.currency,
      merchant: {
        name: subscription.merchantName,
        url: merchantUrl,
        country_code_iso2: env.PRAVA_MERCHANT_COUNTRY,
      },
      items: [
        {
          description: describeLineItem(subscription, packaged.recommendation),
          unit_price: policy.amount,
          quantity: 1,
        },
      ],
      integration_type: "embedding",
      externalOrderRef: localId,
    });
  } catch (error) {
    await recordAudit(
      {
        workspaceId: auth.workspace.id,
        actorUserId: auth.user.id,
        type: "payment.blocked",
        entityType: "decision_package",
        entityId: decision.id,
        data: {
          reason: error instanceof AppError ? error.code : "PRAVA_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      },
      db,
    );
    throw error;
  }

  const [session] = await db
    .insert(paymentSessions)
    .values({
      id: localId,
      workspaceId: auth.workspace.id,
      subscriptionId: subscription.id,
      decisionId: decision.id,
      pravaSessionId: created.sessionId,
      pravaOrderId: created.orderId ?? null,
      amount: policy.amount,
      currency: policy.currency,
      merchantName: subscription.merchantName,
      status: "awaiting_collection",
      mode: prava.mode,
      iframeUrl: created.iframeUrl,
      expiresAt: created.expiresAt ? new Date(created.expiresAt) : null,
    })
    .returning();
  if (!session) throw new Error("payment session insert returned no row");

  await recordAudit(
    {
      workspaceId: auth.workspace.id,
      actorUserId: auth.user.id,
      type: "payment.session_created",
      entityType: "payment_session",
      entityId: session.id,
      data: {
        decisionId: decision.id,
        subscriptionId: subscription.id,
        amount: policy.amount,
        currency: policy.currency,
        merchantName: subscription.merchantName,
        approvalPath: policy.approvalPath,
        policyFlags: policy.flags,
        mode: prava.mode,
      },
    },
    db,
  );

  return {
    session,
    sessionToken: created.sessionToken,
    iframeUrl: created.iframeUrl,
    publishableKey: env.PRAVA_PUBLISHABLE_KEY ?? null,
  };
}

/**
 * `merchant_details.url` is required by POST /v1/sessions and must be https.
 * The merchant graph is the source of truth; vendors we have no website for
 * fall back to the configured URL so a missing row cannot fail a renewal.
 */
async function resolveMerchantUrl(
  workspaceId: string,
  subscription: Subscription,
  db: Database,
): Promise<string> {
  const merchant = await resolveMerchant(workspaceId, subscription.merchantCanonical, db);
  return toHttpsUrl(merchant?.website) ?? env.PRAVA_MERCHANT_FALLBACK_URL;
}

/** Upgrades a bare host or http:// URL to https, or returns null if unusable. */
export function toHttpsUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (!url.hostname.includes(".")) return null;
    url.protocol = "https:";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function describeLineItem(
  subscription: Subscription,
  recommendation: DecisionPackageRow["recommendation"],
): string {
  const plan = subscription.planName ? ` ${subscription.planName}` : "";
  const verb = recommendation === "renew" ? "renewal" : `${recommendation} charge`;
  return `${subscription.merchantName}${plan} ${verb}`.trim();
}

/* -------------------------------------------------------------------------- */
/* Completion                                                                 */
/* -------------------------------------------------------------------------- */

export interface CompletePaymentInput {
  auth: AuthContext;
  session: PaymentSession;
  subscription: Subscription;
  decision: DecisionPackageRow;
  /** Test-only: forces the checkout adapter to decline. Ignored outside NODE_ENV=test. */
  forceDecline?: boolean;
  db?: Database;
}

export interface CompletePaymentOutput {
  session: PaymentSession;
  transaction: Transaction;
  receiptId: string | null;
}

/**
 * Polls Prava for the one-time credentials, charges them through the checkout
 * adapter, then reports the outcome back so the rail can close the transaction.
 *
 * The credentials live in a local const for the duration of this function and
 * are never persisted, returned or logged.
 */
export async function completePayment(
  input: CompletePaymentInput,
): Promise<CompletePaymentOutput> {
  const db = input.db ?? getDb();
  const { auth, subscription, decision } = input;
  let session = input.session;

  if (session.status === "completed") {
    throw new AppError("CONFLICT", "This payment session has already completed", {
      paymentSessionId: session.id,
    });
  }
  if (session.status === "revoked") {
    throw new AppError("INVALID_DECISION_STATE", "This payment session was revoked", {
      paymentSessionId: session.id,
    });
  }

  // Re-run the guard: the kill switch may have been pulled between the two calls.
  assertPayAllowed({
    settings: auth.settings,
    subscription,
    decision,
    requestedAmount: session.amount,
  });

  const prava = getPravaClient();
  session = await updateSession(db, session.id, { status: "awaiting_result" });

  let credentials: OneTimeCredentials;
  try {
    credentials = await pollForCredentials(session.pravaSessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // We are done with this session, so close it on the rail too rather than
    // leaving it able to mint a credential nobody will charge.
    await prava.revokeSession(session.pravaSessionId).catch(() => undefined);
    session = await updateSession(db, session.id, { status: "failed", lastError: message });
    const transaction = await writeTransaction(db, {
      auth,
      session,
      status: "error",
      failureReason: message,
    });
    await recordAudit(
      {
        workspaceId: auth.workspace.id,
        actorUserId: auth.user.id,
        type: "payment.failed",
        entityType: "payment_session",
        entityId: session.id,
        data: { stage: "credentials", reason: message, transactionId: transaction.id },
      },
      db,
    );
    throw error;
  }

  const cardLast4 = credentials.last4 ?? last4(credentials.cardNumber);
  const cardBrand = credentials.brand ?? brandFromPan(credentials.cardNumber);

  await recordAudit(
    {
      workspaceId: auth.workspace.id,
      actorUserId: auth.user.id,
      type: "payment.credentials_received",
      entityType: "payment_session",
      entityId: session.id,
      // Only the non-sensitive descriptors are recorded.
      data: { cardLast4, cardBrand, txnRefId: credentials.txnRefId },
    },
    db,
  );

  /*
   * `forceDecline` used to construct a mock adapter right here, which put an
   * import of a test double into the module that charges cards. The decline
   * path is exercised by installing an adapter through setCheckoutAdapter
   * instead, so this module only ever talks to whatever the factory returns.
   */
  const adapter = getCheckoutAdapter();

  const outcome = await adapter.charge(credentials, {
    reference: session.id,
    amount: session.amount,
    currency: session.currency,
    merchantName: session.merchantName,
    description: describeLineItem(subscription, decision.recommendation),
  });

  // Report before anything else: the rail must not be left holding an open
  // credential regardless of how the charge went.
  let reportNote: string | null = null;
  try {
    const reported = await prava.reportStatus(session.pravaSessionId, {
      txnRefId: credentials.txnRefId,
      txnStatus: outcome.ok ? "APPROVED" : "DECLINED",
      ...(outcome.ok ? { authorizationCode: outcome.reference } : {}),
    });
    // The charge itself stands; only the network confirmation did not land.
    if (reported.visaConfirmation === "FAILURE") {
      reportNote = "report-status accepted but visa confirmation failed";
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportNote = `report-status failed: ${message}`;
  }
  if (reportNote) await updateSession(db, session.id, { lastError: reportNote });

  if (!outcome.ok) {
    session = await updateSession(db, session.id, {
      status: "failed",
      lastError: outcome.reason,
    });
    const transaction = await writeTransaction(db, {
      auth,
      session,
      status: "declined",
      failureReason: outcome.reason,
      txnRefId: credentials.txnRefId,
      cardLast4,
      cardBrand,
      expMonth: credentials.expMonth,
      expYear: credentials.expYear,
    });
    await recordAudit(
      {
        workspaceId: auth.workspace.id,
        actorUserId: auth.user.id,
        type: "payment.failed",
        entityType: "payment_session",
        entityId: session.id,
        data: {
          stage: "checkout",
          code: outcome.code,
          reason: outcome.reason,
          transactionId: transaction.id,
        },
      },
      db,
    );
    throw new AppError("CHECKOUT_DECLINED", outcome.reason, {
      code: outcome.code,
      paymentSessionId: session.id,
      transactionId: transaction.id,
    });
  }

  session = await updateSession(db, session.id, { status: "completed", lastError: reportNote });

  const transaction = await writeTransaction(db, {
    auth,
    session,
    status: "approved",
    txnRefId: credentials.txnRefId,
    cardLast4,
    cardBrand,
    expMonth: credentials.expMonth,
    expYear: credentials.expYear,
    checkoutReference: outcome.reference,
  });

  const [receipt] = await db
    .insert(receipts)
    .values({
      id: newId("rct"),
      workspaceId: auth.workspace.id,
      transactionId: transaction.id,
      payload: {
        merchant: session.merchantName,
        plan: subscription.planName,
        amount: normalizeAmount(session.amount, session.currency),
        currency: session.currency,
        paid_at: outcome.processedAt,
        card: { brand: cardBrand, last4: cardLast4 },
        rail: { provider: "prava", mode: prava.mode, session_id: session.pravaSessionId },
        checkout: { mode: adapter.mode, reference: outcome.reference },
        decision_id: decision.id,
        recommendation: decision.recommendation,
        subscription_id: subscription.id,
      },
    })
    .returning();

  await recordAudit(
    {
      workspaceId: auth.workspace.id,
      actorUserId: auth.user.id,
      type: "payment.succeeded",
      entityType: "transaction",
      entityId: transaction.id,
      data: {
        paymentSessionId: session.id,
        decisionId: decision.id,
        subscriptionId: subscription.id,
        amount: normalizeAmount(session.amount, session.currency),
        currency: session.currency,
        cardLast4,
        cardBrand,
        checkoutReference: outcome.reference,
      },
    },
    db,
  );

  return { session, transaction, receiptId: receipt?.id ?? null };
}

/**
 * Prava issues credentials only once the user has completed the passkey and
 * card steps in the iframe, so the result is polled rather than pushed.
 */
async function pollForCredentials(pravaSessionId: string): Promise<OneTimeCredentials> {
  const prava = getPravaClient();
  const attempts = isTest() ? Math.min(env.PRAVA_POLL_ATTEMPTS, 5) : env.PRAVA_POLL_ATTEMPTS;
  const interval = isTest() ? 0 : env.PRAVA_POLL_INTERVAL_MS;

  let lastStatus = "unknown";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await prava.getPaymentResult(pravaSessionId);
    lastStatus = result.status;

    if (result.credentials) return result.credentials;
    if (result.status === "failed") {
      throw new AppError("PRAVA_ERROR", "Prava reported the session failed", {
        pravaSessionId,
        status: result.status,
      });
    }
    if (result.status === "completed") {
      throw new AppError("PRAVA_ERROR", "Session already completed without issuing credentials", {
        pravaSessionId,
      });
    }
    if (interval > 0) await sleep(interval);
  }

  throw new AppError("PRAVA_ERROR", "Timed out waiting for card credentials", {
    pravaSessionId,
    lastStatus,
    attempts,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function updateSession(
  db: Database,
  id: string,
  patch: Partial<typeof paymentSessions.$inferInsert>,
): Promise<PaymentSession> {
  const [row] = await db
    .update(paymentSessions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(paymentSessions.id, id))
    .returning();
  if (!row) throw new Error("payment session update returned no row");
  return row;
}

async function writeTransaction(
  db: Database,
  input: {
    auth: AuthContext;
    session: PaymentSession;
    status: Transaction["status"];
    failureReason?: string;
    txnRefId?: string;
    cardLast4?: string;
    cardBrand?: string;
    expMonth?: number;
    expYear?: number;
    checkoutReference?: string;
  },
): Promise<Transaction> {
  const [row] = await db
    .insert(transactions)
    .values({
      id: newId("txn"),
      workspaceId: input.auth.workspace.id,
      paymentSessionId: input.session.id,
      status: input.status,
      amount: input.session.amount,
      currency: input.session.currency,
      merchantName: input.session.merchantName,
      pravaTxnRefId: input.txnRefId ?? null,
      cardLast4: input.cardLast4 ?? null,
      cardBrand: input.cardBrand ?? null,
      cardExpMonth: input.expMonth ?? null,
      cardExpYear: input.expYear ?? null,
      checkoutReference: input.checkoutReference ?? null,
      failureReason: input.failureReason ?? null,
    })
    .returning();
  if (!row) throw new Error("transaction insert returned no row");
  return row;
}

export async function getPaymentSession(
  workspaceId: string,
  id: string,
  db: Database = getDb(),
): Promise<PaymentSession> {
  const [row] = await db
    .select()
    .from(paymentSessions)
    .where(and(eq(paymentSessions.id, id), eq(paymentSessions.workspaceId, workspaceId)));
  if (!row) throw notFound("Payment session");
  return row;
}

export async function findLatestSessionForDecision(
  workspaceId: string,
  decisionId: string,
  db: Database = getDb(),
): Promise<PaymentSession | null> {
  const rows = await db
    .select()
    .from(paymentSessions)
    .where(
      and(
        eq(paymentSessions.workspaceId, workspaceId),
        eq(paymentSessions.decisionId, decisionId),
      ),
    );
  if (rows.length === 0) return null;
  // Ids are ULIDs, so the lexicographic maximum is the most recent.
  return rows.reduce((latest, row) => (row.id > latest.id ? row : latest));
}
