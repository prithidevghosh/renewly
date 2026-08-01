import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "../../../env.js";
import { hmacSha256 } from "../../../lib/crypto.js";
import { WhatsAppChannelAdapter } from "./adapter.js";
import { PROPOSAL_ACTIONS } from "../types.js";

/**
 * Asserted against the Cloud API reference:
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages
 */

const APP_SECRET = "app_secret_value";

function adapter(): WhatsAppChannelAdapter {
  return new WhatsAppChannelAdapter({
    mode: "live",
    token: "EAAG_token",
    phoneNumberId: "123456789",
    appSecret: APP_SECRET,
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendText", () => {
  it("posts the documented text message shape to the configured graph version", async () => {
    const calls = stubFetch({ messages: [{ id: "wamid.abc" }] });

    const result = await adapter().sendText({ to: "+16505551234", body: "Hello" });

    expect(calls[0]?.url).toBe(
      `https://graph.facebook.com/${env.WHATSAPP_GRAPH_VERSION}/123456789/messages`,
    );
    expect(sentBody(calls[0]!.init)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+16505551234",
      type: "text",
      text: { body: "Hello", preview_url: true },
    });
    expect(result.externalMessageId).toBe("wamid.abc");
  });

  it("pins a supported graph version", () => {
    // Versions expire about two years after release; an expired one 400s.
    expect(env.WHATSAPP_GRAPH_VERSION).toMatch(/^v\d+\.\d+$/);
    expect(Number(env.WHATSAPP_GRAPH_VERSION.slice(1))).toBeGreaterThanOrEqual(21);
  });
});

describe("sendProposal", () => {
  it("renders reply buttons whose ids are the reply words", async () => {
    const calls = stubFetch({ messages: [{ id: "wamid.abc" }] });

    await adapter().sendProposal({
      to: "+16505551234",
      proposal: { body: "Renew Claude Pro for $20.00?" },
      actions: PROPOSAL_ACTIONS,
    });

    const body = sentBody(calls[0]!.init) as {
      recipient_type: string;
      interactive: { action: { buttons: Array<{ reply: { id: string; title: string } }> } };
    };

    expect(body.recipient_type).toBe("individual");
    // Four actions exist but the API takes three.
    expect(body.interactive.action.buttons).toHaveLength(3);
    expect(body.interactive.action.buttons[0]?.reply).toEqual({
      id: "APPROVE",
      title: "Approve",
    });
  });

  it("truncates a title to 20 characters instead of taking a 400", async () => {
    const calls = stubFetch({ messages: [{ id: "wamid.abc" }] });

    await adapter().sendProposal({
      to: "+1",
      proposal: { body: "body" },
      actions: [
        { id: "a", label: "Approve this renewal right now please", value: "APPROVE" },
      ],
    });

    const body = sentBody(calls[0]!.init) as {
      interactive: { action: { buttons: Array<{ reply: { title: string } }> } };
    };
    expect(body.interactive.action.buttons[0]?.reply.title).toBe("Approve this renewal");
  });

  it("drops duplicate titles, which the API rejects outright", async () => {
    const calls = stubFetch({ messages: [{ id: "wamid.abc" }] });

    await adapter().sendProposal({
      to: "+1",
      proposal: { body: "body" },
      actions: [
        { id: "a", label: "Approve", value: "APPROVE" },
        { id: "b", label: "approve", value: "APPROVE_2" },
        { id: "c", label: "Keep", value: "KEEP" },
      ],
    });

    const body = sentBody(calls[0]!.init) as {
      interactive: { action: { buttons: Array<{ reply: { title: string } }> } };
    };
    expect(body.interactive.action.buttons.map((b) => b.reply.title)).toEqual(["Approve", "Keep"]);
  });
});

describe("errors", () => {
  it("surfaces the graph error message and fbtrace_id", async () => {
    stubFetch(
      {
        error: {
          message: "(#131009) Parameter value is not valid",
          code: 131009,
          error_subcode: 2494010,
          error_data: { details: "Button title exceeds 20 characters" },
          fbtrace_id: "AbCdEf123",
        },
      },
      { status: 400 },
    );

    await expect(adapter().sendText({ to: "+1", body: "hi" })).rejects.toMatchObject({
      code: "CHANNEL_SEND_FAILED",
      message: "(#131009) Parameter value is not valid",
      details: { whatsappCode: 131009, fbtraceId: "AbCdEf123" },
    });
  });
});

describe("verifyWebhook", () => {
  const body = '{"object":"whatsapp_business_account"}';

  it("accepts Meta's sha256= hex signature over the raw body", () => {
    const parsed = adapter().verifyWebhook({
      rawBody: body,
      headers: { "x-hub-signature-256": `sha256=${hmacSha256(body, APP_SECRET)}` },
    });
    expect(parsed.object).toBe("whatsapp_business_account");
  });

  it("rejects a body signed with another secret", () => {
    expect(() =>
      adapter().verifyWebhook({
        rawBody: body,
        headers: { "x-hub-signature-256": `sha256=${hmacSha256(body, "wrong")}` },
      }),
    ).toThrowError(/did not verify/);
  });

  it("rejects a missing signature header", () => {
    expect(() => adapter().verifyWebhook({ rawBody: body, headers: {} })).toThrowError(
      /did not verify/,
    );
  });
});

describe("parseInbound", () => {
  const envelope = (message: Record<string, unknown>) => ({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "16505551111", phone_number_id: "123456789" },
              messages: [message],
            },
          },
        ],
      },
    ],
  });

  it("reads a plain text reply", () => {
    const inbound = adapter().parseInbound(
      envelope({ from: "16505551234", id: "wamid.1", type: "text", text: { body: "APPROVE" } }),
    );
    expect(inbound).toMatchObject({ from: "16505551234", text: "APPROVE", tapback: null });
  });

  it("reads a button tap as the reply word it stands for", () => {
    const inbound = adapter().parseInbound(
      envelope({
        from: "16505551234",
        id: "wamid.2",
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "APPROVE", title: "Approve" } },
      }),
    );
    expect(inbound?.text).toBe("APPROVE");
  });

  it("reads a reaction as a tapback", () => {
    const inbound = adapter().parseInbound(
      envelope({
        from: "16505551234",
        id: "wamid.3",
        type: "reaction",
        reaction: { message_id: "wamid.1", emoji: "👍" },
      }),
    );
    expect(inbound?.tapback).toBe("👍");
  });

  it("ignores status callbacks, which share the envelope", () => {
    expect(
      adapter().parseInbound({
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              { field: "messages", value: { statuses: [{ id: "wamid.1", status: "delivered" }] } },
            ],
          },
        ],
      }),
    ).toBeNull();
  });
});
