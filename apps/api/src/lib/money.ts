import { validationError } from "./errors.js";

/**
 * Money is a decimal string at every boundary ("20.00") and a bigint of minor
 * units internally. Floats are never used: 0.1 + 0.2 is not 0.3 and a renewal
 * ledger that drifts is worse than no ledger.
 */

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "XAF", "XOF", "XPF"]);
const THREE_DECIMAL = new Set(["BHD", "KWD", "JOD", "OMR", "TND"]);

const DECIMAL_RE = /^-?\d{1,15}(\.\d{1,6})?$/;

export function currencyExponent(currency: string): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

export function isValidAmount(amount: string): boolean {
  return DECIMAL_RE.test(amount.trim());
}

/** Parse a decimal string into minor units, rounding half-up at the currency exponent. */
export function toMinor(amount: string, currency: string = "USD"): bigint {
  const trimmed = amount.trim();
  if (!DECIMAL_RE.test(trimmed)) {
    throw validationError(`Invalid money amount: ${amount}`, { amount });
  }
  const exponent = currencyExponent(currency);
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = "0", fraction = ""] = unsigned.split(".");

  const padded = fraction.padEnd(exponent + 1, "0");
  const kept = padded.slice(0, exponent);
  const nextDigit = Number(padded[exponent] ?? "0");

  let minor = BigInt(whole + (kept || "")) ;
  if (nextDigit >= 5) minor += 1n;
  return negative ? -minor : minor;
}

/** Render minor units back to a fixed-precision decimal string. */
export function fromMinor(minor: bigint, currency: string = "USD"): string {
  const exponent = currencyExponent(currency);
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const digits = abs.toString().padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent) || "0";
  const fraction = exponent === 0 ? "" : `.${digits.slice(digits.length - exponent)}`;
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

/** Normalise any accepted decimal string to the currency's canonical form. */
export function normalizeAmount(amount: string, currency: string = "USD"): string {
  return fromMinor(toMinor(amount, currency), currency);
}

export function add(a: string, b: string, currency: string = "USD"): string {
  return fromMinor(toMinor(a, currency) + toMinor(b, currency), currency);
}

export function sub(a: string, b: string, currency: string = "USD"): string {
  return fromMinor(toMinor(a, currency) - toMinor(b, currency), currency);
}

export function mul(a: string, factor: number, currency: string = "USD"): string {
  if (!Number.isInteger(factor)) {
    throw validationError("Money may only be multiplied by an integer factor", { factor });
  }
  return fromMinor(toMinor(a, currency) * BigInt(factor), currency);
}

/** -1 when a < b, 0 when equal, 1 when a > b. */
export function cmp(a: string, b: string, currency: string = "USD"): -1 | 0 | 1 {
  const left = toMinor(a, currency);
  const right = toMinor(b, currency);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function max(a: string, b: string, currency: string = "USD"): string {
  return cmp(a, b, currency) >= 0 ? normalizeAmount(a, currency) : normalizeAmount(b, currency);
}

export function sum(amounts: string[], currency: string = "USD"): string {
  return fromMinor(
    amounts.reduce<bigint>((acc, amount) => acc + toMinor(amount, currency), 0n),
    currency,
  );
}

export function isZero(amount: string, currency: string = "USD"): boolean {
  return toMinor(amount, currency) === 0n;
}

export function abs(amount: string, currency: string = "USD"): string {
  const minor = toMinor(amount, currency);
  return fromMinor(minor < 0n ? -minor : minor, currency);
}

export type BillingCycle = "monthly" | "yearly" | "weekly" | "unknown";

/** Occurrences per year. `unknown` is treated as monthly — the common default. */
export const CYCLE_MULTIPLIER: Record<BillingCycle, number> = {
  monthly: 12,
  yearly: 1,
  weekly: 52,
  unknown: 12,
};

/** Annualised cost of a per-cycle amount. */
export function annualize(
  amount: string,
  cycle: BillingCycle,
  currency: string = "USD",
): string {
  return mul(amount, CYCLE_MULTIPLIER[cycle], currency);
}

/** Convert an annual amount to a per-cycle amount, rounding half-up. */
export function deannualize(
  annualAmount: string,
  cycle: BillingCycle,
  currency: string = "USD",
): string {
  const divisor = BigInt(CYCLE_MULTIPLIER[cycle]);
  const minor = toMinor(annualAmount, currency);
  const negative = minor < 0n;
  const absMinor = negative ? -minor : minor;
  const quotient = absMinor / divisor;
  const remainder = absMinor % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  return fromMinor(negative ? -rounded : rounded, currency);
}

/** Percentage of an amount, rounded half-up. Used for downgrade estimates. */
export function percentOf(amount: string, percent: number, currency: string = "USD"): string {
  const minor = toMinor(amount, currency);
  const scaled = (minor * BigInt(Math.round(percent * 100)) + 5000n) / 10000n;
  return fromMinor(scaled, currency);
}
