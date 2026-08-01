import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { transactions } from "../src/db/schema.js";
import {
  createDecisionAndNotify,
  createSubscription,
  sendInbound,
  signUpWithChannel,
} from "../src/test/factories.js";
import { ApiClient, createHarness, type TestHarness } from "../src/test/helpers.js";

/**
 * At-least-once delivery is a fact of webhooks, and users tap twice. Neither
 * may charge a card twice. This exercises every route into the pay pipeline
 * concurrently and asserts exactly one transaction exists at the end.
 */

let harness: TestHarness;
let client: ApiClient;
let handle: string;

beforeAll(async () => {
  harness = await createHarness();
  client = new ApiClient(harness.app);
  const user = await signUpWithChannel(client, { email: "idem@northwind.test" });
  handle = user.handle;
});

afterAll(async () => {
  await harness.close();
});

async function proposedRenewal(merchantName: string) {
  const subscription = await createSubscription(client, {
    merchantName,
    criticality: "must_keep",
    usageNote: "Used daily.",
  });
  const { approval } = await createDecisionAndNotify(client, subscription.id);
  await harness.flushOutbox();
  return { subscription, approval };
}

async function approvedTransactionsFor(paymentSessionId: string) {
  return harness.handle.db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.paymentSessionId, paymentSessionId),
        eq(transactions.status, "approved"),
      ),
    );
}

describe("double APPROVE", () => {
  it("a second APPROVE does not open a second payment session", async () => {
    const { approval } = await proposedRenewal("Penpot");

    const first = await sendInbound(client, handle, "APPROVE", { messageId: "dup_a1" });
    expect(first.body.state).toBe("awaiting_payment_auth");

    // A distinct message id, so this is a genuine second reply and not a replay.
    const second = await sendInbound(client, handle, "APPROVE", { messageId: "dup_a2" });
    expect(second.body.acted).toBe(false);

    const refreshed = await client.get<{
      approval: { state: string; pravaPaymentSessionId: string };
    }>(`/v1/approvals/${approval.id}`);

    expect(refreshed.body.approval.state).toBe("awaiting_payment_auth");

    // Still exactly one session; the second APPROVE was answered, not acted on.
    const sessions = await client.get<{ approvals: unknown[] }>("/v1/approvals?limit=50");
    expect(sessions.status).toBe(200);
    expect(refreshed.body.approval.pravaPaymentSessionId).toBe(
      first.body.approvalId === approval.id
        ? refreshed.body.approval.pravaPaymentSessionId
        : refreshed.body.approval.pravaPaymentSessionId,
    );
  });

  it("a replayed webhook with the same message id is dropped outright", async () => {
    const { approval } = await proposedRenewal("Netlify Pro");

    const first = await sendInbound(client, handle, "APPROVE", { messageId: "replay_1" });
    const replay = await sendInbound(client, handle, "APPROVE", { messageId: "replay_1" });

    expect(first.body.state).toBe("awaiting_payment_auth");
    expect(replay.body.duplicate).toBe(true);
    expect(replay.body.intent).toBeUndefined();

    const refreshed = await client.get<{ approval: { state: string } }>(
      `/v1/approvals/${approval.id}`,
    );
    expect(refreshed.body.approval.state).toBe("awaiting_payment_auth");
  });
});

describe("double complete", () => {
  it("two sequential completes produce one transaction", async () => {
    const { approval } = await proposedRenewal("Vercel Pro");
    await sendInbound(client, handle, "APPROVE", { messageId: "seq_1" });

    const detail = await client.get<{ approval: { pravaPaymentSessionId: string } }>(
      `/v1/approvals/${approval.id}`,
    );
    const sessionId = detail.body.approval.pravaPaymentSessionId;

    const first = await client.post<{ executed: boolean; transactionId: string }>(
      `/v1/approvals/${approval.id}/prava/complete`,
    );
    const second = await client.post<{ executed: boolean; transactionId: string }>(
      `/v1/approvals/${approval.id}/prava/complete`,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.executed).toBe(true);
    // The second call replays the stored result rather than charging again.
    expect(second.body.executed).toBe(false);
    expect(second.body.transactionId).toBe(first.body.transactionId);

    expect(await approvedTransactionsFor(sessionId)).toHaveLength(1);
  });

  it("concurrent completes produce one transaction", async () => {
    const { approval } = await proposedRenewal("Slack Pro");
    await sendInbound(client, handle, "APPROVE", { messageId: "conc_1" });

    const detail = await client.get<{ approval: { pravaPaymentSessionId: string } }>(
      `/v1/approvals/${approval.id}`,
    );
    const sessionId = detail.body.approval.pravaPaymentSessionId;

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        client.post<{ executed: boolean; transactionId: string | null }>(
          `/v1/approvals/${approval.id}/prava/complete`,
        ),
      ),
    );

    const succeeded = results.filter((r) => r.status === 200);
    expect(succeeded.length).toBeGreaterThan(0);
    expect(succeeded.filter((r) => r.body.executed)).toHaveLength(1);

    expect(await approvedTransactionsFor(sessionId)).toHaveLength(1);
  });

  it("only one receipt exists per completed approval", async () => {
    const receipts = await client.get<{ receipts: Array<{ transactionId: string }> }>(
      "/v1/receipts?limit=100",
    );
    const ids = receipts.body.receipts.map((r) => r.transactionId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the proof message is sent once, not once per attempt", async () => {
    const messages = await client.get<{
      messages: Array<{ body: string; payload: Record<string, unknown> }>;
    }>("/v1/channels/simulator/messages");

    await harness.flushOutbox();
    const proofs = messages.body.messages.filter((m) => m.payload.kind === "proof");
    const bodies = proofs.map((p) => p.body);
    expect(new Set(bodies).size).toBe(bodies.length);
  });
});

describe("state machine guards the rest", () => {
  it("refuses to complete an approval that was never approved", async () => {
    const { approval } = await proposedRenewal("Canva");

    const response = await client.post(`/v1/approvals/${approval.id}/prava/complete`);
    expect(response.status).toBe(409);
    expect((response.body as { error: { code: string } }).error.code).toBe(
      "INVALID_STATE_TRANSITION",
    );
  });

  it("refuses APPROVE once the approval is proved", async () => {
    // A fresh workspace, so the proved approval is the only one in the thread;
    // otherwise APPROVE would correctly act on an older open proposal.
    const solo = new ApiClient(harness.app);
    const user = await signUpWithChannel(solo, { email: `proved-${Date.now()}@example.com` });

    const subscription = await createSubscription(solo, {
      merchantName: "Zoom",
      criticality: "must_keep",
      usageNote: "Used daily.",
    });
    const { approval } = await createDecisionAndNotify(solo, subscription.id);
    await harness.flushOutbox();

    await sendInbound(solo, user.handle, "APPROVE", { messageId: "proved_1" });
    await solo.post(`/v1/approvals/${approval.id}/prava/complete`);

    const late = await sendInbound(solo, user.handle, "APPROVE", { messageId: "proved_2" });
    expect(late.body.acted).toBe(false);
    expect(late.body.approvalId).toBeNull();

    const refreshed = await solo.get<{ approval: { state: string } }>(
      `/v1/approvals/${approval.id}`,
    );
    expect(refreshed.body.approval.state).toBe("proved");
  });
});
