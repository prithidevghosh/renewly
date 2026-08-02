import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDecision, createSubscription, signUp } from "../src/test/factories.js";
import { ApiClient, createHarness, expectErrorCode, type TestHarness } from "../src/test/helpers.js";
import { transactions } from "../src/db/schema.js";
import { MockPravaClient } from "../src/test/doubles/prava.js";
import { setPravaClient } from "../src/modules/payments/factory.js";
import { setCheckoutAdapter } from "../src/modules/payments/checkoutAdapter.js";
import { MockCheckoutAdapter } from "../src/test/doubles/checkout.js";

let harness: TestHarness;
let client: ApiClient;

interface SessionResponse {
  paymentSession: {
    id: string;
    status: string;
    amount: string;
    currency: string;
    merchantName: string;
    pravaSessionId: string;
    mode: string;
    iframeUrl: string | null;
  };
  sessionId: string;
  sessionToken: string;
  iframeUrl: string;
  publishableKey: string | null;
}

interface CompleteResponse {
  paymentSession: { id: string; status: string };
  transaction: {
    id: string;
    status: string;
    amount: string;
    cardLast4: string | null;
    cardBrand: string | null;
    checkoutReference: string | null;
    pravaTxnRefId: string | null;
  };
  receiptId: string | null;
}

/** A confirmed, payable renewal with a live decision package. */
async function payableRenewal(overrides: Record<string, unknown> = {}) {
  const subscription = await createSubscription(client, {
    criticality: "must_keep",
    usageNote: "Used daily for drafting.",
    ...overrides,
  });
  const decision = await createDecision(client, subscription.id);
  return { subscription, decision };
}

beforeAll(async () => {
  harness = await createHarness();
  client = new ApiClient(harness.app);
  await signUp(client);
});

afterAll(async () => {
  await harness.close();
});

describe("merchant details on the session", () => {
  it("names the merchant with the website the graph knows", async () => {
    const { decision } = await payableRenewal({ merchantName: "Anthropic" });

    const session = await client.post<SessionResponse>(`/v1/decisions/${decision.id}/pay/session`);

    const sent = harness.prava.inspect(session.body.paymentSession.pravaSessionId);
    expect(sent?.merchantName).toBe("Anthropic");
    expect(sent?.merchantUrl).toBe("https://claude.ai");
    expect(sent?.merchantCountry).toBe("US");
  });

  it("falls back to a configured https url for a vendor the graph has no site for", async () => {
    const { decision } = await payableRenewal({ merchantName: "Some Indie Tool" });

    const session = await client.post<SessionResponse>(`/v1/decisions/${decision.id}/pay/session`);

    // The rail rejects a session without an https merchant url, so there is
    // always one, even when we do not know the vendor's site.
    expect(session.status).toBe(201);
    expect(harness.prava.inspect(session.body.paymentSession.pravaSessionId)?.merchantUrl).toMatch(
      /^https:\/\//,
    );
  });
});

describe("pay happy path", () => {
  it("creates a session, completes it, and writes a transaction and receipt", async () => {
    const { subscription, decision } = await payableRenewal({ merchantName: "Penpot" });

    const session = await client.post<SessionResponse>(`/v1/decisions/${decision.id}/pay/session`);
    expect(session.status).toBe(201);
    expect(session.body.paymentSession.status).toBe("awaiting_collection");
    expect(session.body.paymentSession.amount).toBe("20.00");
    expect(session.body.paymentSession.mode).toBe("mock");
    expect(session.body.sessionToken).toBeTruthy();
    expect(session.body.iframeUrl).toBe("https://pay.prava.space/mock");

    const complete = await client.post<CompleteResponse>(
      `/v1/decisions/${decision.id}/pay/complete`,
    );
    expect(complete.status).toBe(200);
    expect(complete.body.paymentSession.status).toBe("completed");
    expect(complete.body.transaction.status).toBe("approved");
    expect(complete.body.transaction.amount).toBe("20.00");
    expect(complete.body.transaction.cardLast4).toBe("1111");
    expect(complete.body.transaction.cardBrand).toBe("visa");
    expect(complete.body.transaction.checkoutReference).toBeTruthy();
    expect(complete.body.receiptId).toBeTruthy();

    // The rail must have been told the outcome.
    expect(harness.prava.inspect(session.body.paymentSession.pravaSessionId)?.reported).toBe(
      "APPROVED",
    );

    const stored = await client.get<{ paymentSession: { status: string } }>(
      `/v1/payment-sessions/${session.body.paymentSession.id}`,
    );
    expect(stored.body.paymentSession.status).toBe("completed");
    expect(subscription.id).toBeTruthy();
  });

  it("never returns or stores a card number or CVV", async () => {
    const { decision } = await payableRenewal({ merchantName: "Netlify Pro" });
    await client.post(`/v1/decisions/${decision.id}/pay/session`);
    const complete = await client.post<CompleteResponse>(
      `/v1/decisions/${decision.id}/pay/complete`,
    );

    const serialized = JSON.stringify(complete.body);
    expect(serialized).not.toContain("4111111111111111");
    expect(serialized).not.toContain('"cvv"');
    expect(serialized).not.toContain("dynamic_cvv");
    expect(serialized).not.toContain("cardNumber");

    // And nothing in the transactions table holds a PAN.
    const rows = await harness.handle.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, complete.body.transaction.id));
    expect(JSON.stringify(rows)).not.toContain("4111111111111111");
    expect(rows[0]?.cardLast4).toBe("1111");

    const receipt = await client.get<{ receipt: { payload: Record<string, unknown> } }>(
      `/v1/receipts/${complete.body.receiptId}`,
    );
    expect(JSON.stringify(receipt.body)).not.toContain("4111111111111111");
    expect(JSON.stringify(receipt.body)).not.toContain("123");
  });

  it("records the receipt with the rail and adapter provenance", async () => {
    const { decision } = await payableRenewal({ merchantName: "Plausible Growth" });
    await client.post(`/v1/decisions/${decision.id}/pay/session`);
    const complete = await client.post<CompleteResponse>(
      `/v1/decisions/${decision.id}/pay/complete`,
    );

    const receipt = await client.get<{
      receipt: { payload: { rail: { provider: string; mode: string }; checkout: { mode: string } } };
      transaction: { status: string };
    }>(`/v1/receipts/${complete.body.receiptId}`);

    expect(receipt.body.receipt.payload.rail.provider).toBe("prava");
    expect(receipt.body.receipt.payload.rail.mode).toBe("mock");
    expect(receipt.body.receipt.payload.checkout.mode).toBe("mock");
    expect(receipt.body.transaction.status).toBe("approved");
  });

  it("writes the full audit chain", async () => {
    const audit = await client.get<{ events: Array<{ type: string }> }>("/v1/audit?limit=200");
    const types = audit.body.events.map((e) => e.type);

    expect(types).toContain("decision.generated");
    expect(types).toContain("payment.session_created");
    expect(types).toContain("payment.credentials_received");
    expect(types).toContain("payment.succeeded");
  });

  it("refuses to complete the same session twice", async () => {
    const { decision } = await payableRenewal({ merchantName: "Zoom" });
    const session = await client.post<SessionResponse>(`/v1/decisions/${decision.id}/pay/session`);
    await client.post(`/v1/decisions/${decision.id}/pay/complete`);

    const again = await client.post(`/v1/decisions/${decision.id}/pay/complete`, {
      paymentSessionId: session.body.paymentSession.id,
    });
    expect(again.status).toBe(409);
    expect(expectErrorCode(again.body)).toBe("CONFLICT");
  });
});

describe("pay is blocked by policy", () => {
  it("kill switch blocks session creation", async () => {
    const { decision } = await payableRenewal({ merchantName: "Canva" });
    await client.post("/v1/settings/kill-switch", { enabled: true });

    const response = await client.post(`/v1/decisions/${decision.id}/pay/session`);
    expect(response.status).toBe(409);
    expect(expectErrorCode(response.body)).toBe("KILL_SWITCH_ENABLED");

    await client.post("/v1/settings/kill-switch", { enabled: false });
  });

  it("kill switch pulled between session and completion blocks the charge", async () => {
    const { decision } = await payableRenewal({ merchantName: "Atlassian" });
    const session = await client.post<SessionResponse>(`/v1/decisions/${decision.id}/pay/session`);
    expect(session.status).toBe(201);

    await client.post("/v1/settings/kill-switch", { enabled: true });
    const complete = await client.post(`/v1/decisions/${decision.id}/pay/complete`);
    expect(complete.status).toBe(409);
    expect(expectErrorCode(complete.body)).toBe("KILL_SWITCH_ENABLED");

    await client.post("/v1/settings/kill-switch", { enabled: false });
  });

  it("an unconfirmed low-confidence renewal cannot be paid until confirmed", async () => {
    const subscription = await createSubscription(client, {
      merchantName: "Guessy Vendor",
      amount: "25.00",
      criticality: "must_keep",
      usageNote: "Used daily.",
      fieldConfidence: { amount: 0.4, merchant_name: 0.5, next_renewal_at: 0.4 },
    });
    expect(subscription.requiresConfirmation).toBe(true);

    const decision = await createDecision(client, subscription.id);

    const blocked = await client.post(`/v1/decisions/${decision.id}/pay/session`);
    expect(blocked.status).toBe(409);
    expect(expectErrorCode(blocked.body)).toBe("CONFIRMATION_REQUIRED");

    await client.post(`/v1/subscriptions/${subscription.id}/confirm`, {});
    const allowed = await client.post(`/v1/decisions/${decision.id}/pay/session`);
    expect(allowed.status).toBe(201);
  });

  it("refuses to pay a cancel recommendation", async () => {
    const subscription = await createSubscription(client, {
      merchantName: "Abandoned Tool",
      usageNote: "Unused for 90 days.",
    });
    const decision = await createDecision(client, subscription.id);
    expect(decision.recommendation).toBe("cancel");

    const response = await client.post(`/v1/decisions/${decision.id}/pay/session`);
    expect(response.status).toBe(409);
    expect(expectErrorCode(response.body)).toBe("INVALID_DECISION_STATE");
  });

  it("refuses an amount that does not match the decision", async () => {
    const { decision } = await payableRenewal({ merchantName: "Github Team" });
    const response = await client.post(`/v1/decisions/${decision.id}/pay/session`, {
      amount: "500.00",
    });
    expect(response.status).toBe(409);
    expect(expectErrorCode(response.body)).toBe("INVALID_DECISION_STATE");
  });

  it("refuses a superseded decision", async () => {
    const subscription = await createSubscription(client, {
      merchantName: "Stale Decision Co",
      criticality: "must_keep",
      usageNote: "Used daily.",
    });
    const first = await createDecision(client, subscription.id);
    await createDecision(client, subscription.id, { regenerate: true });

    const response = await client.post(`/v1/decisions/${first.id}/pay/session`);
    expect(response.status).toBe(409);
    expect(expectErrorCode(response.body)).toBe("INVALID_DECISION_STATE");
  });

  it("auto_within_envelope refuses an above-ceiling charge", async () => {
    await client.patch("/v1/settings", {
      approvalMode: "auto_within_envelope",
      spendCeiling: "10.00",
    });

    const { decision } = await payableRenewal({ merchantName: "Expensive Tool", amount: "80.00" });
    const response = await client.post(`/v1/decisions/${decision.id}/pay/session`);

    expect(response.status).toBe(409);
    expect(expectErrorCode(response.body)).toBe("APPROVAL_REQUIRED");

    await client.patch("/v1/settings", {
      approvalMode: "always_ask",
      spendCeiling: "50.00",
    });
  });

  it("records payment.blocked when the rail refuses the session", async () => {
    setPravaClient(new MockPravaClient({ failureMode: "mandate" }));
    const { decision } = await payableRenewal({ merchantName: "Mandate Failure Co" });

    const response = await client.post(`/v1/decisions/${decision.id}/pay/session`);
    expect(response.status).toBe(502);
    expect(expectErrorCode(response.body)).toBe("PRAVA_ERROR");

    const audit = await client.get<{ events: Array<{ data: Record<string, unknown> }> }>(
      "/v1/audit?type=payment.blocked&limit=10",
    );
    expect(audit.body.events.length).toBeGreaterThan(0);

    setPravaClient(harness.prava);
  });
});

describe("pay failure paths", () => {
  /*
   * A decline is produced by installing an adapter that declines, not by a
   * `forceDecline` flag on the request. The flag reached into the payment
   * service and built a mock there, which meant the module that charges cards
   * imported a test double; the seam is setCheckoutAdapter instead.
   */
  /** Installs a declining adapter for one test and restores it afterwards. */
  function decliningCheckout() {
    setCheckoutAdapter(new MockCheckoutAdapter({ forceDecline: true }));
  }

  afterEach(() => {
    setCheckoutAdapter(new MockCheckoutAdapter());
  });

  it("a declined checkout writes a declined transaction and no receipt", async () => {
    const { decision } = await payableRenewal({ merchantName: "Decline Test Co" });
    await client.post(`/v1/decisions/${decision.id}/pay/session`);
    decliningCheckout();

    const response = await client.post(`/v1/decisions/${decision.id}/pay/complete`, {});

    expect(response.status).toBe(402);
    expect(expectErrorCode(response.body)).toBe("CHECKOUT_DECLINED");

    const details = (response.body as { error: { details: Record<string, string> } }).error.details;
    const rows = await harness.handle.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, details.transactionId!));
    expect(rows[0]?.status).toBe("declined");
    expect(rows[0]?.failureReason).toBeTruthy();

    const session = await client.get<{ paymentSession: { status: string; lastError: string } }>(
      `/v1/payment-sessions/${details.paymentSessionId}`,
    );
    expect(session.body.paymentSession.status).toBe("failed");
    expect(session.body.paymentSession.lastError).toBeTruthy();
  });

  it("reports DECLINED back to the rail so the credential is closed out", async () => {
    const { decision } = await payableRenewal({ merchantName: "Decline Report Co" });
    const session = await client.post<SessionResponse>(`/v1/decisions/${decision.id}/pay/session`);
    decliningCheckout();
    await client.post(`/v1/decisions/${decision.id}/pay/complete`, {});

    expect(harness.prava.inspect(session.body.paymentSession.pravaSessionId)?.reported).toBe(
      "DECLINED",
    );
  });

  it("declines a credential from the reserved decline BIN", async () => {
    setPravaClient(new MockPravaClient({ failureMode: "decline" }));
    const { decision } = await payableRenewal({ merchantName: "Bad Bin Co" });

    await client.post(`/v1/decisions/${decision.id}/pay/session`);
    const response = await client.post(`/v1/decisions/${decision.id}/pay/complete`);

    expect(response.status).toBe(402);
    expect(expectErrorCode(response.body)).toBe("CHECKOUT_DECLINED");

    setPravaClient(harness.prava);
  });

  it("times out cleanly when credentials never arrive", async () => {
    setPravaClient(new MockPravaClient({ failureMode: "card" }));
    const { decision } = await payableRenewal({ merchantName: "Abandoned Iframe Co" });

    await client.post(`/v1/decisions/${decision.id}/pay/session`);
    const response = await client.post(`/v1/decisions/${decision.id}/pay/complete`);

    expect(response.status).toBe(502);
    expect(expectErrorCode(response.body)).toBe("PRAVA_ERROR");

    const audit = await client.get<{ events: Array<{ data: Record<string, unknown> }> }>(
      "/v1/audit?type=payment.failed&limit=20",
    );
    expect(audit.body.events.some((e) => e.data.stage === "credentials")).toBe(true);

    setPravaClient(harness.prava);
  });

  it("polls until the user finishes the iframe", async () => {
    setPravaClient(new MockPravaClient({ pollsBeforeCredentials: 2 }));
    const { decision } = await payableRenewal({ merchantName: "Slow Collection Co" });

    await client.post(`/v1/decisions/${decision.id}/pay/session`);
    const response = await client.post<CompleteResponse>(
      `/v1/decisions/${decision.id}/pay/complete`,
    );

    expect(response.status).toBe(200);
    expect(response.body.transaction.status).toBe("approved");

    setPravaClient(harness.prava);
  });

  it("404s when completing with no session created", async () => {
    const { decision } = await payableRenewal({ merchantName: "No Session Co" });
    const response = await client.post(`/v1/decisions/${decision.id}/pay/complete`);
    expect(response.status).toBe(404);
  });

  it("does not let another workspace pay someone else's decision", async () => {
    const { decision } = await payableRenewal({ merchantName: "Private Pay Co" });

    const other = new ApiClient(harness.app);
    await signUp(other);
    expect((await other.post(`/v1/decisions/${decision.id}/pay/session`)).status).toBe(404);
  });
});

describe("transactions are scoped to their session", () => {
  it("counts one transaction per completed session", async () => {
    const { decision } = await payableRenewal({ merchantName: "Counting Co" });
    const session = await client.post<SessionResponse>(`/v1/decisions/${decision.id}/pay/session`);
    const complete = await client.post<CompleteResponse>(
      `/v1/decisions/${decision.id}/pay/complete`,
    );

    const rows = await harness.handle.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.paymentSessionId, session.body.paymentSession.id),
          eq(transactions.status, "approved"),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(complete.body.transaction.id);
  });
});
