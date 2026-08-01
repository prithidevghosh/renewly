import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signature verification and content hashing. Every comparison here is
 * constant-time: a webhook verifier that short-circuits on the first wrong byte
 * leaks the signature one character at a time.
 */

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacSha256(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Verifies a hex HMAC, tolerating a `sha256=` prefix as several providers send. */
export function verifyHmacSignature(
  payload: string,
  signature: string | undefined | null,
  secret: string,
): boolean {
  if (!signature) return false;
  const provided = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  return constantTimeEquals(hmacSha256(payload, secret), provided.trim());
}

/**
 * The Standard Webhooks specification, which Linq and Svix-backed senders
 * (Resend among them) both implement. It differs from a plain body HMAC in
 * three ways that all matter: the signed content includes the message id and
 * timestamp, the key is the base64 payload of a `whsec_` secret rather than the
 * secret's characters, and the digest is base64 rather than hex.
 *
 * https://www.standardwebhooks.com/ · https://docs.linqapp.com/guides/webhooks
 */
export interface StandardWebhookHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

export const STANDARD_WEBHOOK_TOLERANCE_SECONDS = 300;

export function verifyStandardWebhook(
  rawBody: string,
  headers: StandardWebhookHeaders,
  secret: string,
  options: { now?: Date; toleranceSeconds?: number } = {},
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;

  // A replayed body is still correctly signed, so the timestamp is the defence.
  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return false;
  const tolerance = options.toleranceSeconds ?? STANDARD_WEBHOOK_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - sentAt) > tolerance) return false;

  const key = standardWebhookKey(secret);
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64");

  // The header carries one or more space-delimited `v1,<signature>` entries;
  // a secret rotation is published as two, and either one verifying is a pass.
  return signature
    .split(" ")
    .filter(Boolean)
    .some((entry) => {
      const [version, value] = entry.split(",");
      if (version !== "v1" || !value) return false;
      return constantTimeEquals(expected, value);
    });
}

function standardWebhookKey(secret: string): Buffer {
  const trimmed = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  return Buffer.from(trimmed, "base64");
}

/**
 * Mailgun does not sign the body at all: it signs `timestamp + token`, and
 * sends all three values as fields inside the payload.
 * https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks
 */
export function verifyMailgunSignature(
  parts: { timestamp: string; token: string; signature: string },
  signingKey: string,
  options: { now?: Date; toleranceSeconds?: number } = {},
): boolean {
  const sentAt = Number(parts.timestamp);
  if (!Number.isFinite(sentAt)) return false;
  const tolerance = options.toleranceSeconds ?? STANDARD_WEBHOOK_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - sentAt) > tolerance) return false;

  return constantTimeEquals(
    hmacSha256(`${parts.timestamp}${parts.token}`, signingKey),
    parts.signature.trim(),
  );
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Stable identity for a parsed renewal. Two forwards of the same receipt must
 * produce the same hash, so it deliberately ignores whitespace, case and the
 * fields a forward rewrites (subject prefixes, envelope headers).
 */
export function contentHash(parts: {
  merchantCanonical: string;
  amount: string | null;
  currency: string | null;
  billingCycle?: string | null;
  nextRenewalAt?: string | null;
}): string {
  const normalized = [
    parts.merchantCanonical.toLowerCase().trim(),
    parts.amount ?? "",
    (parts.currency ?? "").toUpperCase(),
    parts.billingCycle ?? "",
    // Only the calendar day matters; a re-send hours later is the same renewal.
    parts.nextRenewalAt ? parts.nextRenewalAt.slice(0, 10) : "",
  ].join("|");
  return sha256(normalized);
}

/** Hash of raw email text, used to spot a byte-identical re-delivery. */
export function rawContentHash(raw: string): string {
  return sha256(raw.replace(/\s+/g, " ").trim().toLowerCase());
}
