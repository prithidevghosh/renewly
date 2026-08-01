import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hmacSha256,
  verifyHmacSignature,
  verifyMailgunSignature,
  verifyStandardWebhook,
} from "./crypto.js";

describe("verifyStandardWebhook", () => {
  // The published Svix vector, so this checks our implementation against
  // theirs rather than against itself.
  const secret = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const id = "msg_p5jXN8AQM9LWM0D4loKWxJek";
  const timestamp = "1614265330";
  const body = '{"test": 2432232314}';
  const signature = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";
  const now = new Date(Number(timestamp) * 1000);

  it("accepts the reference signature", () => {
    expect(verifyStandardWebhook(body, { id, timestamp, signature }, secret, { now })).toBe(true);
  });

  it("accepts a rotation, where the header carries two signatures", () => {
    const header = `v1,bogusbogusbogusbogusbogusbogusbogusbogusbg= ${signature}`;
    expect(
      verifyStandardWebhook(body, { id, timestamp, signature: header }, secret, { now }),
    ).toBe(true);
  });

  it("rejects a body that changed by one byte", () => {
    expect(
      verifyStandardWebhook('{"test": 2432232315}', { id, timestamp, signature }, secret, { now }),
    ).toBe(false);
  });

  it("rejects a different message id, which is part of the signed content", () => {
    expect(
      verifyStandardWebhook(body, { id: "msg_other", timestamp, signature }, secret, { now }),
    ).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(
      verifyStandardWebhook(body, { id, timestamp, signature }, "whsec_AAAAAAAAAAAAAAAAAAAAAAAA", {
        now,
      }),
    ).toBe(false);
  });

  it("rejects a replay outside the tolerance window", () => {
    const late = new Date((Number(timestamp) + 400) * 1000);
    expect(verifyStandardWebhook(body, { id, timestamp, signature }, secret, { now: late })).toBe(
      false,
    );
  });

  it("accepts a delivery inside the tolerance window", () => {
    const slightlyLate = new Date((Number(timestamp) + 120) * 1000);
    expect(
      verifyStandardWebhook(body, { id, timestamp, signature }, secret, { now: slightlyLate }),
    ).toBe(true);
  });

  it("rejects an unversioned or unknown-version signature", () => {
    const raw = signature.slice(3);
    expect(verifyStandardWebhook(body, { id, timestamp, signature: raw }, secret, { now })).toBe(
      false,
    );
    expect(
      verifyStandardWebhook(body, { id, timestamp, signature: `v2,${raw}` }, secret, { now }),
    ).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(
      verifyStandardWebhook(body, { id: undefined, timestamp, signature }, secret, { now }),
    ).toBe(false);
    expect(
      verifyStandardWebhook(body, { id, timestamp: undefined, signature }, secret, { now }),
    ).toBe(false);
    expect(
      verifyStandardWebhook(body, { id, timestamp, signature: undefined }, secret, { now }),
    ).toBe(false);
  });

  it("rejects a non-numeric timestamp", () => {
    expect(
      verifyStandardWebhook(body, { id, timestamp: "not-a-time", signature }, secret, { now }),
    ).toBe(false);
  });

  it("keys on the decoded secret, not its characters", () => {
    // A hex digest over the literal secret string is what a naive
    // implementation produces, and it must not verify.
    const naive = createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`).digest("hex");
    expect(
      verifyStandardWebhook(body, { id, timestamp, signature: `v1,${naive}` }, secret, { now }),
    ).toBe(false);
  });
});

describe("verifyMailgunSignature", () => {
  const signingKey = "key-3ax6xnjp29jd6fds4gc373sgvjxteol0";
  const timestamp = "1529006854";
  const token = "a8ce0edb2dd8301dee6c2405235584e45aa91d1e9f979f3de0";
  const now = new Date(Number(timestamp) * 1000);
  const signature = hmacSha256(`${timestamp}${token}`, signingKey);

  it("accepts a signature over timestamp and token", () => {
    expect(verifyMailgunSignature({ timestamp, token, signature }, signingKey, { now })).toBe(true);
  });

  it("rejects the wrong signing key", () => {
    expect(verifyMailgunSignature({ timestamp, token, signature }, "key-wrong", { now })).toBe(
      false,
    );
  });

  it("rejects a reused token from an old delivery", () => {
    const late = new Date((Number(timestamp) + 3600) * 1000);
    expect(verifyMailgunSignature({ timestamp, token, signature }, signingKey, { now: late })).toBe(
      false,
    );
  });

  it("rejects a signature computed over the body instead", () => {
    const wrong = hmacSha256('{"recipient":"renew+abc@inbound.renewly.app"}', signingKey);
    expect(verifyMailgunSignature({ timestamp, token, signature: wrong }, signingKey, { now })).toBe(
      false,
    );
  });
});

describe("verifyHmacSignature", () => {
  it("accepts a hex digest with or without the sha256= prefix", () => {
    const digest = hmacSha256("body", "secret");
    expect(verifyHmacSignature("body", digest, "secret")).toBe(true);
    expect(verifyHmacSignature("body", `sha256=${digest}`, "secret")).toBe(true);
  });

  it("rejects a missing signature rather than passing on absence", () => {
    expect(verifyHmacSignature("body", undefined, "secret")).toBe(false);
    expect(verifyHmacSignature("body", null, "secret")).toBe(false);
    expect(verifyHmacSignature("body", "", "secret")).toBe(false);
  });
});
