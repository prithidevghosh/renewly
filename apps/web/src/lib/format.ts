/**
 * Formatting helpers.
 *
 * Deliberately avoids `toLocaleDateString` / `Intl` for dates: those resolve
 * differently on the Node server and in the browser (ICU + timezone), which
 * produces hydration mismatches. Everything here is UTC-anchored and
 * deterministic, so server and client always render the same string.
 */

import type { Cents, ISODate } from "@/lib/domain/types";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/* -------------------------------------------------------------------------- */
/* Money — always rendered in mono/tabular. See DESIGN.md §3.1 "the money rule" */
/* -------------------------------------------------------------------------- */

/** `57600` → `"$576.00"`. Set `cents: false` to drop the decimals. */
export function money(value: Cents, opts: { cents?: boolean; sign?: boolean } = {}): string {
  const { cents = true, sign = false } = opts;
  const negative = value < 0;
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 100);
  const rest = abs % 100;

  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = cents ? `${grouped}.${rest.toString().padStart(2, "0")}` : grouped;

  const prefix = negative ? "−" : sign ? "+" : "";
  return `${prefix}$${body}`;
}

/** `863388` → `"$8.6k"`. For hero stats where precision is noise. */
export function moneyCompact(value: Cents): string {
  const abs = Math.abs(value) / 100;
  const prefix = value < 0 ? "−$" : "$";
  if (abs >= 1_000_000) return `${prefix}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1000) return `${prefix}${(abs / 1000).toFixed(1)}k`;
  return `${prefix}${Math.round(abs)}`;
}

/** Annualise a per-cadence amount. */
export function annualise(amountCents: Cents, cadence: "monthly" | "annual" | "quarterly"): Cents {
  if (cadence === "monthly") return amountCents * 12;
  if (cadence === "quarterly") return amountCents * 4;
  return amountCents;
}

export function cadenceSuffix(cadence: "monthly" | "annual" | "quarterly"): string {
  return cadence === "monthly" ? "/mo" : cadence === "quarterly" ? "/qtr" : "/yr";
}

/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */

/** `"2026-08-12T00:00:00.000Z"` → `"12 Aug"`. */
export function shortDate(iso: ISODate): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** `"…"` → `"12 Aug 2026"`. */
export function longDate(iso: ISODate): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** `"…"` → `"14:32"` (UTC, 24h — reads as machine output). */
export function clockTime(iso: ISODate): string {
  const d = new Date(iso);
  return `${d.getUTCHours().toString().padStart(2, "0")}:${d
    .getUTCMinutes()
    .toString()
    .padStart(2, "0")}`;
}

/** `"…"` → `"12 Aug · 14:32"`. Ledger timestamp format. */
export function stamp(iso: ISODate): string {
  return `${shortDate(iso)} · ${clockTime(iso)}`;
}

/** Whole days from today (UTC midnight) to the given date. Negative = past. */
export function daysUntil(iso: ISODate): number {
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const target = new Date(iso);
  const targetUTC = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate());
  return Math.round((targetUTC - todayUTC) / 86_400_000);
}

/** `2` → `"in 2 days"`, `0` → `"today"`, `-3` → `"3 days ago"`. */
export function relativeDays(iso: ISODate): string {
  const d = daysUntil(iso);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d === -1) return "yesterday";
  if (d > 0) return `in ${d} days`;
  return `${Math.abs(d)} days ago`;
}

/** Compact form for dense tables: `"2d"`, `"14d"`, `"3mo"`. */
export function daysBadge(iso: ISODate): string {
  const d = daysUntil(iso);
  if (d <= 0) return "due";
  if (d < 45) return `${d}d`;
  return `${Math.round(d / 30)}mo`;
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                        */
/* -------------------------------------------------------------------------- */

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
