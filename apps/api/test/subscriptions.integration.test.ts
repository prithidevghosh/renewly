import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSubscription, signUp, type SubscriptionShape } from "../src/test/factories.js";
import { ApiClient, createHarness, expectErrorCode, type TestHarness } from "../src/test/helpers.js";

let harness: TestHarness;
let client: ApiClient;

beforeAll(async () => {
  harness = await createHarness();
  client = new ApiClient(harness.app);
  await signUp(client);
});

afterAll(async () => {
  await harness.close();
});

describe("subscriptions CRUD", () => {
  let id: string;

  it("creates a manual subscription that is trusted by default", async () => {
    const subscription = await createSubscription(client);
    id = subscription.id;

    expect(subscription.amount).toBe("20.00");
    expect(subscription.merchantCanonical).toBe("anthropic");
    expect(subscription.annualCost).toBe("240.00");
    expect(subscription.requiresConfirmation).toBe(false);
    expect(subscription.confirmedAt).toBeTruthy();
    expect(subscription.status).toBe("active");
  });

  it("normalises a sloppy amount", async () => {
    const subscription = await createSubscription(client, {
      merchantName: "Linear",
      amount: "8",
    });
    expect(subscription.amount).toBe("8.00");
  });

  it("rejects a non-decimal amount", async () => {
    const response = await client.post("/v1/subscriptions", {
      merchantName: "Bad",
      amount: "$20",
    });
    expect(response.status).toBe(400);
    expect(expectErrorCode(response.body)).toBe("VALIDATION_ERROR");
  });

  it("reads one back", async () => {
    const response = await client.get<{ subscription: SubscriptionShape }>(
      `/v1/subscriptions/${id}`,
    );
    expect(response.status).toBe(200);
    expect(response.body.subscription.id).toBe(id);
  });

  it("404s for an unknown id", async () => {
    const response = await client.get("/v1/subscriptions/sub_does_not_exist");
    expect(response.status).toBe(404);
    expect(expectErrorCode(response.body)).toBe("NOT_FOUND");
  });

  it("lists with pagination", async () => {
    const response = await client.get<{ subscriptions: SubscriptionShape[]; nextCursor: string | null }>(
      "/v1/subscriptions?limit=1",
    );
    expect(response.status).toBe(200);
    expect(response.body.subscriptions).toHaveLength(1);
    expect(response.body.nextCursor).toBeTruthy();

    const next = await client.get<{ subscriptions: SubscriptionShape[] }>(
      `/v1/subscriptions?limit=1&cursor=${response.body.nextCursor}`,
    );
    expect(next.body.subscriptions[0]?.id).not.toBe(response.body.subscriptions[0]?.id);
  });

  it("patches a field", async () => {
    const response = await client.patch<{ subscription: SubscriptionShape }>(
      `/v1/subscriptions/${id}`,
      { usageNote: "Used daily for drafting and review", criticality: "must_keep" },
    );
    expect(response.status).toBe(200);
    expect(response.body.subscription.usageNote).toBe("Used daily for drafting and review");
    expect(response.body.subscription.criticality).toBe("must_keep");
  });

  it("recanonicalises the merchant when the name changes", async () => {
    const subscription = await createSubscription(client, { merchantName: "Vercel Inc." });
    const response = await client.patch<{ subscription: SubscriptionShape }>(
      `/v1/subscriptions/${subscription.id}`,
      { merchantName: "Netlify, LLC" },
    );
    expect(response.body.subscription.merchantCanonical).toBe("netlify");
  });

  it("rejects an empty patch", async () => {
    const response = await client.patch(`/v1/subscriptions/${id}`, {});
    expect(response.status).toBe(400);
  });

  it("deletes", async () => {
    const subscription = await createSubscription(client, { merchantName: "Temporary Tool" });
    const response = await client.delete(`/v1/subscriptions/${subscription.id}`);
    expect(response.status).toBe(200);
    expect((await client.get(`/v1/subscriptions/${subscription.id}`)).status).toBe(404);
  });
});

describe("confirmation gate", () => {
  it("marks a low-confidence subscription as needing confirmation", async () => {
    const subscription = await createSubscription(client, {
      merchantName: "Unknown Vendor",
      amount: "45.00",
      fieldConfidence: { amount: 0.4, merchant_name: 0.5, next_renewal_at: 0.3 },
    });

    expect(subscription.requiresConfirmation).toBe(true);
    expect(subscription.confirmedAt).toBeNull();
    expect(subscription.lowConfidenceFields).toEqual([
      "amount",
      "merchant_name",
      "next_renewal_at",
    ]);
  });

  it("clears the gate on confirm and can correct the values at the same time", async () => {
    const subscription = await createSubscription(client, {
      merchantName: "Guessed Vendor",
      amount: "45.00",
      fieldConfidence: { amount: 0.4, merchant_name: 0.5, next_renewal_at: 0.3 },
    });

    const response = await client.post<{
      subscription: SubscriptionShape & { fieldConfidence: Record<string, number> };
    }>(`/v1/subscriptions/${subscription.id}/confirm`, {
      merchantName: "Figma",
      amount: "45.50",
    });

    expect(response.status).toBe(200);
    expect(response.body.subscription.merchantName).toBe("Figma");
    expect(response.body.subscription.amount).toBe("45.50");
    expect(response.body.subscription.requiresConfirmation).toBe(false);
    expect(response.body.subscription.confirmedAt).toBeTruthy();
    expect(response.body.subscription.fieldConfidence.amount).toBe(1);
  });

  it("refuses to confirm a cancelled subscription", async () => {
    const subscription = await createSubscription(client, { merchantName: "Gone" });
    await client.patch(`/v1/subscriptions/${subscription.id}`, { status: "cancelled" });

    const response = await client.post(`/v1/subscriptions/${subscription.id}/confirm`, {});
    expect(response.status).toBe(409);
    expect(expectErrorCode(response.body)).toBe("CONFLICT");
  });
});

describe("settings", () => {
  it("reads defaults", async () => {
    const response = await client.get<{
      settings: {
        approvalMode: string;
        spendCeiling: string;
        killSwitch: boolean;
        teamSize: number;
        primaryChannel: string;
      };
    }>("/v1/settings");
    expect(response.body.settings.approvalMode).toBe("always_ask");
    expect(response.body.settings.spendCeiling).toBe("50.00");
    // The solo-founder assumption, so a multi-seat invoice can be reasoned about
    // on arrival without asking anyone how many people there are.
    expect(response.body.settings.teamSize).toBe(1);
    expect(response.body.settings.primaryChannel).toBe("imessage");
  });

  it("patches the team size, so the seat rule can be told it is wrong", async () => {
    const response = await client.patch<{ settings: { teamSize: number } }>("/v1/settings", {
      teamSize: 4,
    });

    expect(response.status).toBe(200);
    expect(response.body.settings.teamSize).toBe(4);

    const readBack = await client.get<{ settings: { teamSize: number } }>("/v1/settings");
    expect(readBack.body.settings.teamSize).toBe(4);

    await client.patch("/v1/settings", { teamSize: 1 });
  });

  it("patches budget, ceiling and mode, and bumps the policy version", async () => {
    const before = await client.get<{ settings: { policyVersion: number } }>("/v1/settings");

    const response = await client.patch<{
      settings: {
        aiMonthlyBudget: string | null;
        spendCeiling: string;
        approvalMode: string;
        categoryCeilings: Record<string, string>;
        policyVersion: number;
      };
    }>("/v1/settings", {
      aiMonthlyBudget: "150",
      spendCeiling: "40.5",
      approvalMode: "ask_above_ceiling",
      categoryCeilings: { ai: "80" },
    });

    expect(response.status).toBe(200);
    expect(response.body.settings.aiMonthlyBudget).toBe("150.00");
    expect(response.body.settings.spendCeiling).toBe("40.50");
    expect(response.body.settings.categoryCeilings.ai).toBe("80.00");
    // A policy edit must be detectable by decisions that pinned the old version.
    expect(response.body.settings.policyVersion).toBe(before.body.settings.policyVersion + 1);
  });

  it("clears the budget with an explicit null", async () => {
    const response = await client.patch<{ settings: { aiMonthlyBudget: string | null } }>(
      "/v1/settings",
      { aiMonthlyBudget: null },
    );
    expect(response.body.settings.aiMonthlyBudget).toBeNull();
    await client.patch("/v1/settings", { aiMonthlyBudget: "150.00" });
  });

  it("toggles the kill switch and audits both directions", async () => {
    expect(
      (await client.post<{ settings: { killSwitch: boolean } }>("/v1/settings/kill-switch", {
        enabled: true,
      })).body.settings.killSwitch,
    ).toBe(true);

    expect(
      (await client.post<{ settings: { killSwitch: boolean } }>("/v1/settings/kill-switch", {
        enabled: false,
      })).body.settings.killSwitch,
    ).toBe(false);

    const audit = await client.get<{ events: Array<{ type: string }> }>(
      "/v1/audit?limit=200",
    );
    const types = audit.body.events.map((e) => e.type);
    expect(types).toContain("kill_switch.enabled");
    expect(types).toContain("kill_switch.disabled");
  });

  it("rejects an unknown approval mode", async () => {
    const response = await client.patch("/v1/settings", { approvalMode: "yolo" });
    expect(response.status).toBe(400);
  });
});
