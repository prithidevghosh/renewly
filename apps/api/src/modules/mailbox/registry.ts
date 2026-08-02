import type { MailboxProvider } from "../../db/schema.js";
import { env } from "../../env.js";
import { AppError } from "../../lib/errors.js";
import type { MailboxClient } from "./types.js";

/**
 * Which client reads a given provider's mail.
 *
 * There is no fixture-backed mailbox here any more. The one that used to live
 * beside this file answered `authorizeUrl` by redirecting straight back with
 * `code=mock:gmail:demo@example.com`, so connecting an inbox during onboarding
 * appeared to succeed and then listed somebody else's invented receipts as the
 * user's own mail. Nothing in the UI could distinguish that from a real inbox,
 * which is the whole problem with it.
 *
 * Off is the honest alternative: MAILBOX_MODE=disabled raises FEATURE_DISABLED,
 * and the connect button says the feature is unavailable rather than pretending
 * to work.
 */
const overrides = new Map<MailboxProvider, MailboxClient>();

/** Tests install a double; passing null restores the env-derived client. */
export function setMailboxClient(provider: MailboxProvider, client: MailboxClient | null): void {
  if (client) overrides.set(provider, client);
  else overrides.delete(provider);
}

export function resetMailboxClients(): void {
  overrides.clear();
}

export async function getMailboxClient(provider: MailboxProvider): Promise<MailboxClient> {
  const override = overrides.get(provider);
  if (override) return override;

  if (env.MAILBOX_MODE === "disabled") {
    throw new AppError(
      "FEATURE_DISABLED",
      "Mailbox access is turned off on this deployment. Set MAILBOX_MODE=live and " +
        "configure the provider's credentials to enable it.",
      { provider },
    );
  }

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new AppError(
      "FEATURE_DISABLED",
      "Gmail access needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. The One Tap sign-in " +
        "credential is not enough: an ID token proves identity and grants no API access.",
      { provider },
    );
  }

  const { GmailClient } = await import("./gmail.js");
  return new GmailClient();
}
