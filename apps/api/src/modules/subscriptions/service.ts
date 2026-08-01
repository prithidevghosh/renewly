import { and, desc, eq, lt } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import { subscriptions, type Subscription } from "../../db/schema.js";
import { notFound } from "../../lib/errors.js";
import { toPage, type Page } from "../../lib/http.js";
import { annualize, normalizeAmount, type BillingCycle } from "../../lib/money.js";

/**
 * Merchant strings arrive from card statements ("ANTHROPIC*CLAUDE 4155551212"),
 * email receipts and typing. Canonicalising them is what makes dedupe and
 * catalog lookup possible.
 */
export function canonicalizeMerchant(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(
      /\b(inc|llc|ltd|corp|co|com|sa|bv|gmbh|pbc|technologies|technology|software|labs|subscription|subscr|recurring|payment|autopay|monthly|annual|renewal|www|http|https)\b/g,
      " ",
    )
    .replace(/\b\d{4,}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fields whose confidence gates payment. See PolicyGuard rule 2. */
export const GATED_FIELDS = ["amount", "merchant_name", "next_renewal_at"] as const;
export const CONFIDENCE_FLOOR = 0.7;

export function lowConfidenceFields(
  fieldConfidence: Record<string, number> | null | undefined,
): string[] {
  const confidence = fieldConfidence ?? {};
  return GATED_FIELDS.filter((field) => {
    const value = confidence[field];
    return typeof value === "number" && value < CONFIDENCE_FLOOR;
  });
}

export function requiresConfirmation(subscription: Subscription): boolean {
  if (subscription.confirmedAt) return false;
  return lowConfidenceFields(subscription.fieldConfidence).length > 0;
}

export interface SubscriptionDto {
  id: string;
  workspaceId: string;
  merchantName: string;
  merchantCanonical: string;
  planName: string | null;
  amount: string;
  currency: string;
  billingCycle: BillingCycle;
  annualCost: string;
  nextRenewalAt: string | null;
  cancelByAt: string | null;
  status: Subscription["status"];
  criticality: Subscription["criticality"];
  jobCategory: string | null;
  usageNote: string | null;
  seatsTotal: number;
  seatsActive: number | null;
  merchantId: string | null;
  contentHash: string | null;
  lastSignalAt: string | null;
  sourceType: Subscription["sourceType"];
  confirmedAt: string | null;
  fieldConfidence: Record<string, number>;
  lowConfidenceFields: string[];
  requiresConfirmation: boolean;
  priceChangeNote: string | null;
  rawExcerpt: string | null;
  notes: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function serializeSubscription(row: Subscription): SubscriptionDto {
  const currency = row.currency;
  const amount = normalizeAmount(row.amount, currency);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    merchantName: row.merchantName,
    merchantCanonical: row.merchantCanonical,
    planName: row.planName,
    amount,
    currency,
    billingCycle: row.billingCycle,
    annualCost: annualize(amount, row.billingCycle, currency),
    nextRenewalAt: row.nextRenewalAt?.toISOString() ?? null,
    cancelByAt: row.cancelByAt?.toISOString() ?? null,
    status: row.status,
    criticality: row.criticality,
    jobCategory: row.jobCategory,
    usageNote: row.usageNote,
    seatsTotal: row.seatsTotal,
    seatsActive: row.seatsActive,
    merchantId: row.merchantId,
    contentHash: row.contentHash,
    lastSignalAt: row.lastSignalAt?.toISOString() ?? null,
    sourceType: row.sourceType,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    fieldConfidence: row.fieldConfidence ?? {},
    lowConfidenceFields: lowConfidenceFields(row.fieldConfidence),
    requiresConfirmation: requiresConfirmation(row),
    priceChangeNote: row.priceChangeNote,
    rawExcerpt: row.rawExcerpt,
    notes: row.notes,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getSubscription(
  workspaceId: string,
  id: string,
  db: Database = getDb(),
): Promise<Subscription> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.id, id), eq(subscriptions.workspaceId, workspaceId)));
  if (!row) throw notFound("Subscription");
  return row;
}

export async function listSubscriptions(
  workspaceId: string,
  options: { limit: number; cursor?: string; status?: Subscription["status"] },
  db: Database = getDb(),
): Promise<Page<Subscription>> {
  const filters = [eq(subscriptions.workspaceId, workspaceId)];
  if (options.status) filters.push(eq(subscriptions.status, options.status));
  if (options.cursor) filters.push(lt(subscriptions.id, options.cursor));

  const rows = await db
    .select()
    .from(subscriptions)
    .where(and(...filters))
    .orderBy(desc(subscriptions.id))
    .limit(options.limit + 1);

  return toPage(rows, options.limit);
}

/** An existing active subscription for the same canonical merchant, if any. */
export async function findByCanonicalMerchant(
  workspaceId: string,
  merchantCanonical: string,
  db: Database = getDb(),
): Promise<Subscription | null> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.workspaceId, workspaceId),
        eq(subscriptions.merchantCanonical, merchantCanonical),
        eq(subscriptions.status, "active"),
      ),
    );
  return row ?? null;
}
