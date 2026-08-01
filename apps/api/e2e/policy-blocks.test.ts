import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDecisionAndNotify,
  createSubscription,
  lastOutbound,
  sendInbound,
  signUpWithChannel,
  type ApprovalShape,
} from "../src/test/factories.js";
import { ApiClient, createHarness, expectErrorCode, type TestHarness } from "../src/test/helpers.js";

/**
 * Every way the agent is stopped from spending, driven through the thread the
 * user actually reads. A block that is silent is indistinguishable from a bug,
 * so each one must also produce a message saying what happened.
 */

let harness: TestHarness;

/** A fresh workspace per case, so one blocked proposal cannot mask another. */
async function freshWorkspace(email: string) {
  const client = new ApiClient(harness.app);
  const user = await signUpWithChannel(client, { email });
  return { client, handle: user.handle };
}

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

describe("kill switch", () => {
  it("blocks APPROVE and says so in-thread, leaving the proposal open", async () => {
    const { client, handle } = await freshWorkspace(`ks-${Date.now()}@test.com`);

    const subscription = await createSubscription(client, {
      merchantName: "Penpot",
      criticality: "must_keep",
      usageNote: "Used daily.",
    });
    const { approval } = await createDecisionAndNotify(client, subscription.id);
    await harness.flushOutbox();

    await client.post("/v1/settings/kill-switch", { enabled: true });

    const result = await sendInbound(client, handle, "APPROVE");
    expect(result.body.acted).toBe(false);

    await harness.flushOutbox();
    expect((await lastOutbound(client))!.body).toContain("kill switch is on");

    const refreshed = await client.get<{ approval: ApprovalShape }>(`/v1/approvals/${approval.id}`);
    // Still approvable once the switch is off, rather than burned.
    expect(refreshed.body.approval.state).toBe("awaiting_intent");
    expect(refreshed.body.approval.pravaPaymentSessionId).toBeNull();

    const audit = await client.get<{ events: Array<{ type: string; data: Record<string, unknown> }> }>(
      "/v1/audit?type=payment.blocked&limit=10",
    );
    expect(audit.body.events[0]?.data.reason).toBe("KILL_SWITCH_ENABLED");
  });

  it("allows the same APPROVE once the switch is off", async () => {
    const { client, handle } = await freshWorkspace(`ks2-${Date.now()}@test.com`);

    const subscription = await createSubscription(client, {
      merchantName: "Penpot",
      criticality: "must_keep",
      usageNote: "Used daily.",
    });
    await createDecisionAndNotify(client, subscription.id);
    await harness.flushOutbox();

    await client.post("/v1/settings/kill-switch", { enabled: true });
    await sendInbound(client, handle, "APPROVE", { messageId: "ks_blocked" });

    await client.post("/v1/settings/kill-switch", { enabled: false });
    const allowed = await sendInbound(client, handle, "APPROVE", { messageId: "ks_allowed" });

    expect(allowed.body.acted).toBe(true);
    expect(allowed.body.state).toBe("awaiting_payment_auth");
  });
});

describe("spend ceiling", () => {
  it("auto_within_envelope refuses an above-ceiling charge and explains it", async () => {
    const { client, handle } = await freshWorkspace(`ceil-${Date.now()}@test.com`);

    await client.patch("/v1/settings", {
      approvalMode: "auto_within_envelope",
      spendCeiling: "25.00",
    });

    const subscription = await createSubscription(client, {
      merchantName: "Penpot",
      amount: "99.00",
      criticality: "must_keep",
      usageNote: "Used daily.",
    });
    const { decision } = await createDecisionAndNotify(client, subscription.id);
    await harness.flushOutbox();

    const result = await sendInbound(client, handle, "APPROVE");
    expect(result.body.acted).toBe(false);
    expect(result.body.state).toBe("failed");

    await harness.flushOutbox();
    expect((await lastOutbound(client))!.body).toContain("needs your explicit approval");

    // The direct route reports the same refusal with the numbers attached.
    const direct = await client.post(`/v1/decisions/${decision.id}/pay/session`);
    expect(direct.status).toBe(409);
    expect(expectErrorCode(direct.body)).toBe("APPROVAL_REQUIRED");
    const details = (direct.body as { error: { details: Record<string, string> } }).error.details;
    expect(details.ceiling).toBe("25.00");
  });

  it("ask_above_ceiling permits the same charge, because the user was asked", async () => {
    const { client, handle } = await freshWorkspace(`ceil2-${Date.now()}@test.com`);

    await client.patch("/v1/settings", {
      approvalMode: "ask_above_ceiling",
      spendCeiling: "25.00",
    });

    const subscription = await createSubscription(client, {
      merchantName: "Penpot",
      amount: "99.00",
      criticality: "must_keep",
      usageNote: "Used daily.",
    });
    await createDecisionAndNotify(client, subscription.id);
    await harness.flushOutbox();

    const result = await sendInbound(client, handle, "APPROVE");
    expect(result.body.acted).toBe(true);
    expect(result.body.state).toBe("awaiting_payment_auth");
  });
});

describe("unconfirmed parse", () => {
  it("refuses to pay a low-confidence renewal until it is confirmed", async () => {
    const { client, handle } = await freshWorkspace(`conf-${Date.now()}@test.com`);

    const subscription = await createSubscription(client, {
      merchantName: "Penpot",
      amount: "22.00",
      criticality: "must_keep",
      usageNote: "Used daily.",
      fieldConfidence: { amount: 0.35, merchant_name: 0.4, next_renewal_at: 0.3 },
    });
    expect(subscription.requiresConfirmation).toBe(true);

    const { decision, approval } = await createDecisionAndNotify(client, subscription.id);
    await harness.flushOutbox();

    const blocked = await sendInbound(client, handle, "APPROVE", { messageId: "conf_1" });
    expect(blocked.body.acted).toBe(false);

    await harness.flushOutbox();
    expect((await lastOutbound(client))!.body).toContain("need confirming first");

    const direct = await client.post(`/v1/decisions/${decision.id}/pay/session`);
    expect(direct.status).toBe(409);
    expect(expectErrorCode(direct.body)).toBe("CONFIRMATION_REQUIRED");
    const details = (direct.body as { error: { details: { fields: string[] } } }).error.details;
    expect(details.fields).toContain("amount");

    // Confirming clears the gate; the same decision is then payable.
    await client.post(`/v1/subscriptions/${subscription.id}/confirm`, {});
    const allowed = await client.post(`/v1/decisions/${decision.id}/pay/session`);
    expect(allowed.status).toBe(201);
    expect(approval.id).toBeTruthy();
  });
});

describe("decision state", () => {
  it("refuses to pay an attested action through the pay route", async () => {
    const { client } = await freshWorkspace(`att-${Date.now()}@test.com`);

    const subscription = await createSubscription(client, {
      merchantName: "Midjourney",
      amount: "30.00",
      criticality: "experimental",
      usageNote: "Unused for 120 days.",
    });
    const { decision } = await createDecisionAndNotify(client, subscription.id);
    expect(decision.recommendation).toBe("cancel");

    const response = await client.post(`/v1/decisions/${decision.id}/pay/session`);
    expect(response.status).toBe(409);
    expect(expectErrorCode(response.body)).toBe("INVALID_DECISION_STATE");
  });

  it("refuses a superseded decision", async () => {
    const { client } = await freshWorkspace(`sup-${Date.now()}@test.com`);

    const subscription = await createSubscription(client, {
      merchantName: "Penpot",
      criticality: "must_keep",
      usageNote: "Used daily.",
    });
    const first = await createDecisionAndNotify(client, subscription.id);
    await createDecisionAndNotify(client, subscription.id);

    const response = await client.post(`/v1/decisions/${first.decision.id}/pay/session`);
    expect(response.status).toBe(409);
    expect(expectErrorCode(response.body)).toBe("INVALID_DECISION_STATE");
  });

  it("refuses to pay after the price moved under the decision", async () => {
    const { client } = await freshWorkspace(`price-${Date.now()}@test.com`);

    const subscription = await createSubscription(client, {
      merchantName: "Penpot",
      amount: "20.00",
      criticality: "must_keep",
      usageNote: "Used daily.",
    });
    const { decision } = await createDecisionAndNotify(client, subscription.id);

    // The merchant raised the price after the package was built.
    await client.patch(`/v1/subscriptions/${subscription.id}`, { amount: "35.00" });

    const response = await client.post(`/v1/decisions/${decision.id}/pay/session`);
    expect(response.status).toBe(409);
    expect(expectErrorCode(response.body)).toBe("INVALID_DECISION_STATE");
    const details = (response.body as { error: { details: Record<string, string> } }).error.details;
    expect(details.currentPrice).toBe("35.00");
  });
});

describe("policy simulation", () => {
  it("answers what would change without executing anything", async () => {
    const { client } = await freshWorkspace(`sim-${Date.now()}@test.com`);

    await client.patch("/v1/settings", {
      approvalMode: "always_ask",
      spendCeiling: "50.00",
    });

    const cheap = await createSubscription(client, {
      merchantName: "Penpot",
      amount: "20.00",
      criticality: "must_keep",
      usageNote: "Used daily.",
    });
    const dear = await createSubscription(client, {
      merchantName: "Netlify Pro",
      amount: "99.00",
      criticality: "must_keep",
      usageNote: "Used daily.",
    });
    await createDecisionAndNotify(client, cheap.id);
    await createDecisionAndNotify(client, dear.id);

    const asIs = await client.post<{ counts: { auto: number; ask: number; blocked: number } }>(
      "/v1/settings/simulate",
      {},
    );
    // always_ask means nothing is automatic.
    expect(asIs.body.counts.auto).toBe(0);
    expect(asIs.body.counts.ask).toBeGreaterThan(0);

    const loosened = await client.post<{
      counts: { auto: number; ask: number; blocked: number };
      decisions: Array<{ merchantName: string; outcome: string; reason: string }>;
    }>("/v1/settings/simulate", { approvalMode: "auto_within_envelope", spendCeiling: "50.00" });

    expect(loosened.body.counts.auto).toBeGreaterThan(0);
    expect(loosened.body.counts.blocked).toBeGreaterThan(0);
    const overCeiling = loosened.body.decisions.find((d) => d.merchantName === "Netlify Pro");
    expect(overCeiling?.outcome).toBe("blocked");
    expect(overCeiling?.reason).toBe("ABOVE_SPEND_CEILING");

    // Simulating must not have changed the stored policy.
    const settings = await client.get<{ settings: { approvalMode: string } }>("/v1/settings");
    expect(settings.body.settings.approvalMode).toBe("always_ask");
  });
});
