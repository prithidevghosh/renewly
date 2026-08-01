import { AppError } from "../../../lib/errors.js";
import {
  verifyHmacSignature,
  verifyMailgunSignature,
  verifyStandardWebhook,
} from "../../../lib/crypto.js";

/**
 * Inbound mail providers do not agree on how a webhook is authenticated, and
 * the differences are not cosmetic — a body HMAC is simply the wrong check for
 * two of the three we accept:
 *
 *   mailgun  signs `timestamp + token`, not the body, and sends all three
 *            values as fields inside the payload rather than as headers
 *   resend   uses the Standard Webhooks spec via Svix: base64 digest over
 *            `id.timestamp.body`, keyed on the decoded `whsec_` secret
 *   other    a plain hex HMAC of the raw body, for a forwarder you run
 *
 * https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks
 * https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests
 */

export type MailProvider = "mailgun" | "resend" | "generic";

export function mailProviderFrom(value: string): MailProvider {
  const normalized = value.trim().toLowerCase();
  if (normalized === "mailgun") return "mailgun";
  if (normalized === "resend" || normalized === "svix") return "resend";
  return "generic";
}

/** Mailgun's inbound routes post form fields; the rest post JSON. */
export function parseMailPayload(
  rawBody: string,
  contentType: string | undefined,
  provider: string,
): Record<string, unknown> {
  if (contentType?.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(rawBody);
    const payload: Record<string, unknown> = {};
    for (const [key, value] of params) payload[key] = value;
    if (Object.keys(payload).length === 0) {
      throw new AppError("VALIDATION_ERROR", "Mail webhook body was empty", { provider });
    }
    return payload;
  }

  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError("VALIDATION_ERROR", "Mail webhook body was not valid JSON", { provider });
  }
}

export interface VerifyMailInput {
  provider: string;
  rawBody: string;
  payload: Record<string, unknown>;
  headers: Record<string, string | undefined>;
  secret: string;
  now?: Date;
}

/** Throws WEBHOOK_INVALID_SIGNATURE unless the payload is provably genuine. */
export function verifyMailWebhook(input: VerifyMailInput): void {
  const provider = mailProviderFrom(input.provider);
  const reject = (reason: string): never => {
    throw new AppError("WEBHOOK_INVALID_SIGNATURE", reason, { provider: input.provider });
  };

  if (provider === "mailgun") {
    const parts = mailgunSignatureParts(input.payload);
    if (!parts) reject("Mailgun webhook carried no signature fields");
    if (
      !verifyMailgunSignature(parts!, input.secret, {
        ...(input.now ? { now: input.now } : {}),
      })
    ) {
      reject("Mailgun webhook signature did not verify");
    }
    return;
  }

  if (provider === "resend") {
    const headers = {
      id: input.headers["svix-id"] ?? input.headers["webhook-id"],
      timestamp: input.headers["svix-timestamp"] ?? input.headers["webhook-timestamp"],
      signature: input.headers["svix-signature"] ?? input.headers["webhook-signature"],
    };
    if (
      !verifyStandardWebhook(input.rawBody, headers, input.secret, {
        ...(input.now ? { now: input.now } : {}),
      })
    ) {
      reject("Resend webhook signature did not verify");
    }
    return;
  }

  const signature = input.headers["x-webhook-signature"] ?? input.headers["x-renewly-signature"];
  if (!verifyHmacSignature(input.rawBody, signature, input.secret)) {
    reject("Mail webhook signature did not verify");
  }
}

/**
 * Form-encoded routes put the three fields at the top level; the JSON
 * "store and notify" shape nests them under `signature`.
 */
function mailgunSignatureParts(
  payload: Record<string, unknown>,
): { timestamp: string; token: string; signature: string } | null {
  const nested = (payload.signature ?? {}) as Record<string, unknown>;
  const source = typeof payload.signature === "object" && payload.signature ? nested : payload;

  const timestamp = source.timestamp;
  const token = source.token;
  const signature = source.signature;

  if (typeof timestamp !== "string" || typeof token !== "string" || typeof signature !== "string") {
    return null;
  }
  return { timestamp, token, signature };
}
