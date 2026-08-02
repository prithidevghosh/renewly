import type { MailboxProvider } from "../../db/schema.js";

/**
 * Mailbox read access.
 *
 * Deliberately a separate consent from sign-in. Gmail's read scope is
 * *restricted* — asking for it on the login screen means every new user meets a
 * scary permission dialog before they have seen the product, and it drags the
 * whole app into Google's security review. So login proves who you are, and
 * this asks for the inbox later, when there is a reason to.
 */

export interface MailboxTokens {
  accessToken: string;
  /** Absent when the provider declines to reissue one on a repeat consent. */
  refreshToken: string | null;
  expiresIn: number | null;
  scopes: string[];
}

export interface MailboxGrant {
  tokens: MailboxTokens;
  /** The mailbox actually granted, which need not be the login address. */
  emailAddress: string;
}

/** One message, normalised across providers. */
export interface MailMessage {
  providerMessageId: string;
  subject: string | null;
  from: string | null;
  receivedAt: Date | null;
  snippet: string | null;
  /** Plain-text body, already decoded. Empty when the message had none. */
  body: string;
}

export interface SearchInput {
  accessToken: string;
  /** Only messages at or after this instant. */
  since: Date;
  /** Words any of which may appear; providers differ on how they match. */
  keywords: string[];
  limit: number;
}

export interface MailboxClient {
  readonly provider: MailboxProvider;
  readonly mode: "mock" | "live";
  /** Where to send the browser to ask for inbox access. */
  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchange(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<MailboxGrant>;
  refresh(refreshToken: string): Promise<MailboxTokens>;
  /** Messages matching the keywords since the given date, newest first. */
  search(input: SearchInput): Promise<MailMessage[]>;
}

/**
 * Read-only, and nothing else. `offline_access` / `access_type=offline` is what
 * yields the refresh token the monthly sweep needs — without it the connection
 * dies the first time the access token expires.
 */
export const MAILBOX_SCOPES: Record<MailboxProvider, string[]> = {
  gmail: ["https://www.googleapis.com/auth/gmail.readonly", "email", "openid"],
  outlook: ["https://graph.microsoft.com/Mail.Read", "offline_access", "openid", "email"],
};

/** What the detector looks for. Deliberately broad; the model filters after. */
export const RECEIPT_KEYWORDS = ["receipt", "receipts", "invoice", "subscription", "billing"];
