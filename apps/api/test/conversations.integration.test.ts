import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDecisionAndNotify,
  createSubscription,
  lastOutbound,
  sendInbound,
  signUpWithChannel,
  simulatorMessages,
  type ApprovalShape,
} from "../src/test/factories.js";
import { ApiClient, createHarness, expectErrorCode, type TestHarness } from "../src/test/helpers.js";

let harness: TestHarness;
let client: ApiClient;
let handle: string;

/** A confirmed, payable renewal already proposed in the thread. */
async function proposedRenewal(overrides: Record<string, unknown> = {}) {
  const subscription = await createSubscription(client, {
    merchantName: "Penpot",
    criticality: "must_keep",
    usageNote: "Used daily.",
    ...overrides,
  });
  const { decision, approval } = await createDecisionAndNotify(client, subscription.id);
  await harness.flushOutbox();
  return { subscription, decision, approval };
}

beforeAll(async () => {
  harness = await createHarness();
  client = new ApiClient(harness.app);
  const user = await signUpWithChannel(client);
  handle = user.handle;
});

afterAll(async () => {
  await harness.close();
});

describe("channel connection", () => {
  it("lists the connected simulator channel", async () => {
    const response = await client.get<{
      channels: Array<{ channel: string; externalId: string; status: string }>;
    }>("/v1/channels");

    expect(response.status).toBe(200);
    expect(response.body.channels[0]?.channel).toBe("simulator");
    expect(response.body.channels[0]?.status).toBe("active");
  });

  it("connecting the same handle twice is idempotent", async () => {
    const before = await client.get<{ channels: unknown[] }>("/v1/channels");
    await client.post("/v1/channels/connect", { channel: "simulator", externalId: handle });
    const after = await client.get<{ channels: unknown[] }>("/v1/channels");
    expect(after.body.channels).toHaveLength(before.body.channels.length);
  });
});

describe("notify", () => {
  it("puts a proposal in the thread and moves the approval to awaiting_intent", async () => {
    const { approval } = await proposedRenewal();

    expect(approval.state).toBe("awaiting_intent");
    expect(approval.threadId).toBeTruthy();

    const outbound = await lastOutbound(client);
    expect(outbound?.body).toContain("Penpot");
    expect(outbound?.body).toContain("Reply APPROVE");
    expect(outbound?.payload.kind).toBe("proposal");
  });

  it("does not send twice for the same approval", async () => {
    const subscription = await createSubscription(client, {
      merchantName: "Netlify Pro",
      criticality: "must_keep",
      usageNote: "Used daily.",
    });
    await createDecisionAndNotify(client, subscription.id);
    await harness.flushOutbox();

    const before = (await simulatorMessages(client)).length;

    // Re-requesting the approval must not produce a second proposal.
    const decision = await client.post<{ decision: { id: string } }>(
      `/v1/subscriptions/${subscription.id}/decisions`,
      {},
    );
    await client.post(`/v1/decisions/${decision.body.decision.id}/approvals`, {});
    await harness.flushOutbox();

    expect((await simulatorMessages(client)).length).toBe(before);
  });

  it("quotes today's price on line one, not the switch price", async () => {
    const subscription = await createSubscription(client, {
      merchantName: "Anthropic",
      planName: "Claude Pro",
      amount: "20.00",
      billingCycle: "monthly",
      criticality: "must_keep",
      usageNote: "Used daily.",
    });

    const { decision } = await createDecisionAndNotify(client, subscription.id);
    await harness.flushOutbox();

    // switch_term pays the annual amount, but the header line describes the
    // status quo. Printing 204.00/mo would read as a price rise.
    expect(decision.recommendation).toBe("switch_term");
    expect(decision.package.amount_due).toBe("204.00");

    const outbound = await lastOutbound(client);
    const [header] = outbound!.body.split("\n");
    expect(header).toContain("$20.00/mo");
    expect(header).not.toContain("204.00");
    // The saving still appears, on the recommendation line.
    expect(outbound!.body).toContain("save 36.00 USD/yr");
  });

  it("never proposes a snooze", async () => {
    const subscription = await createSubscription(client, {
      merchantName: "Penpot",
      // must_keep would short-circuit to renew before the snooze rule is reached.
      criticality: "nice_to_have",
      usageNote: "Used weekly.",
      nextRenewalAt: new Date(Date.now() + 200 * 86_400_000).toISOString(),
    });

    const response = await client.post<{
      decision: { recommendation: string };
      approval: unknown;
      notified: boolean;
    }>(`/v1/subscriptions/${subscription.id}/decisions`, { regenerate: true, notify: true });

    expect(response.body.decision.recommendation).toBe("snooze");
    expect(response.body.approval).toBeNull();
    expect(response.body.notified).toBe(false);
  });
});

describe("inbound intents", () => {
  it("APPROVE opens a payment session and replies with the passkey link", async () => {
    const { approval } = await proposedRenewal({ merchantName: "Vercel Pro" });

    const result = await sendInbound(client, handle, "APPROVE");
    expect(result.status).toBe(200);
    expect(result.body.intent).toBe("APPROVE");
    expect(result.body.state).toBe("awaiting_payment_auth");
    expect(result.body.acted).toBe(true);

    await harness.flushOutbox();
    const outbound = await lastOutbound(client);
    expect(outbound?.body).toContain("with passkey");
    expect(outbound?.body).toContain("/pay/");

    const refreshed = await client.get<{ approval: ApprovalShape }>(`/v1/approvals/${approval.id}`);
    expect(refreshed.body.approval.state).toBe("awaiting_payment_auth");
    expect(refreshed.body.approval.pravaPaymentSessionId).toBeTruthy();
  });

  it("a thumbs-up tapback approves just like the word", async () => {
    const { approval } = await proposedRenewal({ merchantName: "Slack Pro" });

    const result = await sendInbound(client, handle, "", { tapback: "like" });
    expect(result.body.intent).toBe("APPROVE");
    expect(result.body.approvalId).toBe(approval.id);
    expect(result.body.state).toBe("awaiting_payment_auth");
  });

  it("KEEP closes the approval without charging anything", async () => {
    const { approval } = await proposedRenewal({ merchantName: "Canva" });

    const result = await sendInbound(client, handle, "keep it");
    expect(result.body.intent).toBe("KEEP");
    expect(result.body.state).toBe("cancelled_by_user");

    await harness.flushOutbox();
    expect((await lastOutbound(client))?.body).toContain("Nothing was charged");

    const refreshed = await client.get<{ approval: ApprovalShape }>(`/v1/approvals/${approval.id}`);
    expect(refreshed.body.approval.state).toBe("cancelled_by_user");
    expect(refreshed.body.approval.pravaPaymentSessionId).toBeNull();
  });

  it("WHY explains without consuming the approval", async () => {
    const { approval } = await proposedRenewal({ merchantName: "Zoom" });

    const result = await sendInbound(client, handle, "why?");
    expect(result.body.intent).toBe("WHY");
    // The proposal is still live and can still be approved.
    expect(result.body.state).toBe("awaiting_intent");

    await harness.flushOutbox();
    const outbound = await lastOutbound(client);
    expect(outbound?.body).toContain("doing nothing costs");

    const refreshed = await client.get<{ approval: ApprovalShape }>(`/v1/approvals/${approval.id}`);
    expect(refreshed.body.approval.state).toBe("awaiting_intent");
  });

  it("LATER snoozes and closes the approval", async () => {
    await proposedRenewal({ merchantName: "Atlassian" });
    const result = await sendInbound(client, handle, "later");
    expect(result.body.intent).toBe("SNOOZE");
    expect(result.body.state).toBe("cancelled_by_user");
  });

  it("HELP lists the commands without touching state", async () => {
    const { approval } = await proposedRenewal({ merchantName: "Plausible Growth" });
    const result = await sendInbound(client, handle, "help");

    expect(result.body.intent).toBe("HELP");
    await harness.flushOutbox();
    expect((await lastOutbound(client))?.body).toContain("Renewly commands");

    const refreshed = await client.get<{ approval: ApprovalShape }>(`/v1/approvals/${approval.id}`);
    expect(refreshed.body.approval.state).toBe("awaiting_intent");
  });

  it("answers even when nothing is waiting for approval", async () => {
    // A fresh workspace, because approvals parked in awaiting_payment_auth by
    // earlier cases are deliberately not closable by KEEP.
    const quiet = new ApiClient(harness.app);
    const user = await signUpWithChannel(quiet, { email: `quiet-${Date.now()}@example.com` });

    const result = await sendInbound(quiet, user.handle, "APPROVE");

    expect(result.body.approvalId).toBeNull();
    await harness.flushOutbox();
    expect((await lastOutbound(quiet))?.body).toContain("nothing waiting for approval");
  });

  it("ignores a replayed message id", async () => {
    await proposedRenewal({ merchantName: "Linear Basic" });

    const messageId = "sim_replay_1";
    const first = await sendInbound(client, handle, "why", { messageId });
    const second = await sendInbound(client, handle, "why", { messageId });

    expect(first.body.duplicate).toBeUndefined();
    expect(second.body.duplicate).toBe(true);
  });

  it("drops a message from a handle that is not connected", async () => {
    const result = await sendInbound(client, "+15559999999", "APPROVE");
    expect(result.status).toBe(200);
    expect(result.body.ignored).toBe(true);
    expect(result.body.reason).toBe("CHANNEL_NOT_CONNECTED");
  });

  it("records both directions on the thread", async () => {
    const messages = await simulatorMessages(client);
    expect(messages.some((m) => m.direction === "outbound")).toBe(true);
    expect(messages.some((m) => m.direction === "inbound")).toBe(true);
  });
});

describe("kill switch in the thread", () => {
  it("refuses APPROVE and says why, in-thread", async () => {
    const { approval } = await proposedRenewal({ merchantName: "Github Team" });
    await client.post("/v1/settings/kill-switch", { enabled: true });

    const result = await sendInbound(client, handle, "APPROVE");
    expect(result.body.acted).toBe(false);

    await harness.flushOutbox();
    expect((await lastOutbound(client))?.body).toContain("kill switch is on");

    const refreshed = await client.get<{ approval: ApprovalShape }>(`/v1/approvals/${approval.id}`);
    // Still open, so it can be approved once the switch is off.
    expect(refreshed.body.approval.state).toBe("awaiting_intent");

    await client.post("/v1/settings/kill-switch", { enabled: false });
  });
});

describe("expiry", () => {
  it("the worker retires an approval whose window closed", async () => {
    const { approval } = await proposedRenewal({ merchantName: "Notion Plus" });

    // Wind the clock forward by rewriting the expiry directly.
    const { approvalRequests } = await import("../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    await harness.handle.db
      .update(approvalRequests)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(approvalRequests.id, approval.id));

    const expired = await harness.expireApprovals();
    expect(expired).toBeGreaterThanOrEqual(1);

    const refreshed = await client.get<{ approval: ApprovalShape }>(`/v1/approvals/${approval.id}`);
    expect(refreshed.body.approval.state).toBe("expired");
  });

  it("an expired approval cannot then be approved", async () => {
    const { approval } = await proposedRenewal({ merchantName: "Figma Professional" });

    const { approvalRequests } = await import("../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    await harness.handle.db
      .update(approvalRequests)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(approvalRequests.id, approval.id));

    const result = await sendInbound(client, handle, "APPROVE");
    expect(result.body.acted).toBe(false);
    expect(result.body.state).toBe("expired");

    await harness.flushOutbox();
    expect((await lastOutbound(client))?.body).toContain("approval window closed");
  });
});

describe("approvals API", () => {
  it("lists approvals and filters by state", async () => {
    const response = await client.get<{ approvals: ApprovalShape[] }>("/v1/approvals?limit=50");
    expect(response.body.approvals.length).toBeGreaterThan(0);

    const cancelled = await client.get<{ approvals: ApprovalShape[] }>(
      "/v1/approvals?state=cancelled_by_user&limit=50",
    );
    expect(cancelled.body.approvals.every((a) => a.state === "cancelled_by_user")).toBe(true);
  });

  it("does not leak an approval to another workspace", async () => {
    const { approval } = await proposedRenewal({ merchantName: "Cursor Pro" });

    const other = new ApiClient(harness.app);
    await signUpWithChannel(other, { email: `other-${Date.now()}@example.com` });
    expect((await other.get(`/v1/approvals/${approval.id}`)).status).toBe(404);
  });

  it("rejects an intent for an approval with no thread", async () => {
    const subscription = await createSubscription(client, { merchantName: "Penpot" });
    const decision = await client.post<{ decision: { id: string } }>(
      `/v1/subscriptions/${subscription.id}/decisions`,
      { regenerate: true },
    );
    const created = await client.post<{ approval: ApprovalShape }>(
      `/v1/decisions/${decision.body.decision.id}/approvals`,
      { notify: false },
    );

    const response = await client.post(`/v1/approvals/${created.body.approval.id}/intent`, {
      intent: "APPROVE",
    });
    expect(response.status).toBe(409);
    expect(expectErrorCode(response.body)).toBe("CHANNEL_NOT_CONNECTED");
  });
});
