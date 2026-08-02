import type { ChannelName } from "../../db/schema.js";

/**
 * One interface per messaging surface. iMessage (via Linq), WhatsApp and the
 * simulator differ enormously in what rich UI they support, so the contract is
 * deliberately text-first: `sendProposal` may render buttons where the platform
 * has them, but the body must stand alone, because a reply of "APPROVE" has to
 * work everywhere.
 */

export interface SendTextInput {
  to: string;
  body: string;
  threadId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ProposalAction {
  id: string;
  label: string;
  /** The reply text this button stands for, so text and taps converge. */
  value: string;
}

export interface SendProposalInput {
  to: string;
  proposal: { body: string; title?: string };
  actions: ProposalAction[];
  threadId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface SendResult {
  externalMessageId: string;
  externalThreadId: string;
  /** False when the adapter accepted the message but delivery is deferred. */
  delivered: boolean;
}

export interface InboundMessage {
  externalThreadId: string;
  externalMessageId: string;
  from: string;
  text: string;
  tapback?: string | null;
  receivedAt: Date;
  raw: Record<string, unknown>;
}

export interface VerifyInput {
  rawBody: string;
  headers: Record<string, string | undefined>;
}

export interface ChannelAdapter {
  readonly channel: ChannelName;
  readonly mode: "live" | "disabled" | "simulator";

  sendText(input: SendTextInput): Promise<SendResult>;
  sendProposal(input: SendProposalInput): Promise<SendResult>;

  /**
   * Throws WEBHOOK_INVALID_SIGNATURE when the payload is not provably from the
   * provider. Returns the parsed payload on success.
   */
  verifyWebhook(input: VerifyInput): Record<string, unknown>;

  /** Returns null for payloads that are not user messages (delivery receipts). */
  parseInbound(payload: Record<string, unknown>): InboundMessage | null;
}

/** Standard reply buttons, for the channels that can render them. */
export const PROPOSAL_ACTIONS: ProposalAction[] = [
  { id: "approve", label: "Approve", value: "APPROVE" },
  { id: "keep", label: "Keep", value: "KEEP" },
  { id: "later", label: "Later", value: "LATER" },
  { id: "why", label: "Why", value: "WHY" },
];
