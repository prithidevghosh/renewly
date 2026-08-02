import { describe, expect, it } from "vitest";
import {
  decide,
  type EngineSubscription,
  type Recommendation,
} from "../decisions/engine.js";
import {
  composeActionProof,
  composeAttestationAsk,
  composeAuthLink,
  composeBlocked,
  composeFailure,
  composeHelp,
  composeKeepAck,
  composePayProof,
  composeProposal,
  composeWhy,
  shortDate,
} from "./composer.js";

describe("shortDate", () => {
  it("formats a date for a lock screen", () => {
    expect(shortDate(new Date("2026-08-12T12:00:00Z"))).toBe("12 Aug");
    expect(shortDate(new Date("2026-01-03T12:00:00Z"))).toBe("3 Jan");
  });

  it("says soon when the date is unknown", () => {
    expect(shortDate(null)).toBe("soon");
  });
});

describe("composeProposal", () => {
  const base = {
    merchant: "Anthropic",
    amount: "20.00",
    currency: "USD",
    cycle: "monthly" as const,
    renewalDate: new Date("2026-08-12T12:00:00Z"),
    diagnosis: "In use, within budget, and nothing cheaper covers the same job.",
    recommendation: "renew" as const,
    savingsAnnual: "0.00",
  };

  it("leads with merchant, date and amount", () => {
    const text = composeProposal(base);
    const [first] = text.split("\n");
    expect(first).toBe("Anthropic renews 12 Aug — $20.00/mo");
  });

  it("offers the reply commands", () => {
    expect(composeProposal(base)).toContain("Reply APPROVE · KEEP · LATER · WHY");
  });

  it("states the saving when there is one", () => {
    const text = composeProposal({
      ...base,
      recommendation: "switch_term",
      savingsAnnual: "36.00",
    });
    expect(text).toContain("Recommended: Switch to annual · save 36.00 USD/yr");
  });

  it("states what you keep when there is no saving", () => {
    expect(composeProposal(base)).toContain("keep access for $20.00/mo");
  });

  it("includes the diagnosis line", () => {
    expect(composeProposal(base)).toContain(base.diagnosis);
  });

  it("is four lines, so it fits a notification", () => {
    expect(composeProposal(base).split("\n")).toHaveLength(4);
  });

  it("renders a non-dollar currency with its code", () => {
    const text = composeProposal({ ...base, currency: "GBP", amount: "18.00" });
    expect(text).toContain("18.00 GBP/mo");
  });

  it("labels each action type", () => {
    const labels: Array<[Recommendation, string]> = [
      ["renew", "Renew"],
      ["rightsize_seats", "Rightsize seats"],
      ["switch_term", "Switch to annual"],
      ["switch_vendor", "Switch vendor"],
      ["cancel", "Cancel"],
    ];
    for (const [recommendation, label] of labels) {
      const text = composeProposal({ ...base, recommendation, savingsAnnual: "10.00" });
      expect(text, recommendation).toContain(`Recommended: ${label}`);
    }
  });
});

describe("composeAuthLink", () => {
  it("names the amount, the merchant and the expiry", () => {
    const text = composeAuthLink({
      merchant: "Anthropic",
      amount: "20.00",
      currency: "USD",
      payLink: "https://app.renewly.test/pay/apr_1?token=abc",
      expiresInMinutes: 60,
    });

    expect(text).toContain("Approve $20.00 to Anthropic with passkey:");
    expect(text).toContain("https://app.renewly.test/pay/apr_1?token=abc");
    expect(text).toContain("Expires in 60 minutes.");
  });
});

describe("proofs", () => {
  it("states what was paid and where the receipt is", () => {
    const text = composePayProof({
      merchant: "Anthropic",
      amount: "20.00",
      currency: "USD",
      receiptId: "rct_123",
      nextRenewalAt: new Date("2026-09-12T12:00:00Z"),
    });

    expect(text).toContain("Done. Paid $20.00 to Anthropic.");
    expect(text).toContain("Receipt rct_123. Next renewal 12 Sep.");
  });

  it("states realized savings for an attested action", () => {
    const text = composeActionProof({
      actionSummary: "Cancelled Midjourney",
      amountSaved: "360.00",
      currency: "USD",
    });

    expect(text).toContain("Done. Cancelled Midjourney.");
    expect(text).toContain("Realized savings 360.00 USD/yr");
  });
});

describe("composeBlocked", () => {
  it("names the reason in plain language", () => {
    expect(composeBlocked("KILL_SWITCH_ENABLED")).toBe("Paused: kill switch is on.");
    expect(composeBlocked("ABOVE_SPEND_CEILING")).toBe("Paused: over your spend ceiling.");
    expect(composeBlocked("CONFIRMATION_REQUIRED")).toContain("need confirming first");
  });

  it("appends the remedy when there is one", () => {
    expect(composeBlocked("KILL_SWITCH_ENABLED", "Turn it off in settings.")).toBe(
      "Paused: kill switch is on. Turn it off in settings.",
    );
  });
});

describe("composeFailure", () => {
  it("says nothing was charged, which is the user's first question", () => {
    const text = composeFailure({
      merchant: "Anthropic",
      reason: "the card was declined",
      canRetry: true,
    });
    expect(text).toContain("Could not complete Anthropic: the card was declined.");
    expect(text).toContain("Nothing was charged.");
    expect(text).toContain("Reply RETRY");
  });

  it("omits the retry offer when retrying cannot help", () => {
    const text = composeFailure({ merchant: "Figma", reason: "policy blocked it", canRetry: false });
    expect(text).toContain("Nothing was charged.");
    expect(text).not.toContain("RETRY");
  });
});

describe("composeWhy", () => {
  it("shows the counterfactual rather than restating the pitch", () => {
    const text = composeWhy({
      merchant: "Anthropic",
      doNothingAnnual: "240.00",
      recommendedAnnual: "204.00",
      savingsAnnual: "36.00",
      currency: "USD",
      inputsUsed: ["subscription.amount=20.00 USD", "policy.spend_ceiling=50.00"],
    });

    expect(text).toContain("doing nothing costs 240.00 USD/yr");
    expect(text).toContain("costs 204.00 USD/yr, a difference of 36.00 USD");
    expect(text).toContain("Based on:");
  });

  it("caps the inputs so the message stays a message", () => {
    const text = composeWhy({
      merchant: "X",
      doNothingAnnual: "1.00",
      recommendedAnnual: "1.00",
      savingsAnnual: "0.00",
      currency: "USD",
      inputsUsed: ["a", "b", "c", "d", "e", "f", "g"],
    });
    expect(text).toContain("Based on: a, b, c, d.");
    expect(text).not.toContain("e,");
  });
});

describe("attestation ask", () => {
  it("says plainly that Renewly cannot do this leg", () => {
    const text = composeAttestationAsk({
      merchant: "Midjourney",
      actionType: "cancel",
      portalUrl: "https://www.midjourney.com/account",
      savingsAnnual: "360.00",
      currency: "USD",
    });

    expect(text).toContain("Cancel Midjourney to save 360.00 USD/yr.");
    expect(text).toContain("I cannot do this one for you");
    expect(text).toContain("https://www.midjourney.com/account");
    expect(text).toContain("Reply DONE");
  });

  it("still gives instructions without a portal URL", () => {
    const text = composeAttestationAsk({
      merchant: "Obscure Vendor",
      actionType: "cancel",
      portalUrl: null,
      savingsAnnual: "99.00",
      currency: "USD",
    });
    expect(text).toContain("Obscure Vendor billing settings");
  });
});

describe("acknowledgements", () => {
  it("acknowledges KEEP without ambiguity about money", () => {
    expect(composeKeepAck("Figma")).toContain("Leaving Figma as it is. Nothing was charged.");
  });

  it("lists the commands in help", () => {
    const text = composeHelp();
    for (const command of ["APPROVE", "KEEP", "LATER", "WHY", "DONE", "STOP"]) {
      expect(text).toContain(command);
    }
  });
});

describe("honesty about what is known", () => {
  /**
   * These drive the real engine into the real composer, because the honesty
   * guarantee only matters for the string that actually reaches the phone.
   * V1 reads no vendor telemetry, so a message may only claim a tool is unused
   * when the user's own note said so.
   */
  const USAGE_CLAIM = /barely|rarely|hardly|no recorded use|you (do not|don't) use|abandoned/i;

  function engineSubscription(overrides: Partial<EngineSubscription> = {}): EngineSubscription {
    return {
      id: "sub_1",
      merchantName: "Midjourney Standard",
      planName: "Standard",
      amount: "30.00",
      currency: "USD",
      billingCycle: "monthly",
      criticality: "experimental",
      jobCategory: "design",
      usageNote: null,
      seatsTotal: 1,
      seatsActive: null,
      nextRenewalAt: new Date("2026-08-12T12:00:00Z"),
      status: "active",
      ...overrides,
    };
  }

  function proposalFor(sub: EngineSubscription, spendCeiling: string | null = "10.00"): string {
    const outcome = decide({
      subscription: sub,
      policy: {
        killSwitch: false,
        approvalMode: "ask_above_ceiling",
        spendCeiling,
        aiMonthlyBudget: null,
        categoryCeilings: {},
        currency: "USD",
        policyVersion: 1,
        teamSize: 1,
      },
      peers: [],
      now: new Date("2026-08-01T00:00:00Z"),
    });

    return composeProposal({
      merchant: sub.merchantName,
      amount: sub.amount,
      currency: sub.currency,
      cycle: sub.billingCycle,
      renewalDate: sub.nextRenewalAt,
      diagnosis: outcome.diagnosis,
      recommendation: outcome.recommendation,
      savingsAnnual: outcome.savingsAnnual,
    });
  }

  it("does not claim the user barely uses a tool when there is no usage note", () => {
    const text = proposalFor(engineSubscription({ usageNote: null }));

    expect(text).not.toMatch(USAGE_CLAIM);
    // "null" leaking into a message is the specific bug this guards.
    expect(text).not.toContain("null");
  });

  it("gives the policy reason instead, so the user can argue with it", () => {
    const text = proposalFor(
      engineSubscription({ merchantName: "Some Bespoke Vendor", amount: "99.00" }),
    );

    expect(text).toContain("experimental");
    expect(text).toContain("ceiling");
    expect(text).not.toMatch(USAGE_CLAIM);
  });

  it("may only describe a tool as unused when the user's own note said so", () => {
    const text = proposalFor(
      engineSubscription({ usageNote: "Unused for 60 days since the brand work finished." }),
    );

    expect(text).toContain("Cancel");
    expect(text).toContain("60 days");
    // Attributed to the note rather than asserted as observed fact.
    expect(text).toContain("Your note says");
  });

  it("proposes rightsizing a multi-seat invoice without naming or accusing anyone", () => {
    const text = proposalFor(
      engineSubscription({
        merchantName: "Figma Professional",
        amount: "144.00",
        criticality: "nice_to_have",
        seatsTotal: 4,
        seatsActive: null,
        usageNote: null,
      }),
      "500.00",
    );

    expect(text).toContain("Recommended: Rightsize seats");
    // States the invoice fact and the workspace setting, and nothing about people.
    expect(text).toContain("bills 4 seats");
    expect(text).toContain("set to 1");
    expect(text).not.toMatch(/dead|idle|inactive|seat holder|member|user \w+|@/i);
    expect(text).not.toMatch(USAGE_CLAIM);
  });

  it("still asks for one approval rather than asking how much the tool is used", () => {
    const text = proposalFor(engineSubscription({ usageNote: null }));

    expect(text).toContain("Reply APPROVE");
    // No interview: the agent decides first and asks once.
    expect(text).not.toMatch(/how (often|much|many)|reply 1|rate this|do you (still )?use/i);
  });
});

describe("tone", () => {
  it("uses no emoji anywhere in the agent's own copy", () => {
    const samples = [
      composeProposal({
        merchant: "A",
        amount: "1.00",
        currency: "USD",
        cycle: "monthly",
        renewalDate: null,
        diagnosis: "d",
        recommendation: "renew",
        savingsAnnual: "0.00",
      }),
      composeHelp(),
      composeBlocked("KILL_SWITCH_ENABLED"),
      composePayProof({
        merchant: "A",
        amount: "1.00",
        currency: "USD",
        receiptId: "r",
        nextRenewalAt: null,
      }),
    ];
    const emoji = /\p{Extended_Pictographic}/u;
    for (const sample of samples) expect(emoji.test(sample), sample).toBe(false);
  });
});
