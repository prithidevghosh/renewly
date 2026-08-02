import { newId } from "../../lib/id.js";
import type {
  ChannelAdapter,
  InboundMessage,
  SendProposalInput,
  SendResult,
  SendTextInput,
  VerifyInput,
} from "../../modules/channels/types.js";
import { assertTestOnly } from "./guard.js";

/**
 * A channel that exists only inside this process and the database. It is what
 * makes the whole message-to-payment journey testable end to end without a
 * phone number, an API key or an external service — the e2e suite drives the
 * real runtime through this adapter.
 *
 * It was previously available in every environment, on the argument that it was
 * the fastest way to demo the loop. That is exactly the problem: an approval
 * "delivered" here reached nobody, and the thread it appeared in was
 * indistinguishable from a real conversation. A demo that shows a message
 * arriving on a phone that never rang is a claim about the product that is not
 * true. It is a test instrument now, and only a test may install it.
 */
export class SimulatorChannelAdapter implements ChannelAdapter {
  readonly channel = "simulator" as const;
  readonly mode = "simulator" as const;

  private counter = 0;

  constructor() {
    assertTestOnly("SimulatorChannelAdapter");
  }

  private nextId(): string {
    this.counter += 1;
    return `sim_msg_${Date.now().toString(36)}_${this.counter}`;
  }

  async sendText(input: SendTextInput): Promise<SendResult> {
    return {
      externalMessageId: this.nextId(),
      externalThreadId: input.threadId ?? `sim_thread_${input.to}`,
      delivered: true,
    };
  }

  async sendProposal(input: SendProposalInput): Promise<SendResult> {
    return {
      externalMessageId: this.nextId(),
      externalThreadId: input.threadId ?? `sim_thread_${input.to}`,
      delivered: true,
    };
  }

  /** No signature: the route is guarded by workspace auth instead. */
  verifyWebhook(input: VerifyInput): Record<string, unknown> {
    try {
      return JSON.parse(input.rawBody) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  parseInbound(payload: Record<string, unknown>): InboundMessage | null {
    const from = typeof payload.from === "string" ? payload.from : null;
    const text = typeof payload.text === "string" ? payload.text : "";
    const tapback = typeof payload.tapback === "string" ? payload.tapback : null;

    if (!from || (!text && !tapback)) return null;

    return {
      externalThreadId:
        typeof payload.threadId === "string" ? payload.threadId : `sim_thread_${from}`,
      externalMessageId:
        typeof payload.messageId === "string" ? payload.messageId : newId("msg"),
      from,
      text,
      tapback,
      receivedAt: new Date(),
      raw: payload,
    };
  }
}
