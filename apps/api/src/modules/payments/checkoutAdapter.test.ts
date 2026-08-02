import { describe, expect, it } from "vitest";
import {
  
  signBody,
  verifySignature,
  type CheckoutOrder,
} from "./checkoutAdapter.js";
import { MockCheckoutAdapter } from "../../test/doubles/checkout.js";
import type { OneTimeCredentials } from "./pravaClient.js";

function credentials(overrides: Partial<OneTimeCredentials> = {}): OneTimeCredentials {
  return {
    txnRefId: "tli_1",
    cardNumber: "4111111111111111",
    cvv: "123",
    expMonth: 12,
    expYear: 2030,
    last4: "1111",
    brand: "visa",
    ...overrides,
  };
}

const order: CheckoutOrder = {
  reference: "pay_1",
  amount: "20.00",
  currency: "USD",
  merchantName: "Anthropic",
  description: "Claude Pro renewal",
};

describe("MockCheckoutAdapter", () => {
  const adapter = new MockCheckoutAdapter();

  it("approves a well-formed credential", async () => {
    const result = await adapter.charge(credentials(), order);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reference).toBe("chk_pay_1");
      expect(result.processedAt).toBeTruthy();
    }
  });

  it("declines the reserved test BIN", async () => {
    const result = await adapter.charge(credentials({ cardNumber: "4000000000000002" }), order);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("DO_NOT_HONOR");
  });

  it("declines when forced, which is how the failure path is exercised", async () => {
    const forced = new MockCheckoutAdapter({ forceDecline: true });
    const result = await forced.charge(credentials(), order);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FORCED_DECLINE");
  });

  it("rejects a credential with no card number", async () => {
    const result = await adapter.charge(credentials({ cardNumber: "" }), order);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_CREDENTIALS");
  });

  it("rejects a credential with no CVV", async () => {
    const result = await adapter.charge(credentials({ cvv: "" }), order);
    expect(result.ok).toBe(false);
  });

  it("rejects an impossible expiry", async () => {
    expect((await adapter.charge(credentials({ expMonth: 13 }), order)).ok).toBe(false);
    expect((await adapter.charge(credentials({ expYear: 12 }), order)).ok).toBe(false);
  });

  it("rejects a zero or negative amount", async () => {
    expect((await adapter.charge(credentials(), { ...order, amount: "0.00" })).ok).toBe(false);
    expect((await adapter.charge(credentials(), { ...order, amount: "-5.00" })).ok).toBe(false);
  });

  it("rejects a missing transaction reference", async () => {
    const result = await adapter.charge(credentials({ txnRefId: "" }), order);
    expect(result.ok).toBe(false);
  });
});

describe("adapter signing", () => {
  it("verifies its own signature", () => {
    const body = JSON.stringify({ reference: "pay_1", amount: "20.00" });
    expect(verifySignature(body, signBody(body, "secret"), "secret")).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ reference: "pay_1", amount: "20.00" });
    const signature = signBody(body, "secret");
    const tampered = JSON.stringify({ reference: "pay_1", amount: "2000.00" });
    expect(verifySignature(tampered, signature, "secret")).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const body = "{}";
    expect(verifySignature(body, signBody(body, "secret"), "other")).toBe(false);
  });

  it("rejects a malformed signature without throwing", () => {
    expect(verifySignature("{}", "short", "secret")).toBe(false);
  });
});
