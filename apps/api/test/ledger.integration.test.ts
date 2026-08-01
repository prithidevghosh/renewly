import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDecision, createSubscription, signUp } from "../src/test/factories.js";
import { ApiClient, createHarness, expectErrorCode, type TestHarness } from "../src/test/helpers.js";

let harness: TestHarness;
let client: ApiClient;

interface CancelPlanResponse {
  plan: {
    subscriptionId: string;
    status: string;
    merchantName: string;
    portalUrl: string | null;
    portalUrlVerified: boolean;
    projectedAnnualSaving: string;
    currency: string;
    checklist: Array<{ step: number; label: string; detail: string }>;
    disclaimer: string;
  };
  subscription: { status: string };
}

interface ConfirmResponse {
  subscription: { status: string; cancelledAt: string | null };
  savingsEntryId: string;
  amountSaved: string;
}

/** A subscription whose engine outcome is cancel. */
async function cancellable(overrides: Record<string, unknown> = {}) {
  const subscription = await createSubscription(client, {
    merchantName: "Midjourney",
    amount: "30.00",
    criticality: "experimental",
    usageNote: "Unused for 90 days.",
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

describe("cancel orchestration", () => {
  it("returns an honest checklist rather than claiming to have cancelled", async () => {
    const { subscription, decision } = await cancellable();

    const response = await client.post<CancelPlanResponse>(
      `/v1/decisions/${decision.id}/cancel/start`,
    );

    expect(response.status).toBe(201);
    expect(response.body.plan.status).toBe("pending_user_confirmation");
    expect(response.body.plan.subscriptionId).toBe(subscription.id);
    expect(response.body.plan.checklist.length).toBeGreaterThan(3);
    expect(response.body.plan.disclaimer).toMatch(/cannot cancel this subscription on your behalf/i);
    // The subscription is parked, not cancelled: the user has not done it yet.
    expect(response.body.subscription.status).toBe("pending_cancel");
  });

  it("gives a verified portal URL for a merchant we know", async () => {
    const { decision } = await cancellable({ merchantName: "Anthropic" });
    const response = await client.post<CancelPlanResponse>(
      `/v1/decisions/${decision.id}/cancel/start`,
    );

    expect(response.body.plan.portalUrl).toBe("https://claude.ai/settings/billing");
    expect(response.body.plan.portalUrlVerified).toBe(true);
  });

  it("says so when it has no portal URL rather than guessing one", async () => {
    const { decision } = await cancellable({ merchantName: "Obscure Vendor Ltd" });
    const response = await client.post<CancelPlanResponse>(
      `/v1/decisions/${decision.id}/cancel/start`,
    );

    expect(response.body.plan.portalUrl).toBeNull();
    expect(response.body.plan.portalUrlVerified).toBe(false);
    expect(response.body.plan.checklist[0]!.detail).toMatch(/Sign in to Obscure Vendor/);
  });

  it("surfaces the cancel-by deadline at the top of the checklist", async () => {
    const { decision } = await cancellable({
      merchantName: "Deadline Co",
      cancelByAt: "2026-09-01T00:00:00.000Z",
    });
    const response = await client.post<CancelPlanResponse>(
      `/v1/decisions/${decision.id}/cancel/start`,
    );

    expect(response.body.plan.checklist.some((i) => i.label === "Mind the deadline")).toBe(true);
  });

  it("only writes to the ledger once the user attests it is done", async () => {
    const { subscription, decision } = await cancellable({ merchantName: "Attest Co" });

    const before = await client.get<{ realizedTotal: string; realizedCount: number }>(
      "/v1/savings/summary",
    );
    await client.post(`/v1/decisions/${decision.id}/cancel/start`);

    const stillNothing = await client.get<{ realizedTotal: string }>("/v1/savings/summary");
    // Starting a cancellation banks nothing: the user has not done it yet.
    expect(stillNothing.body.realizedTotal).toBe(before.body.realizedTotal);

    const confirm = await client.post<ConfirmResponse>(
      `/v1/decisions/${decision.id}/cancel/confirm`,
      { note: "Cancelled in the billing portal on 30 July" },
    );

    expect(confirm.status).toBe(200);
    expect(confirm.body.subscription.status).toBe("cancelled");
    expect(confirm.body.subscription.cancelledAt).toBeTruthy();
    // 30.00 a month cancelled is 360.00 a year saved.
    expect(confirm.body.amountSaved).toBe("360.00");
    expect(confirm.body.savingsEntryId).toMatch(/^sav_/);

    const after = await client.get<{ realizedTotal: string; realizedCount: number }>(
      "/v1/savings/summary",
    );
    expect(Number(after.body.realizedTotal)).toBeCloseTo(
      Number(before.body.realizedTotal) + 360,
      2,
    );
    expect(after.body.realizedCount).toBe(before.body.realizedCount + 1);
    expect(subscription.id).toBeTruthy();
  });

  it("accepts a corrected saving when the user negotiated instead", async () => {
    const { decision } = await cancellable({ merchantName: "Negotiated Co" });
    await client.post(`/v1/decisions/${decision.id}/cancel/start`);

    const confirm = await client.post<ConfirmResponse>(
      `/v1/decisions/${decision.id}/cancel/confirm`,
      { actualAnnualSaving: "120.00", note: "Talked them down instead of cancelling" },
    );

    expect(confirm.body.amountSaved).toBe("120.00");
  });

  it("is blocked by the kill switch", async () => {
    const { decision } = await cancellable({ merchantName: "Killswitch Cancel Co" });
    await client.post("/v1/settings/kill-switch", { enabled: true });

    const response = await client.post(`/v1/decisions/${decision.id}/cancel/start`);
    await client.post("/v1/settings/kill-switch", { enabled: false });

    expect(response.status).toBe(409);
    expect(expectErrorCode(response.body)).toBe("KILL_SWITCH_ENABLED");
  });

  it("refuses to cancel twice", async () => {
    const { decision } = await cancellable({ merchantName: "Double Cancel Co" });
    await client.post(`/v1/decisions/${decision.id}/cancel/start`);
    await client.post(`/v1/decisions/${decision.id}/cancel/confirm`, {});

    const again = await client.post(`/v1/decisions/${decision.id}/cancel/confirm`, {});
    expect(again.status).toBe(409);
    expect(expectErrorCode(again.body)).toBe("INVALID_DECISION_STATE");
  });

  it("writes cancel.started, cancel.confirmed and savings.recorded", async () => {
    const audit = await client.get<{ events: Array<{ type: string; data: Record<string, unknown> }> }>(
      "/v1/audit?limit=200",
    );
    const types = audit.body.events.map((e) => e.type);

    expect(types).toContain("cancel.started");
    expect(types).toContain("cancel.confirmed");
    expect(types).toContain("savings.recorded");
    expect(types).toContain("subscription.cancelled");

    const started = audit.body.events.find((e) => e.type === "cancel.started");
    // The audit must record that no automation ran.
    expect(started?.data.automated).toBe(false);

    const confirmed = audit.body.events.find((e) => e.type === "cancel.confirmed");
    expect(confirmed?.data.attestedByUser).toBe(true);
  });
});

describe("savings ledger", () => {
  it("lists entries newest first with pagination", async () => {
    const response = await client.get<{
      savings: Array<{ id: string; actionType: string; recognition: string; amountSaved: string }>;
      nextCursor: string | null;
    }>("/v1/savings?limit=2");

    expect(response.status).toBe(200);
    expect(response.body.savings.length).toBeLessThanOrEqual(2);
    expect(response.body.savings[0]!.id > (response.body.savings[1]?.id ?? "")).toBe(true);
  });

  it("reports identified and realized separately, never summed", async () => {
    const response = await client.get<{
      identifiedTotal: string;
      realizedTotal: string;
      currency: string;
      identifiedCount: number;
      realizedCount: number;
      byActionType: Record<string, string>;
      ignoredCurrencies: string[];
    }>("/v1/savings/summary");

    expect(response.status).toBe(200);
    expect(response.body.currency).toBe("USD");
    expect(Number(response.body.realizedTotal)).toBeGreaterThan(0);
    expect(Number(response.body.byActionType.cancel)).toBeGreaterThan(0);
    // byActionType covers realized money only.
    expect(response.body.byActionType.switch_vendor).toBe("0.00");
    expect(response.body.ignoredCurrencies).toEqual([]);
  });

  it("records an identified estimate when a decision finds a saving", async () => {
    const { decision } = await cancellable({ merchantName: "Identified Only Co" });
    expect(decision.id).toBeTruthy();

    const identified = await client.get<{ savings: Array<{ recognition: string }> }>(
      "/v1/savings?recognition=identified&limit=50",
    );
    expect(identified.body.savings.length).toBeGreaterThan(0);
    expect(identified.body.savings.every((s) => s.recognition === "identified")).toBe(true);
  });

  it("retires the identified estimate once the saving is realized", async () => {
    const { subscription, decision } = await cancellable({ merchantName: "Retire Estimate Co" });

    const before = await client.get<{ savings: Array<{ subscriptionId: string | null }> }>(
      "/v1/savings?recognition=identified&limit=100",
    );
    expect(before.body.savings.some((s) => s.subscriptionId === subscription.id)).toBe(true);

    await client.post(`/v1/decisions/${decision.id}/cancel/start`);
    await client.post(`/v1/decisions/${decision.id}/cancel/confirm`, {});

    const after = await client.get<{ savings: Array<{ subscriptionId: string | null }> }>(
      "/v1/savings?recognition=identified&limit=100",
    );
    // Otherwise the same saving would be counted twice, once as a claim and
    // once as banked money.
    expect(after.body.savings.some((s) => s.subscriptionId === subscription.id)).toBe(false);
  });

  it("is empty for a fresh workspace", async () => {
    const other = new ApiClient(harness.app);
    await signUp(other);

    const summary = await other.get<{
      identifiedTotal: string;
      realizedTotal: string;
      realizedCount: number;
    }>("/v1/savings/summary");
    expect(summary.body.identifiedTotal).toBe("0.00");
    expect(summary.body.realizedTotal).toBe("0.00");
    expect(summary.body.realizedCount).toBe(0);

    const list = await other.get<{ savings: unknown[] }>("/v1/savings");
    expect(list.body.savings).toHaveLength(0);
  });
});

describe("receipts and audit", () => {
  it("returns an empty receipt list before any payment", async () => {
    const other = new ApiClient(harness.app);
    await signUp(other);
    const response = await other.get<{ receipts: unknown[] }>("/v1/receipts");
    expect(response.body.receipts).toHaveLength(0);
  });

  it("404s an unknown receipt", async () => {
    const response = await client.get("/v1/receipts/rct_nope");
    expect(response.status).toBe(404);
  });

  it("filters the audit log by type", async () => {
    const response = await client.get<{ events: Array<{ type: string }> }>(
      "/v1/audit?type=cancel.confirmed&limit=50",
    );
    expect(response.body.events.length).toBeGreaterThan(0);
    expect(response.body.events.every((e) => e.type === "cancel.confirmed")).toBe(true);
  });

  it("paginates the audit log", async () => {
    const first = await client.get<{ events: Array<{ id: string }>; nextCursor: string | null }>(
      "/v1/audit?limit=3",
    );
    expect(first.body.events).toHaveLength(3);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await client.get<{ events: Array<{ id: string }> }>(
      `/v1/audit?limit=3&cursor=${first.body.nextCursor}`,
    );
    const firstIds = first.body.events.map((e) => e.id);
    expect(second.body.events.every((e) => !firstIds.includes(e.id))).toBe(true);
  });

  it("does not leak audit events across workspaces", async () => {
    const other = new ApiClient(harness.app);
    await signUp(other);
    const response = await other.get<{ events: Array<{ type: string }> }>("/v1/audit?limit=200");
    // A brand new workspace has only its own signup event.
    expect(response.body.events.map((e) => e.type)).toEqual(["auth.signup"]);
  });
});
