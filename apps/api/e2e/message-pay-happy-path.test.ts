import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixture, lastOutbound, sendInbound, simulatorMessages } from "../src/test/factories.js";
import { ApiClient, createHarness, expectErrorCode, type TestHarness } from "../src/test/helpers.js";

/**
 * The product in one flow: a renewal email arrives, the agent decides, the
 * proposal lands in the user's thread, the user replies APPROVE, Prava issues a
 * one-time credential behind a passkey, the charge settles, and the proof goes
 * back into the same thread.
 *
 * Each step depends on the last, so the assertions run in order in a single
 * describe rather than as independent cases.
 *
 * The subscription is deliberately created with no usage note and no seat
 * activity, because that is all a renewal email actually gives you. The hero
 * demo has to work from the invoice, the policy and the catalog alone.
 */

let harness: TestHarness;
let client: ApiClient;

const state = {
  handle: "+15550100777",
  workspaceId: "",
  subscriptionId: "",
  decisionId: "",
  approvalId: "",
  threadId: "",
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

describe("message to payment, end to end", () => {
  it("1. signs up", async () => {
    const response = await client.post<{
      token: string;
      workspaceId: string;
      verificationRequired: boolean;
      verificationCode: string;
    }>("/v1/auth/signup", {
      email: "founder@northwind.test",
      password: "Sup3rSecret!",
      name: "Ada Founder",
      workspaceName: "Northwind Labs",
    });

    expect(response.status).toBe(201);
    client.setToken(response.body.token);
    state.workspaceId = response.body.workspaceId;

    // A new account is unverified and reaches nothing until the emailed code is
    // entered, so the journey does what a real user does before going on.
    expect(response.body.verificationRequired).toBe(true);
    const verified = await client.post("/v1/auth/verify", {
      email: "founder@northwind.test",
      code: response.body.verificationCode,
    });
    expect(verified.status).toBe(200);
  });

  it("2. connects the simulator channel", async () => {
    const response = await client.post<{ channel: { channel: string; status: string } }>(
      "/v1/channels/connect",
      { channel: "simulator", externalId: state.handle },
    );

    expect(response.status).toBe(201);
    expect(response.body.channel.status).toBe("active");
  });

  it("3. sets a ceiling, a budget and always_ask", async () => {
    const response = await client.patch<{
      settings: { spendCeiling: string; approvalMode: string; primaryChannel: string };
    }>("/v1/settings", {
      aiMonthlyBudget: "200.00",
      spendCeiling: "50.00",
      approvalMode: "always_ask",
      primaryChannel: "simulator",
    });

    expect(response.status).toBe(200);
    expect(response.body.settings.spendCeiling).toBe("50.00");
    expect(response.body.settings.primaryChannel).toBe("simulator");
  });

  it("4. takes in the renewal email and gets a parsed draft", async () => {
    const response = await client.post<{
      renewalEvent: { parserUsed: string };
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
    expect(response.body.draft.nextRenewalAt).toContain("2026-08-12");
    // No LLM key in tests, so the heuristic path must have produced this.
    expect(response.body.renewalEvent.parserUsed).toBe("heuristic");

    const created = await client.post<{
      subscription: { id: string; requiresConfirmation: boolean };
    }>("/v1/subscriptions", {
      merchantName: response.body.draft.merchantName,
      planName: "Claude Pro",
      amount: response.body.draft.amount,
      currency: response.body.draft.currency,
      billingCycle: response.body.draft.billingCycle,
      nextRenewalAt: response.body.draft.nextRenewalAt,
      criticality: "must_keep",
      jobCategory: "ai",
      // No usageNote, no seatsActive: the decision must stand on the invoice.
      sourceType: "email",
      // Deliberately below the 0.7 gate, to prove confirmation is enforced.
      fieldConfidence: { ...response.body.draft.fieldConfidence, next_renewal_at: 0.55 },
    });

    expect(created.body.subscription.requiresConfirmation).toBe(true);
    state.subscriptionId = created.body.subscription.id;
  });

  it("5. confirms the subscription", async () => {
    const response = await client.post<{
      subscription: { requiresConfirmation: boolean; confirmedAt: string };
    }>(`/v1/subscriptions/${state.subscriptionId}/confirm`, {});

    expect(response.status).toBe(200);
    expect(response.body.subscription.requiresConfirmation).toBe(false);
    expect(response.body.subscription.confirmedAt).toBeTruthy();
  });

  it("6. generates a decision and notifies the thread", async () => {
    const response = await client.post<{
      decision: {
        id: string;
        recommendation: string;
        package: {
          counterfactuals: {
            do_nothing: { annual_cost: string };
            recommended: { annual_cost: string; savings_vs_do_nothing: string };
          };
          inputs_used: string[];
          diagnosis: string;
        };
      };
      approval: { id: string; state: string; threadId: string };
      notified: boolean;
    }>(`/v1/subscriptions/${state.subscriptionId}/decisions`, { regenerate: true, notify: true });

    expect(response.status).toBe(201);
    expect(response.body.notified).toBe(true);
    expect(response.body.decision.recommendation).toBe("switch_term");

    const pkg = response.body.decision.package;
    expect(pkg.counterfactuals.do_nothing.annual_cost).toBe("240.00");
    expect(pkg.counterfactuals.recommended.annual_cost).toBe("204.00");
    expect(pkg.counterfactuals.recommended.savings_vs_do_nothing).toBe("36.00");
    expect(pkg.inputs_used).toContain("subscription.criticality=must_keep");

    // The decision must be attributable to the invoice, the policy and the
    // catalog — nothing here came from usage or seat activity.
    expect(pkg.inputs_used.some((i) => i.startsWith("subscription.usage_note"))).toBe(false);
    expect(pkg.inputs_used.some((i) => i.startsWith("subscription.seats_active"))).toBe(false);
    expect(pkg.diagnosis).not.toMatch(/barely|rarely|no recorded use|unused/i);

    state.decisionId = response.body.decision.id;
    state.approvalId = response.body.approval.id;
    state.threadId = response.body.approval.threadId;
    expect(response.body.approval.state).toBe("awaiting_intent");
  });

  it("7. the proposal reaches the thread with the merchant and the amount", async () => {
    await harness.flushOutbox();

    const outbound = await lastOutbound(client);
    expect(outbound).not.toBeNull();
    expect(outbound!.body).toContain("Anthropic");
    // Line one quotes today's price, not the annual switch price.
    expect(outbound!.body).toContain("$20.00/mo");
    expect(outbound!.body).toContain("save 36.00 USD/yr");
    expect(outbound!.body).toContain("Reply APPROVE");
    expect(outbound!.payload.kind).toBe("proposal");
  });

  it("8. the user replies APPROVE and gets a passkey link", async () => {
    const result = await sendInbound(client, state.handle, "APPROVE");

    expect(result.status).toBe(200);
    expect(result.body.intent).toBe("APPROVE");
    expect(result.body.state).toBe("awaiting_payment_auth");
    expect(result.body.acted).toBe(true);

    await harness.flushOutbox();
    const outbound = await lastOutbound(client);
    expect(outbound!.body).toContain("with passkey");
    expect(outbound!.body).toContain("/pay/");
  });

  it("9. pay-bootstrap gives the page what it needs to mount Prava", async () => {
    const approval = await client.get<{
      approval: { pravaPaymentSessionId: string; pravaHostedUrl: string };
    }>(`/v1/approvals/${state.approvalId}`);
    expect(approval.body.approval.pravaPaymentSessionId).toBeTruthy();

    // The link carries a single-use token; the endpoint refuses without it.
    const unauthorized = await client.get(`/v1/approvals/${state.approvalId}/pay-bootstrap`);
    expect(unauthorized.status).toBe(401);

    const messages = await simulatorMessages(client);
    const link = messages
      .map((m) => m.body.match(/\/pay\/[^?]+\?token=([\w-]+)/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .pop();
    expect(link).toBeTruthy();

    const bootstrap = await client.get<{
      sessionId: string;
      hostedUrl: string;
      amount: string;
      merchantName: string;
    }>(`/v1/approvals/${state.approvalId}/pay-bootstrap?token=${link![1]}`);

    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body.sessionId).toBeTruthy();
    expect(bootstrap.body.hostedUrl).toBeTruthy();
    expect(bootstrap.body.amount).toBe("204.00");
    expect(bootstrap.body.merchantName).toBe("Anthropic");
  });

  it("10. completing the payment proves the approval", async () => {
    const response = await client.post<{
      approval: { state: string };
      transactionId: string;
      receiptId: string;
      executed: boolean;
    }>(`/v1/approvals/${state.approvalId}/prava/complete`);

    expect(response.status).toBe(200);
    expect(response.body.approval.state).toBe("proved");
    expect(response.body.executed).toBe(true);
    expect(response.body.transactionId).toBeTruthy();
    expect(response.body.receiptId).toBeTruthy();

    state.transactionId = response.body.transactionId;
    state.receiptId = response.body.receiptId;
  });

  it("11. the proof lands back in the thread", async () => {
    await harness.flushOutbox();

    const outbound = await lastOutbound(client);
    expect(outbound!.body).toContain("Done. Paid");
    expect(outbound!.body).toContain("Anthropic");
    expect(outbound!.body).toContain(state.receiptId);
    expect(outbound!.payload.kind).toBe("proof");
  });

  it("12. the receipt, transaction and audit chain all agree", async () => {
    const receipt = await client.get<{
      receipt: { transactionId: string; payload: Record<string, unknown> };
      transaction: { status: string; amount: string; cardLast4: string };
    }>(`/v1/receipts/${state.receiptId}`);

    expect(receipt.body.receipt.transactionId).toBe(state.transactionId);
    expect(receipt.body.transaction.status).toBe("approved");
    expect(receipt.body.transaction.amount).toBe("204.00");
    expect(receipt.body.transaction.cardLast4).toBe("1111");

    const audit = await client.get<{
      events: Array<{ type: string; entityId: string | null; data: Record<string, unknown> }>;
    }>("/v1/audit?limit=200");

    const chain = audit.body.events.map((e) => e.type);
    for (const expected of [
      "auth.signup",
      "channel.connected",
      "settings.updated",
      "renewal.parsed",
      "subscription.created",
      "subscription.confirmed",
      "decision.generated",
      "approval.created",
      "approval.notified",
      "approval.awaiting_intent",
      "message.outbound",
      "message.inbound",
      "intent.parsed",
      "approval.awaiting_payment_auth",
      "payment.session_created",
      "approval.executing",
      "payment.credentials_received",
      "payment.succeeded",
      "approval.proved",
    ]) {
      expect(chain, expected).toContain(expected);
    }

    // The audit log is the most likely place for a credential to leak.
    expect(JSON.stringify(audit.body)).not.toContain("4111111111111111");
  });

  it("13. the renewal moved on and the identified saving was retired", async () => {
    const subscription = await client.get<{
      subscription: { nextRenewalAt: string };
    }>(`/v1/subscriptions/${state.subscriptionId}`);

    // Paid, so the next charge is a cycle later; otherwise the agent would
    // propose paying the same renewal again.
    expect(subscription.body.subscription.nextRenewalAt).toContain("2026-09-12");

    const identified = await client.get<{ savings: Array<{ subscriptionId: string | null }> }>(
      "/v1/savings?recognition=identified&limit=100",
    );
    expect(identified.body.savings.some((s) => s.subscriptionId === state.subscriptionId)).toBe(
      false,
    );
  });

  it("14. the kill switch stops the next payment", async () => {
    await client.post("/v1/settings/kill-switch", { enabled: true });

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
      approval: { id: string } | null;
    }>(`/v1/subscriptions/${next.body.subscription.id}/decisions`, {
      regenerate: true,
      notify: true,
    });

    // Decisions still generate under the kill switch; only spending stops.
    expect(decision.status).toBe(201);
    expect(decision.body.decision.package.policy_flags).toContain("KILL_SWITCH_ENABLED");

    await harness.flushOutbox();
    const approved = await sendInbound(client, state.handle, "APPROVE");
    expect(approved.body.acted).toBe(false);

    await harness.flushOutbox();
    expect((await lastOutbound(client))!.body).toContain("kill switch is on");

    const blocked = await client.post(`/v1/decisions/${decision.body.decision.id}/pay/session`);
    expect(blocked.status).toBe(409);
    expect(expectErrorCode(blocked.body)).toBe("KILL_SWITCH_ENABLED");
  });
});
