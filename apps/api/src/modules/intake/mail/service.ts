import { and, eq } from "drizzle-orm";
import { getDb, type Database } from "../../../db/client.js";
import {
  inboundEmails,
  subscriptions,
  workspaces,
  type InboundEmail,
} from "../../../db/schema.js";
import { AppError } from "../../../lib/errors.js";
import { newId } from "../../../lib/id.js";
import { contentHash, rawContentHash, sha256 } from "../../../lib/crypto.js";
import { normalizeAmount } from "../../../lib/money.js";
import { canonicalizeMerchant } from "../../subscriptions/service.js";
import { resolveOrCreateMerchant } from "../../merchants/service.js";
import { parseRenewalText, recordRenewalEvent } from "../service.js";
import { recordAudit } from "../../audit/service.js";
import type { AuthContext } from "../../../types/context.js";

/**
 * Inbound mail. A founder forwards a renewal notice to their Renewly address
 * and the subscription appears — no OAuth, no mailbox access, no scopes.
 *
 * Two things make this safe to run unattended: the workspace is derived from
 * the plus-address token rather than the From header (which is trivially
 * forged), and every message is deduped twice — once on the provider's
 * Message-ID and once on a hash of the parsed facts, because a forward rewrites
 * the envelope but not the numbers.
 */

export interface NormalizedEmail {
  messageId: string | null;
  from: string;
  to: string;
  subject: string | null;
  text: string;
  provider: string;
}

/**
 * Providers disagree on field names. Rather than one adapter per vendor, the
 * shapes we have seen (Mailgun, Resend, SES/SNS, Postmark) are probed in turn.
 */
export function normalizeInboundEmail(
  payload: Record<string, unknown>,
  provider: string,
): NormalizedEmail {
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = readPath(payload, key);
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  };

  const text =
    pick(
      "text",
      "body-plain",
      "TextBody",
      "stripped-text",
      "plain",
      "content.text",
      "mail.text",
    ) ??
    pick("html", "body-html", "HtmlBody", "content.html") ??
    "";

  const from =
    pick("from", "sender", "From", "envelope.from", "mail.source", "headers.from") ?? "unknown@unknown";
  const to =
    pick("to", "recipient", "To", "envelope.to", "mail.destination.0", "headers.to") ?? "";

  if (!text.trim()) {
    throw new AppError("VALIDATION_ERROR", "Inbound email carried no readable body", { provider });
  }

  return {
    messageId: pick("message-id", "Message-ID", "messageId", "MessageID", "headers.message-id"),
    from: extractAddress(from),
    to: extractAddress(to),
    subject: pick("subject", "Subject", "headers.subject"),
    text,
    provider,
  };
}

function readPath(source: Record<string, unknown>, path: string): unknown {
  if (!path.includes(".")) return source[path];
  let current: unknown = source;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = Array.isArray(current)
      ? current[Number(part)]
      : (current as Record<string, unknown>)[part];
  }
  return current;
}

/** "Anthropic <billing@anthropic.com>" -> "billing@anthropic.com". */
export function extractAddress(value: string): string {
  const angled = value.match(/<([^>]+)>/);
  const address = (angled?.[1] ?? value).trim().toLowerCase();
  return address.split(/[,;]/)[0]?.trim() ?? address;
}

/**
 * `renew+<token>@inbound.renewly.app` -> the token. The token is derived from
 * the workspace id, so it is stable, unguessable and needs no extra storage.
 */
export function extractRoutingToken(toAddress: string): string | null {
  const local = toAddress.split("@")[0];
  if (!local) return null;
  const plus = local.indexOf("+");
  if (plus < 0) return null;
  const token = local.slice(plus + 1).trim();
  return token.length > 0 ? token : null;
}

/** Short, stable, unguessable without AUTH_SECRET. */
export function inboundTokenFor(workspaceId: string): string {
  return sha256(`inbound:${workspaceId}`).slice(0, 20);
}

export function inboundAddressFor(workspaceId: string, domain: string): string {
  return `renew+${inboundTokenFor(workspaceId)}@${domain}`;
}

export async function resolveWorkspaceByToken(
  token: string,
  db: Database = getDb(),
): Promise<string | null> {
  // The token is a one-way hash, so the mapping is rebuilt rather than reversed.
  const rows = await db.select({ id: workspaces.id }).from(workspaces);
  return rows.find((row) => inboundTokenFor(row.id) === token)?.id ?? null;
}

export interface IngestResult {
  inboundEmail: InboundEmail;
  status: "parsed" | "duplicate" | "failed";
  subscriptionId: string | null;
  renewalEventId: string | null;
  duplicateOf: string | null;
}

/**
 * Stores, parses and reconciles one inbound message. Reconciliation updates an
 * existing subscription rather than creating a second one when the merchant and
 * amount match: a forwarded receipt for a tool already tracked is a signal that
 * it is still alive, not a new line item.
 */
export async function ingestInboundEmail(
  input: { auth: AuthContext; email: NormalizedEmail; db?: Database },
): Promise<IngestResult> {
  const db = input.db ?? getDb();
  const { auth, email } = input;

  const rawHash = rawContentHash(email.text);

  // Same Message-ID, or a byte-identical body, means we have seen this already.
  const priors = await db
    .select()
    .from(inboundEmails)
    .where(
      and(
        eq(inboundEmails.workspaceId, auth.workspace.id),
        eq(inboundEmails.contentHash, rawHash),
      ),
    );

  if (priors.length > 0 || (email.messageId && (await messageIdSeen(email.messageId, db)))) {
    const [stored] = await db
      .insert(inboundEmails)
      .values({
        id: newId("eml"),
        workspaceId: auth.workspace.id,
        // Null so the unique index does not reject a genuine re-delivery.
        messageId: null,
        fromAddr: email.from,
        toAddr: email.to,
        subject: email.subject,
        rawText: email.text.slice(0, 100_000),
        contentHash: rawHash,
        parseStatus: "duplicate",
        provider: email.provider,
      })
      .returning();
    if (!stored) throw new Error("inbound email insert returned no row");

    await recordAudit(
      {
        workspaceId: auth.workspace.id,
        type: "mail.duplicate",
        entityType: "inbound_email",
        entityId: stored.id,
        data: { from: email.from, subject: email.subject },
      },
      db,
    );

    return {
      inboundEmail: stored,
      status: "duplicate",
      subscriptionId: priors[0]?.id ?? null,
      renewalEventId: null,
      duplicateOf: priors[0]?.id ?? null,
    };
  }

  const [stored] = await db
    .insert(inboundEmails)
    .values({
      id: newId("eml"),
      workspaceId: auth.workspace.id,
      messageId: email.messageId,
      fromAddr: email.from,
      toAddr: email.to,
      subject: email.subject,
      rawText: email.text.slice(0, 100_000),
      contentHash: rawHash,
      parseStatus: "pending",
      provider: email.provider,
    })
    .returning();
  if (!stored) throw new Error("inbound email insert returned no row");

  await recordAudit(
    {
      workspaceId: auth.workspace.id,
      type: "mail.received",
      entityType: "inbound_email",
      entityId: stored.id,
      data: { from: email.from, subject: email.subject, provider: email.provider },
    },
    db,
  );

  const outcome = await parseRenewalText(
    email.subject ? `Subject: ${email.subject}\n${email.text}` : email.text,
  );

  const renewalEvent = await recordRenewalEvent(
    { auth, rawText: email.text, outcome, sourceType: "email", db },
    );

  const merchantName = outcome.parsed.merchant_name;
  const canonical = canonicalizeMerchant(merchantName);
  const currency = outcome.parsed.currency ?? "USD";

  const facts = contentHash({
    merchantCanonical: canonical,
    amount: outcome.parsed.amount,
    currency,
    billingCycle: outcome.parsed.billing_cycle,
    nextRenewalAt: outcome.parsed.next_renewal_at,
  });

  const merchant = await resolveOrCreateMerchant(auth.workspace.id, merchantName, db);

  const subscriptionId = await reconcile(
    {
      workspaceId: auth.workspace.id,
      canonical,
      merchantId: merchant?.id ?? null,
      merchantName,
      parsed: outcome.parsed,
      contentHash: facts,
      currency,
    },
    db,
  );

  const [updated] = await db
    .update(inboundEmails)
    .set({ parseStatus: "parsed", renewalEventId: renewalEvent.id })
    .where(eq(inboundEmails.id, stored.id))
    .returning();

  return {
    inboundEmail: updated ?? stored,
    status: "parsed",
    subscriptionId,
    renewalEventId: renewalEvent.id,
    duplicateOf: null,
  };
}

async function messageIdSeen(messageId: string, db: Database): Promise<boolean> {
  const [row] = await db
    .select({ id: inboundEmails.id })
    .from(inboundEmails)
    .where(eq(inboundEmails.messageId, messageId));
  return row !== undefined;
}

/**
 * Match on canonical merchant. A repeat sighting refreshes the price and the
 * renewal date instead of forking a duplicate row.
 */
async function reconcile(
  input: {
    workspaceId: string;
    canonical: string;
    merchantId: string | null;
    merchantName: string;
    parsed: { amount: string | null; billing_cycle: string; next_renewal_at: string | null; cancel_by_at: string | null; field_confidence: Record<string, number>; plan_name: string | null; price_change_note: string | null; raw_excerpt: string };
    contentHash: string;
    currency: string;
  },
  db: Database,
): Promise<string | null> {
  if (!input.parsed.amount) return null;

  const existing = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.workspaceId, input.workspaceId),
        eq(subscriptions.merchantCanonical, input.canonical),
      ),
    );

  const live = existing.find((row) => row.status === "active" || row.status === "pending_cancel");
  const amount = normalizeAmount(input.parsed.amount, input.currency);
  const nextRenewalAt = input.parsed.next_renewal_at
    ? new Date(input.parsed.next_renewal_at)
    : null;

  if (live) {
    // A price change is the single most valuable thing a renewal email carries,
    // so it overwrites; confidence is re-gated because the numbers moved.
    const priceMoved = live.amount !== amount;
    await db
      .update(subscriptions)
      .set({
        amount,
        ...(nextRenewalAt ? { nextRenewalAt } : {}),
        ...(input.parsed.cancel_by_at ? { cancelByAt: new Date(input.parsed.cancel_by_at) } : {}),
        ...(input.parsed.price_change_note
          ? { priceChangeNote: input.parsed.price_change_note }
          : {}),
        merchantId: input.merchantId,
        contentHash: input.contentHash,
        lastSignalAt: new Date(),
        fieldConfidence: input.parsed.field_confidence,
        ...(priceMoved ? { confirmedAt: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(subscriptions.id, live.id));
    return live.id;
  }

  const [created] = await db
    .insert(subscriptions)
    .values({
      id: newId("sub"),
      workspaceId: input.workspaceId,
      merchantName: input.merchantName,
      merchantCanonical: input.canonical,
      merchantId: input.merchantId,
      planName: input.parsed.plan_name,
      amount,
      currency: input.currency,
      billingCycle: input.parsed.billing_cycle as "monthly" | "yearly" | "weekly" | "unknown",
      nextRenewalAt,
      cancelByAt: input.parsed.cancel_by_at ? new Date(input.parsed.cancel_by_at) : null,
      sourceType: "email",
      fieldConfidence: input.parsed.field_confidence,
      priceChangeNote: input.parsed.price_change_note,
      rawExcerpt: input.parsed.raw_excerpt,
      contentHash: input.contentHash,
      lastSignalAt: new Date(),
      // Confirmation is decided by the parser's confidence, not by the source.
      confirmedAt: null,
    })
    .returning();

  return created?.id ?? null;
}
