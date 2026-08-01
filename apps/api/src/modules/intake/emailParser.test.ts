import { describe, expect, it } from "vitest";
import { fixture } from "../../test/factories.js";
import { extractRenewalHeuristically, parseDateToken } from "./emailParser.js";

describe("parseDateToken", () => {
  const reference = new Date("2026-07-30T00:00:00Z");

  it("parses ISO dates", () => {
    expect(parseDateToken("2026-08-12", reference)?.toISOString()).toContain("2026-08-12");
  });

  it("parses month-first prose dates", () => {
    expect(parseDateToken("August 12, 2026", reference)?.toISOString()).toContain("2026-08-12");
    expect(parseDateToken("Aug 12, 2026", reference)?.toISOString()).toContain("2026-08-12");
  });

  it("parses day-first prose dates", () => {
    expect(parseDateToken("03 September 2026", reference)?.toISOString()).toContain("2026-09-03");
    expect(parseDateToken("3rd Sept 2026", reference)?.toISOString()).toContain("2026-09-03");
  });

  it("parses US numeric dates", () => {
    expect(parseDateToken("08/12/2026", reference)?.toISOString()).toContain("2026-08-12");
  });

  it("returns null for nonsense", () => {
    expect(parseDateToken("next tuesday-ish", reference)).toBeNull();
    expect(parseDateToken("", reference)).toBeNull();
  });
});

describe("extractRenewalHeuristically", () => {
  it("extracts a Claude Pro renewal notice", () => {
    const parsed = extractRenewalHeuristically(fixture("emails/claude-pro-renewal.txt"));

    expect(parsed.merchant_name).toBe("Anthropic");
    expect(parsed.amount).toBe("20.00");
    expect(parsed.currency).toBe("USD");
    expect(parsed.billing_cycle).toBe("monthly");
    expect(parsed.next_renewal_at).toContain("2026-08-12");
    expect(parsed.cancel_by_at).toContain("2026-08-11");
    expect(parsed.plan_name).toBe("Pro");
    expect(parsed.raw_excerpt).toContain("20.00");
  });

  it("extracts a Midjourney receipt including the price change", () => {
    const parsed = extractRenewalHeuristically(fixture("emails/midjourney-receipt.txt"));

    expect(parsed.merchant_name).toBe("Midjourney");
    expect(parsed.amount).toBe("30.00");
    expect(parsed.billing_cycle).toBe("monthly");
    expect(parsed.next_renewal_at).toContain("2026-08-05");
    expect(parsed.price_change_note).toMatch(/increas/i);
  });

  it("extracts an annual Figma renewal", () => {
    const parsed = extractRenewalHeuristically(fixture("emails/figma-annual-renewal.txt"));

    expect(parsed.merchant_name).toBe("Figma");
    expect(parsed.amount).toBe("432.00");
    expect(parsed.billing_cycle).toBe("yearly");
    expect(parsed.next_renewal_at).toContain("2026-09-03");
  });

  it("prefers a labelled total over an incidental number", () => {
    const parsed = extractRenewalHeuristically(
      [
        "From: billing@notion.so",
        "Order 88213 for 4 seats",
        "Subtotal $40.00",
        "Discount $8.00",
        "Total: $32.00",
        "Renews on 2026-09-01, billed monthly.",
      ].join("\n"),
    );

    expect(parsed.amount).toBe("32.00");
    expect(parsed.merchant_name).toBe("Notion");
  });

  it("reports low confidence when it is guessing, which is what gates payment", () => {
    const parsed = extractRenewalHeuristically(
      "hey, think we still pay for that thing, maybe 15 bucks a month?",
    );

    expect(parsed.field_confidence.merchant_name).toBeLessThan(0.7);
    expect(parsed.field_confidence.next_renewal_at).toBeLessThan(0.7);
    expect(parsed.merchant_name).toBe("Unknown merchant");
  });

  it("strips HTML before parsing", () => {
    const parsed = extractRenewalHeuristically(
      '<html><body><p>From: billing@figma.com</p><p>Total: <b>$45.00</b> billed monthly</p><p>Renews on 2026-08-20</p></body></html>',
    );

    expect(parsed.amount).toBe("45.00");
    expect(parsed.raw_excerpt).not.toContain("<b>");
  });

  it("recognises non-dollar currencies", () => {
    const parsed = extractRenewalHeuristically(
      "From: billing@linear.app\nTotal: £96.00 per year\nNext billing 2027-01-04",
    );

    expect(parsed.currency).toBe("GBP");
    expect(parsed.amount).toBe("96.00");
    expect(parsed.billing_cycle).toBe("yearly");
  });
});
