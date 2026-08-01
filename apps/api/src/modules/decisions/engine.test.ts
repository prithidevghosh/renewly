import { describe, expect, it } from "vitest";
import {
  decide,
  deterministicNarrative,
  inferActiveSeats,
  inferUnusedDays,
  isAttestedAction,
  isPayingAction,
  monthlyRunRate,
  type EngineInput,
  type EnginePolicy,
  type EngineSubscription,
} from "./engine.js";

function subscription(overrides: Partial<EngineSubscription> = {}): EngineSubscription {
  return {
    id: "sub_1",
    merchantName: "Anthropic",
    planName: "Claude Pro",
    amount: "20.00",
    currency: "USD",
    billingCycle: "monthly",
    criticality: "nice_to_have",
    jobCategory: "ai",
    usageNote: null,
    seatsTotal: 1,
    seatsActive: null,
    // Inside the snooze horizon, so the snooze rule does not mask the others.
    nextRenewalAt: new Date(Date.now() + 12 * 86_400_000),
    status: "active",
    ...overrides,
  };
}

function policy(overrides: Partial<EnginePolicy> = {}): EnginePolicy {
  return {
    killSwitch: false,
    approvalMode: "ask_above_ceiling",
    spendCeiling: "50.00",
    aiMonthlyBudget: null,
    categoryCeilings: {},
    currency: "USD",
    policyVersion: 1,
    ...overrides,
  };
}

function input(overrides: Partial<EngineInput> = {}): EngineInput {
  return { subscription: subscription(), policy: policy(), peers: [], ...overrides };
}

describe("action classification", () => {
  it("separates actions that move money from actions the user performs", () => {
    expect(isPayingAction("renew")).toBe(true);
    expect(isPayingAction("switch_term")).toBe(true);
    expect(isPayingAction("switch_vendor")).toBe(true);
    expect(isPayingAction("cancel")).toBe(false);
    expect(isPayingAction("rightsize_seats")).toBe(false);
    expect(isPayingAction("snooze")).toBe(false);

    expect(isAttestedAction("cancel")).toBe(true);
    expect(isAttestedAction("rightsize_seats")).toBe(true);
    expect(isAttestedAction("renew")).toBe(false);
  });
});

describe("inferUnusedDays", () => {
  it("reads an explicit duration", () => {
    expect(inferUnusedDays("Unused for 60 days since the brand work finished")).toBe(60);
    expect(inferUnusedDays("idle for 6 weeks")).toBe(42);
    expect(inferUnusedDays("no usage in 3 months")).toBe(90);
  });

  it("reads a duration stated before the word", () => {
    expect(inferUnusedDays("45 days without any use")).toBe(45);
  });

  it("treats a bare 'unused' as exactly at the threshold", () => {
    expect(inferUnusedDays("nobody uses this any more")).toBe(30);
  });

  it("returns null when usage is described positively", () => {
    expect(inferUnusedDays("Used daily for drafting")).toBeNull();
    expect(inferUnusedDays(null)).toBeNull();
  });
});

describe("inferActiveSeats", () => {
  it("reads a seat ratio from free text", () => {
    expect(inferActiveSeats("only 2 of 5 seats are used")).toBe(2);
    expect(inferActiveSeats("3 out of 10 licenses active")).toBe(3);
    expect(inferActiveSeats("1/4 users log in")).toBe(1);
  });

  it("returns null when there is no ratio", () => {
    expect(inferActiveSeats("everyone uses it")).toBeNull();
    expect(inferActiveSeats(null)).toBeNull();
  });
});

describe("monthlyRunRate", () => {
  it("normalises mixed cycles to a monthly figure", () => {
    expect(
      monthlyRunRate(
        [
          { amount: "20.00", billingCycle: "monthly" },
          { amount: "120.00", billingCycle: "yearly" },
        ],
        "USD",
      ),
    ).toBe("30.00");
  });
});

describe("decide — rule matrix", () => {
  it("rule 1: kill switch flags the package but still produces a decision", () => {
    const outcome = decide(input({ policy: policy({ killSwitch: true }) }));

    expect(outcome.policyFlags).toContain("KILL_SWITCH_ENABLED");
    expect(outcome.recommendation).toBeDefined();
    expect(outcome.inputsUsed).toContain("policy.kill_switch=true");
  });

  it("rule 2: must_keep with no cheaper equivalent renews", () => {
    const outcome = decide(
      input({
        subscription: subscription({
          merchantName: "Penpot",
          criticality: "must_keep",
          usageNote: "Used daily",
        }),
      }),
    );

    expect(outcome.recommendation).toBe("renew");
    expect(outcome.savingsAnnual).toBe("0.00");
  });

  it("rule 2b: must_keep on monthly billing switches term rather than renewing blind", () => {
    const outcome = decide(
      input({ subscription: subscription({ criticality: "must_keep", usageNote: "Used daily" }) }),
    );

    // Claude Pro is 20.00/mo list, 17.00/mo billed annually.
    expect(outcome.recommendation).toBe("switch_term");
    expect(outcome.termTarget).toBe("yearly");
    expect(outcome.doNothingAnnual).toBe("240.00");
    expect(outcome.recommendedAnnual).toBe("204.00");
    expect(outcome.savingsAnnual).toBe("36.00");
    // A term switch pays the annual amount up front.
    expect(outcome.amountDue).toBe("204.00");
  });

  it("rule 3: an experimental tool above the ceiling switches vendor", () => {
    const outcome = decide(
      input({
        subscription: subscription({
          merchantName: "Midjourney Standard",
          amount: "60.00",
          criticality: "experimental",
          jobCategory: "design",
        }),
      }),
    );

    expect(outcome.recommendation).toBe("switch_vendor");
    expect(outcome.switchTarget?.name).toBe("Midjourney Basic");
    expect(outcome.vendorTarget).toBe("Midjourney Basic");
    expect(outcome.policyFlags).toContain("ABOVE_SPEND_CEILING");
    expect(Number(outcome.savingsAnnual)).toBeGreaterThan(0);
  });

  it("rule 3b: experimental above the ceiling with nothing cheaper is cancelled", () => {
    const outcome = decide(
      input({
        subscription: subscription({
          merchantName: "Some Bespoke Vendor",
          amount: "99.00",
          criticality: "experimental",
        }),
      }),
    );

    expect(outcome.recommendation).toBe("cancel");
    expect(outcome.recommendedAnnual).toBe("0.00");
    expect(outcome.savingsAnnual).toBe("1188.00");
    // Cancelling moves no money through the rail.
    expect(outcome.amountDue).toBe("0.00");
  });

  it("rule 4: exceeding the workspace budget prefers a vendor switch", () => {
    const outcome = decide(
      input({
        subscription: subscription({ merchantName: "Midjourney Standard", amount: "30.00" }),
        policy: policy({ aiMonthlyBudget: "40.00" }),
        peers: [
          {
            id: "sub_2",
            amount: "20.00",
            billingCycle: "monthly",
            jobCategory: "ai",
            merchantName: "Anthropic",
          },
        ],
      }),
    );

    expect(outcome.policyFlags).toContain("BUDGET_EXCEEDED");
    expect(outcome.recommendation).toBe("switch_vendor");
    expect(outcome.switchTarget?.name).toBe("Midjourney Basic");
  });

  it("rule 4b: a category ceiling breach is detected independently", () => {
    const outcome = decide(
      input({
        subscription: subscription({
          merchantName: "Midjourney Standard",
          amount: "30.00",
          jobCategory: "design",
        }),
        policy: policy({ categoryCeilings: { design: "25.00" } }),
      }),
    );

    expect(outcome.policyFlags).toContain("CATEGORY_CEILING_EXCEEDED");
    expect(outcome.recommendation).toBe("switch_vendor");
  });

  it("rule 5: 30+ days unused leans cancel, even when it is affordable", () => {
    const outcome = decide(
      input({ subscription: subscription({ usageNote: "Unused for 45 days." }) }),
    );

    expect(outcome.recommendation).toBe("cancel");
    expect(outcome.recommendedAnnual).toBe("0.00");
    expect(outcome.savingsAnnual).toBe("240.00");
    expect(outcome.inputsUsed).toContain("derived.unused_days=45");
  });

  it("rule 5b: a must_keep tool that has gone unused is still a cancel candidate", () => {
    const outcome = decide(
      input({
        subscription: subscription({ criticality: "must_keep", usageNote: "Unused for 90 days." }),
      }),
    );
    expect(outcome.recommendation).toBe("cancel");
  });

  it("rule 6: idle seats are rightsized, not cancelled", () => {
    const outcome = decide(
      input({
        subscription: subscription({
          merchantName: "Figma Professional",
          amount: "75.00",
          seatsTotal: 5,
          seatsActive: 2,
          jobCategory: "design",
        }),
      }),
    );

    expect(outcome.recommendation).toBe("rightsize_seats");
    expect(outcome.seatsTarget).toBe(2);
    // 75.00/mo across 5 seats is 15.00 per seat; two seats is 30.00/mo.
    expect(outcome.doNothingAnnual).toBe("900.00");
    expect(outcome.recommendedAnnual).toBe("360.00");
    expect(outcome.savingsAnnual).toBe("540.00");
    // The user performs a seat change, so nothing is charged.
    expect(outcome.amountDue).toBe("0.00");
  });

  it("rule 6b: infers idle seats from the usage note when seatsActive is unset", () => {
    const outcome = decide(
      input({
        subscription: subscription({
          merchantName: "Figma Professional",
          amount: "75.00",
          seatsTotal: 5,
          seatsActive: null,
          usageNote: "only 2 of 5 seats are used",
        }),
      }),
    );

    expect(outcome.recommendation).toBe("rightsize_seats");
    expect(outcome.seatsTarget).toBe(2);
    // Lower confidence than structured data, because it was inferred from prose.
    expect(outcome.confidence).toBeLessThan(0.86);
  });

  it("does not rightsize when every seat is in use", () => {
    const outcome = decide(
      input({
        subscription: subscription({
          merchantName: "Figma Professional",
          amount: "45.00",
          seatsTotal: 3,
          seatsActive: 3,
        }),
      }),
    );
    expect(outcome.recommendation).not.toBe("rightsize_seats");
  });

  it("snoozes a healthy subscription whose renewal is far away", () => {
    const outcome = decide(
      input({
        subscription: subscription({
          merchantName: "Penpot",
          usageNote: "Used every week by the design team",
          nextRenewalAt: new Date(Date.now() + 120 * 86_400_000),
        }),
      }),
    );

    expect(outcome.recommendation).toBe("snooze");
    expect(outcome.savingsAnnual).toBe("0.00");
    expect(outcome.amountDue).toBe("0.00");
  });

  it("renews rather than snoozing when the renewal is imminent", () => {
    const outcome = decide(
      input({
        subscription: subscription({
          merchantName: "Penpot",
          usageNote: "Used every week",
          nextRenewalAt: new Date(Date.now() + 5 * 86_400_000),
        }),
      }),
    );
    expect(outcome.recommendation).toBe("renew");
  });

  it("never reports a negative saving", () => {
    const outcome = decide(
      input({ subscription: subscription({ merchantName: "Penpot", amount: "0.00" }) }),
    );
    expect(Number(outcome.savingsAnnual)).toBeGreaterThanOrEqual(0);
  });

  it("records every input that was actually consulted, and the policy version", () => {
    const outcome = decide(
      input({
        subscription: subscription({ usageNote: "Used daily", jobCategory: "ai" }),
        policy: policy({ aiMonthlyBudget: "300.00", policyVersion: 7 }),
      }),
    );

    expect(outcome.inputsUsed).toContain("subscription.amount=20.00 USD");
    expect(outcome.inputsUsed).toContain("subscription.criticality=nice_to_have");
    expect(outcome.inputsUsed).toContain("policy.ai_monthly_budget=300.00");
    expect(outcome.inputsUsed).toContain("policy.version=7");
    expect(outcome.inputsUsed).toContain("subscription.job_category=ai");
    expect(outcome.inputsUsed.some((i) => i.startsWith("catalog.match="))).toBe(true);
  });

  it("produces a one-line diagnosis for every action", () => {
    const cases = [
      subscription({ usageNote: "Unused for 60 days" }),
      subscription({ merchantName: "Figma Professional", seatsTotal: 4, seatsActive: 1 }),
      subscription({ criticality: "must_keep", usageNote: "daily" }),
      subscription({
        merchantName: "Penpot",
        usageNote: "daily",
        nextRenewalAt: new Date(Date.now() + 200 * 86_400_000),
      }),
    ];
    for (const sub of cases) {
      const outcome = decide(input({ subscription: sub }));
      expect(outcome.diagnosis.length, outcome.recommendation).toBeGreaterThan(10);
    }
  });

  it("is deterministic for the same input", () => {
    const now = new Date("2026-08-01T00:00:00Z");
    const first = decide({ ...input(), now });
    const second = decide({ ...input(), now });
    expect(second).toEqual(first);
  });

  it("handles a yearly cycle without double-counting", () => {
    const outcome = decide(
      input({
        subscription: subscription({
          merchantName: "Penpot",
          amount: "432.00",
          billingCycle: "yearly",
          criticality: "must_keep",
          usageNote: "Used daily",
        }),
      }),
    );

    expect(outcome.doNothingAnnual).toBe("432.00");
    expect(outcome.amountDue).toBe("432.00");
  });

  it("treats a null spend ceiling as no ceiling", () => {
    const outcome = decide(
      input({
        subscription: subscription({ amount: "500.00", criticality: "experimental" }),
        policy: policy({ spendCeiling: null }),
      }),
    );
    expect(outcome.policyFlags).not.toContain("ABOVE_SPEND_CEILING");
  });
});

describe("deterministicNarrative", () => {
  it("states the counterfactual in plain numbers", () => {
    const sub = subscription({ usageNote: "Unused for 60 days." });
    const outcome = decide(input({ subscription: sub }));
    const { headline, narrative } = deterministicNarrative(outcome, sub);

    expect(headline).toContain("Cancel Anthropic");
    expect(narrative).toContain("240.00");
    expect(narrative).toContain("Doing nothing costs");
    expect(headline.length).toBeLessThanOrEqual(160);
  });

  it("names the seat target when rightsizing", () => {
    const sub = subscription({
      merchantName: "Figma Professional",
      amount: "75.00",
      seatsTotal: 5,
      seatsActive: 2,
    });
    const outcome = decide(input({ subscription: sub }));
    expect(deterministicNarrative(outcome, sub).headline).toContain("Rightsize");
  });
});
