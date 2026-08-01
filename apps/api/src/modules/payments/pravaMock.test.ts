import { describe, expect, it } from "vitest";
import { AppError } from "../../lib/errors.js";
import { brandFromPan, last4, type CreateSessionInput } from "./pravaClient.js";
import { MockPravaClient } from "./pravaMock.js";

const sessionInput: CreateSessionInput = {
  userId: "usr_1",
  userEmail: "founder@example.com",
  amount: "20.00",
  currency: "USD",
  merchant: { name: "Anthropic", url: "https://claude.ai", country_code_iso2: "US" },
  items: [{ description: "Claude Pro renewal", unit_price: "20.00", quantity: 1 }],
  integration_type: "embedding",
};

describe("MockPravaClient", () => {
  it("creates a session with the fields the SDK needs", async () => {
    const client = new MockPravaClient();
    const session = await client.createSession(sessionInput);

    expect(session.sessionId).toMatch(/^sess_mock_/);
    expect(session.sessionToken).toMatch(/^tok_mock_/);
    expect(session.iframeUrl).toBe("https://pay.prava.space/mock");
    expect(session.orderId).toBeTruthy();
    expect(new Date(session.expiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("issues credentials, then completes after report-status", async () => {
    const client = new MockPravaClient();
    const session = await client.createSession(sessionInput);

    const result = await client.getPaymentResult(session.sessionId);
    expect(result.status).toBe("awaiting_result");
    expect(result.credentials?.txnRefId).toBeTruthy();
    expect(result.credentials?.last4).toBe("1111");

    await client.reportStatus(session.sessionId, {
      txnRefId: result.credentials!.txnRefId,
      txnStatus: "APPROVED",
    });

    expect(client.inspect(session.sessionId)?.status).toBe("completed");
    expect((await client.getPaymentResult(session.sessionId)).status).toBe("completed");
  });

  it("stays pending until collection latency has elapsed", async () => {
    const client = new MockPravaClient({ pollsBeforeCredentials: 2 });
    const session = await client.createSession(sessionInput);

    expect((await client.getPaymentResult(session.sessionId)).credentials).toBeUndefined();
    expect((await client.getPaymentResult(session.sessionId)).credentials).toBeUndefined();
    expect((await client.getPaymentResult(session.sessionId)).credentials).toBeDefined();
  });

  it("never returns raw credentials in the raw payload", async () => {
    const client = new MockPravaClient();
    const session = await client.createSession(sessionInput);
    const result = await client.getPaymentResult(session.sessionId);

    expect(JSON.stringify(result.raw)).not.toContain("4111111111111111");
    expect(JSON.stringify(result.raw)).not.toContain("123");
  });

  it("marks the session failed when the outcome is DECLINED", async () => {
    const client = new MockPravaClient();
    const session = await client.createSession(sessionInput);
    const result = await client.getPaymentResult(session.sessionId);

    await client.reportStatus(session.sessionId, {
      txnRefId: result.credentials!.txnRefId,
      txnStatus: "DECLINED",
    });
    expect(client.inspect(session.sessionId)?.status).toBe("failed");
  });

  it("rejects a txn_ref_id from another session", async () => {
    const client = new MockPravaClient();
    const session = await client.createSession(sessionInput);

    await expect(
      client.reportStatus(session.sessionId, { txnRefId: "tli_wrong", txnStatus: "APPROVED" }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("rejects an unknown session id", async () => {
    const client = new MockPravaClient();
    await expect(client.getPaymentResult("sess_nope")).rejects.toBeInstanceOf(AppError);
  });

  it("refuses merchant_details the real API would reject", async () => {
    const client = new MockPravaClient();

    await expect(
      client.createSession({
        ...sessionInput,
        merchant: { ...sessionInput.merchant, url: "http://claude.ai" },
      }),
    ).rejects.toMatchObject({ details: { pravaCode: "VAL_2001" } });

    await expect(
      client.createSession({
        ...sessionInput,
        merchant: { ...sessionInput.merchant, country_code_iso2: "usa" },
      }),
    ).rejects.toMatchObject({ details: { pravaCode: "VAL_2001" } });
  });

  describe("revokeSession", () => {
    it("closes a session that never produced a charge", async () => {
      const client = new MockPravaClient();
      const session = await client.createSession(sessionInput);

      await client.revokeSession(session.sessionId);

      expect(client.inspect(session.sessionId)?.status).toBe("revoked");
      await expect(client.getPaymentResult(session.sessionId)).rejects.toMatchObject({
        details: { pravaCode: "AUTH_1004" },
      });
    });

    it("refuses to revoke a session that already completed", async () => {
      const client = new MockPravaClient();
      const session = await client.createSession(sessionInput);
      const result = await client.getPaymentResult(session.sessionId);
      await client.reportStatus(session.sessionId, {
        txnRefId: result.credentials!.txnRefId,
        txnStatus: "APPROVED",
      });

      await expect(client.revokeSession(session.sessionId)).rejects.toMatchObject({
        details: { pravaCode: "INVALID_STATE" },
      });
    });

    it("rejects an unknown session id", async () => {
      const client = new MockPravaClient();
      await expect(client.revokeSession("sess_nope")).rejects.toBeInstanceOf(AppError);
    });
  });

  describe("failure injection", () => {
    it("mandate: session creation is refused", async () => {
      const client = new MockPravaClient({ failureMode: "mandate" });
      await expect(client.createSession(sessionInput)).rejects.toMatchObject({
        code: "PRAVA_ERROR",
      });
    });

    it("card: credentials never arrive", async () => {
      const client = new MockPravaClient({ failureMode: "card" });
      const session = await client.createSession(sessionInput);

      for (let i = 0; i < 5; i += 1) {
        const result = await client.getPaymentResult(session.sessionId);
        expect(result.status).toBe("pending");
        expect(result.credentials).toBeUndefined();
      }
    });

    it("decline: credentials are issued for a PAN the adapter refuses", async () => {
      const client = new MockPravaClient({ failureMode: "decline" });
      const session = await client.createSession(sessionInput);
      const result = await client.getPaymentResult(session.sessionId);

      expect(result.credentials?.cardNumber.startsWith("400000")).toBe(true);
    });
  });
});

describe("card helpers", () => {
  it("labels the common brands", () => {
    expect(brandFromPan("4111111111111111")).toBe("visa");
    expect(brandFromPan("5555555555554444")).toBe("mastercard");
    expect(brandFromPan("378282246310005")).toBe("amex");
    expect(brandFromPan("6011111111111117")).toBe("discover");
    expect(brandFromPan("9999999999999999")).toBe("unknown");
  });

  it("takes the last four digits", () => {
    expect(last4("4111111111111111")).toBe("1111");
  });
});
