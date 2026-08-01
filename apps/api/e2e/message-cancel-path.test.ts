import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSubscription,
  lastOutbound,
  sendInbound,
  signUpWithChannel,
} from "../src/test/factories.js";
import { ApiClient, createHarness, type TestHarness } from "../src/test/helpers.js";

/**
 * The cancellation journey, which saves money without moving any. Renewly
 * cannot cancel a Midjourney plan — there is no API and V1 does not drive
 * billing portals — so the thread asks the user to do it and logs the saving
 * only once they say it is done.
 */

let harness: TestHarness;
let client: ApiClient;
let handle: string;

const state = { subscriptionId: "", decisionId: "", approvalId: "" };

beforeAll(async () => {
  harness = await createHarness();
  client = new ApiClient(harness.app);
  const user = await signUpWithChannel(client, { email: "cancel@northwind.test" });
  handle = user.handle;
});

afterAll(async () => {
  await harness.close();
});

describe("cancel through the thread", () => {
  it("1. a zombie subscription produces a cancel decision", async () => {
    const subscription = await createSubscription(client, {
      merchantName: "Midjourney",
      planName: "Standard",
      amount: "30.00",
      criticality: "experimental",
      jobCategory: "design",
      usageNote: "Unused for 75 days since the rebrand shipped.",
    });
    state.subscriptionId = subscription.id;

    const response = await client.post<{
      decision: { id: string; recommendation: string; package: { amount_due: string } };
      approval: { id: string; state: string; actionType: string; amount: string };
    }>(`/v1/subscriptions/${subscription.id}/decisions`, { regenerate: true, notify: true });

    expect(response.status).toBe(201);
    expect(response.body.decision.recommendation).toBe("cancel");
    // Cancelling moves no money, so there is nothing to charge.
    expect(response.body.decision.package.amount_due).toBe("0.00");
    expect(response.body.approval.actionType).toBe("cancel");
    expect(response.body.approval.amount).toBe("0.00");

    state.decisionId = response.body.decision.id;
    state.approvalId = response.body.approval.id;
  });

  it("2. the thread says plainly that Renewly cannot do this leg", async () => {
    await harness.flushOutbox();

    const outbound = await lastOutbound(client);
    expect(outbound!.body).toContain("Cancel Midjourney");
    expect(outbound!.body).toContain("I cannot do this one for you");
    expect(outbound!.body).toContain("Reply DONE");
  });

  it("3. the checklist points at the real billing page", async () => {
    const response = await client.post<{
      plan: {
        portalUrl: string;
        portalUrlVerified: boolean;
        checklist: Array<{ label: string }>;
        disclaimer: string;
        projectedAnnualSaving: string;
      };
      subscription: { status: string };
    }>(`/v1/approvals/${state.approvalId}/cancel/start`);

    expect(response.status).toBe(201);
    expect(response.body.plan.portalUrl).toBe("https://www.midjourney.com/account");
    expect(response.body.plan.portalUrlVerified).toBe(true);
    expect(response.body.plan.projectedAnnualSaving).toBe("360.00");
    expect(response.body.plan.disclaimer).toMatch(/cannot cancel this subscription on your behalf/i);
    // Parked, not cancelled: the user has not done it yet.
    expect(response.body.subscription.status).toBe("pending_cancel");
  });

  it("4. nothing is banked before the user attests", async () => {
    const summary = await client.get<{ realizedTotal: string; identifiedTotal: string }>(
      "/v1/savings/summary",
    );
    expect(summary.body.realizedTotal).toBe("0.00");
    // The opportunity is claimed, but not banked.
    expect(Number(summary.body.identifiedTotal)).toBeGreaterThan(0);
  });

  it("5. replying DONE in the thread records the saving", async () => {
    const result = await sendInbound(client, handle, "done");

    expect(result.body.intent).toBe("DONE");
    expect(result.body.state).toBe("proved");
    expect(result.body.acted).toBe(true);
  });

  it("6. the proof states the realized savings", async () => {
    await harness.flushOutbox();

    const outbound = await lastOutbound(client);
    expect(outbound!.body).toContain("Done. Cancelled Midjourney.");
    expect(outbound!.body).toContain("Realized savings 360.00 USD/yr");
  });

  it("7. the ledger moves the saving from identified to realized", async () => {
    const summary = await client.get<{
      identifiedTotal: string;
      realizedTotal: string;
      realizedCount: number;
      byActionType: Record<string, string>;
    }>("/v1/savings/summary");

    expect(summary.body.realizedTotal).toBe("360.00");
    expect(summary.body.realizedCount).toBe(1);
    expect(summary.body.byActionType.cancel).toBe("360.00");
    // Not double counted as both a claim and banked money.
    expect(summary.body.identifiedTotal).toBe("0.00");
  });

  it("8. the subscription is cancelled and no money moved", async () => {
    const subscription = await client.get<{
      subscription: { status: string; cancelledAt: string | null };
    }>(`/v1/subscriptions/${state.subscriptionId}`);

    expect(subscription.body.subscription.status).toBe("cancelled");
    expect(subscription.body.subscription.cancelledAt).toBeTruthy();

    const receipts = await client.get<{ receipts: unknown[] }>("/v1/receipts");
    expect(receipts.body.receipts).toHaveLength(0);
  });

  it("9. the audit records that no automation ran", async () => {
    const audit = await client.get<{
      events: Array<{ type: string; data: Record<string, unknown> }>;
    }>("/v1/audit?limit=200");

    const types = audit.body.events.map((e) => e.type);
    expect(types).toContain("cancel.confirmed");
    expect(types).toContain("savings.recorded");
    expect(types).toContain("approval.proved");

    const confirmed = audit.body.events.find((e) => e.type === "cancel.confirmed");
    expect(confirmed?.data.attestedByUser).toBe(true);
  });
});

describe("rightsize through the thread", () => {
  it("proposes dropping idle seats and banks the saving on DONE", async () => {
    const subscription = await createSubscription(client, {
      merchantName: "Figma",
      planName: "Professional",
      amount: "75.00",
      seatsTotal: 5,
      seatsActive: 2,
      criticality: "must_keep",
      jobCategory: "design",
      usageNote: "Two designers use it daily.",
    });

    const decision = await client.post<{
      decision: { id: string; recommendation: string; package: { seats_target: number } };
      approval: { id: string; actionType: string };
    }>(`/v1/subscriptions/${subscription.id}/decisions`, { regenerate: true, notify: true });

    expect(decision.body.decision.recommendation).toBe("rightsize_seats");
    expect(decision.body.decision.package.seats_target).toBe(2);

    await harness.flushOutbox();
    expect((await lastOutbound(client))!.body).toContain("Reduce the seats on Figma");

    const result = await sendInbound(client, handle, "done");
    expect(result.body.state).toBe("proved");

    const updated = await client.get<{
      subscription: { seatsTotal: number; amount: string; status: string };
    }>(`/v1/subscriptions/${subscription.id}`);

    // The plan really is smaller now, or the next decision would re-propose it.
    expect(updated.body.subscription.seatsTotal).toBe(2);
    expect(updated.body.subscription.amount).toBe("30.00");
    expect(updated.body.subscription.status).toBe("active");

    const summary = await client.get<{ byActionType: Record<string, string> }>(
      "/v1/savings/summary",
    );
    expect(Number(summary.body.byActionType.rightsize)).toBeGreaterThan(0);
  });
});
