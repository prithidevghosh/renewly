import { newId } from "../../lib/id.js";
import { env } from "../../env.js";
import type { MailTransport, OutboundEmail, SentEmail } from "../../lib/mailer.js";
import { assertTestOnly } from "./guard.js";

/**
 * A transport that keeps mail instead of sending it, so a test can read back
 * exactly what would have gone out.
 *
 * This used to be MAIL_OUTBOUND_MODE=mock inside the mailer itself, which meant
 * a deployment could accept a signup, report success, and quietly file the
 * verification code in a process-local array the user could never reach. The
 * capture is the same; what changed is that reaching it now requires a test to
 * install this transport by hand.
 */
const mailbox: SentEmail[] = [];

/** The mailbox is a debugging aid, not a store; it must not grow unbounded. */
const MAILBOX_LIMIT = 100;

export function captureTransport(): MailTransport {
  assertTestOnly("captureTransport");
  return async (email: OutboundEmail) => {
    const id = newId("eml");
    mailbox.push({ ...email, id, from: env.MAIL_FROM, sentAt: new Date() });
    if (mailbox.length > MAILBOX_LIMIT) mailbox.splice(0, mailbox.length - MAILBOX_LIMIT);
    return { id, mode: "transport" as const };
  };
}

/** Newest last, so a test can read `at(-1)`. */
export function readMailbox(): readonly SentEmail[] {
  return mailbox;
}

export function clearMailbox(): void {
  mailbox.length = 0;
}
