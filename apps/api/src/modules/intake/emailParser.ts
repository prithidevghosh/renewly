import { normalizeAmount, type BillingCycle } from "../../lib/money.js";
import type { ParsedRenewal } from "../../lib/llm.js";

/**
 * Heuristic renewal extractor. This is the fallback when no LLM key is
 * configured, and it is a real code path — not a stub. It is deliberately
 * conservative: every field it infers rather than reads gets a confidence below
 * the 0.7 payment gate so the user is asked to confirm.
 */

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₹": "INR",
};

const AMOUNT_RE =
  /(?:(?<symbol>[$€£¥₹])\s?(?<symAmount>\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)|(?<isoAmount>\d{1,3}(?:,\d{3})*(?:\.\d{2}))\s?(?<iso>USD|EUR|GBP|CAD|AUD|INR|JPY|SGD))/gi;

const AMOUNT_CONTEXT_RE =
  /(total|amount|charged|charge|billed|bill|payment|price|due|subtotal|renew\w*|per month|per year|\/mo|\/yr)/i;

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

const CYCLE_PATTERNS: Array<{ cycle: BillingCycle; re: RegExp }> = [
  { cycle: "yearly", re: /\b(annual(?:ly)?|per year|\/\s?year|\/yr|yearly|12\s?months)\b/i },
  { cycle: "weekly", re: /\b(weekly|per week|\/\s?week|\/wk)\b/i },
  { cycle: "monthly", re: /\b(monthly|per month|\/\s?month|\/mo|每月)\b/i },
];

const NOISE_PREFIXES =
  /^(re|fwd|fw|receipt|invoice|payment|your|thank you for|order|billing|subscription)\b[:\s-]*/i;

/** Merchants whose emails we can name with high confidence from the sender. */
const KNOWN_MERCHANT_DOMAINS: Record<string, string> = {
  "anthropic.com": "Anthropic",
  "claude.ai": "Anthropic",
  "openai.com": "OpenAI",
  "midjourney.com": "Midjourney",
  "notion.so": "Notion",
  "figma.com": "Figma",
  "github.com": "GitHub",
  "linear.app": "Linear",
  "vercel.com": "Vercel",
  "slack.com": "Slack",
  "stripe.com": "Stripe",
  "google.com": "Google",
  "atlassian.com": "Atlassian",
  "zoom.us": "Zoom",
  "canva.com": "Canva",
};

interface Candidate<T> {
  value: T;
  confidence: number;
}

function stripHtml(text: string): string {
  return text
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#\d+;/g, " ");
}

function findMerchant(text: string, lines: string[]): Candidate<string> | null {
  const fromLine = lines.find((line) => /^from:/i.test(line));
  const domainMatch = (fromLine ?? text).match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  if (domainMatch?.[1]) {
    const domain = domainMatch[1].toLowerCase();
    for (const [known, name] of Object.entries(KNOWN_MERCHANT_DOMAINS)) {
      if (domain === known || domain.endsWith(`.${known}`)) {
        return { value: name, confidence: 0.92 };
      }
    }
    const root = domain.split(".").slice(-2, -1)[0];
    if (root && root.length > 1 && !["gmail", "outlook", "yahoo", "icloud"].includes(root)) {
      return { value: titleCase(root), confidence: 0.72 };
    }
  }

  // A body mention of a known brand is strong even without a usable sender.
  for (const name of new Set(Object.values(KNOWN_MERCHANT_DOMAINS))) {
    const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, "i");
    if (re.test(text)) return { value: name, confidence: 0.8 };
  }

  const subject = lines.find((line) => /^subject:/i.test(line));
  if (subject) {
    const cleaned = subject.replace(/^subject:/i, "").replace(NOISE_PREFIXES, "").trim();
    const first = cleaned.split(/[\s—–-]+/).filter(Boolean)[0];
    if (first && first.length > 2) return { value: titleCase(first), confidence: 0.45 };
  }

  return null;
}

function findAmount(text: string): Candidate<{ amount: string; currency: string }> | null {
  const matches = [...text.matchAll(AMOUNT_RE)];
  if (matches.length === 0) return null;

  let best: { amount: string; currency: string; score: number } | null = null;

  for (const match of matches) {
    const groups = match.groups ?? {};
    const rawAmount = groups.symAmount ?? groups.isoAmount;
    if (!rawAmount) continue;

    const currency = groups.symbol
      ? (CURRENCY_SYMBOLS[groups.symbol] ?? "USD")
      : (groups.iso ?? "USD").toUpperCase();

    const start = Math.max(0, (match.index ?? 0) - 60);
    const context = text.slice(start, (match.index ?? 0) + rawAmount.length + 20);
    const contextual = AMOUNT_CONTEXT_RE.test(context);
    const isTotal = /\btotal\b/i.test(context);

    const numeric = Number(rawAmount.replace(/,/g, ""));
    if (!Number.isFinite(numeric) || numeric <= 0) continue;

    // Prefer a labelled "total", then any labelled amount, then the largest.
    const score = (isTotal ? 1000 : 0) + (contextual ? 100 : 0) + Math.min(numeric, 99);
    if (!best || score > best.score) {
      best = { amount: normalizeAmount(rawAmount.replace(/,/g, ""), currency), currency, score };
    }
  }

  if (!best) return null;
  const confidence = best.score >= 1000 ? 0.9 : best.score >= 100 ? 0.75 : 0.5;
  return { value: { amount: best.amount, currency: best.currency }, confidence };
}

function findCycle(text: string): Candidate<BillingCycle> {
  for (const { cycle, re } of CYCLE_PATTERNS) {
    if (re.test(text)) return { value: cycle, confidence: 0.85 };
  }
  return { value: "unknown", confidence: 0.3 };
}

/** Parses "August 12, 2026", "12 August 2026", "2026-08-12" and "08/12/2026". */
export function parseDateToken(token: string, reference: Date = new Date()): Date | null {
  const trimmed = token.trim();

  const iso = trimmed.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso?.[1] && iso[2] && iso[3]) {
    return utc(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }

  const monthFirst = trimmed.match(
    /\b([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s*(\d{4})?\b/i,
  );
  if (monthFirst?.[1] && monthFirst[2]) {
    const monthIndex = MONTHS.findIndex((m) => m.startsWith(monthFirst[1]!.toLowerCase()));
    if (monthIndex >= 0) {
      const year = monthFirst[3] ? Number(monthFirst[3]) : reference.getUTCFullYear();
      return utc(year, monthIndex, Number(monthFirst[2]));
    }
  }

  const dayFirst = trimmed.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\.?\s*(\d{4})?\b/i);
  if (dayFirst?.[1] && dayFirst[2]) {
    const monthIndex = MONTHS.findIndex((m) => m.startsWith(dayFirst[2]!.toLowerCase()));
    if (monthIndex >= 0) {
      const year = dayFirst[3] ? Number(dayFirst[3]) : reference.getUTCFullYear();
      return utc(year, monthIndex, Number(dayFirst[1]));
    }
  }

  // Ambiguous numeric form. Assume US ordering, which is what the merchants we
  // see actually send, and let the low confidence carry the doubt.
  const numeric = trimmed.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (numeric?.[1] && numeric[2] && numeric[3]) {
    const year = Number(numeric[3]);
    return utc(year < 100 ? 2000 + year : year, Number(numeric[1]) - 1, Number(numeric[2]));
  }

  return null;
}

function utc(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month, day, 12, 0, 0));
  if (Number.isNaN(date.getTime())) return null;
  if (date.getUTCMonth() !== ((month % 12) + 12) % 12) return null;
  return date;
}

/**
 * The month name is spelled out in the pattern rather than left as `[a-z]+`.
 * Without it, "renews on 03 September" lets the connective word "on" pose as a
 * month and the date is silently lost.
 */
const MONTH_ALT = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

const DATE_ALT = [
  "\\d{4}-\\d{2}-\\d{2}",
  `(?:${MONTH_ALT})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s*\\d{4}?`,
  `\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTH_ALT})\\.?,?\\s*\\d{4}?`,
  "\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}",
].join("|");

// A line break between the cue and the date is normal in wrapped email bodies,
// so whitespace is allowed in the gap but a sentence boundary is not.
const RENEW_DATE_RE = new RegExp(
  `(renew\\w*|next (?:billing|payment|charge)|bill(?:ed|ing)? on|next charge|due on|charged on)[^.]{0,40}?(${DATE_ALT})`,
  "i",
);

const CANCEL_DATE_RE = new RegExp(
  `cancel[^.]{0,40}?(?:by|before|until)[^.]{0,40}?(${DATE_ALT})`,
  "i",
);

const PRICE_CHANGE_RE =
  /((?:price|pricing|rate|cost)[^.\n]{0,80}(?:increas|chang|updat|rise|rising|going up)[^.\n]{0,80}|(?:increas|chang)[^.\n]{0,40}(?:price|pricing|rate)[^.\n]{0,80})/i;

const PLAN_RE =
  /\b(pro|plus|premium|business|team|enterprise|standard|basic|starter|growth|scale|max|ultimate|individual|personal|professional|unlimited|advanced)\b/i;

export interface HeuristicResult extends ParsedRenewal {
  parser: "heuristic";
}

export function extractRenewalHeuristically(
  rawText: string,
  reference: Date = new Date(),
): HeuristicResult {
  const text = stripHtml(rawText).replace(/\r\n/g, "\n");
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const merchant = findMerchant(text, lines);
  const amount = findAmount(text);
  const cycle = findCycle(text);

  const renewMatch = text.match(RENEW_DATE_RE);
  const renewDate = renewMatch?.[2] ? parseDateToken(renewMatch[2], reference) : null;
  const cancelMatch = text.match(CANCEL_DATE_RE);
  const cancelDate = cancelMatch?.[1] ? parseDateToken(cancelMatch[1], reference) : null;

  const priceChange = text.match(PRICE_CHANGE_RE)?.[1]?.replace(/\s+/g, " ").trim() ?? null;
  const planMatch = text.match(PLAN_RE)?.[1];

  const fieldConfidence: Record<string, number> = {
    merchant_name: merchant?.confidence ?? 0.2,
    amount: amount?.confidence ?? 0.1,
    next_renewal_at: renewDate ? 0.75 : 0.1,
    billing_cycle: cycle.confidence,
  };

  return {
    parser: "heuristic",
    merchant_name: merchant?.value ?? "Unknown merchant",
    plan_name: planMatch ? titleCase(planMatch.trim()) : null,
    amount: amount?.value.amount ?? null,
    currency: amount?.value.currency ?? null,
    billing_cycle: cycle.value,
    next_renewal_at: renewDate?.toISOString() ?? null,
    cancel_by_at: cancelDate?.toISOString() ?? null,
    price_change_note: priceChange,
    field_confidence: fieldConfidence,
    raw_excerpt: buildExcerpt(text, amount?.value.amount ?? null),
  };
}

/** The shortest span that evidences the amount, so the UI can show its source. */
function buildExcerpt(text: string, amount: string | null): string {
  if (amount) {
    const bare = amount.replace(/\.00$/, "");
    const index = text.indexOf(amount) >= 0 ? text.indexOf(amount) : text.indexOf(bare);
    if (index >= 0) {
      const start = Math.max(0, index - 90);
      return text.slice(start, Math.min(text.length, index + 110)).replace(/\s+/g, " ").trim();
    }
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
