import { and, desc, eq, lt } from "drizzle-orm";
import { getDb, type Database } from "../../db/client.js";
import {
  receipts,
  savingsEntries,
  transactions,
  type Receipt,
  type SavingsEntry,
} from "../../db/schema.js";
import { notFound } from "../../lib/errors.js";
import { toPage, type Page } from "../../lib/http.js";
import { newId } from "../../lib/id.js";
import { normalizeAmount, sum } from "../../lib/money.js";
import { recordAudit } from "../audit/service.js";

export type SavingsActionType = SavingsEntry["actionType"];
export type SavingsRecognition = SavingsEntry["recognition"];

export interface SavingsEntryDto {
  id: string;
  workspaceId: string;
  subscriptionId: string | null;
  decisionId: string | null;
  approvalRequestId: string | null;
  actionType: SavingsActionType;
  recognition: SavingsRecognition;
  amountSaved: string;
  currency: string;
  periodMonths: number;
  note: string | null;
  createdAt: string;
}

export function serializeSavings(row: SavingsEntry): SavingsEntryDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    subscriptionId: row.subscriptionId,
    decisionId: row.decisionId,
    approvalRequestId: row.approvalRequestId,
    actionType: row.actionType,
    recognition: row.recognition,
    amountSaved: normalizeAmount(row.amountSaved, row.currency),
    currency: row.currency,
    periodMonths: row.periodMonths,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface RecordSavingsInput {
  workspaceId: string;
  actorUserId?: string | null;
  subscriptionId?: string | null;
  decisionId?: string | null;
  approvalRequestId?: string | null;
  actionType: SavingsActionType;
  /** `identified` is a claim the agent is making; `realized` is banked money. */
  recognition: SavingsRecognition;
  amountSaved: string;
  currency: string;
  periodMonths?: number;
  note?: string | null;
}

export async function recordSavings(
  input: RecordSavingsInput,
  db: Database = getDb(),
): Promise<SavingsEntry> {
  const [row] = await db
    .insert(savingsEntries)
    .values({
      id: newId("sav"),
      workspaceId: input.workspaceId,
      subscriptionId: input.subscriptionId ?? null,
      decisionId: input.decisionId ?? null,
      approvalRequestId: input.approvalRequestId ?? null,
      actionType: input.actionType,
      recognition: input.recognition,
      amountSaved: normalizeAmount(input.amountSaved, input.currency),
      currency: input.currency,
      periodMonths: input.periodMonths ?? 12,
      note: input.note ?? null,
    })
    .returning();
  if (!row) throw new Error("savings insert returned no row");

  await recordAudit(
    {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId ?? null,
      type: "savings.recorded",
      entityType: "savings_entry",
      entityId: row.id,
      data: {
        actionType: row.actionType,
        recognition: row.recognition,
        amountSaved: row.amountSaved,
        currency: row.currency,
        subscriptionId: row.subscriptionId,
        approvalRequestId: row.approvalRequestId,
      },
    },
    db,
  );

  return row;
}

/**
 * Supersedes any prior identified estimate for a decision. Regenerating a
 * decision must not stack two claims for the same opportunity.
 */
export async function replaceIdentifiedSavings(
  input: RecordSavingsInput & { decisionId: string },
  db: Database = getDb(),
): Promise<SavingsEntry> {
  await db
    .delete(savingsEntries)
    .where(
      and(
        eq(savingsEntries.decisionId, input.decisionId),
        eq(savingsEntries.recognition, "identified"),
      ),
    );
  return recordSavings({ ...input, recognition: "identified" }, db);
}

/**
 * An opportunity that has been banked is no longer merely identified. Dropping
 * the estimate on realization is what keeps the two totals from double-counting
 * the same saving.
 */
export async function retireIdentifiedForSubscription(
  subscriptionId: string,
  db: Database = getDb(),
): Promise<void> {
  await db
    .delete(savingsEntries)
    .where(
      and(
        eq(savingsEntries.subscriptionId, subscriptionId),
        eq(savingsEntries.recognition, "identified"),
      ),
    );
}

export async function listSavings(
  workspaceId: string,
  options: { limit: number; cursor?: string; recognition?: SavingsRecognition },
  db: Database = getDb(),
): Promise<Page<SavingsEntry>> {
  const filters = [eq(savingsEntries.workspaceId, workspaceId)];
  if (options.recognition) filters.push(eq(savingsEntries.recognition, options.recognition));
  if (options.cursor) filters.push(lt(savingsEntries.id, options.cursor));

  const rows = await db
    .select()
    .from(savingsEntries)
    .where(and(...filters))
    .orderBy(desc(savingsEntries.id))
    .limit(options.limit + 1);

  return toPage(rows, options.limit);
}

export interface SavingsSummary {
  identifiedTotal: string;
  realizedTotal: string;
  currency: string;
  identifiedCount: number;
  realizedCount: number;
  byActionType: Record<SavingsActionType, string>;
  ignoredCurrencies: string[];
}

const ZERO_BY_ACTION = (): Record<SavingsActionType, string> => ({
  cancel: "0.00",
  rightsize: "0.00",
  term_switch: "0.00",
  switch_vendor: "0.00",
  renew: "0.00",
  other: "0.00",
});

/**
 * Identified and realized are reported separately and never summed. V1
 * workspaces are single-currency; entries in another currency are listed as
 * ignored rather than converted, because a made-up FX rate is worse than an
 * explicit omission.
 */
export async function savingsSummary(
  workspaceId: string,
  currency: string,
  db: Database = getDb(),
): Promise<SavingsSummary> {
  const rows = await db
    .select()
    .from(savingsEntries)
    .where(eq(savingsEntries.workspaceId, workspaceId));

  const matching = rows.filter((row) => row.currency === currency);
  const ignored = [...new Set(rows.filter((r) => r.currency !== currency).map((r) => r.currency))];

  const identified = matching.filter((row) => row.recognition === "identified");
  const realized = matching.filter((row) => row.recognition === "realized");

  const byActionType = ZERO_BY_ACTION();
  for (const action of Object.keys(byActionType) as SavingsActionType[]) {
    byActionType[action] = sum(
      realized.filter((row) => row.actionType === action).map((row) => row.amountSaved),
      currency,
    );
  }

  return {
    identifiedTotal: sum(
      identified.map((row) => row.amountSaved),
      currency,
    ),
    realizedTotal: sum(
      realized.map((row) => row.amountSaved),
      currency,
    ),
    currency,
    identifiedCount: identified.length,
    realizedCount: realized.length,
    byActionType,
    ignoredCurrencies: ignored,
  };
}

export interface ReceiptDto {
  id: string;
  workspaceId: string;
  transactionId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export function serializeReceipt(row: Receipt): ReceiptDto {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    transactionId: row.transactionId,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listReceipts(
  workspaceId: string,
  options: { limit: number; cursor?: string },
  db: Database = getDb(),
): Promise<Page<Receipt>> {
  const filters = [eq(receipts.workspaceId, workspaceId)];
  if (options.cursor) filters.push(lt(receipts.id, options.cursor));

  const rows = await db
    .select()
    .from(receipts)
    .where(and(...filters))
    .orderBy(desc(receipts.id))
    .limit(options.limit + 1);

  return toPage(rows, options.limit);
}

export async function getReceipt(
  workspaceId: string,
  id: string,
  db: Database = getDb(),
): Promise<{ receipt: Receipt; transaction: typeof transactions.$inferSelect | null }> {
  const [row] = await db
    .select()
    .from(receipts)
    .where(and(eq(receipts.id, id), eq(receipts.workspaceId, workspaceId)));
  if (!row) throw notFound("Receipt");

  const [transaction] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, row.transactionId));

  return { receipt: row, transaction: transaction ?? null };
}
