import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hmacSha256 } from "../../../lib/crypto.js";
import { mailProviderFrom, parseMailPayload, verifyMailWebhook } from "./verify.js";

const SVIX_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const MAILGUN_KEY = "key-3ax6xnjp29jd6fds4gc373sgvjxteol0";

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

function svixSignature(body: string, id: string, timestamp: string, secret = SVIX_SECRET): string {
  const key = Buffer.from(secret.slice(6), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

describe("mailProviderFrom", () => {
  it("recognises the providers with their own signing schemes", () => {
    expect(mailProviderFrom("mailgun")).toBe("mailgun");
    expect(mailProviderFrom("Mailgun")).toBe("mailgun");
    expect(mailProviderFrom("resend")).toBe("resend");
    expect(mailProviderFrom("svix")).toBe("resend");
    expect(mailProviderFrom("postmark")).toBe("generic");
  });
});

describe("parseMailPayload", () => {
  it("parses the form encoding Mailgun's inbound routes post", () => {
    const body = new URLSearchParams({
      recipient: "renew+abc@inbound.renewly.app",
      "body-plain": "Your plan renews on 1 August.",
      timestamp: "1529006854",
    }).toString();

    expect(parseMailPayload(body, "application/x-www-form-urlencoded", "mailgun")).toEqual({
      recipient: "renew+abc@inbound.renewly.app",
      "body-plain": "Your plan renews on 1 August.",
      timestamp: "1529006854",
    });
  });

  it("parses JSON for everyone else", () => {
    expect(parseMailPayload('{"to":"a@b.c"}', "application/json", "resend")).toEqual({
      to: "a@b.c",
    });
  });

  it("rejects a body that is not an object", () => {
    expect(() => parseMailPayload("[1,2]", "application/json", "resend")).toThrowError(
      /not valid JSON/,
    );
    expect(() => parseMailPayload("{not json", "application/json", "resend")).toThrowError(
      /not valid JSON/,
    );
    expect(() => parseMailPayload("", "application/x-www-form-urlencoded", "mailgun")).toThrowError(
      /empty/,
    );
  });
});

describe("verifyMailWebhook: mailgun", () => {
  const timestamp = "1529006854";
  const token = "a8ce0edb2dd8301dee6c2405235584e45aa91d1e9f979f3de0";
  const now = new Date(Number(timestamp) * 1000);
  const signature = hmacSha256(`${timestamp}${token}`, MAILGUN_KEY);

  it("accepts fields signed over timestamp and token", () => {
    expect(() =>
      verifyMailWebhook({
        provider: "mailgun",
        rawBody: "ignored",
        payload: { timestamp, token, signature, recipient: "renew+abc@inbound.renewly.app" },
        headers: {},
        secret: MAILGUN_KEY,
        now,
      }),
    ).not.toThrow();
  });

  it("accepts the nested shape that store-and-notify posts", () => {
    expect(() =>
      verifyMailWebhook({
        provider: "mailgun",
        rawBody: "ignored",
        payload: { signature: { timestamp, token, signature } },
        headers: {},
        secret: MAILGUN_KEY,
        now,
      }),
    ).not.toThrow();
  });

  it("rejects a forged signature", () => {
    expect(() =>
      verifyMailWebhook({
        provider: "mailgun",
        rawBody: "ignored",
        payload: { timestamp, token, signature: "0".repeat(64) },
        headers: {},
        secret: MAILGUN_KEY,
        now,
      }),
    ).toThrowError(/did not verify/);
  });

  it("rejects a payload with no signature fields", () => {
    expect(() =>
      verifyMailWebhook({
        provider: "mailgun",
        rawBody: "ignored",
        payload: { recipient: "renew+abc@inbound.renewly.app" },
        headers: {},
        secret: MAILGUN_KEY,
        now,
      }),
    ).toThrowError(/no signature fields/);
  });

  it("does not accept a header-based signature for mailgun", () => {
    // The old implementation checked x-mailgun-signature against a body HMAC,
    // which Mailgun never sends.
    expect(() =>
      verifyMailWebhook({
        provider: "mailgun",
        rawBody: "body",
        payload: { recipient: "a@b.c" },
        headers: { "x-webhook-signature": hmacSha256("body", MAILGUN_KEY) },
        secret: MAILGUN_KEY,
        now,
      }),
    ).toThrowError(/no signature fields/);
  });
});

describe("verifyMailWebhook: resend", () => {
  const body = '{"type":"email.delivered"}';
  const id = "msg_1";

  it("accepts a Standard Webhooks signature on the svix headers", () => {
    const timestamp = nowSeconds();
    expect(() =>
      verifyMailWebhook({
        provider: "resend",
        rawBody: body,
        payload: {},
        headers: {
          "svix-id": id,
          "svix-timestamp": timestamp,
          "svix-signature": svixSignature(body, id, timestamp),
        },
        secret: SVIX_SECRET,
      }),
    ).not.toThrow();
  });

  it("accepts the vendor-neutral webhook-* headers too", () => {
    const timestamp = nowSeconds();
    expect(() =>
      verifyMailWebhook({
        provider: "resend",
        rawBody: body,
        payload: {},
        headers: {
          "webhook-id": id,
          "webhook-timestamp": timestamp,
          "webhook-signature": svixSignature(body, id, timestamp),
        },
        secret: SVIX_SECRET,
      }),
    ).not.toThrow();
  });

  it("rejects a hex body HMAC, which is what the old check computed", () => {
    const timestamp = nowSeconds();
    expect(() =>
      verifyMailWebhook({
        provider: "resend",
        rawBody: body,
        payload: {},
        headers: {
          "svix-id": id,
          "svix-timestamp": timestamp,
          "svix-signature": `v1,${hmacSha256(body, SVIX_SECRET)}`,
        },
        secret: SVIX_SECRET,
      }),
    ).toThrowError(/did not verify/);
  });

  it("rejects a stale delivery", () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    expect(() =>
      verifyMailWebhook({
        provider: "resend",
        rawBody: body,
        payload: {},
        headers: {
          "svix-id": id,
          "svix-timestamp": stale,
          "svix-signature": svixSignature(body, id, stale),
        },
        secret: SVIX_SECRET,
      }),
    ).toThrowError(/did not verify/);
  });
});

describe("verifyMailWebhook: generic forwarder", () => {
  const body = '{"to":"renew+abc@inbound.renewly.app"}';

  it("accepts a hex HMAC of the raw body", () => {
    expect(() =>
      verifyMailWebhook({
        provider: "my-forwarder",
        rawBody: body,
        payload: {},
        headers: { "x-webhook-signature": hmacSha256(body, "shared-secret") },
        secret: "shared-secret",
      }),
    ).not.toThrow();
  });

  it("rejects an unsigned delivery", () => {
    expect(() =>
      verifyMailWebhook({
        provider: "my-forwarder",
        rawBody: body,
        payload: {},
        headers: {},
        secret: "shared-secret",
      }),
    ).toThrowError(/did not verify/);
  });
});
