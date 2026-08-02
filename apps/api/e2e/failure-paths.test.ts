import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDecision, createSubscription, fixture, signUp } from "../src/test/factories.js";
import { ApiClient, createHarness, expectErrorCode, textFile, type TestHarness } from "../src/test/helpers.js";
import { setPravaClient } from "../src/modules/payments/factory.js";
import { MockPravaClient } from "../src/test/doubles/prava.js";

/**
 * Every way the flow can fail, exercised end to end: a rail that refuses the
 * mandate, a card that never arrives, a merchant that declines, policy blocks,
 * and the cancel path that saves money without moving any.
 */

let harness: TestHarness;
let client: ApiClient;

async function payable(overrides: Record<string, unknown> = {}) {
  const subscription = await createSubscription(client, {
    criticality: "must_keep",
    usageNote: "Used daily.",
    ...overrides,
  });
  const decision = await createDecision(client, subscription.id);
  return { subscription, decision };
}

beforeAll(async () => {
  harness = await createHarness();
  client = new ApiClient(harness.app);
  await signUp(client, { email: "failures@northwind.test" });
});

afterAll(async () => {
  setPravaClient(null);
  await harness.close();
});

describe("authentication failures", () => {
  it("refuses every protected route without a token", async () => {
    const routes: Array<[string, string]> = [
      ["GET", "/v1/me"],
      ["GET", "/v1/settings"],
      ["GET", "/v1/subscriptions"],
      ["POST", "/v1/intake/email"],
      ["GET", "/v1/receipts"],
      ["GET", "/v1/savings"],
      ["GET", "/v1/audit"],
    ];

    for (const [method, path] of routes) {
      const response = await client.request(method, path, { token: null });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(expectErrorCode(response.body)).toBe("UNAUTHORIZED");
    }
  });

  it("refuses a token signed with the wrong secret", async () => {
    const forged =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c3JfMSIsIndzcCI6IndzcF8xIiwiaXNzIjoicmVuZXdseS1hcGkiLCJhdWQiOiJyZW5ld2x5LWFwcCIsImV4cCI6NDEwMjQ0NDgwMH0.wrongsignaturewrongsignaturewrongsignature";
    const response = await client.get("/v1/me", forged);
    expect(response.status).toBe(401);
  });

  it("rate limits repeated login attempts", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 15 }, () =>
        client.post("/v1/auth/login", { email: "nobody@example.com", password: "wrong" }, null),
      ),
    );
    expect(attempts.some((r) => r.status === 429)).toBe(true);
  });
});

describe("rail and mandate failures", () => {
  it("surfaces a refused mandate as PRAVA_ERROR and audits the block", async () => {
    setPravaClient(new MockPravaClient({ failureMode: "mandate" }));
    const { decision } = await payable({ merchantName: "Mandate Refused Co" });

    const response = await client.post(`/v1/decisions/${decision.id}/pay/session`);
    expect(response.status).toBe(502);
    expect(expectErrorCode(response.body)).toBe("PRAVA_ERROR");

    const audit = await client.get<{ events: Array<{ data: Record<string, unknown> }> }>(
      "/v1/audit?type=payment.blocked&limit=10",
    );
    expect(audit.body.events[0]?.data.reason).toBe("PRAVA_ERROR");

    // No session row is created when the rail refuses, so nothing to complete.
    const complete = await client.post(`/v1/decisions/${decision.id}/pay/complete`);
    expect(complete.status).toBe(404);

    setPravaClient(harness.prava);
  });

  it("fails cleanly when the user abandons the card iframe", async () => {
    setPravaClient(new MockPravaClient({ failureMode: "card" }));
    const { decision } = await payable({ merchantName: "Abandoned Card Co" });

    const session = await client.post<{ paymentSession: { id: string } }>(
      `/v1/decisions/${decision.id}/pay/session`,
    );
    expect(session.status).toBe(201);

    const complete = await client.post(`/v1/decisions/${decision.id}/pay/complete`);
    expect(complete.status).toBe(502);

    const after = await client.get<{ paymentSession: { status: string; lastError: string } }>(
      `/v1/payment-sessions/${session.body.paymentSession.id}`,
    );
    expect(after.body.paymentSession.status).toBe("failed");
    expect(after.body.paymentSession.lastError).toMatch(/credentials/i);

    // No receipt is written for a payment that did not happen.
    const receipts = await client.get<{ receipts: unknown[] }>("/v1/receipts");
    expect(receipts.body.receipts).toHaveLength(0);

    setPravaClient(harness.prava);
  });

  it("records a declined charge without a receipt and reports it to the rail", async () => {
    setPravaClient(new MockPravaClient({ failureMode: "decline" }));
    const { decision } = await payable({ merchantName: "Declined Charge Co" });

    const session = await client.post<{ paymentSession: { pravaSessionId: string } }>(
      `/v1/decisions/${decision.id}/pay/session`,
    );
    const complete = await client.post(`/v1/decisions/${decision.id}/pay/complete`);

    expect(complete.status).toBe(402);
    expect(expectErrorCode(complete.body)).toBe("CHECKOUT_DECLINED");

    const receipts = await client.get<{ receipts: unknown[] }>("/v1/receipts");
    expect(receipts.body.receipts).toHaveLength(0);

    const audit = await client.get<{ events: Array<{ data: Record<string, unknown> }> }>(
      "/v1/audit?type=payment.failed&limit=20",
    );
    expect(audit.body.events.some((e) => e.data.stage === "checkout")).toBe(true);
    expect(session.body.paymentSession.pravaSessionId).toBeTruthy();

    setPravaClient(harness.prava);
  });
});

describe("policy failures", () => {
  it("blocks a payment above the auto-approval limit", async () => {
    await client.patch("/v1/settings", {
      approvalMode: "auto_within_envelope",
      spendCeiling: "25.00",
    });

    const { decision } = await payable({ merchantName: "Over Limit Co", amount: "99.00" });
    const response = await client.post(`/v1/decisions/${decision.id}/pay/session`);

    expect(response.status).toBe(409);
    expect(expectErrorCode(response.body)).toBe("APPROVAL_REQUIRED");
    const details = (response.body as { error: { details: Record<string, string> } }).error.details;
    expect(details.ceiling).toBe("25.00");

    await client.patch("/v1/settings", {
      approvalMode: "always_ask",
      spendCeiling: "50.00",
    });
  });

  it("blocks a payment for a subscription whose parse was never confirmed", async () => {
    const subscription = await createSubscription(client, {
      merchantName: "Unconfirmed Co",
      amount: "22.00",
      criticality: "must_keep",
      usageNote: "Used daily.",
      fieldConfidence: { amount: 0.35, merchant_name: 0.4, next_renewal_at: 0.3 },
    });
    const decision = await createDecision(client, subscription.id);

    const response = await client.post(`/v1/decisions/${decision.id}/pay/session`);
    expect(response.status).toBe(409);
    expect(expectErrorCode(response.body)).toBe("CONFIRMATION_REQUIRED");

    const details = (response.body as { error: { details: { fields: string[] } } }).error.details;
    expect(details.fields).toContain("amount");
  });

  it("refuses to run the pay flow for a cancel recommendation", async () => {
    const subscription = await createSubscription(client, {
      merchantName: "Zombie Tool",
      amount: "40.00",
      criticality: "experimental",
      usageNote: "Unused for 120 days.",
    });
    const decision = await createDecision(client, subscription.id);
    expect(decision.recommendation).toBe("cancel");

    const response = await client.post(`/v1/decisions/${decision.id}/pay/session`);
    expect(response.status).toBe(409);
    expect(expectErrorCode(response.body)).toBe("INVALID_DECISION_STATE");
  });
});

describe("cancel path saves money without moving any", () => {
  it("runs start, confirm and lands in the savings ledger", async () => {
    const subscription = await createSubscription(client, {
      merchantName: "Midjourney",
      planName: "Standard",
      amount: "30.00",
      criticality: "experimental",
      jobCategory: "design",
      usageNote: "Unused for 75 days since the rebrand shipped.",
    });
    const decision = await createDecision(client, subscription.id);
    expect(decision.recommendation).toBe("cancel");

    const start = await client.post<{
      plan: { status: string; portalUrl: string; portalUrlVerified: boolean; disclaimer: string };
      subscription: { status: string };
    }>(`/v1/decisions/${decision.id}/cancel/start`);

    expect(start.status).toBe(201);
    expect(start.body.plan.status).toBe("pending_user_confirmation");
    expect(start.body.plan.portalUrl).toBe("https://www.midjourney.com/account");
    expect(start.body.plan.portalUrlVerified).toBe(true);
    expect(start.body.subscription.status).toBe("pending_cancel");

    const beforeSummary = await client.get<{ realizedTotal: string }>("/v1/savings/summary");

    const confirm = await client.post<{
      subscription: { status: string };
      amountSaved: string;
      savingsEntryId: string;
    }>(`/v1/decisions/${decision.id}/cancel/confirm`, {
      note: "Cancelled in the Midjourney account page",
    });

    expect(confirm.status).toBe(200);
    expect(confirm.body.subscription.status).toBe("cancelled");
    expect(confirm.body.amountSaved).toBe("360.00");

    const afterSummary = await client.get<{
      realizedTotal: string;
      byActionType: Record<string, string>;
    }>("/v1/savings/summary");
    expect(
      Number(afterSummary.body.realizedTotal) - Number(beforeSummary.body.realizedTotal),
    ).toBe(360);
    expect(Number(afterSummary.body.byActionType.cancel)).toBeGreaterThanOrEqual(360);

    // Nothing was charged, so no transaction or receipt exists for this action.
    const receipts = await client.get<{ receipts: unknown[] }>("/v1/receipts");
    expect(receipts.body.receipts).toHaveLength(0);

    const audit = await client.get<{ events: Array<{ type: string; data: Record<string, unknown> }> }>(
      "/v1/audit?limit=200",
    );
    const cancelStarted = audit.body.events.find((e) => e.type === "cancel.started");
    expect(cancelStarted?.data.automated).toBe(false);
  });

  it("refuses to cancel again once cancelled", async () => {
    const subscription = await createSubscription(client, {
      merchantName: "Already Gone Co",
      criticality: "experimental",
      usageNote: "Unused for 100 days.",
    });
    const decision = await createDecision(client, subscription.id);

    await client.post(`/v1/decisions/${decision.id}/cancel/start`);
    await client.post(`/v1/decisions/${decision.id}/cancel/confirm`, {});

    const again = await client.post(`/v1/decisions/${decision.id}/cancel/start`);
    expect(again.status).toBe(409);
    expect(expectErrorCode(again.body)).toBe("INVALID_DECISION_STATE");
  });
});

describe("input failures", () => {
  it("rejects an oversized upload", async () => {
    const form = new FormData();
    form.append("file", textFile("big.csv", "date,description,amount\n" + "x".repeat(1_100_000)));
    const response = await client.upload("/v1/intake/csv", form);
    expect(response.status).toBe(413);
  });

  it("rejects a CSV with no usable columns", async () => {
    const form = new FormData();
    form.append("file", textFile("bad.csv", "foo,bar\n1,2", "text/csv"));
    const response = await client.upload("/v1/intake/csv", form);
    expect(response.status).toBe(400);
    expect(expectErrorCode(response.body)).toBe("VALIDATION_ERROR");
  });

  it("rejects malformed JSON", async () => {
    const response = await harness.app.request("http://localhost/v1/subscriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${client.getToken()}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });

  it("still parses a real statement after all that", async () => {
    const form = new FormData();
    form.append("file", textFile("small-bank.csv", fixture("csv/small-bank.csv"), "text/csv"));
    const response = await client.upload<{ candidates: unknown[] }>("/v1/intake/csv", form);
    expect(response.status).toBe(201);
    expect(response.body.candidates).toHaveLength(3);
  });
});
