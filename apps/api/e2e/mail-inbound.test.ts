import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hmacSha256 } from "../src/lib/crypto.js";
import { inboundTokenFor } from "../src/modules/intake/mail/service.js";
import { verifyMailWebhook } from "../src/modules/intake/mail/verify.js";
import { fixture, jsonFixture, signUpWithChannel } from "../src/test/factories.js";
import { ApiClient, createHarness, expectErrorCode, type TestHarness } from "../src/test/helpers.js";

/**
 * The intake path that needs no OAuth: a founder forwards a renewal notice to
 * their Renewly address and the subscription appears. Routing is by the
 * plus-address token, never by the From header, which anyone can forge.
 */

let harness: TestHarness;
let client: ApiClient;
let workspaceId: string;
let token: string;

function mailgunPayload(overrides: Record<string, unknown> = {}) {
  const base = jsonFixture<Record<string, unknown>>("webhooks/mailgun-inbound-claude.json");
  return {
    ...base,
    recipient: `renew+${token}@inbound.renewly.app`,
    ...overrides,
  };
}

beforeAll(async () => {
  harness = await createHarness();
  client = new ApiClient(harness.app);
  const user = await signUpWithChannel(client, { email: "mail@northwind.test" });
  workspaceId = user.workspaceId;
  token = inboundTokenFor(workspaceId);
});

afterAll(async () => {
  await harness.close();
});

describe("inbound address", () => {
  it("tells the user where to forward mail", async () => {
    const response = await client.get<{ address: string; domain: string; mode: string }>(
      "/v1/intake/mail-address",
    );

    expect(response.status).toBe(200);
    expect(response.body.address).toBe(`renew+${token}@inbound.renewly.app`);
    expect(response.body.mode).toBe("mock");
  });
});

describe("forwarded renewal becomes a subscription", () => {
  it("1. accepts the webhook and parses the renewal", async () => {
    const response = await client.webhook<{
      ok: boolean;
      status: string;
      subscriptionId: string;
      renewalEventId: string;
    }>("/v1/webhooks/mail/mailgun", mailgunPayload());

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("parsed");
    expect(response.body.subscriptionId).toBeTruthy();
    expect(response.body.renewalEventId).toBeTruthy();
  });

  it("2. the subscription carries the parsed facts and is payment-gated", async () => {
    const response = await client.get<{
      subscriptions: Array<{
        merchantName: string;
        amount: string;
        billingCycle: string;
        nextRenewalAt: string;
        sourceType: string;
        merchantId: string | null;
        contentHash: string | null;
        confirmedAt: string | null;
      }>;
    }>("/v1/subscriptions");

    const claude = response.body.subscriptions.find((s) => s.merchantName === "Anthropic");
    expect(claude).toBeTruthy();
    expect(claude!.amount).toBe("20.00");
    expect(claude!.billingCycle).toBe("monthly");
    expect(claude!.nextRenewalAt).toContain("2026-08-12");
    expect(claude!.sourceType).toBe("email");
    // Resolved against the merchant graph rather than left as a loose string.
    expect(claude!.merchantId).toBeTruthy();
    expect(claude!.contentHash).toBeTruthy();
    // Parsed, not typed, so payment stays gated until the user confirms.
    expect(claude!.confirmedAt).toBeNull();
  });

  it("3. a re-forward of the same email is recognised as a duplicate", async () => {
    const before = await client.get<{ subscriptions: unknown[] }>("/v1/subscriptions");

    const response = await client.webhook<{ status: string }>(
      "/v1/webhooks/mail/mailgun",
      mailgunPayload({ "Message-Id": "<different-envelope@forwarder.test>" }),
    );

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("duplicate");

    const after = await client.get<{ subscriptions: unknown[] }>("/v1/subscriptions");
    // A forward rewrites the envelope but not the body, so no second row.
    expect(after.body.subscriptions).toHaveLength(before.body.subscriptions.length);

    const audit = await client.get<{ events: Array<{ type: string }> }>(
      "/v1/audit?type=mail.duplicate&limit=10",
    );
    expect(audit.body.events.length).toBeGreaterThan(0);
  });

  it("4. a genuine price change updates the row and re-gates payment", async () => {
    const before = await client.get<{
      subscriptions: Array<{ id: string; merchantName: string; amount: string }>;
    }>("/v1/subscriptions");
    const claudeId = before.body.subscriptions.find((s) => s.merchantName === "Anthropic")!.id;

    // Confirm first, so the re-gating is observable.
    await client.post(`/v1/subscriptions/${claudeId}/confirm`, {});

    const raised = fixture("emails/claude-pro-renewal.txt")
      .replace(/\$20\.00/g, "$25.00")
      .replace("Total: $25.00", "Total: $25.00");

    const response = await client.webhook<{ status: string; subscriptionId: string }>(
      "/v1/webhooks/mail/mailgun",
      mailgunPayload({
        "body-plain": raised,
        "Message-Id": "<anthropic-price-change@anthropic.com>",
      }),
    );

    expect(response.status).toBe(201);
    expect(response.body.subscriptionId).toBe(claudeId);

    const after = await client.get<{
      subscription: { amount: string; confirmedAt: string | null };
    }>(`/v1/subscriptions/${claudeId}`);

    expect(after.body.subscription.amount).toBe("25.00");
    // The user approved the old number, not this one.
    expect(after.body.subscription.confirmedAt).toBeNull();
  });

  it("5. a second merchant creates a second subscription", async () => {
    const response = await client.webhook<{ status: string; subscriptionId: string }>(
      "/v1/webhooks/mail/mailgun",
      mailgunPayload({
        "body-plain": fixture("emails/midjourney-receipt.txt"),
        "Message-Id": "<midjourney-receipt-1@midjourney.com>",
        from: "Midjourney <no-reply@midjourney.com>",
      }),
    );

    expect(response.status).toBe(201);

    const subscriptions = await client.get<{
      subscriptions: Array<{ merchantName: string; amount: string }>;
    }>("/v1/subscriptions");

    const midjourney = subscriptions.body.subscriptions.find(
      (s) => s.merchantName === "Midjourney",
    );
    expect(midjourney?.amount).toBe("30.00");
  });

  it("6. the audit records every message that arrived", async () => {
    const audit = await client.get<{ events: Array<{ type: string }> }>("/v1/audit?limit=200");
    const types = audit.body.events.map((e) => e.type);

    expect(types).toContain("mail.received");
    expect(types).toContain("renewal.parsed");
    expect(types).toContain("mail.duplicate");
  });
});

describe("routing and verification", () => {
  it("drops a message with no routing token rather than guessing an owner", async () => {
    const response = await client.webhook<{ ok: boolean; reason: string }>(
      "/v1/webhooks/mail/mailgun",
      mailgunPayload({ recipient: "renew@inbound.renewly.app" }),
    );

    expect(response.status).toBe(200);
    expect(response.body.reason).toBe("NO_ROUTING_TOKEN");
  });

  it("drops a message for an unknown workspace token", async () => {
    const response = await client.webhook<{ ok: boolean; reason: string }>(
      "/v1/webhooks/mail/mailgun",
      mailgunPayload({ recipient: "renew+deadbeefdeadbeefdead@inbound.renewly.app" }),
    );

    expect(response.status).toBe(200);
    expect(response.body.reason).toBe("UNKNOWN_WORKSPACE");
  });

  it("does not route on the From header, which is forgeable", async () => {
    const other = new ApiClient(harness.app);
    const otherUser = await signUpWithChannel(other, { email: `other-${Date.now()}@test.com` });

    // Addressed to this workspace's token but claiming to be from the victim.
    await client.webhook("/v1/webhooks/mail/mailgun", {
      ...mailgunPayload({
        recipient: `renew+${inboundTokenFor(otherUser.workspaceId)}@inbound.renewly.app`,
        "Message-Id": "<routing-proof@test>",
      }),
    });

    // It landed in the workspace named by the token, not the sender.
    const victim = await other.get<{ subscriptions: unknown[] }>("/v1/subscriptions");
    expect(victim.body.subscriptions.length).toBe(1);
  });

  it("rejects an unparseable body", async () => {
    const response = await client.webhook(
      "/v1/webhooks/mail/mailgun",
      mailgunPayload({ "body-plain": "", text: "", html: "" }),
    );
    expect(response.status).toBe(400);
    expect(expectErrorCode(response.body)).toBe("VALIDATION_ERROR");
  });

  it("rejects a malformed JSON body", async () => {
    const response = await client.request("POST", "/v1/webhooks/mail/mailgun", {
      rawBody: "{not json",
      token: null,
    });
    expect(response.status).toBe(400);
  });
});

describe("signature verification in live mode", () => {
  // MAIL_MODE is mock in tests, so the verifier is driven directly. Each
  // provider signs something different; the shapes are covered in
  // src/modules/intake/mail/verify.test.ts.
  const secret = "key-3ax6xnjp29jd6fds4gc373sgvjxteol0";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const mailgunToken = "a8ce0edb2dd8301dee6c2405235584e45aa91d1e9f979f3de0";

  it("accepts a genuine Mailgun delivery", () => {
    expect(() =>
      verifyMailWebhook({
        provider: "mailgun",
        rawBody: "",
        payload: {
          ...mailgunPayload(),
          timestamp,
          token: mailgunToken,
          signature: hmacSha256(`${timestamp}${mailgunToken}`, secret),
        },
        headers: {},
        secret,
      }),
    ).not.toThrow();
  });

  it("refuses a payload an attacker assembled without the signing key", () => {
    expect(() =>
      verifyMailWebhook({
        provider: "mailgun",
        rawBody: "",
        payload: {
          ...mailgunPayload({ "body-plain": "Pay me instead" }),
          timestamp,
          token: mailgunToken,
          signature: hmacSha256(`${timestamp}${mailgunToken}`, "guessed-key"),
        },
        headers: {},
        secret,
      }),
    ).toThrowError(/did not verify/);
  });
});
