import { describe, expect, it } from "vitest";
import type { DecisionPackageRow, Subscription, WorkspaceSettings } from "../../db/schema.js";
import { AppError } from "../../lib/errors.js";
import type { DecisionPackage } from "../decisions/engine.js";
import { assertCancelAllowed, assertPayAllowed } from "./policyGuard.js";

function settings(overrides: Partial<WorkspaceSettings> = {}): WorkspaceSettings {
  return {
    workspaceId: "wsp_1",
    aiMonthlyBudget: null,
    approvalMode: "ask_above_ceiling",
    spendCeiling: "50.00",
    killSwitch: false,
    categoryCeilings: {},
    teamSize: 1,
    quietHoursJson: null,
    primaryChannel: "simulator",
    policyVersion: 1,
    currency: "USD",
    updatedAt: new Date(),
    ...overrides,
  };
}

function subscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub_1",
    workspaceId: "wsp_1",
    merchantName: "Anthropic",
    merchantCanonical: "anthropic",
    planName: "Claude Pro",
    amount: "20.00",
    currency: "USD",
    billingCycle: "monthly",
    nextRenewalAt: new Date("2026-08-12T00:00:00Z"),
    cancelByAt: null,
    status: "active",
    criticality: "must_keep",
    jobCategory: "ai",
    usageNote: null,
    seatsTotal: 1,
    seatsActive: null,
    merchantId: null,
    contentHash: null,
    lastSignalAt: null,
    sourceType: "manual",
    confirmedAt: new Date(),
    fieldConfidence: { amount: 1, merchant_name: 1, next_renewal_at: 1 },
    priceChangeNote: null,
    rawExcerpt: null,
    notes: null,
    cancelledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function packagePayload(overrides: Partial<DecisionPackage> = {}): DecisionPackage {
  return {
    recommendation: "renew",
    confidence: 0.85,
    headline: "Renew Anthropic",
    narrative: "Renew as is.",
    counterfactuals: {
      do_nothing: { annual_cost: "240.00", summary: "Keep paying." },
      recommended: { annual_cost: "240.00", savings_vs_do_nothing: "0.00", summary: "Renew." },
    },
    alternatives: [],
    diagnosis: "In use and priced correctly.",
    inputs_used: ["subscription.amount=20.00 USD"],
    policy_flags: [],
    policy_version: 1,
    amount_due: "20.00",
    currency: "USD",
    seats_target: null,
    term_target: null,
    vendor_target: null,
    narrative_source: "deterministic",
    ...overrides,
  };
}

function decision(overrides: Partial<DecisionPackageRow> = {}): DecisionPackageRow {
  return {
    id: "dec_1",
    workspaceId: "wsp_1",
    subscriptionId: "sub_1",
    recommendation: "renew",
    payload: packagePayload() as unknown as Record<string, unknown>,
    confidence: "0.850",
    modelId: null,
    policyVersion: 1,
    pricedAmount: null,
    expiresAt: null,
    supersededAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "NO_ERROR";
  } catch (error) {
    return error instanceof AppError ? error.code : "UNEXPECTED";
  }
}

describe("assertPayAllowed", () => {
  it("allows a confirmed renewal within the threshold", () => {
    const result = assertPayAllowed({
      settings: settings(),
      subscription: subscription(),
      decision: decision(),
    });

    expect(result.amount).toBe("20.00");
    expect(result.approvalPath).toBe("within_ceiling");
    expect(result.flags).toEqual([]);
  });

  it("blocks everything when the kill switch is on", () => {
    expect(
      codeOf(() =>
        assertPayAllowed({
          settings: settings({ killSwitch: true }),
          subscription: subscription(),
          decision: decision(),
        }),
      ),
    ).toBe("KILL_SWITCH_ENABLED");
  });

  it("blocks an unconfirmed low-confidence subscription", () => {
    expect(
      codeOf(() =>
        assertPayAllowed({
          settings: settings(),
          subscription: subscription({
            confirmedAt: null,
            fieldConfidence: { amount: 0.4, merchant_name: 0.9, next_renewal_at: 0.9 },
          }),
          decision: decision(),
        }),
      ),
    ).toBe("CONFIRMATION_REQUIRED");
  });

  it("allows a low-confidence subscription once it has been confirmed", () => {
    const result = assertPayAllowed({
      settings: settings(),
      subscription: subscription({
        confirmedAt: new Date(),
        fieldConfidence: { amount: 0.4, merchant_name: 0.9, next_renewal_at: 0.9 },
      }),
      decision: decision(),
    });
    expect(result.amount).toBe("20.00");
  });

  it("allows a high-confidence unconfirmed subscription", () => {
    const result = assertPayAllowed({
      settings: settings(),
      subscription: subscription({
        confirmedAt: null,
        fieldConfidence: { amount: 0.95, merchant_name: 0.92, next_renewal_at: 0.8 },
      }),
      decision: decision(),
    });
    expect(result.amount).toBe("20.00");
  });

  it("refuses to pay an attested action", () => {
    expect(
      codeOf(() =>
        assertPayAllowed({
          settings: settings(),
          subscription: subscription(),
          decision: decision({
            recommendation: "cancel",
            payload: packagePayload({
              recommendation: "cancel",
              amount_due: "0.00",
            }) as unknown as Record<string, unknown>,
          }),
        }),
      ),
    ).toBe("INVALID_DECISION_STATE");
  });

  it("refuses a superseded decision", () => {
    expect(
      codeOf(() =>
        assertPayAllowed({
          settings: settings(),
          subscription: subscription(),
          decision: decision({ supersededAt: new Date() }),
        }),
      ),
    ).toBe("INVALID_DECISION_STATE");
  });

  it("refuses a decision belonging to another subscription", () => {
    expect(
      codeOf(() =>
        assertPayAllowed({
          settings: settings(),
          subscription: subscription(),
          decision: decision({ subscriptionId: "sub_other" }),
        }),
      ),
    ).toBe("INVALID_DECISION_STATE");
  });

  it("refuses an amount that disagrees with the decision", () => {
    expect(
      codeOf(() =>
        assertPayAllowed({
          settings: settings(),
          subscription: subscription(),
          decision: decision(),
          requestedAmount: "200.00",
        }),
      ),
    ).toBe("INVALID_DECISION_STATE");
  });

  it("tolerates a one-minor-unit rounding difference", () => {
    const result = assertPayAllowed({
      settings: settings(),
      subscription: subscription(),
      decision: decision(),
      requestedAmount: "20.01",
    });
    expect(result.amount).toBe("20.01");
  });

  it("refuses a zero amount", () => {
    expect(
      codeOf(() =>
        assertPayAllowed({
          settings: settings(),
          subscription: subscription(),
          decision: decision({
            payload: packagePayload({ amount_due: "0.00" }) as unknown as Record<string, unknown>,
          }),
        }),
      ),
    ).toBe("INVALID_DECISION_STATE");
  });

  it("refuses an already-cancelled subscription", () => {
    expect(
      codeOf(() =>
        assertPayAllowed({
          settings: settings(),
          subscription: subscription({ status: "cancelled" }),
          decision: decision(),
        }),
      ),
    ).toBe("INVALID_DECISION_STATE");
  });

  describe("approval modes", () => {
    const bigDecision = decision({
      payload: packagePayload({ amount_due: "120.00" }) as unknown as Record<string, unknown>,
    });

    it("always_ask treats the call itself as the approval", () => {
      const result = assertPayAllowed({
        settings: settings({ approvalMode: "always_ask" }),
        subscription: subscription({ amount: "120.00" }),
        decision: bigDecision,
      });
      expect(result.approvalPath).toBe("explicit_request");
      expect(result.flags).toContain("ABOVE_SPEND_CEILING");
    });

    it("ask_above_ceiling flags but permits an above-ceiling charge", () => {
      const result = assertPayAllowed({
        settings: settings({ approvalMode: "ask_above_ceiling" }),
        subscription: subscription({ amount: "120.00" }),
        decision: bigDecision,
      });
      expect(result.approvalPath).toBe("explicit_request");
    });

    it("auto_within_envelope refuses above the ceiling", () => {
      expect(
        codeOf(() =>
          assertPayAllowed({
            settings: settings({ approvalMode: "auto_within_envelope" }),
            subscription: subscription({ amount: "120.00" }),
            decision: bigDecision,
          }),
        ),
      ).toBe("APPROVAL_REQUIRED");
    });

    it("auto_within_envelope permits below the ceiling", () => {
      const result = assertPayAllowed({
        settings: settings({ approvalMode: "auto_within_envelope" }),
        subscription: subscription(),
        decision: decision(),
      });
      expect(result.approvalPath).toBe("auto_within_envelope");
    });
  });

  it("flags a charge above the monthly budget without blocking it", () => {
    const result = assertPayAllowed({
      settings: settings({ aiMonthlyBudget: "15.00" }),
      subscription: subscription(),
      decision: decision(),
    });
    expect(result.flags).toContain("EXCEEDS_MONTHLY_BUDGET");
  });
});

describe("assertCancelAllowed", () => {
  it("permits a normal cancel", () => {
    expect(() =>
      assertCancelAllowed({
        settings: settings(),
        subscription: subscription(),
        decision: decision({ recommendation: "cancel" }),
      }),
    ).not.toThrow();
  });

  it("is blocked by the kill switch", () => {
    expect(
      codeOf(() =>
        assertCancelAllowed({
          settings: settings({ killSwitch: true }),
          subscription: subscription(),
          decision: decision({ recommendation: "cancel" }),
        }),
      ),
    ).toBe("KILL_SWITCH_ENABLED");
  });

  it("refuses an already-cancelled subscription", () => {
    expect(
      codeOf(() =>
        assertCancelAllowed({
          settings: settings(),
          subscription: subscription({ status: "cancelled" }),
          decision: decision({ recommendation: "cancel" }),
        }),
      ),
    ).toBe("INVALID_DECISION_STATE");
  });
});
