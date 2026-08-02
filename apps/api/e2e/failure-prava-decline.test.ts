import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { approvalRequests, transactions } from "../src/db/schema.js";
import { setPravaClient } from "../src/modules/payments/factory.js";
import { MockPravaClient } from "../src/test/doubles/prava.js";
import {
  createDecisionAndNotify,
  createSubscription,
  lastOutbound,
  sendInbound,
  signUpWithChannel,
} from "../src/test/factories.js";
import { ApiClient, createHarness, expectErrorCode, type TestHarness } from "../src/test/helpers.js";
import { setCheckoutAdapter } from "../src/modules/payments/checkoutAdapter.js";
import { MockCheckoutAdapter } from "../src/test/doubles/checkout.js";

/**
 * Everything that can go wrong once money is in motion. The bar for each: the
 * user is told, nothing is charged, and the ledger does not claim a saving that
 * did not happen.
 */

let harness: TestHarness;

async function freshWorkspace(email: string) {
  const client = new ApiClient(harness.app);
  const user = await signUpWithChannel(client, { email });
  return { client, handle: user.handle };
}

async function proposeAndApprove(client: ApiClient, handle: string, merchantName: string) {
  const subscription = await createSubscription(client, {
    merchantName,
    criticality: "must_keep",
    usageNote: "Used daily.",
  });
  const { approval } = await createDecisionAndNotify(client, subscription.id);
  await harness.flushOutbox();
  await sendInbound(client, handle, "APPROVE");
  await harness.flushOutbox();
  return { subscription, approval };
}

beforeAll(async () => {
  // Declines are produced by installing an adapter that declines, not by a flag
  // on the request — the payment service no longer reaches for a mock of its
  // own. Each describe below installs whichever it needs.
  harness = await createHarness();
});

afterAll(async () => {
  setPravaClient(null);
  await harness.close();
});

describe("card declined", () => {
  beforeEach(() => {
    setCheckoutAdapter(new MockCheckoutAdapter({ forceDecline: true }));
  });

  afterEach(() => {
    setCheckoutAdapter(new MockCheckoutAdapter());
  });


  it("tells the user nothing was charged and offers a retry", async () => {
    const { client, handle } = await freshWorkspace(`decline-${Date.now()}@test.com`);
    const { approval } = await proposeAndApprove(client, handle, "Penpot");

    const response = await client.post(`/v1/approvals/${approval.id}/prava/complete`, {});

    expect(response.status).toBe(402);
    expect(expectErrorCode(response.body)).toBe("CHECKOUT_DECLINED");

    await harness.flushOutbox();
    const outbound = await lastOutbound(client);
    expect(outbound!.body).toContain("Could not complete Penpot");
    expect(outbound!.body).toContain("Nothing was charged");
    expect(outbound!.body).toContain("Reply RETRY");
  });

  it("leaves the approval failed with the reason recorded", async () => {
    const { client, handle } = await freshWorkspace(`decline2-${Date.now()}@test.com`);
    const { approval } = await proposeAndApprove(client, handle, "Netlify Pro");

    await client.post(`/v1/approvals/${approval.id}/prava/complete`, {});

    const refreshed = await client.get<{
      approval: { state: string; failureCode: string; resultPayload: Record<string, unknown> };
    }>(`/v1/approvals/${approval.id}`);

    expect(refreshed.body.approval.state).toBe("failed");
    expect(refreshed.body.approval.failureCode).toBe("CHECKOUT_DECLINED");
    expect(refreshed.body.approval.resultPayload.error).toBeTruthy();
  });

  it("writes a declined transaction and no receipt", async () => {
    const { client, handle } = await freshWorkspace(`decline3-${Date.now()}@test.com`);
    const { approval } = await proposeAndApprove(client, handle, "Vercel Pro");

    await client.post(`/v1/approvals/${approval.id}/prava/complete`, {});

    const [row] = await harness.handle.db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approval.id));

    const declined = await harness.handle.db
      .select()
      .from(transactions)
      .where(eq(transactions.paymentSessionId, row!.pravaPaymentSessionId!));

    expect(declined).toHaveLength(1);
    expect(declined[0]?.status).toBe("declined");
    expect(declined[0]?.failureReason).toBeTruthy();
    // The last four are still recorded, so the user knows which card failed.
    expect(declined[0]?.cardLast4).toBe("1111");

    const receipts = await client.get<{ receipts: unknown[] }>("/v1/receipts");
    expect(receipts.body.receipts).toHaveLength(0);
  });

  it("reports DECLINED back to the rail so the credential is closed out", async () => {
    const { client, handle } = await freshWorkspace(`decline4-${Date.now()}@test.com`);
    const { approval } = await proposeAndApprove(client, handle, "Slack Pro");

    const detail = await client.get<{ approval: { pravaPaymentSessionId: string } }>(
      `/v1/approvals/${approval.id}`,
    );
    const session = await client.get<{ paymentSession: { pravaSessionId: string } }>(
      `/v1/payment-sessions/${detail.body.approval.pravaPaymentSessionId}`,
    );

    await client.post(`/v1/approvals/${approval.id}/prava/complete`, {});

    expect(harness.prava.inspect(session.body.paymentSession.pravaSessionId)?.reported).toBe(
      "DECLINED",
    );
  });

  it("claims no saving for a payment that did not happen", async () => {
    const { client, handle } = await freshWorkspace(`decline5-${Date.now()}@test.com`);
    const { approval } = await proposeAndApprove(client, handle, "Canva");

    await client.post(`/v1/approvals/${approval.id}/prava/complete`, {});

    const summary = await client.get<{ realizedTotal: string }>("/v1/savings/summary");
    expect(summary.body.realizedTotal).toBe("0.00");
  });
});

describe("declined by the reserved BIN", () => {
  beforeEach(() => {
    setCheckoutAdapter(new MockCheckoutAdapter({ forceDecline: true }));
  });

  afterEach(() => {
    setCheckoutAdapter(new MockCheckoutAdapter());
  });


  it("fails the same way when the rail issues a bad credential", async () => {
    setPravaClient(new MockPravaClient({ failureMode: "decline" }));
    const { client, handle } = await freshWorkspace(`bin-${Date.now()}@test.com`);
    const { approval } = await proposeAndApprove(client, handle, "Zoom");

    const response = await client.post(`/v1/approvals/${approval.id}/prava/complete`);
    expect(response.status).toBe(402);
    expect(expectErrorCode(response.body)).toBe("CHECKOUT_DECLINED");

    await harness.flushOutbox();
    expect((await lastOutbound(client))!.body).toContain("Nothing was charged");

    setPravaClient(harness.prava);
  });
});

describe("the rail never issues credentials", () => {
  it("fails cleanly when the user abandons the card iframe", async () => {
    setPravaClient(new MockPravaClient({ failureMode: "card" }));
    const { client, handle } = await freshWorkspace(`abandon-${Date.now()}@test.com`);
    const { approval } = await proposeAndApprove(client, handle, "Atlassian");

    const response = await client.post(`/v1/approvals/${approval.id}/prava/complete`);
    expect(response.status).toBe(502);
    expect(expectErrorCode(response.body)).toBe("PRAVA_ERROR");

    const refreshed = await client.get<{ approval: { state: string; failureCode: string } }>(
      `/v1/approvals/${approval.id}`,
    );
    expect(refreshed.body.approval.state).toBe("failed");
    expect(refreshed.body.approval.failureCode).toBe("PRAVA_ERROR");

    const receipts = await client.get<{ receipts: unknown[] }>("/v1/receipts");
    expect(receipts.body.receipts).toHaveLength(0);

    setPravaClient(harness.prava);
  });
});

describe("the rail refuses the mandate", () => {
  it("never reaches awaiting_payment_auth and says so in-thread", async () => {
    setPravaClient(new MockPravaClient({ failureMode: "mandate" }));
    const { client, handle } = await freshWorkspace(`mandate-${Date.now()}@test.com`);

    const subscription = await createSubscription(client, {
      merchantName: "Linear Basic",
      criticality: "must_keep",
      usageNote: "Used daily.",
    });
    const { approval } = await createDecisionAndNotify(client, subscription.id);
    await harness.flushOutbox();

    const result = await sendInbound(client, handle, "APPROVE");
    expect(result.body.acted).toBe(false);
    expect(result.body.state).toBe("failed");

    await harness.flushOutbox();
    expect((await lastOutbound(client))!.body).toContain("Could not complete Linear Basic");

    const refreshed = await client.get<{ approval: { state: string; pravaPaymentSessionId: string | null } }>(
      `/v1/approvals/${approval.id}`,
    );
    expect(refreshed.body.approval.state).toBe("failed");
    // No session was ever opened, so there is nothing to complete.
    expect(refreshed.body.approval.pravaPaymentSessionId).toBeNull();

    const audit = await client.get<{ events: Array<{ data: Record<string, unknown> }> }>(
      "/v1/audit?type=payment.blocked&limit=10",
    );
    expect(audit.body.events[0]?.data.reason).toBe("PRAVA_ERROR");

    setPravaClient(harness.prava);
  });
});

describe("slow collection still succeeds", () => {
  it("polls until the user finishes the passkey step", async () => {
    setPravaClient(new MockPravaClient({ pollsBeforeCredentials: 2 }));
    const { client, handle } = await freshWorkspace(`slow-${Date.now()}@test.com`);
    const { approval } = await proposeAndApprove(client, handle, "Plausible Growth");

    const response = await client.post<{ approval: { state: string }; receiptId: string }>(
      `/v1/approvals/${approval.id}/prava/complete`,
    );

    expect(response.status).toBe(200);
    expect(response.body.approval.state).toBe("proved");
    expect(response.body.receiptId).toBeTruthy();

    await harness.flushOutbox();
    expect((await lastOutbound(client))!.body).toContain("Done. Paid");

    setPravaClient(harness.prava);
  });
});

describe("recovery", () => {
  it("a failed approval is terminal; a fresh decision is needed to try again", async () => {
    const { client, handle } = await freshWorkspace(`recover-${Date.now()}@test.com`);
    const { subscription, approval } = await proposeAndApprove(client, handle, "Github Team");

    // The first charge declines; the retry below must be allowed to settle, so
    // the adapter is swapped between the two rather than fixed for the file.
    setCheckoutAdapter(new MockCheckoutAdapter({ forceDecline: true }));
    await client.post(`/v1/approvals/${approval.id}/prava/complete`, {});

    // The same approval cannot be replayed.
    const again = await client.post(`/v1/approvals/${approval.id}/prava/complete`);
    expect(again.status).toBe(409);
    expect(expectErrorCode(again.body)).toBe("INVALID_STATE_TRANSITION");

    // A regenerated decision produces a new approval, and that one can succeed.
    setCheckoutAdapter(new MockCheckoutAdapter());
    const retry = await createDecisionAndNotify(client, subscription.id);
    await harness.flushOutbox();
    expect(retry.approval.id).not.toBe(approval.id);

    await sendInbound(client, handle, "APPROVE", { messageId: `retry_${Date.now()}` });
    const completed = await client.post<{ approval: { state: string } }>(
      `/v1/approvals/${retry.approval.id}/prava/complete`,
    );

    expect(completed.status).toBe(200);
    expect(completed.body.approval.state).toBe("proved");
  });
});
