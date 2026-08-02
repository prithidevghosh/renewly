import type { MailMessage } from "../mailbox/types.js";

/**
 * Deciding what a message is, before anything expensive happens to it.
 *
 * The sweep pulls a few hundred messages and only a handful are subscription
 * charges. Running the model over all of them would be slow and would bill for
 * reading Uber receipts, so the cheap deterministic pass runs first and the
 * model only sees what survives it. That split is also why the transcript can
 * narrate every message: a heuristic verdict costs nothing to produce and can
 * say *why* it decided, which is the part a user actually reads.
 *
 * Being wrong here is recoverable in one direction only. A missed subscription
 * is invisible; a one-off purchase promoted to a recurring subscription puts a
 * wrong number in someone's budget. So the SaaS gate is deliberately strict:
 * when the evidence is thin the message is kept as a receipt but not treated as
 * a subscription.
 */

/** Sender domains that are subscription software, keyed by display name. */
const SAAS_DOMAINS: Record<string, string> = {
  "anthropic.com": "Anthropic",
  "claude.ai": "Anthropic",
  "openai.com": "OpenAI",
  "cursor.com": "Cursor",
  "cursor.sh": "Cursor",
  "midjourney.com": "Midjourney",
  "notion.so": "Notion",
  "coda.io": "Coda",
  "figma.com": "Figma",
  "github.com": "GitHub",
  "linear.app": "Linear",
  "vercel.com": "Vercel",
  "netlify.com": "Netlify",
  "railway.app": "Railway",
  "render.com": "Render",
  "supabase.com": "Supabase",
  "planetscale.com": "PlanetScale",
  "mongodb.com": "MongoDB",
  "slack.com": "Slack",
  "atlassian.com": "Atlassian",
  "zoom.us": "Zoom",
  "canva.com": "Canva",
  "adobe.com": "Adobe",
  "dropbox.com": "Dropbox",
  "1password.com": "1Password",
  "elevenlabs.io": "ElevenLabs",
  "replit.com": "Replit",
  "sentry.io": "Sentry",
  "datadoghq.com": "Datadog",
  "twilio.com": "Twilio",
  "sendgrid.com": "SendGrid",
  "postmarkapp.com": "Postmark",
  "cloudflare.com": "Cloudflare",
  "digitalocean.com": "DigitalOcean",
  "heroku.com": "Heroku",
  "intercom.com": "Intercom",
  "hubspot.com": "HubSpot",
  "mailchimp.com": "Mailchimp",
  "webflow.com": "Webflow",
  "framer.com": "Framer",
  "loom.com": "Loom",
  "calendly.com": "Calendly",
  "typeform.com": "Typeform",
  "airtable.com": "Airtable",
  "asana.com": "Asana",
  "monday.com": "Monday",
  "clickup.com": "ClickUp",
  "spotify.com": "Spotify",
  "netflix.com": "Netflix",
  "perplexity.ai": "Perplexity",
  "raycast.com": "Raycast",
  "linkedin.com": "LinkedIn",
  "grammarly.com": "Grammarly",
};

/**
 * Merchants that send receipt-shaped mail constantly and almost never for a
 * subscription. Matching one is a hard no on the SaaS gate — a marketplace
 * order that happens to say "your receipt" must not become a monthly line item.
 */
const MARKETPLACE_DOMAINS = [
  "amazon.",
  "uber.com",
  "ubereats.com",
  "lyft.com",
  "doordash.com",
  "grubhub.com",
  "instacart.com",
  "walmart.com",
  "target.com",
  "ebay.com",
  "etsy.com",
  "flipkart.com",
  "swiggy.in",
  "zomato.com",
  "airbnb.com",
  "booking.com",
  "expedia.com",
  "paypal.com",
  "venmo.com",
  "stripe.com",
  "razorpay.com",
  "shopify.com",
  "irctc.co.in",
  "makemytrip.com",
];

/** Words that make a message look like proof of a charge. */
const RECEIPT_RE =
  /\b(receipt|invoice|payment\s+(received|confirmation|successful)|paid|charged|billing\s+statement|your\s+bill|order\s+confirmation|thank\s+you\s+for\s+your\s+(payment|purchase|order)|transaction)\b/i;

/** Words that make a charge look recurring rather than one-off. */
const RECURRING_RE =
  /\b(subscription|subscribed|recurring|renew(s|ed|al)?|auto[-\s]?renew|billing\s+(cycle|period)|per\s+(month|year|seat|user)|\/\s?(mo|month|yr|year)|monthly|annual(ly)?|plan|seat|workspace|membership|pro\s+plan|team\s+plan|next\s+(billing|charge|payment))\b/i;

/** Words that mean the money went the other way, or never moved. */
const NEGATIVE_RE =
  /\b(refund(ed)?|credit\s+note|chargeback|failed|declined|unsuccessful|could\s+not\s+be\s+processed|cancel(l)?ed\s+your|has\s+been\s+cancel(l)?ed|trial\s+(ending|ended|expires)|free\s+trial|estimate|quote|reminder\s+to\s+pay|payment\s+due)\b/i;

/** Any money-shaped token. A receipt without an amount is a notification. */
const AMOUNT_RE = /(?:[$€£¥₹]\s?\d|(?:\d{1,3}(?:,\d{3})*|\d+)\.\d{2}\s?(?:USD|EUR|GBP|INR|CAD|AUD))/i;

export interface Verdict {
  /** Proof of a charge: worth keeping and showing. */
  isReceipt: boolean;
  /** A recurring software charge: worth turning into a subscription. */
  isSaas: boolean;
  /** Display name when the sender is recognised, else null. */
  merchant: string | null;
  /** One short clause, written for the transcript rather than for a log. */
  reason: string;
  /** 0–1, how sure the SaaS verdict is. Feeds nothing that spends money. */
  confidence: number;
}

/** The domain part of a `Name <user@host>` header, lowercased. */
export function senderDomain(from: string | null): string | null {
  const match = from?.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function knownSaas(domain: string | null): string | null {
  if (!domain) return null;
  for (const [host, name] of Object.entries(SAAS_DOMAINS)) {
    if (domain === host || domain.endsWith(`.${host}`)) return name;
  }
  return null;
}

/**
 * Brand names that are also ordinary English words. Matching these in body text
 * costs more than it earns — "your payment on Monday" is not a Monday.com
 * receipt. They are still recognised by sender domain, which is unambiguous.
 */
const AMBIGUOUS_BRANDS = new Set(["Monday", "Linear", "Render", "Loom", "Framer"]);

/** Longest first, so a short name cannot shadow a longer one containing it. */
const TEXT_MATCHABLE_BRANDS = [...new Set(Object.values(SAAS_DOMAINS))]
  .filter((name) => !AMBIGUOUS_BRANDS.has(name))
  .sort((a, b) => b.length - a.length);

/**
 * The vendor named in the message when the sender is not the vendor: a receipt
 * someone forwarded, or one an accountant passed on. Without this every such
 * message is merchant-less, and the pipeline groups merchant-less receipts by
 * sender domain — so a whole forwarded inbox would collapse into one
 * subscription.
 *
 * The sender domain is the better signal and is always tried first.
 */
function brandInText(haystack: string): string | null {
  const text = haystack.toLowerCase();

  // A vendor's own domain in the text is near-proof: it survives forwarding in
  // the quoted headers, the links and the footer.
  for (const [host, name] of Object.entries(SAAS_DOMAINS)) {
    if (text.includes(host)) return name;
  }

  for (const brand of TEXT_MATCHABLE_BRANDS) {
    const pattern = new RegExp(`(^|[^a-z0-9])${brand.toLowerCase()}([^a-z0-9]|$)`);
    if (pattern.test(text)) return brand;
  }

  return null;
}

function isMarketplace(domain: string | null): boolean {
  if (!domain) return false;
  return MARKETPLACE_DOMAINS.some((host) =>
    host.endsWith(".") ? domain.startsWith(host) || domain.includes(`.${host}`) : domain === host || domain.endsWith(`.${host}`),
  );
}

/**
 * Reads subject, sender and the first part of the body. The body is truncated
 * because the signal is always near the top and a marketing footer full of
 * "subscribe" links is only noise.
 */
export function classify(message: MailMessage): Verdict {
  const domain = senderDomain(message.from);
  const brand = knownSaas(domain);
  const haystack = [message.subject ?? "", message.snippet ?? "", message.body.slice(0, 4_000)].join(
    "\n",
  );

  const hasAmount = AMOUNT_RE.test(haystack);
  const receiptWords = RECEIPT_RE.test(haystack);
  const recurringWords = RECURRING_RE.test(haystack);
  const negative = NEGATIVE_RE.test(haystack);

  if (negative) {
    return {
      isReceipt: false,
      isSaas: false,
      merchant: brand,
      reason: "reads as a refund, a failure or a trial notice, not a charge",
      confidence: 0.8,
    };
  }

  // An amount is the one thing a receipt cannot do without. Everything else is
  // circumstantial, so a message with words but no number stays out.
  if (!hasAmount || !(receiptWords || recurringWords)) {
    return {
      isReceipt: false,
      isSaas: false,
      merchant: brand,
      reason: hasAmount ? "has an amount but does not read as a receipt" : "no amount in the message",
      confidence: 0.7,
    };
  }

  if (isMarketplace(domain)) {
    return {
      isReceipt: true,
      isSaas: false,
      merchant: null,
      reason: `${domain ?? "the sender"} is a marketplace, so this is a purchase rather than a subscription`,
      confidence: 0.85,
    };
  }

  if (brand) {
    // A known software vendor sending a receipt is the high-confidence case;
    // recurring wording on top of that makes it near-certain.
    return {
      isReceipt: true,
      isSaas: true,
      merchant: brand,
      reason: recurringWords
        ? `${brand} charged a recurring plan`
        : `${brand} is a known software vendor`,
      confidence: recurringWords ? 0.95 : 0.8,
    };
  }

  // The sender is not the vendor, but the message names one — a forwarded
  // receipt. Weaker than a vendor domain in the From header, stronger than
  // nothing, and it is what stops forwarded mail piling up under one merchant.
  const named = brandInText(haystack);
  if (named && recurringWords) {
    return {
      isReceipt: true,
      isSaas: true,
      merchant: named,
      reason: `sent on from elsewhere, but it reads as a recurring ${named} plan`,
      confidence: 0.75,
    };
  }

  if (recurringWords) {
    return {
      isReceipt: true,
      isSaas: true,
      merchant: null,
      reason: "an unfamiliar sender, but the wording is a recurring plan",
      confidence: 0.6,
    };
  }

  return {
    isReceipt: true,
    isSaas: false,
    merchant: null,
    reason: "a one-off charge with nothing recurring about it",
    confidence: 0.55,
  };
}
