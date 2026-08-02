import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "./errors.js";
import {
  sendEmail,
  sendViaResend,
  setMailTransport,
  type ResendConfig,
} from "./mailer.js";
import { captureTransport, clearMailbox, readMailbox } from "../test/doubles/mailer.js";

/**
 * Mock mode is what every other test runs against, so the wire contract for the
 * live path is asserted here against what the provider documents:
 * https://resend.com/docs/api-reference/emails/send-email
 */

const config: ResendConfig = { apiKey: "re_test_key", from: "Renewly <hello@renewly.app>" };

const message = {
  to: "founder@example.com",
  subject: "You are on the Renewly waitlist",
  html: "<p>Hello</p>",
  text: "Hello",
};

function stubFetch(body: unknown, init: { status?: number } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, requestInit) => {
    calls.push({ url: String(url), init: (requestInit ?? {}) as RequestInit });
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
  setMailTransport(null);
  clearMailbox();
});

describe("sendViaResend", () => {
  it("posts the documented body with a bearer key", async () => {
    const calls = stubFetch({ id: "b7e1-…" });

    const result = await sendViaResend(message, config);

    expect(result).toEqual({ id: "b7e1-…", mode: "live" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    expect(calls[0]?.init.method).toBe("POST");

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer re_test_key");
    expect(headers["content-type"]).toBe("application/json");

    const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    // `to` is an array even for one recipient, and both bodies are sent so the
    // client can pick.
    expect(sent).toMatchObject({
      from: "Renewly <hello@renewly.app>",
      to: ["founder@example.com"],
      subject: "You are on the Renewly waitlist",
      html: "<p>Hello</p>",
      text: "Hello",
    });
    expect(sent).not.toHaveProperty("reply_to");
  });

  it("sends reply_to only when one is configured", async () => {
    const calls = stubFetch({ id: "1" });
    await sendViaResend(message, { ...config, replyTo: "team@renewly.app" });

    const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(sent.reply_to).toBe("team@renewly.app");
  });

  it("prefers a per-message reply-to over the configured one", async () => {
    const calls = stubFetch({ id: "1" });
    await sendViaResend(
      { ...message, replyTo: "founders@renewly.app" },
      { ...config, replyTo: "team@renewly.app" },
    );

    const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(sent.reply_to).toBe("founders@renewly.app");
  });

  it("surfaces a provider rejection as CHANNEL_SEND_FAILED", async () => {
    stubFetch({ name: "validation_error", message: "The from address is not verified" }, { status: 422 });

    const error = await sendViaResend(message, config).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("CHANNEL_SEND_FAILED");
    expect((error as AppError).status).toBe(502);
    expect((error as AppError).message).toBe("The from address is not verified");
    expect((error as AppError).details).toMatchObject({
      status: 422,
      providerError: "validation_error",
    });
  });

  it("surfaces an unreachable provider as CHANNEL_SEND_FAILED", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const error = await sendViaResend(message, config).catch((e: unknown) => e);

    expect((error as AppError).code).toBe("CHANNEL_SEND_FAILED");
    expect((error as AppError).details.cause).toBe("ECONNREFUSED");
  });

  it("falls back to a local id when the provider returns none", async () => {
    stubFetch({});
    const result = await sendViaResend(message, config);
    expect(result.id).toMatch(/^eml_/);
  });
});

describe("sendEmail", () => {
  it("refuses rather than pretending when outbound mail is disabled", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // No transport installed and MAIL_OUTBOUND_MODE=disabled. There used to be a
    // mock mode here that filed the message in memory and reported success,
    // which meant a signup could complete while the verification code reached
    // nobody. Refusing is the behaviour that cannot be mistaken for delivery.
    await expect(sendEmail(message)).rejects.toMatchObject({ code: "FEATURE_DISABLED" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readMailbox()).toHaveLength(0);
  });

  it("captures when a capture transport is installed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    setMailTransport(captureTransport());

    const result = await sendEmail(message);

    expect(result.mode).toBe("transport");
    expect(result.id).toMatch(/^eml_/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readMailbox()).toHaveLength(1);
    expect(readMailbox().at(-1)).toMatchObject({ to: "founder@example.com", text: "Hello" });
  });

  it("hands off to an installed transport instead", async () => {
    const seen: string[] = [];
    setMailTransport(async (email) => {
      seen.push(email.to);
      return { id: "stub", mode: "transport" as const };
    });

    await sendEmail(message);

    expect(seen).toEqual(["founder@example.com"]);
    expect(readMailbox()).toHaveLength(0);
  });
});
