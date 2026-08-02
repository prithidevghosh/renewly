import { env } from "../../../env.js";
import { AppError } from "../../../lib/errors.js";
import { verifyStandardWebhook } from "../../../lib/crypto.js";
import { newId } from "../../../lib/id.js";
import { logger } from "../../../lib/logger.js";
import type {
  ChannelAdapter,
  InboundMessage,
  SendProposalInput,
  SendResult,
  SendTextInput,
  VerifyInput,
} from "../types.js";

/**
 * Linq delivers iMessage, which is the channel the product is really designed
 * for: a founder already lives in it, and a tapback is a one-gesture approval.
 *
 * Written against the Partner API v3: https://docs.linqapp.com/api
 * A message either starts a chat (`POST /chats`, which needs the provisioned
 * `from` number) or continues one (`POST /chats/{chatId}/messages`). It has not
 * been exercised against a real key in this repo, so the mock is the default and
 * `LINQ_MODE=live` is the switch.
 */

/**
 * `POST /chats` returns the chat; the message it sent is nested inside it.
 *
 * The id has been observed at the top level and wrapped under `chat` or `data`,
 * so all three are read. Nothing here is required — see `send` for why a
 * missing id must not fail the call.
 */
interface LinqChatResponse {
  id?: string;
  chat_id?: string;
  chat?: { id?: string; last_message?: { id?: string } };
  data?: { id?: string; chat?: { id?: string }; last_message?: { id?: string } };
  last_message?: { id?: string; sent_at?: string };
}

/** Whichever shape the chat came back in. */
function readChatId(payload: LinqChatResponse): string | null {
  return (
    payload.id ??
    payload.chat?.id ??
    payload.data?.id ??
    payload.data?.chat?.id ??
    payload.chat_id ??
    null
  );
}

function readMessageId(payload: LinqChatResponse): string | null {
  return (
    payload.last_message?.id ??
    payload.chat?.last_message?.id ??
    payload.data?.last_message?.id ??
    null
  );
}

/** `POST /chats/{chatId}/messages` returns the message itself. */
interface LinqMessageResponse {
  id?: string;
  sent_at?: string;
}

interface LinqHandle {
  handle?: string;
  is_me?: boolean;
}

interface LinqMessagePart {
  type?: string;
  value?: string;
}

interface LinqMessageData {
  id?: string;
  direction?: string;
  chat?: { id?: string };
  sender_handle?: LinqHandle;
  parts?: LinqMessagePart[];
  sent_at?: string;
}

interface LinqReactionData {
  chat_id?: string;
  message_id?: string;
  reaction_type?: string;
  custom_emoji?: string | null;
  is_from_me?: boolean;
  from?: string;
  from_handle?: LinqHandle;
  reacted_at?: string;
}

/** The docs' base already carries the version, so paths are appended to it. */
const DEFAULT_BASE_URL = "https://api.linqapp.com/api/partner/v3";

export class LinqChannelAdapter implements ChannelAdapter {
  readonly channel = "imessage" as const;
  readonly mode: "live" | "disabled";

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly webhookSecret: string | undefined;
  private readonly fromNumber: string | undefined;
  private counter = 0;

  constructor(options?: {
    mode?: "live" | "disabled";
    baseUrl?: string;
    apiKey?: string;
    webhookSecret?: string;
    fromNumber?: string;
  }) {
    this.mode = options?.mode ?? env.LINQ_MODE;
    this.baseUrl = normalizeBaseUrl(options?.baseUrl ?? env.LINQ_BASE_URL);
    this.apiKey = stripBearer(options?.apiKey ?? env.LINQ_API_KEY);
    this.webhookSecret = options?.webhookSecret ?? env.LINQ_WEBHOOK_SECRET;
    this.fromNumber = options?.fromNumber ?? env.LINQ_FROM_NUMBER;

    if (this.mode === "live") {
      if (!this.apiKey) {
        throw new AppError("CHANNEL_NOT_CONNECTED", "LINQ_API_KEY is required when LINQ_MODE=live");
      }
      // Starting a chat requires a line provisioned on the Linq account.
      if (!this.fromNumber) {
        throw new AppError(
          "CHANNEL_NOT_CONNECTED",
          "LINQ_FROM_NUMBER is required when LINQ_MODE=live",
        );
      }
    }
  }

  async sendText(input: SendTextInput): Promise<SendResult> {
    return this.send(input.to, input.body, input.threadId);
  }

  async sendProposal(input: SendProposalInput): Promise<SendResult> {
    // iMessage has no native button rack. The composer already spells the reply
    // words out in the body, so the actions need no separate rendering — and the
    // Partner API has nowhere to put them.
    return this.send(input.to, input.proposal.body, input.threadId);
  }

  private async send(to: string, body: string, threadId: string | undefined): Promise<SendResult> {
    if (this.mode === "disabled") {
      this.counter += 1;
      return {
        externalMessageId: `linq_mock_${Date.now().toString(36)}_${this.counter}`,
        externalThreadId: threadId ?? `linq_thread_${to}`,
        delivered: true,
      };
    }

    // A text part is capped at 10,000 characters.
    const message = { parts: [{ type: "text", value: body.slice(0, 10_000) }] };

    if (threadId) {
      const payload = await this.post<LinqMessageResponse>(
        `/chats/${encodeURIComponent(threadId)}/messages`,
        { message },
      );
      return {
        externalMessageId: payload.id ?? newId("msg"),
        externalThreadId: threadId,
        delivered: true,
      };
    }

    const payload = await this.post<LinqChatResponse>("/chats", {
      from: this.fromNumber,
      to: [to],
      message,
    });

    /*
     * A 2xx here means Linq accepted the message and the recipient's phone has
     * it. The chat id is bookkeeping on top of that, so failing the send when
     * we cannot find one is precisely the wrong trade: the outbox retries, and
     * the user's phone buzzes again for every retry. That is what produced five
     * copies of every proposal. Warn, carry on, and fall back to a stable
     * per-recipient thread id.
     */
    const chatId = readChatId(payload);
    if (!chatId) {
      logger.warn(
        { to, received: Object.keys(payload) },
        "linq accepted the message but returned no chat id — threading falls back to the recipient",
      );
    }

    return {
      externalMessageId: readMessageId(payload) ?? newId("msg"),
      externalThreadId: chatId ?? `linq_thread_${to}`,
      delivered: true,
    };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new AppError("CHANNEL_SEND_FAILED", "Could not reach Linq", {
        path,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const payload = (await response.json().catch(() => ({}))) as T & {
      error?: { code?: string; message?: string };
      message?: string;
    };

    if (!response.ok) {
      throw new AppError(
        "CHANNEL_SEND_FAILED",
        payload.error?.message ?? payload.message ?? `Linq returned ${response.status}`,
        { status: response.status, linqCode: payload.error?.code ?? null, path },
      );
    }

    return payload;
  }

  verifyWebhook(input: VerifyInput): Record<string, unknown> {
    // A mock deployment has no shared secret to verify against; a live one must.
    if (this.mode === "live") {
      if (!this.webhookSecret) {
        throw new AppError("WEBHOOK_INVALID_SIGNATURE", "LINQ_WEBHOOK_SECRET is not configured");
      }
      const verified = verifyStandardWebhook(
        input.rawBody,
        {
          id: input.headers["webhook-id"],
          timestamp: input.headers["webhook-timestamp"],
          signature: input.headers["webhook-signature"],
        },
        this.webhookSecret,
      );
      if (!verified) {
        throw new AppError("WEBHOOK_INVALID_SIGNATURE", "Linq webhook signature did not verify");
      }
    }

    try {
      return JSON.parse(input.rawBody) as Record<string, unknown>;
    } catch {
      throw new AppError("WEBHOOK_INVALID_SIGNATURE", "Linq webhook body was not valid JSON");
    }
  }

  parseInbound(payload: Record<string, unknown>): InboundMessage | null {
    // Every event shares one envelope, and most of them — delivery receipts,
    // typing indicators, our own outbound sends — are not user input.
    const eventType = typeof payload.event_type === "string" ? payload.event_type : "";
    const data = (payload.data ?? {}) as Record<string, unknown>;

    if (eventType === "message.received") return parseMessage(data as LinqMessageData, payload);
    if (eventType === "reaction.added") return parseReaction(data as LinqReactionData, payload);
    return null;
  }
}

function parseMessage(
  data: LinqMessageData,
  raw: Record<string, unknown>,
): InboundMessage | null {
  if (data.direction && data.direction !== "inbound") return null;

  const sender = data.sender_handle;
  if (sender?.is_me) return null;
  const from = sender?.handle?.trim();
  if (!from) return null;

  // A message is a list of parts; only the text ones are intent-bearing.
  const text = (data.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.value === "string")
    .map((part) => part.value!.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!text) return null;

  return {
    externalThreadId: data.chat?.id ?? `linq_thread_${from}`,
    externalMessageId: data.id ?? newId("msg"),
    from,
    text,
    tapback: null,
    receivedAt: parseDate(data.sent_at),
    raw,
  };
}

function parseReaction(
  data: LinqReactionData,
  raw: Record<string, unknown>,
): InboundMessage | null {
  if (data.is_from_me) return null;

  const from = (data.from ?? data.from_handle?.handle)?.trim();
  if (!from) return null;

  // A custom reaction carries the emoji itself; a tapback carries a name such
  // as "love" or "dislike". The intent parser understands both vocabularies.
  const tapback = data.custom_emoji?.trim() || data.reaction_type?.trim();
  if (!tapback) return null;

  return {
    externalThreadId: data.chat_id ?? `linq_thread_${from}`,
    // Reactions have no id of their own; they point at the message reacted to.
    externalMessageId: data.message_id ? `reaction_${data.message_id}` : newId("msg"),
    from,
    text: "",
    tapback,
    receivedAt: parseDate(data.reacted_at),
    raw,
  };
}

function parseDate(value: string | undefined): Date {
  if (!value) return new Date();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * Accepts a key pasted with its scheme still attached.
 *
 * The header is built as `Bearer ${key}`, so a `LINQ_API_KEY=Bearer sk_…` sends
 * `Bearer Bearer sk_…` and Linq answers "Invalid or expired token" — which
 * reads as a bad key and sends you looking in the wrong place. Copying the
 * whole `Authorization` value out of API docs is the normal way to make this
 * mistake, so it is cheaper to absorb it than to explain it.
 */
function stripBearer(key: string | undefined): string | undefined {
  return key?.replace(/^\s*bearer\s+/i, "").trim() || undefined;
}

/** Tolerates a bare host being configured, which is what the old default was. */
function normalizeBaseUrl(configured: string | undefined): string {
  const base = (configured ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  return /\/api\/partner\/v\d+$/.test(base) ? base : `${base}/api/partner/v3`;
}
