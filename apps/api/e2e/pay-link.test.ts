import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalRequests, transactions } from "../src/db/schema.js";
import { sha256 } from "../src/lib/crypto.js";
import {
  createDecisionAndNotify,
  createSubscription,
  lastOutbound,
  sendInbound,
  signUpWithChannel,
} from "../src/test/factories.js";
import { ApiClient, createHarness, expectErrorCode, type TestHarness } from "../src/test/helpers.js";

/**
 * The pay link is opened on the device that received the text, which holds no
 * session. These journeys drive an approval to awaiting_payment_auth exactly as
 * the happy path does, then exercise the token-only routes with a client that
 * carries no bearer token at all.
 *
 * The token is never returned by any API — it is parsed off the link in the
 * outbound message, which also proves the texted link is well formed.
 */

let harness: TestHarness;

interface PayLinkContext {
  client: ApiClient;
  handle: string;
  workspaceId: string;
  approvalId: string;
  token: string;
}

/** Sign up, propose, APPROVE, and capture the pay link from the thread. */
async function driveToPayLink(): Promise<PayLinkContext> {
  const client = new ApiClient(harness.app);
  const user = await signUpWithChannel(client);

  const subscription = await createSubscription(client);
  await createDecisionAndNotify(client, subscription.id);
  await harness.flushOutbox();

  const approved = await sendInbound(client, user.handle, "APPROVE");
  expect(approved.body.state).toBe("awaiting_payment_auth");
  await harness.flushOutbox();

  const outbound = await lastOutbound(client);
  const match = outbound!.body.match(/\/pay\/([\w]+)\?token=([\w-]+)/);
  expect(match, "outbound message must carry a well-formed pay link").toBeTruthy();

  return {
    client,
    handle: user.handle,
    workspaceId: user.workspaceId,
    approvalId: match![1]!,
    token: match![2]!,
  };
}

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

describe("pay link without a session", () => {
  // One fully-driven approval shared by the read-only cases; the anonymous
  // client below carries no token or cookie, like the phone that got the text.
  let ctx: PayLinkContext;
  let anonymous: ApiClient;

  beforeAll(async () => {
    ctx = await driveToPayLink();
    anonymous = new ApiClient(harness.app);
  });

  it("4. never serves another workspace's approval to a foreign token", async () => {
    // Written first because it is the security regression test: a valid token
    // from workspace A must open nothing that belongs to workspace B.
    const other = await driveToPayLink();

    const response = await anonymous.get(
      `/v1/approvals/${other.approvalId}/pay-bootstrap?token=${ctx.token}`,
    );

    expect([401, 404]).toContain(response.status);
    expect(JSON.stringify(response.body)).not.toContain("hostedUrl");
  });

  it("1. bootstraps the pay page with a valid token and no auth header", async () => {
    const response = await anonymous.get<{
      approvalId: string;
      sessionId: string;
      hostedUrl: string;
      amount: string;
      currency: string;
      merchantName: string;
      expiresAt: string;
    }>(`/v1/approvals/${ctx.approvalId}/pay-bootstrap?token=${ctx.token}`);

    expect(response.status).toBe(200);
    expect(response.body.hostedUrl).toBeTruthy();
    expect(response.body.amount).toBe("204.00");
    expect(response.body.merchantName).toBe("Anthropic");
  });

  it("2. refuses with no token", async () => {
    const response = await anonymous.get(`/v1/approvals/${ctx.approvalId}/pay-bootstrap`);

    expect(response.status).toBe(401);
    expect(expectErrorCode(response.body)).toBe("UNAUTHORIZED");
  });

  it("3. refuses a wrong token", async () => {
    const response = await anonymous.get(
      `/v1/approvals/${ctx.approvalId}/pay-bootstrap?token=definitely-not-the-token`,
    );

    expect(response.status).toBe(401);
    expect(expectErrorCode(response.body)).toBe("UNAUTHORIZED");
  });

  it("5. completes the payment unauthenticated and proves the approval", async () => {
    const response = await anonymous.post<{
      approval: { state: string };
      transactionId: string;
      executed: boolean;
    }>(`/v1/approvals/${ctx.approvalId}/prava/complete?token=${ctx.token}`);

    expect(response.status).toBe(200);
    expect(response.body.approval.state).toBe("proved");
    expect(response.body.executed).toBe(true);
    expect(response.body.transactionId).toBeTruthy();
  });

  it("6. a second tap on the same link converges on the single charge", async () => {
    const response = await anonymous.post<{
      approval: { state: string };
      transactionId: string;
      executed: boolean;
    }>(`/v1/approvals/${ctx.approvalId}/prava/complete?token=${ctx.token}`);

    expect(response.status).toBe(200);
    expect(response.body.approval.state).toBe("proved");
    expect(response.body.executed).toBe(false);

    const rows = await harness.handle.db
      .select()
      .from(transactions)
      .where(eq(transactions.workspaceId, ctx.workspaceId));
    expect(rows).toHaveLength(1);
  });

  it("7. refuses to complete once the approval window has closed", async () => {
    const expired = await driveToPayLink();

    await harness.handle.db
      .update(approvalRequests)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(approvalRequests.id, expired.approvalId));

    const response = await anonymous.post(
      `/v1/approvals/${expired.approvalId}/prava/complete?token=${expired.token}`,
    );

    expect([401, 409]).toContain(response.status);
    expect(expectErrorCode(response.body)).toBe("APPROVAL_EXPIRED");

    const check = await expired.client.get<{ approval: { state: string } }>(
      `/v1/approvals/${expired.approvalId}`,
    );
    expect(check.body.approval.state).not.toBe("proved");
  });

  it("8. reports no-session-yet on an approval still awaiting intent", async () => {
    // A token normally only exists after APPROVE mints the payment session, so
    // this plants one directly to isolate the state check from the token check.
    const early = await createSubscription(ctx.client, {
      merchantName: "Figma",
      planName: "Professional",
      amount: "45.00",
      jobCategory: "design",
    });
    const { approval } = await createDecisionAndNotify(ctx.client, early.id);
    expect(approval.state).toBe("awaiting_intent");

    const plantedToken = "planted-token-for-state-check";
    await harness.handle.db
      .update(approvalRequests)
      .set({ payTokenHash: sha256(plantedToken) })
      .where(eq(approvalRequests.id, approval.id));

    const response = await anonymous.get(
      `/v1/approvals/${approval.id}/pay-bootstrap?token=${plantedToken}`,
    );

    expect(response.status).toBe(409);
    expect(expectErrorCode(response.body)).toBe("INVALID_STATE_TRANSITION");
  });
});
