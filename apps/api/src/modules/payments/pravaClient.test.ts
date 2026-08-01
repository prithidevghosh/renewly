import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpPravaClient, type CreateSessionInput } from "./pravaClient.js";

/**
 * The HTTP client is the one part of the rail no mock-mode test touches, so the
 * wire contract is asserted here against what the API reference documents:
 * https://docs.prava.space/api-reference/create-session
 */

const sessionInput: CreateSessionInput = {
  userId: "usr_1",
  userEmail: "founder@example.com",
  amount: "20.00",
  currency: "USD",
  merchant: { name: "Anthropic", url: "https://claude.ai", country_code_iso2: "US" },
  items: [{ description: "Claude Pro renewal", unit_price: "20.00", quantity: 1 }],
  integration_type: "embedding",
};

function client(): HttpPravaClient {
  return new HttpPravaClient({
    mode: "sandbox",
    baseUrl: "https://sandbox.api.prava.space",
    secretKey: "sk_test_abc",
  });
}

/** Captures the outgoing request and replies with `body`. */
function stubFetch(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, requestInit) => {
    calls.push({ url: String(url), init: (requestInit ?? {}) as RequestInit });
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  });
  return { calls, spy };
}

function sentBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HttpPravaClient configuration", () => {
  it("rejects a live key in sandbox mode", () => {
    expect(
      () => new HttpPravaClient({ mode: "sandbox", secretKey: "sk_live_abc" }),
    ).toThrowError(/sk_test_/);
  });

  it("rejects a test key in live mode", () => {
    expect(() => new HttpPravaClient({ mode: "live", secretKey: "sk_test_abc" })).toThrowError(
      /sk_live_/,
    );
  });

  it("refuses to run without a secret key", () => {
    expect(() => new HttpPravaClient({ mode: "sandbox", secretKey: "" })).toThrowError(
      /PRAVA_SECRET_KEY/,
    );
  });
});

describe("createSession", () => {
  it("sends the documented merchant_details and product_details shape", async () => {
    const { calls } = stubFetch({
      session_id: "sess_1",
      session_token: "tok_1",
      iframe_url: "https://pay.prava.space/sess_1",
      order_id: "ord_1",
    });

    const result = await client().createSession({ ...sessionInput, externalOrderRef: "pay_1" });

    expect(calls[0]?.url).toBe("https://sandbox.api.prava.space/v1/sessions");
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      "Bearer sk_test_abc",
    );

    const body = sentBody(calls[0]!.init);
    expect(body.user_id).toBe("usr_1");
    expect(body.total_amount).toBe("20.00");
    expect(body.currency).toBe("USD");
    expect(body.integration_type).toBe("embedding");
    expect(body.external_order_ref).toBe("pay_1");
    expect(body.purchase_context).toEqual([
      {
        merchant_details: { name: "Anthropic", url: "https://claude.ai", country_code_iso2: "US" },
        product_details: [{ description: "Claude Pro renewal", unit_price: "20.00", quantity: 1 }],
      },
    ]);

    expect(result.sessionId).toBe("sess_1");
    expect(result.iframeUrl).toBe("https://pay.prava.space/sess_1");
  });

  it("defaults integration_type to embedding", async () => {
    const { calls } = stubFetch({
      session_id: "sess_1",
      session_token: "tok_1",
      iframe_url: "https://pay.prava.space/sess_1",
    });

    const { integration_type: _omitted, ...withoutType } = sessionInput;
    await client().createSession(withoutType);

    expect(sentBody(calls[0]!.init).integration_type).toBe("embedding");
  });

  it("rejects a non-https merchant url before it reaches the rail", async () => {
    const { spy } = stubFetch({});
    await expect(
      client().createSession({
        ...sessionInput,
        merchant: { ...sessionInput.merchant, url: "http://claude.ai" },
      }),
    ).rejects.toThrowError(/https/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rejects a malformed country code before it reaches the rail", async () => {
    const { spy } = stubFetch({});
    await expect(
      client().createSession({
        ...sessionInput,
        merchant: { ...sessionInput.merchant, country_code_iso2: "USA" },
      }),
    ).rejects.toThrowError(/2-letter/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("fails loudly when the response omits a field the SDK needs", async () => {
    stubFetch({ session_id: "sess_1", order_id: "ord_1" });
    await expect(client().createSession(sessionInput)).rejects.toThrowError(/missing required/i);
  });

  it("surfaces the error code and response id from a rejected request", async () => {
    stubFetch(
      { error: { code: "VAL_2001", message: "user_email must be a valid email", details: {} } },
      { status: 400, headers: { "x-response-id": "resp_abc123" } },
    );

    await expect(client().createSession(sessionInput)).rejects.toMatchObject({
      code: "PRAVA_ERROR",
      message: "user_email must be a valid email",
      details: { pravaCode: "VAL_2001", responseId: "resp_abc123", status: 400 },
    });
  });
});

describe("getPaymentResult", () => {
  it("returns credentials once the line item carries a token", async () => {
    const { calls } = stubFetch({
      session_id: "sess_1",
      status: "awaiting_result",
      transactions: [
        {
          txn_id: "txn_1",
          status: "awaiting_result",
          line_items: [
            {
              txn_ref_id: "tli_1",
              merchant_name: "Anthropic",
              merchant_url: "https://claude.ai",
              total_amount: "20.00",
              status: "awaiting_result",
              token: "4111111111111111",
              dynamic_cvv: "123",
              expiry_month: "12",
              expiry_year: "2030",
            },
          ],
        },
      ],
    });

    const result = await client().getPaymentResult("sess_1");

    expect(calls[0]?.url).toBe("https://sandbox.api.prava.space/v1/sessions/sess_1/payment-result");
    expect(result.status).toBe("awaiting_result");
    expect(result.credentials).toMatchObject({
      txnRefId: "tli_1",
      cardNumber: "4111111111111111",
      cvv: "123",
      expMonth: 12,
      expYear: 2030,
      // Neither field is on the wire, so both are derived from the PAN.
      last4: "1111",
      brand: "visa",
    });
  });

  it("keeps the card number and cvv out of the retained payload", async () => {
    stubFetch({
      session_id: "sess_1",
      status: "awaiting_result",
      transactions: [
        {
          txn_id: "txn_1",
          line_items: [
            {
              txn_ref_id: "tli_1",
              token: "4111111111111111",
              dynamic_cvv: "123",
              expiry_month: "12",
              expiry_year: "2030",
            },
          ],
        },
      ],
    });

    const result = await client().getPaymentResult("sess_1");
    const serialized = JSON.stringify(result.raw);
    expect(serialized).not.toContain("4111111111111111");
    expect(serialized).not.toContain("123");
    expect(serialized).toContain("[redacted]");
  });

  it("reports pending while the user is still in the iframe", async () => {
    stubFetch({ session_id: "sess_1", status: "pending", transactions: [] });
    const result = await client().getPaymentResult("sess_1");
    expect(result.status).toBe("pending");
    expect(result.credentials).toBeUndefined();
  });

  it("raises the transaction error when the rail reports one", async () => {
    stubFetch({
      session_id: "sess_1",
      status: "failed",
      transactions: [
        { txn_id: "txn_1", status: "failed", error: { code: "THRESHOLD_EXCEEDED", message: "over limit" } },
      ],
    });

    await expect(client().getPaymentResult("sess_1")).rejects.toMatchObject({
      code: "PRAVA_ERROR",
      message: "over limit",
      details: { code: "THRESHOLD_EXCEEDED" },
    });
  });
});

describe("reportStatus", () => {
  it("posts the reference and status, and passes the authorization code through", async () => {
    const { calls } = stubFetch({
      status: "confirmed",
      txn_ref_id: "tli_1",
      txn_status: "APPROVED",
      visa_confirmation: "SUCCESS",
    });

    const result = await client().reportStatus("sess_1", {
      txnRefId: "tli_1",
      txnStatus: "APPROVED",
      authorizationCode: "chk_pay_1",
    });

    expect(calls[0]?.url).toBe("https://sandbox.api.prava.space/v1/sessions/sess_1/report-status");
    expect(sentBody(calls[0]!.init)).toEqual({
      txn_ref_id: "tli_1",
      txn_status: "APPROVED",
      authorization_code: "chk_pay_1",
    });
    expect(result).toEqual({ txnStatus: "APPROVED", visaConfirmation: "SUCCESS" });
  });

  it("surfaces a failed network confirmation", async () => {
    stubFetch({ status: "confirmed", txn_status: "DECLINED", visa_confirmation: "FAILURE" });
    const result = await client().reportStatus("sess_1", {
      txnRefId: "tli_1",
      txnStatus: "DECLINED",
    });
    expect(result.visaConfirmation).toBe("FAILURE");
  });

  it("truncates an over-long authorization code to the documented 128 chars", async () => {
    const { calls } = stubFetch({ status: "confirmed", txn_status: "APPROVED" });
    await client().reportStatus("sess_1", {
      txnRefId: "tli_1",
      txnStatus: "APPROVED",
      authorizationCode: "x".repeat(200),
    });
    expect(String(sentBody(calls[0]!.init).authorization_code)).toHaveLength(128);
  });
});

describe("revokeSession", () => {
  it("posts to the revoke endpoint", async () => {
    const { calls } = stubFetch({});
    await client().revokeSession("sess_1");
    expect(calls[0]?.url).toBe("https://sandbox.api.prava.space/v1/sessions/sess_1/revoke");
    expect(calls[0]?.init.method).toBe("POST");
  });
});
