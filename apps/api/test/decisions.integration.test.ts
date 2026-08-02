import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDecision, createSubscription, signUp, type DecisionShape } from "../src/test/factories.js";
import { ApiClient, createHarness, expectErrorCode, type TestHarness } from "../src/test/helpers.js";
import { setLlmClient, type DecisionNarrative, type LlmClient } from "../src/lib/llm.js";

let harness: TestHarness;
let client: ApiClient;

beforeAll(async () => {
  harness = await createHarness();
  client = new ApiClient(harness.app);
  await signUp(client);
});

afterAll(async () => {
  setLlmClient(null);
  await harness.close();
});

describe("decision packages", () => {
  it("generates a complete package with counterfactuals and explainability", async () => {
    const subscription = await createSubscription(client, {
      criticality: "must_keep",
      usageNote: "Used daily for drafting.",
    });
    const decision = await createDecision(client, subscription.id);

    // Claude Pro at 20.00/mo has a cheaper annual term, so the engine proposes
    // switching term rather than renewing blind.
    expect(decision.recommendation).toBe("switch_term");
    expect(decision.confidence).toBeGreaterThan(0);
    expect(decision.confidence).toBeLessThanOrEqual(1);

    const pkg = decision.package;
    expect(pkg.counterfactuals.do_nothing.annual_cost).toBe("240.00");
    expect(pkg.counterfactuals.recommended.annual_cost).toBe("204.00");
    expect(pkg.counterfactuals.recommended.savings_vs_do_nothing).toBe("36.00");
    expect(pkg.inputs_used.length).toBeGreaterThan(3);
    expect(pkg.amount_due).toBe("204.00");
    expect(pkg.currency).toBe("USD");
    expect(pkg.term_target).toBe("yearly");
    expect(pkg.diagnosis).toBeTruthy();
    expect(pkg.policy_version).toBeGreaterThanOrEqual(1);
    expect(pkg.headline).toBeTruthy();
    expect(pkg.narrative).toBeTruthy();
    // No LLM key in tests, so the deterministic writer must have produced it.
    expect(pkg.narrative_source).toBe("deterministic");
  });

  it("decides from a bare invoice, with no usage note and no seat activity", async () => {
    // Exactly what a renewal email gives you: a merchant, an amount, a cycle
    // and a date. No question is asked of the user before this decision exists.
    const subscription = await createSubscription(client, {
      merchantName: "Anthropic",
      planName: "Claude Pro",
      amount: "20.00",
      billingCycle: "monthly",
      criticality: "must_keep",
      jobCategory: "ai",
      usageNote: null,
    });
    const decision = await createDecision(client, subscription.id);

    expect(decision.recommendation).toBe("switch_term");
    expect(decision.package.counterfactuals.recommended.savings_vs_do_nothing).toBe("36.00");

    const pkg = decision.package;
    expect(pkg.inputs_used.some((i) => i.startsWith("subscription.usage_note"))).toBe(false);
    expect(pkg.inputs_used.some((i) => i.startsWith("subscription.seats_active"))).toBe(false);
    expect(pkg.diagnosis).not.toMatch(/barely|rarely|no recorded use|unused/i);
  });

  it("proposes rightsizing a multi-seat invoice against the workspace team size", async () => {
    const subscription = await createSubscription(client, {
      merchantName: "Figma Professional",
      amount: "144.00",
      billingCycle: "monthly",
      criticality: "nice_to_have",
      jobCategory: "design",
      seatsTotal: 4,
      usageNote: null,
    });
    const decision = await createDecision(client, subscription.id);

    expect(decision.recommendation).toBe("rightsize_seats");
    // The default solo workspace, not a claim about who logs in.
    expect(decision.package.seats_target).toBe(1);
    expect(decision.package.diagnosis).toContain("bills 4 seats");
    expect(decision.package.diagnosis).not.toMatch(/idle|dead|inactive/i);
    expect(decision.package.inputs_used).toContain("policy.team_size=1");
  });

  it("offers only catalog alternatives, at catalog prices", async () => {
    const subscription = await createSubscription(client, {
      merchantName: "Midjourney Standard",
      amount: "30.00",
      criticality: "experimental",
      jobCategory: "design",
    });
    const decision = await createDecision(client, subscription.id);

    for (const alternative of decision.package.alternatives) {
      expect(alternative.name).toMatch(/Midjourney|Penpot|Figma/);
      expect(alternative.annual_cost).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it("returns the existing package rather than churning a new one", async () => {
    const subscription = await createSubscription(client, { merchantName: "Notion Plus" });
    const first = await createDecision(client, subscription.id);
    const second = await createDecision(client, subscription.id);
    expect(second.id).toBe(first.id);
  });

  it("regenerates on request and supersedes the old package", async () => {
    const subscription = await createSubscription(client, { merchantName: "Linear Basic" });
    const first = await createDecision(client, subscription.id);
    const second = await createDecision(client, subscription.id, { regenerate: true });

    expect(second.id).not.toBe(first.id);

    const old = await client.get<{ decision: DecisionShape }>(`/v1/decisions/${first.id}`);
    expect(old.body.decision.supersededAt).toBeTruthy();
    expect(second.supersededAt).toBeNull();
  });

  it("reflects a settings change on regeneration", async () => {
    const subscription = await createSubscription(client, {
      merchantName: "Midjourney Standard",
      amount: "30.00",
      criticality: "nice_to_have",
      jobCategory: "design",
      usageNote: "Used weekly by the design lead",
    });

    const before = await createDecision(client, subscription.id);
    expect(before.package.policy_flags).not.toContain("CATEGORY_CEILING_EXCEEDED");

    await client.patch("/v1/settings", { categoryCeilings: { design: "10.00" } });
    const after = await createDecision(client, subscription.id, { regenerate: true });

    expect(after.package.policy_flags).toContain("CATEGORY_CEILING_EXCEEDED");
    await client.patch("/v1/settings", { categoryCeilings: {} });
  });

  it("still generates a decision when the kill switch is on, flagged accordingly", async () => {
    const subscription = await createSubscription(client, { merchantName: "Slack Pro" });
    await client.post("/v1/settings/kill-switch", { enabled: true });

    const decision = await createDecision(client, subscription.id, { regenerate: true });
    expect(decision.package.policy_flags).toContain("KILL_SWITCH_ENABLED");

    await client.post("/v1/settings/kill-switch", { enabled: false });
  });

  it("refuses to decide on a cancelled subscription", async () => {
    const subscription = await createSubscription(client, { merchantName: "Dead Tool" });
    await client.patch(`/v1/subscriptions/${subscription.id}`, { status: "cancelled" });

    const response = await client.post(`/v1/subscriptions/${subscription.id}/decisions`, {});
    expect(response.status).toBe(409);
    expect(expectErrorCode(response.body)).toBe("INVALID_DECISION_STATE");
  });

  it("lists a subscription's decision history newest first", async () => {
    const subscription = await createSubscription(client, { merchantName: "Plausible Growth" });
    await createDecision(client, subscription.id);
    await createDecision(client, subscription.id, { regenerate: true });

    const response = await client.get<{ decisions: DecisionShape[] }>(
      `/v1/subscriptions/${subscription.id}/decisions`,
    );
    expect(response.body.decisions).toHaveLength(2);
    expect(response.body.decisions[0]!.id > response.body.decisions[1]!.id).toBe(true);
  });

  it("does not leak a decision across workspaces", async () => {
    const subscription = await createSubscription(client, { merchantName: "Private Tool" });
    const decision = await createDecision(client, subscription.id);

    const other = new ApiClient(harness.app);
    await signUp(other);
    expect((await other.get(`/v1/decisions/${decision.id}`)).status).toBe(404);
  });

  it("writes decision.generated to the audit log", async () => {
    const response = await client.get<{ events: Array<{ type: string; data: Record<string, unknown> }> }>(
      "/v1/audit?type=decision.generated&limit=50",
    );
    expect(response.body.events.length).toBeGreaterThan(0);
    expect(response.body.events[0]!.data.recommendation).toBeTruthy();
  });
});

describe("LLM narrative", () => {
  it("uses the model's wording but discards alternatives it invented", async () => {
    const fakeLlm: LlmClient = {
      available: true,
      modelId: "test-model",
      async chatReply() {
        return null;
      },
      async extractRenewalFromText() {
        return null;
      },
      async explainDecision(): Promise<DecisionNarrative> {
        return {
          headline: "Model-written headline",
          narrative: "Model-written narrative.",
          alternatives: [
            // Not in the catalog: must be dropped rather than shown to the user.
            {
              name: "TotallyMadeUpTool",
              annual_cost: "1.00",
              pros: [],
              cons: [],
              switch_friction: "low",
            },
          ],
        };
      },
    };
    setLlmClient(fakeLlm);

    const subscription = await createSubscription(client, {
      merchantName: "Midjourney Standard",
      amount: "30.00",
      criticality: "experimental",
      jobCategory: "design",
    });
    const decision = await createDecision(client, subscription.id, { regenerate: true });

    expect(decision.package.headline).toBe("Model-written headline");
    expect(decision.package.narrative_source).toBe("llm");
    expect(decision.modelId).toBe("test-model");
    expect(decision.package.alternatives.some((a) => a.name === "TotallyMadeUpTool")).toBe(false);
    expect(decision.package.alternatives.length).toBeGreaterThan(0);

    setLlmClient(null);
  });

  it("falls back to the deterministic narrative when the model fails", async () => {
    setLlmClient({
      available: true,
      modelId: "test-model",
      async chatReply() {
        return null;
      },
      async extractRenewalFromText() {
        return null;
      },
      async explainDecision() {
        return null;
      },
    });

    const subscription = await createSubscription(client, { merchantName: "Vercel Pro" });
    const decision = await createDecision(client, subscription.id, { regenerate: true });

    expect(decision.package.narrative_source).toBe("deterministic");
    expect(decision.modelId).toBeNull();
    expect(decision.package.narrative).toContain("Doing nothing costs");

    setLlmClient(null);
  });
});
