import type { OneTimeCredentials } from "../../modules/payments/pravaClient.js";
import {
  DECLINE_PREFIXES,
  validateCheckout,
  type CheckoutAdapter,
  type CheckoutOrder,
  type CheckoutOutcome,
} from "../../modules/payments/checkoutAdapter.js";
import { assertTestOnly } from "./guard.js";

/**
 * Settles a Prava credential in-process, for tests only.
 *
 * It was previously the default checkout adapter, reached whenever
 * CHECKOUT_ADAPTER_MODE was unset — which meant a deployment could report a
 * subscription as paid when no merchant had ever been contacted and no money
 * had moved. The runtime factory now refuses instead, and this is installed by
 * a test through setCheckoutAdapter.
 */
export class MockCheckoutAdapter implements CheckoutAdapter {
  readonly mode = "mock" as const;

  constructor(private readonly options: { forceDecline?: boolean } = {}) {
    assertTestOnly("MockCheckoutAdapter");
  }

  async charge(
    credentials: OneTimeCredentials,
    order: CheckoutOrder,
  ): Promise<CheckoutOutcome> {
    const invalid = validateCheckout(credentials, order);
    if (invalid) return { ok: false, reason: invalid, code: "INVALID_CREDENTIALS" };

    if (this.options.forceDecline) {
      return { ok: false, reason: "Checkout declined by test override", code: "FORCED_DECLINE" };
    }
    if (DECLINE_PREFIXES.some((prefix) => credentials.cardNumber.startsWith(prefix))) {
      return { ok: false, reason: "Issuer declined the credential", code: "DO_NOT_HONOR" };
    }

    return {
      ok: true,
      reference: `chk_${order.reference}`,
      processedAt: new Date().toISOString(),
    };
  }
}
