import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../env.js";
import { AppError } from "../../lib/errors.js";
import { isValidAmount, toMinor } from "../../lib/money.js";
import type { OneTimeCredentials } from "./pravaClient.js";

/**
 * Renewly does not drive real merchant checkout pages in V1. Prava mints a
 * usable one-time credential; settling it against Anthropic or Midjourney would
 * require scraping their billing portals, which we do not do. Instead the
 * credential is charged against a Renewly-controlled test merchant.
 *
 * This is the honest boundary of the product: the rail is real (or driven per
 * env), the merchant settlement is ours.
 */

export interface CheckoutOrder {
  reference: string;
  amount: string;
  currency: string;
  merchantName: string;
  description: string;
}

export type CheckoutOutcome =
  | { ok: true; reference: string; processedAt: string }
  | { ok: false; reason: string; code: string };

export interface CheckoutAdapter {
  readonly mode: "mock" | "http";
  charge(credentials: OneTimeCredentials, order: CheckoutOrder): Promise<CheckoutOutcome>;
}

/** Test BINs that must decline, so failure paths are exercisable end to end. */
/** Shared with the test double so both paths agree on what a decline is. */
export const DECLINE_PREFIXES = ["400000"];

export function validateCheckout(
  credentials: OneTimeCredentials,
  order: CheckoutOrder,
): string | null {
  if (!credentials.cardNumber || credentials.cardNumber.length < 12) {
    return "Credential is missing a usable card number";
  }
  if (!credentials.cvv) return "Credential is missing a dynamic CVV";
  if (!credentials.txnRefId) return "Credential is missing a transaction reference";
  if (!Number.isInteger(credentials.expMonth) || credentials.expMonth < 1 || credentials.expMonth > 12) {
    return "Credential has an invalid expiry month";
  }
  if (!Number.isInteger(credentials.expYear) || credentials.expYear < 2000) {
    return "Credential has an invalid expiry year";
  }
  if (!isValidAmount(order.amount) || toMinor(order.amount, order.currency) <= 0n) {
    return "Order amount must be greater than zero";
  }
  return null;
}

/**
 * Posts to a merchant endpoint the operator controls. The body is signed with
 * CHECKOUT_ADAPTER_SECRET so the receiver can prove the call came from us.
 */
export class HttpCheckoutAdapter implements CheckoutAdapter {
  readonly mode = "http" as const;

  constructor(
    private readonly url: string,
    private readonly secret: string | undefined,
  ) {}

  async charge(
    credentials: OneTimeCredentials,
    order: CheckoutOrder,
  ): Promise<CheckoutOutcome> {
    const invalid = validateCheckout(credentials, order);
    if (invalid) return { ok: false, reason: invalid, code: "INVALID_CREDENTIALS" };

    const body = JSON.stringify({
      reference: order.reference,
      amount: order.amount,
      currency: order.currency,
      merchant_name: order.merchantName,
      description: order.description,
      card: {
        number: credentials.cardNumber,
        cvv: credentials.cvv,
        exp_month: credentials.expMonth,
        exp_year: credentials.expYear,
      },
      txn_ref_id: credentials.txnRefId,
    });

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.secret) headers["x-renewly-signature"] = signBody(body, this.secret);

    let response: Response;
    try {
      response = await fetch(this.url, { method: "POST", headers, body });
    } catch (error) {
      throw new AppError("PRAVA_ERROR", "Checkout adapter is unreachable", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      reference?: string;
      reason?: string;
      code?: string;
    };

    if (!response.ok || payload.ok === false) {
      return {
        ok: false,
        reason: payload.reason ?? `Checkout adapter returned ${response.status}`,
        code: payload.code ?? "ADAPTER_ERROR",
      };
    }

    return {
      ok: true,
      reference: payload.reference ?? `chk_${order.reference}`,
      processedAt: new Date().toISOString(),
    };
  }
}

export function signBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function verifySignature(body: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(signBody(body, secret), "utf8");
  const provided = Buffer.from(signature, "utf8");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

let adapter: CheckoutAdapter | null = null;

export function getCheckoutAdapter(): CheckoutAdapter {
  // An installed adapter wins over the mode; only a test installs one.
  if (adapter) return adapter;

  // There is no in-process settlement to fall back to. A checkout that reports
  // success while nothing was charged is indistinguishable from one that
  // worked, so an unconfigured adapter refuses instead.
  if (env.CHECKOUT_ADAPTER_MODE !== "http" || !env.CHECKOUT_ADAPTER_URL) {
    throw new AppError(
      "FEATURE_DISABLED",
      "Checkout settlement is turned off on this deployment. Set " +
        "CHECKOUT_ADAPTER_MODE=http and CHECKOUT_ADAPTER_URL to enable it.",
    );
  }

  adapter = new HttpCheckoutAdapter(env.CHECKOUT_ADAPTER_URL, process.env.CHECKOUT_ADAPTER_SECRET);
  return adapter;
}

export function setCheckoutAdapter(next: CheckoutAdapter | null): void {
  adapter = next;
}
