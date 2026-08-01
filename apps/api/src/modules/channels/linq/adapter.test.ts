import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinqChannelAdapter } from "./adapter.js";

/**
 * Asserted against the Partner API v3 reference:
 * https://docs.linqapp.com/guides/messaging/sending-messages
 * https://docs.linqapp.com/guides/webhooks
 */

const BASE = "https://api.linqapp.com/api/partner/v3";
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

function adapter(): LinqChannelAdapter {
  return new LinqChannelAdapter({
    mode: "live",
    apiKey: "linq_test_key",
    fromNumber: "+12223334444",
    webhookSecret: SECRET,
  });
}

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

function sentBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

/** Signs like Linq does, so the verifier is exercised end to end. */
function sign(body: string, id: string, timestamp: string): string {
  const key = Buffer.from(SECRET.slice(6), "base64");
  const digest = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return `v1,${digest}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("configuration", () => {
  it("requires an api key and a from number in live mode", () => {
    expect(() => new LinqChannelAdapter({ mode: "live", apiKey: "" })).toThrowError(
      /LINQ_API_KEY/,
    );
    expect(
      () => new LinqChannelAdapter({ mode: "live", apiKey: "k", fromNumber: "" }),
    ).toThrowError(/LINQ_FROM_NUMBER/);
  });

  it("upgrades a bare host to the versioned partner base path", async () => {
    const calls = stubFetch({ id: "chat_1", last_message: { id: "msg_1" } });
    const client = new LinqChannelAdapter({
      mode: "live",
      apiKey: "k",
      fromNumber: "+1",
      baseUrl: "https://api.linqapp.com",
    });

    await client.sendText({ to: "+15556667777", body: "hi" });

    expect(calls[0]?.url).toBe(`${BASE}/chats`);
  });
});

describe("sending", () => {
  it("starts a chat when there is no thread yet", async () => {
    const calls = stubFetch({
      id: "550e8400-e29b-41d4-a716-446655440000",
      is_group: false,
      last_message: { id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" },
    });

    const result = await adapter().sendText({ to: "+15556667777", body: "Hello from Linq!" });

    expect(calls[0]?.url).toBe(`${BASE}/chats`);
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      "Bearer linq_test_key",
    );
    expect(sentBody(calls[0]!.init)).toEqual({
      from: "+12223334444",
      to: ["+15556667777"],
      message: { parts: [{ type: "text", value: "Hello from Linq!" }] },
    });

    // The chat is the thread; the message id comes from the nested send.
    expect(result.externalThreadId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(result.externalMessageId).toBe("6ba7b810-9dad-11d1-80b4-00c04fd430c8");
    expect(result.delivered).toBe(true);
  });

  it("posts into an existing chat and does not resend from/to", async () => {
    const calls = stubFetch({ id: "msg_2" });

    const result = await adapter().sendText({
      to: "+15556667777",
      body: "Following up!",
      threadId: "chat_abc",
    });

    expect(calls[0]?.url).toBe(`${BASE}/chats/chat_abc/messages`);
    expect(sentBody(calls[0]!.init)).toEqual({
      message: { parts: [{ type: "text", value: "Following up!" }] },
    });
    expect(result.externalThreadId).toBe("chat_abc");
    expect(result.externalMessageId).toBe("msg_2");
  });

  it("sends a proposal as plain text, since iMessage has no buttons", async () => {
    const calls = stubFetch({ id: "chat_1", last_message: { id: "msg_1" } });

    await adapter().sendProposal({
      to: "+15556667777",
      proposal: { body: "Renew Claude Pro for $20.00?\nReply APPROVE · KEEP" },
      actions: [{ id: "approve", label: "Approve", value: "APPROVE" }],
    });

    const body = sentBody(calls[0]!.init) as { message: { parts: Array<{ value: string }> } };
    expect(body.message.parts[0]?.value).toContain("Reply APPROVE");
    expect(JSON.stringify(body)).not.toContain("metadata");
  });

  it("truncates a text part at the documented 10,000 characters", async () => {
    const calls = stubFetch({ id: "msg_2" });
    await adapter().sendText({ to: "+1", body: "x".repeat(12_000), threadId: "chat_abc" });

    const body = sentBody(calls[0]!.init) as { message: { parts: Array<{ value: string }> } };
    expect(body.message.parts[0]?.value).toHaveLength(10_000);
  });

  it("surfaces an error body rather than only the status", async () => {
    stubFetch({ error: { code: "invalid_recipient", message: "Not an iMessage number" } }, {
      status: 422,
    });

    await expect(adapter().sendText({ to: "+1", body: "hi" })).rejects.toMatchObject({
      code: "CHANNEL_SEND_FAILED",
      message: "Not an iMessage number",
      details: { status: 422, linqCode: "invalid_recipient" },
    });
  });
});

describe("verifyWebhook", () => {
  const body = '{"event_type":"message.received"}';
  const id = "evt_1";

  it("accepts a correctly signed delivery", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const parsed = adapter().verifyWebhook({
      rawBody: body,
      headers: {
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": sign(body, id, timestamp),
      },
    });
    expect(parsed.event_type).toBe("message.received");
  });

  it("rejects a tampered body", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    expect(() =>
      adapter().verifyWebhook({
        rawBody: '{"event_type":"message.received","injected":true}',
        headers: {
          "webhook-id": id,
          "webhook-timestamp": timestamp,
          "webhook-signature": sign(body, id, timestamp),
        },
      }),
    ).toThrowError(/did not verify/);
  });

  it("rejects a replayed delivery", () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    expect(() =>
      adapter().verifyWebhook({
        rawBody: body,
        headers: {
          "webhook-id": id,
          "webhook-timestamp": stale,
          "webhook-signature": sign(body, id, stale),
        },
      }),
    ).toThrowError(/did not verify/);
  });

  it("rejects a delivery with no signature headers at all", () => {
    expect(() => adapter().verifyWebhook({ rawBody: body, headers: {} })).toThrowError(
      /did not verify/,
    );
  });

  it("skips verification in mock mode, where there is no shared secret", () => {
    const mock = new LinqChannelAdapter({ mode: "mock" });
    expect(mock.verifyWebhook({ rawBody: body, headers: {} }).event_type).toBe("message.received");
  });
});

describe("parseInbound", () => {
  const messageReceived = {
    api_version: "v3",
    event_type: "message.received",
    event_id: "2915e81c",
    data: {
      chat: { id: "8f392755-6865-4b18-880a-227f9d8b458f", is_group: false },
      id: "89e3566e-1d13-49e5-a8ee-48490d5bfeb7",
      direction: "inbound",
      sender_handle: { handle: "+12025559876", is_me: false, service: "iMessage" },
      parts: [{ type: "text", value: "APPROVE" }],
      sent_at: "2026-02-05T19:31:13.074Z",
      service: "iMessage",
    },
  };

  it("reads a received message out of the v3 envelope", () => {
    const inbound = adapter().parseInbound(messageReceived);

    expect(inbound).toMatchObject({
      externalThreadId: "8f392755-6865-4b18-880a-227f9d8b458f",
      externalMessageId: "89e3566e-1d13-49e5-a8ee-48490d5bfeb7",
      from: "+12025559876",
      text: "APPROVE",
      tapback: null,
    });
    expect(inbound?.receivedAt.toISOString()).toBe("2026-02-05T19:31:13.074Z");
  });

  it("joins the text parts and ignores the others", () => {
    const inbound = adapter().parseInbound({
      ...messageReceived,
      data: {
        ...messageReceived.data,
        parts: [
          { type: "text", value: "Approve" },
          { type: "media", url: "https://example.com/a.png" },
          { type: "text", value: "please" },
        ],
      },
    });
    expect(inbound?.text).toBe("Approve please");
  });

  it("ignores our own outbound messages", () => {
    expect(
      adapter().parseInbound({
        ...messageReceived,
        event_type: "message.sent",
      }),
    ).toBeNull();

    expect(
      adapter().parseInbound({
        ...messageReceived,
        data: {
          ...messageReceived.data,
          direction: "outbound",
          sender_handle: { handle: "+12025551234", is_me: true },
        },
      }),
    ).toBeNull();
  });

  it("ignores receipts, typing indicators and every other event", () => {
    for (const eventType of [
      "message.delivered",
      "message.read",
      "message.failed",
      "chat.typing_indicator.started",
      "connection.created",
    ]) {
      expect(adapter().parseInbound({ ...messageReceived, event_type: eventType })).toBeNull();
    }
  });

  it("reads a tapback as a reaction event", () => {
    const inbound = adapter().parseInbound({
      event_type: "reaction.added",
      data: {
        chat_id: "550e8400-e29b-41d4-a716-446655440000",
        message_id: "550e8400-e29b-41d4-a716-446655440001",
        part_index: 0,
        reaction_type: "love",
        custom_emoji: null,
        is_from_me: false,
        from: "+14155559876",
        from_handle: { handle: "+14155559876", is_me: false },
        reacted_at: "2025-11-23T17:35:00.000Z",
      },
    });

    // "love" is a word the intent parser already reads as approval.
    expect(inbound).toMatchObject({
      externalThreadId: "550e8400-e29b-41d4-a716-446655440000",
      from: "+14155559876",
      text: "",
      tapback: "love",
    });
  });

  it("prefers the emoji on a custom reaction", () => {
    const inbound = adapter().parseInbound({
      event_type: "reaction.added",
      data: {
        chat_id: "chat_1",
        message_id: "msg_1",
        reaction_type: "custom",
        custom_emoji: "👍",
        is_from_me: false,
        from: "+14155559876",
      },
    });
    expect(inbound?.tapback).toBe("👍");
  });

  it("ignores a reaction we sent ourselves", () => {
    expect(
      adapter().parseInbound({
        event_type: "reaction.added",
        data: { chat_id: "c", message_id: "m", reaction_type: "love", is_from_me: true, from: "+1" },
      }),
    ).toBeNull();
  });

  it("returns null rather than throwing on a payload it does not recognise", () => {
    expect(adapter().parseInbound({})).toBeNull();
    expect(adapter().parseInbound({ event_type: "message.received" })).toBeNull();
    expect(
      adapter().parseInbound({ event_type: "message.received", data: { parts: [] } }),
    ).toBeNull();
  });
});
