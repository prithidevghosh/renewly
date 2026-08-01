import { env } from "../../../env.js";
import { AppError } from "../../../lib/errors.js";
import { verifyHmacSignature } from "../../../lib/crypto.js";
import { newId } from "../../../lib/id.js";
import type {
  ChannelAdapter,
  InboundMessage,
  SendProposalInput,
  SendResult,
  SendTextInput,
  VerifyInput,
} from "../types.js";

/**
 * WhatsApp Cloud API. Unlike iMessage this platform does have native reply
 * buttons, so `sendProposal` renders up to three of them — the Cloud API's
 * limit — and still puts the full text in the body for anyone who types.
 */

interface WhatsAppSendResponse {
  messages?: Array<{ id?: string }>;
  contacts?: Array<{ wa_id?: string }>;
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    error_data?: { details?: string };
    fbtrace_id?: string;
  };
}

/** Reply button limits from the interactive-message reference. */
const MAX_BUTTONS = 3;
const MAX_BUTTON_TITLE = 20;
const MAX_BUTTON_ID = 256;

export class WhatsAppChannelAdapter implements ChannelAdapter {
  readonly channel = "whatsapp" as const;
  readonly mode: "mock" | "live";

  private readonly token: string | undefined;
  private readonly phoneNumberId: string | undefined;
  private readonly appSecret: string | undefined;
  private counter = 0;

  constructor(options?: {
    mode?: "mock" | "live";
    token?: string;
    phoneNumberId?: string;
    appSecret?: string;
  }) {
    this.mode = options?.mode ?? env.WHATSAPP_MODE;
    this.token = options?.token ?? env.WHATSAPP_TOKEN;
    this.phoneNumberId = options?.phoneNumberId ?? env.WHATSAPP_PHONE_NUMBER_ID;
    this.appSecret = options?.appSecret ?? env.WHATSAPP_APP_SECRET;

    if (this.mode === "live" && (!this.token || !this.phoneNumberId)) {
      throw new AppError(
        "CHANNEL_NOT_CONNECTED",
        "WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required when WHATSAPP_MODE=live",
      );
    }
  }

  async sendText(input: SendTextInput): Promise<SendResult> {
    return this.post(input.to, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "text",
      text: { body: input.body, preview_url: true },
    });
  }

  async sendProposal(input: SendProposalInput): Promise<SendResult> {
    // Three buttons, 20-character titles that must be unique, 256-character
    // ids. Anything longer is rejected outright, so it is trimmed here rather
    // than discovered as a 400 in production.
    const seen = new Set<string>();
    const buttons = input.actions
      .map((action) => ({
        type: "reply",
        reply: {
          id: action.value.slice(0, MAX_BUTTON_ID),
          title: action.label.slice(0, MAX_BUTTON_TITLE),
        },
      }))
      .filter((button) => {
        const key = button.reply.title.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_BUTTONS);

    return this.post(input.to, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: input.proposal.body },
        action: { buttons },
      },
    });
  }

  private async post(to: string, body: Record<string, unknown>): Promise<SendResult> {
    if (this.mode === "mock") {
      this.counter += 1;
      return {
        externalMessageId: `wa_mock_${Date.now().toString(36)}_${this.counter}`,
        externalThreadId: `wa_thread_${to}`,
        delivered: true,
      };
    }

    let response: Response;
    try {
      response = await fetch(
        `https://graph.facebook.com/${env.WHATSAPP_GRAPH_VERSION}/${this.phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
    } catch (error) {
      throw new AppError("CHANNEL_SEND_FAILED", "Could not reach the WhatsApp Cloud API", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const payload = (await response.json().catch(() => ({}))) as WhatsAppSendResponse;
    if (!response.ok) {
      // Graph errors carry the useful part in the body; fbtrace_id is what
      // Meta support asks for.
      throw new AppError(
        "CHANNEL_SEND_FAILED",
        payload.error?.message ?? `WhatsApp returned ${response.status}`,
        {
          status: response.status,
          whatsappCode: payload.error?.code ?? null,
          whatsappSubcode: payload.error?.error_subcode ?? null,
          details: payload.error?.error_data?.details ?? null,
          fbtraceId: payload.error?.fbtrace_id ?? null,
        },
      );
    }

    return {
      externalMessageId: payload.messages?.[0]?.id ?? newId("msg"),
      externalThreadId: `wa_thread_${to}`,
      delivered: true,
    };
  }

  verifyWebhook(input: VerifyInput): Record<string, unknown> {
    if (this.mode === "live") {
      if (!this.appSecret) {
        throw new AppError("WEBHOOK_INVALID_SIGNATURE", "WHATSAPP_APP_SECRET is not configured");
      }
      // Meta signs with sha256= over the exact raw body.
      const signature = input.headers["x-hub-signature-256"];
      if (!verifyHmacSignature(input.rawBody, signature, this.appSecret)) {
        throw new AppError(
          "WEBHOOK_INVALID_SIGNATURE",
          "WhatsApp webhook signature did not verify",
        );
      }
    }

    try {
      return JSON.parse(input.rawBody) as Record<string, unknown>;
    } catch {
      throw new AppError("WEBHOOK_INVALID_SIGNATURE", "WhatsApp webhook body was not valid JSON");
    }
  }

  parseInbound(payload: Record<string, unknown>): InboundMessage | null {
    // entry[].changes[].value.messages[] — status callbacks share the envelope
    // and carry no `messages`, so they fall through to null.
    const entry = asArray(payload.entry)[0] as Record<string, unknown> | undefined;
    const change = asArray(entry?.changes)[0] as Record<string, unknown> | undefined;
    const value = (change?.value ?? {}) as Record<string, unknown>;
    const message = asArray(value.messages)[0] as Record<string, unknown> | undefined;
    if (!message) return null;

    const from = typeof message.from === "string" ? message.from : null;
    if (!from) return null;

    let text = "";
    if (message.type === "text") {
      const textBody = (message.text ?? {}) as Record<string, unknown>;
      text = typeof textBody.body === "string" ? textBody.body : "";
    } else if (message.type === "interactive") {
      const interactive = (message.interactive ?? {}) as Record<string, unknown>;
      const reply = (interactive.button_reply ?? interactive.list_reply ?? {}) as Record<
        string,
        unknown
      >;
      // The button id is the literal reply word, so taps and typing converge.
      text = typeof reply.id === "string" ? reply.id : "";
    } else if (message.type === "button") {
      const button = (message.button ?? {}) as Record<string, unknown>;
      text = typeof button.text === "string" ? button.text : "";
    }

    const reaction = (message.reaction ?? {}) as Record<string, unknown>;
    const tapback = typeof reaction.emoji === "string" ? reaction.emoji : null;

    if (!text && !tapback) return null;

    return {
      externalThreadId: `wa_thread_${from}`,
      externalMessageId: typeof message.id === "string" ? message.id : newId("msg"),
      from,
      text,
      tapback,
      receivedAt: new Date(),
      raw: payload,
    };
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
