import { validationError } from "../../lib/errors.js";
import { normalizeAmount, type BillingCycle } from "../../lib/money.js";
import { canonicalizeMerchant } from "../subscriptions/service.js";
import { parseDateToken } from "./emailParser.js";

/**
 * Bank CSV import. Two jobs: parse a statement export whose column names we do
 * not control, then find which charges look recurring. A single coffee is not a
 * subscription; the same amount to the same merchant three months running is.
 */

export interface CsvRow {
  date: Date | null;
  description: string;
  amount: string;
  currency: string;
  raw: Record<string, string>;
}

export interface RecurringCandidate {
  merchantGuess: string;
  merchantCanonical: string;
  amount: string;
  currency: string;
  date: Date | null;
  billingCycle: BillingCycle;
  occurrences: number;
  confidence: number;
  rawRow: Record<string, unknown>;
}

const DATE_HEADERS = ["date", "transaction date", "posted date", "posting date", "trans date"];
const DESC_HEADERS = ["description", "details", "narrative", "merchant", "name", "memo", "payee"];
const AMOUNT_HEADERS = ["amount", "debit", "value", "transaction amount", "amount (usd)"];
const CURRENCY_HEADERS = ["currency", "ccy", "currency code"];

/** RFC 4180 field splitting: quoted fields may contain commas and "" escapes. */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((field) => field.trim());
}

function headerIndex(headers: string[], names: string[]): number {
  const normalized = headers.map((h) => h.toLowerCase().trim());
  for (const name of names) {
    const exact = normalized.indexOf(name);
    if (exact >= 0) return exact;
  }
  for (const name of names) {
    const partial = normalized.findIndex((h) => h.includes(name));
    if (partial >= 0) return partial;
  }
  return -1;
}

function parseAmountCell(cell: string): { amount: string; currency: string } | null {
  const trimmed = cell.trim();
  if (!trimmed) return null;

  const currency = /[$]/.test(trimmed)
    ? "USD"
    : /€/.test(trimmed)
      ? "EUR"
      : /£/.test(trimmed)
        ? "GBP"
        : "USD";

  // Statements express spend as a negative, or in parentheses, or unsigned in a
  // dedicated debit column. All three mean money left the account.
  const parenthesised = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed.replace(/[()$€£,\s]/g, "");
  const numeric = Number(cleaned);
  if (!Number.isFinite(numeric) || numeric === 0) return null;

  const magnitude = Math.abs(numeric);
  void parenthesised;
  return { amount: normalizeAmount(magnitude.toFixed(2), currency), currency };
}

export function parseCsv(content: string, maxRows: number): CsvRow[] {
  const lines = content
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) throw validationError("CSV file is empty");
  if (lines.length - 1 > maxRows) {
    throw validationError(`CSV exceeds the ${maxRows} row limit`, { rows: lines.length - 1 });
  }

  const headers = splitCsvLine(lines[0]!);
  const dateIdx = headerIndex(headers, DATE_HEADERS);
  const descIdx = headerIndex(headers, DESC_HEADERS);
  const amountIdx = headerIndex(headers, AMOUNT_HEADERS);
  const currencyIdx = headerIndex(headers, CURRENCY_HEADERS);

  if (descIdx < 0 || amountIdx < 0) {
    throw validationError("CSV must have a description column and an amount column", { headers });
  }

  const rows: CsvRow[] = [];
  for (const line of lines.slice(1)) {
    const fields = splitCsvLine(line);
    const description = (fields[descIdx] ?? "").trim();
    const parsedAmount = parseAmountCell(fields[amountIdx] ?? "");
    if (!description || !parsedAmount) continue;

    const raw: Record<string, string> = {};
    headers.forEach((header, index) => {
      raw[header] = fields[index] ?? "";
    });

    const explicitCurrency =
      currencyIdx >= 0 ? (fields[currencyIdx] ?? "").trim().toUpperCase() : "";

    rows.push({
      date: dateIdx >= 0 ? parseDateToken(fields[dateIdx] ?? "") : null,
      description,
      amount: parsedAmount.amount,
      currency: explicitCurrency.length === 3 ? explicitCurrency : parsedAmount.currency,
      raw,
    });
  }

  return rows;
}

const SUBSCRIPTION_HINT_RE =
  /\b(subscription|subscr|recurring|monthly|annual|renewal|membership|plan|pro|premium|saas)\b/i;

/** Days between charges that read as a cycle, with slack for weekend posting. */
const CYCLE_WINDOWS: Array<{ cycle: BillingCycle; min: number; max: number }> = [
  { cycle: "weekly", min: 5, max: 9 },
  { cycle: "monthly", min: 26, max: 35 },
  { cycle: "yearly", min: 350, max: 380 },
];

function inferCycle(dates: Date[]): { cycle: BillingCycle; regular: boolean } {
  if (dates.length < 2) return { cycle: "monthly", regular: false };

  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    gaps.push((sorted[i]!.getTime() - sorted[i - 1]!.getTime()) / 86_400_000);
  }
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const window = CYCLE_WINDOWS.find((w) => mean >= w.min && mean <= w.max);
  if (!window) return { cycle: "monthly", regular: false };

  const consistent = gaps.every((gap) => gap >= window.min && gap <= window.max);
  return { cycle: window.cycle, regular: consistent };
}

/**
 * Group by canonical merchant + amount. Identical amounts recurring to the same
 * merchant is the strongest signal available in a bare statement; a single
 * charge only qualifies if the description says "subscription" outright.
 */
export function detectRecurring(rows: CsvRow[]): RecurringCandidate[] {
  const groups = new Map<string, CsvRow[]>();

  for (const row of rows) {
    const canonical = canonicalizeMerchant(row.description);
    if (!canonical) continue;
    const key = `${canonical}|${row.amount}|${row.currency}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const candidates: RecurringCandidate[] = [];

  for (const bucket of groups.values()) {
    const first = bucket[0]!;
    const canonical = canonicalizeMerchant(first.description);
    const dates = bucket.map((r) => r.date).filter((d): d is Date => d !== null);
    const { cycle, regular } = inferCycle(dates);
    const hinted = SUBSCRIPTION_HINT_RE.test(first.description);

    if (bucket.length < 2 && !hinted) continue;

    // Two identical charges 80 days apart are a coincidence, not a cycle. When
    // the statement gives us dates, the spacing has to look like a billing
    // period before we call it recurring.
    if (bucket.length >= 2 && dates.length === bucket.length && !regular && !hinted) continue;

    let confidence = 0.35;
    if (bucket.length >= 2) confidence += 0.25;
    if (bucket.length >= 3) confidence += 0.15;
    if (regular) confidence += 0.15;
    if (hinted) confidence += 0.1;
    confidence = Math.min(0.95, Number(confidence.toFixed(3)));

    const latest = dates.length > 0 ? new Date(Math.max(...dates.map((d) => d.getTime()))) : null;

    candidates.push({
      merchantGuess: cleanDescription(first.description),
      merchantCanonical: canonical,
      amount: first.amount,
      currency: first.currency,
      date: latest,
      billingCycle: bucket.length >= 2 ? cycle : "monthly",
      occurrences: bucket.length,
      confidence,
      rawRow: { ...first.raw, occurrences: bucket.length },
    });
  }

  return candidates.sort((a, b) => b.confidence - a.confidence || b.occurrences - a.occurrences);
}

/** Statement descriptors carry payment-processor noise: strip it for display. */
export function cleanDescription(description: string): string {
  const cleaned = description
    .replace(/^\s*(sq|tst|sp|pp|py|paypal|toast)\s*\*?\s*/i, " ")
    .replace(/\b(pos|ach|debit|card|purchase|payment|autopay|recurring|web|pmt)\b/gi, " ")
    .replace(/[*#]+/g, " ")
    .replace(/\b\d{4,}\b/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  const result = cleaned || description.trim();
  return result
    .split(/\s+/)
    .map((word) =>
      word.length > 1 && word === word.toUpperCase()
        ? word[0]! + word.slice(1).toLowerCase()
        : word,
    )
    .join(" ");
}
