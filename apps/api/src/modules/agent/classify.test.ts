import { describe, expect, it } from "vitest";
import { classify, senderDomain } from "./classify.js";
import type { MailMessage } from "../mailbox/types.js";

/**
 * The gate that decides what the model ever sees, and what ends up in someone's
 * budget. The asymmetry it is built around: a missed subscription is invisible,
 * a promoted one-off purchase is a wrong number on a dashboard. So the cases
 * below lean on the second kind.
 */

function message(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    providerMessageId: "m1",
    subject: "Your receipt",
    from: "billing@anthropic.com",
    receivedAt: new Date("2026-07-29T09:14:22Z"),
    snippet: null,
    body: "Amount: $20.00 USD\nBilling period: Monthly",
    ...overrides,
  };
}

describe("senderDomain", () => {
  it("reads the domain out of a display-name header", () => {
    expect(senderDomain("Anthropic <billing@anthropic.com>")).toBe("anthropic.com");
  });

  it("is null when there is no address to read", () => {
    expect(senderDomain(null)).toBeNull();
    expect(senderDomain("no address here")).toBeNull();
  });
});

describe("classify", () => {
  it("accepts a known vendor's recurring charge", () => {
    const verdict = classify(message());

    expect(verdict.isReceipt).toBe(true);
    expect(verdict.isSaas).toBe(true);
    expect(verdict.merchant).toBe("Anthropic");
    expect(verdict.confidence).toBeGreaterThan(0.9);
  });

  it("refuses anything without an amount, however receipt-shaped the words are", () => {
    const verdict = classify(
      message({ subject: "Your invoice is ready", body: "View your invoice online." }),
    );

    expect(verdict.isReceipt).toBe(false);
    expect(verdict.reason).toContain("no amount");
  });

  it("keeps a marketplace order as a receipt but never as a subscription", () => {
    const verdict = classify(
      message({
        from: "auto-confirm@amazon.in",
        subject: "Your Amazon.in order",
        body: "Order Total: $42.00\nThank you for your order",
      }),
    );

    expect(verdict.isReceipt).toBe(true);
    expect(verdict.isSaas).toBe(false);
    expect(verdict.reason).toContain("marketplace");
  });

  it("throws out refunds, failures and trial notices", () => {
    for (const body of [
      "We refunded $20.00 to your card",
      "Your payment of $20.00 failed",
      "Your free trial ends soon. After that it is $20.00 a month",
    ]) {
      const verdict = classify(message({ body }));
      expect(verdict.isReceipt, body).toBe(false);
    }
  });

  it("trusts recurring wording from a sender it does not recognise", () => {
    const verdict = classify(
      message({
        from: "billing@some-small-tool.io",
        subject: "Receipt",
        body: "Pro plan — $12.00 per month. Your subscription renews automatically.",
      }),
    );

    expect(verdict.isSaas).toBe(true);
    // Lower than a known vendor: it is an inference, and it says so.
    expect(verdict.confidence).toBeLessThan(0.8);
  });

  it("keeps an unrecognised one-off charge out of the subscription list", () => {
    const verdict = classify(
      message({
        from: "receipts@some-hardware-shop.com",
        subject: "Receipt for your purchase",
        body: "Total charged: $89.00. Thank you for your purchase.",
      }),
    );

    expect(verdict.isReceipt).toBe(true);
    expect(verdict.isSaas).toBe(false);
  });

  it("matches a vendor on a billing subdomain", () => {
    const verdict = classify(message({ from: "noreply@mail.figma.com" }));
    expect(verdict.merchant).toBe("Figma");
  });
});

/**
 * A receipt that reaches the mailbox second-hand: forwarded by the person who
 * holds the vendor account, or passed on by an accountant. The sender says
 * nothing about the vendor, so the message body has to.
 *
 * This matters more than it looks. Merchant-less receipts are grouped by sender
 * domain further down the pipeline, so without this every receipt forwarded
 * from one address collapses into a single subscription.
 */
describe("classify, on mail that did not come from the vendor", () => {
  const forwarded = (subject: string, body: string) =>
    classify(message({ from: "Demo <demo.sender@gmail.com>", subject, body }));

  it("names the vendor from its domain in the body", () => {
    const verdict = forwarded(
      "Fwd: Your Notion invoice",
      "notion.so\nAmount: $20.00 USD\nBilling period: Monthly",
    );
    expect(verdict.merchant).toBe("Notion");
    expect(verdict.isSaas).toBe(true);
  });

  it("names the vendor from the brand in the subject", () => {
    const verdict = forwarded("Fwd: Coda subscription receipt", "Amount: $47.00 USD\nMonthly plan");
    expect(verdict.merchant).toBe("Coda");
    expect(verdict.isSaas).toBe(true);
  });

  it("tells two forwarded receipts apart rather than merging them", () => {
    // The regression this whole branch exists for.
    const notion = forwarded("Fwd: Notion receipt", "Amount: $20.00 USD\nMonthly plan");
    const coda = forwarded("Fwd: Coda receipt", "Amount: $47.00 USD\nMonthly plan");
    expect(notion.merchant).not.toBe(coda.merchant);
  });

  it("trusts the sender domain over a brand mentioned in the body", () => {
    const verdict = classify(
      message({
        from: "billing@figma.com",
        subject: "Your receipt",
        body: "Amount: $45.00 USD\nMonthly plan\nImported from Notion",
      }),
    );
    expect(verdict.merchant).toBe("Figma");
    expect(verdict.confidence).toBeGreaterThan(0.75);
  });

  it("stays unnamed when a brand name is only an ordinary word", () => {
    const verdict = forwarded(
      "Fwd: subscription receipt",
      "Amount: $12.00 USD\nMonthly plan\nCharged on Monday as usual",
    );
    expect(verdict.merchant).toBeNull();
    expect(verdict.isSaas).toBe(true);
  });

  it("does not invent a vendor for a message with no amount", () => {
    const verdict = forwarded("Fwd: Notion news", "Notion shipped a monthly plan update");
    expect(verdict.isReceipt).toBe(false);
    expect(verdict.isSaas).toBe(false);
  });
});
