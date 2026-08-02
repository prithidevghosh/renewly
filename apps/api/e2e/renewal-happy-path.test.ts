import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixture } from "../src/test/factories.js";
import { ApiClient, createHarness, expectErrorCode, type TestHarness } from "../src/test/helpers.js";
import { verificationCodeFor } from "../src/test/factories.js";

/**
 * The whole product in one flow: a renewal email arrives, the user confirms what
 * was parsed, the agent decides, Prava issues a one-time credential, the charge
 * settles, and the receipt and audit trail prove it happened. Then the kill
 * switch is pulled and the next payment is refused.
 *
 * Each step depends on the last, so the assertions run in order in a single
 * describe rather than as independent cases.
 */

let harness: TestHarness;
let client: ApiClient;

const state = {
  token: "",
  workspaceId: "",
  subscriptionId: "",
  decisionId: "",
  paymentSessionId: "",
  pravaSessionId: "",
  transactionId: "",
  receiptId: "",
};

beforeAll(async () => {
  harness = await createHarness();
  client = new ApiClient(harness.app);
});

afterAll(async () => {
  await harness.close();
});

describe("renewal happy path", () => {
  it("1. signs up", async () => {
    const response = await client.post<{
      token: string;
      workspaceId: string;
      user: { email: string };
    }>("/v1/auth/signup", {
      email: "founder@northwind.test",
      password: "Sup3rSecret!",
      name: "Ada Founder",
      workspaceName: "Northwind Labs",
    });

    expect(response.status).toBe(201);
    state.token = response.body.token;
    state.workspaceId = response.body.workspaceId;
    client.setToken(state.token);

    // Unverified accounts reach nothing; enter the emailed code first.
    const verified = await client.post("/v1/auth/verify", {
      email: "founder@northwind.test",
      // The code is never in the response; it is read from the captured mail.
      code: verificationCodeFor("founder@northwind.test"),
    });
    expect(verified.status).toBe(200);

    const me = await client.get<{ workspace: { name: string } }>("/v1/me");
    expect(me.body.workspace.name).toBe("Northwind Labs");
  });

  it("2. sets a budget, ceiling and approval mode", async () => {
    const response = await client.patch<{
      settings: { aiMonthlyBudget: string; spendCeiling: string; approvalMode: string };
    }>("/v1/settings", {
      aiMonthlyBudget: "200.00",
      spendCeiling: "50.00",
      approvalMode: "ask_above_ceiling",
      categoryCeilings: { ai: "100.00" },
    });

    expect(response.status).toBe(200);
    expect(response.body.settings.aiMonthlyBudget).toBe("200.00");
    expect(response.body.settings.approvalMode).toBe("ask_above_ceiling");
  });

  it("3. pastes the renewal email and gets a parsed draft", async () => {
    const response = await client.post<{
      renewalEvent: { id: string; parserUsed: string };
      draft: {
        merchantName: string;
        amount: string;
        currency: string;
        billingCycle: string;
        nextRenewalAt: string;
        fieldConfidence: Record<string, number>;
      };
    }>("/v1/intake/email", { text: fixture("emails/claude-pro-renewal.txt") });

    expect(response.status).toBe(201);
    expect(response.body.draft.merchantName).toBe("Anthropic");
    expect(response.body.draft.amount).toBe("20.00");
    expect(response.body.draft.billingCycle).toBe("monthly");
    expect(response.body.draft.nextRenewalAt).toContain("2026-08-12");

    // Create the subscription from the draft, carrying the parser's confidence
    // through so the payment gate can do its job.
    const created = await client.post<{
      subscription: { id: string; requiresConfirmation: boolean; confirmedAt: string | null };
    }>("/v1/subscriptions", {
      merchantName: response.body.draft.merchantName,
      planName: "Claude Pro",
      amount: response.body.draft.amount,
      currency: response.body.draft.currency,
      billingCycle: response.body.draft.billingCycle,
      nextRenewalAt: response.body.draft.nextRenewalAt,
      criticality: "must_keep",
      jobCategory: "ai",
      usageNote: "Used daily for drafting and code review.",
      sourceType: "email",
      // Deliberately below the 0.7 gate to prove confirmation is enforced.
      fieldConfidence: { ...response.body.draft.fieldConfidence, next_renewal_at: 0.55 },
    });

    expect(created.status).toBe(201);
    expect(created.body.subscription.requiresConfirmation).toBe(true);
    expect(created.body.subscription.confirmedAt).toBeNull();
    state.subscriptionId = created.body.subscription.id;
  });

  it("4. cannot pay before confirming, then confirms", async () => {
    const decision = await client.post<{ decision: { id: string } }>(
      `/v1/subscriptions/${state.subscriptionId}/decisions`,
    );
    expect(decision.status).toBe(201);

    const blocked = await client.post(`/v1/decisions/${decision.body.decision.id}/pay/session`);
    expect(blocked.status).toBe(409);
    expect(expectErrorCode(blocked.body)).toBe("CONFIRMATION_REQUIRED");

    const confirmed = await client.post<{
      subscription: { requiresConfirmation: boolean; confirmedAt: string };
    }>(`/v1/subscriptions/${state.subscriptionId}/confirm`, {});

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.subscription.requiresConfirmation).toBe(false);
    expect(confirmed.body.subscription.confirmedAt).toBeTruthy();
  });

  it("5. generates a decision package with counterfactuals", async () => {
    const response = await client.post<{
      decision: {
        id: string;
        recommendation: string;
        confidence: number;
        package: {
          amount_due: string;
          counterfactuals: {
            do_nothing: { annual_cost: string };
            recommended: { annual_cost: string; savings_vs_do_nothing: string };
          };
          inputs_used: string[];
          alternatives: Array<{ name: string; annual_cost: string }>;
          headline: string;
          narrative: string;
        };
      };
    }>(`/v1/subscriptions/${state.subscriptionId}/decisions`, { regenerate: true });

    expect(response.status).toBe(201);
    state.decisionId = response.body.decision.id;

    const pkg = response.body.decision.package;
    // Claude Pro has a cheaper annual term, so the engine proposes switching it.
    expect(response.body.decision.recommendation).toBe("switch_term");
    expect(pkg.counterfactuals.do_nothing.annual_cost).toBe("240.00");
    expect(pkg.counterfactuals.recommended.annual_cost).toBe("204.00");
    expect(pkg.counterfactuals.recommended.savings_vs_do_nothing).toBe("36.00");
    expect(pkg.amount_due).toBe("204.00");
    expect(pkg.inputs_used).toContain("subscription.criticality=must_keep");
    expect(pkg.inputs_used).toContain("policy.ai_monthly_budget=200.00");
    expect(pkg.alternatives.length).toBeGreaterThan(0);
    expect(pkg.headline).toBeTruthy();
    expect(pkg.narrative).toBeTruthy();
  });

  it("6. opens a Prava payment session", async () => {
    const response = await client.post<{
      paymentSession: { id: string; status: string; amount: string; pravaSessionId: string };
      sessionToken: string;
      iframeUrl: string;
    }>(`/v1/decisions/${state.decisionId}/pay/session`);

    expect(response.status).toBe(201);
    expect(response.body.paymentSession.status).toBe("awaiting_collection");
    expect(response.body.paymentSession.amount).toBe("204.00");
    expect(response.body.sessionToken).toBeTruthy();
    expect(response.body.iframeUrl).toBeTruthy();

    state.paymentSessionId = response.body.paymentSession.id;
    state.pravaSessionId = response.body.paymentSession.pravaSessionId;
  });

  it("7. completes the payment", async () => {
    const response = await client.post<{
      paymentSession: { status: string };
      transaction: { id: string; status: string; amount: string; cardLast4: string };
      receiptId: string;
    }>(`/v1/decisions/${state.decisionId}/pay/complete`);

    expect(response.status).toBe(200);
    expect(response.body.paymentSession.status).toBe("completed");
    expect(response.body.transaction.status).toBe("approved");
    expect(response.body.transaction.amount).toBe("204.00");
    expect(response.body.transaction.cardLast4).toBe("1111");

    state.transactionId = response.body.transaction.id;
    state.receiptId = response.body.receiptId;

    expect(harness.prava.inspect(state.pravaSessionId)?.reported).toBe("APPROVED");
  });

  it("8. proves it: receipt, transaction and an unbroken audit chain", async () => {
    const receipt = await client.get<{
      receipt: { transactionId: string; payload: Record<string, unknown> };
      transaction: { id: string; status: string };
    }>(`/v1/receipts/${state.receiptId}`);

    expect(receipt.status).toBe(200);
    expect(receipt.body.receipt.transactionId).toBe(state.transactionId);
    expect(receipt.body.transaction.status).toBe("approved");
    expect(receipt.body.receipt.payload.amount).toBe("204.00");
    expect(receipt.body.receipt.payload.merchant).toBe("Anthropic");

    const list = await client.get<{ receipts: Array<{ id: string }> }>("/v1/receipts");
    expect(list.body.receipts.map((r) => r.id)).toContain(state.receiptId);

    const audit = await client.get<{
      events: Array<{ type: string; entityId: string | null; data: Record<string, unknown> }>;
    }>("/v1/audit?limit=200");

    const chain = audit.body.events.map((e) => e.type);
    for (const expected of [
      "auth.signup",
      "settings.updated",
      "renewal.parsed",
      "subscription.created",
      "subscription.confirmed",
      "decision.generated",
      "payment.session_created",
      "payment.credentials_received",
      "payment.succeeded",
    ]) {
      expect(chain).toContain(expected);
    }

    const succeeded = audit.body.events.find((e) => e.type === "payment.succeeded");
    expect(succeeded?.entityId).toBe(state.transactionId);
    expect(succeeded?.data.amount).toBe("204.00");
    expect(succeeded?.data.cardLast4).toBe("1111");

    // The audit log is the one place most likely to leak a credential.
    expect(JSON.stringify(audit.body)).not.toContain("4111111111111111");
  });

  it("9. enables the kill switch", async () => {
    const response = await client.post<{ settings: { killSwitch: boolean } }>(
      "/v1/settings/kill-switch",
      { enabled: true },
    );
    expect(response.status).toBe(200);
    expect(response.body.settings.killSwitch).toBe(true);
  });

  it("10. refuses the next payment while the kill switch is on", async () => {
    const next = await client.post<{ subscription: { id: string } }>("/v1/subscriptions", {
      merchantName: "Figma",
      planName: "Professional",
      amount: "45.00",
      billingCycle: "monthly",
      criticality: "must_keep",
      usageNote: "Used daily by the design team.",
    });

    const decision = await client.post<{
      decision: { id: string; package: { policy_flags: string[] } };
    }>(`/v1/subscriptions/${next.body.subscription.id}/decisions`);

    // Decisions still generate under the kill switch; only spending stops.
    expect(decision.status).toBe(201);
    expect(decision.body.decision.package.policy_flags).toContain("KILL_SWITCH_ENABLED");

    const blocked = await client.post(`/v1/decisions/${decision.body.decision.id}/pay/session`);
    expect(blocked.status).toBe(409);
    expect(expectErrorCode(blocked.body)).toBe("KILL_SWITCH_ENABLED");

    const savings = await client.get<{ totalSaved: string }>("/v1/savings/summary");
    expect(savings.status).toBe(200);
  });
});
