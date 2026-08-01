import type { Logger } from "pino";
import { env } from "../../env.js";
import { AppError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { sendEmail } from "../../lib/mailer.js";
import { renderContactMessage } from "./message.js";

/**
 * The contact form is the waitlist's simpler sibling: public, unauthenticated,
 * and mail-only. Nothing is stored, because nothing here is a record we own —
 * the message is the mail, and the inbox is the store.
 *
 * That makes success unambiguous: the mail was accepted by the provider, or the
 * request failed. A form that says "thanks, we'll be in touch" when the message
 * went nowhere is the one outcome worth engineering against, so a send failure
 * propagates as an error rather than being swallowed.
 */

export interface SendContactMessageInput {
  name: string;
  email: string;
  message: string;
}

export interface SendContactMessageResult {
  /** Normalized address the reply will go to. */
  email: string;
  sentAt: Date;
}

export async function sendContactMessage(
  input: SendContactMessageInput,
  log: Logger = logger,
): Promise<SendContactMessageResult> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  const message = input.message.trim();
  const receivedAt = new Date();

  log.info(
    {
      email,
      // Not `name`: pino reserves that for the logger's own name, and a
      // pretty-printed line would render it as "INFO (Ada Lovelace)".
      senderName: name,
      messageBytes: message.length,
      to: env.CONTACT_NOTIFY_TO,
    },
    "contact message received",
  );

  const mail = renderContactMessage({ name, email, message, receivedAt });

  let result;
  try {
    result = await sendEmail(
      {
        to: env.CONTACT_NOTIFY_TO,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        // Replying to the notice reaches the person who wrote in.
        replyTo: email,
      },
      log,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.error(
      { err: error, email, to: env.CONTACT_NOTIFY_TO, reason },
      "contact mail failed — the message will be reported as an error",
    );
    // A failed send is an outbound channel failure, not an internal fault: the
    // caller gets 502 and can retry, because nothing here was persisted.
    throw error instanceof AppError
      ? error
      : new AppError("CHANNEL_SEND_FAILED", "Could not send the contact message", {
          cause: reason,
        });
  }

  log.info(
    { email, to: env.CONTACT_NOTIFY_TO, messageId: result.id, mode: result.mode },
    "contact message delivered",
  );
  return { email, sentAt: receivedAt };
}
