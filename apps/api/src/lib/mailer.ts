import type { Logger } from "pino";
import { env } from "../env.js";
import { AppError } from "./errors.js";
import { newId } from "./id.js";
import { logger } from "./logger.js";

/**
 * Outbound transactional mail.
 *
 * Same shape as the chat channel adapters: `mock` is the default and needs no
 * key, `live` talks to Resend over plain fetch. Mock does not discard the
 * message — it keeps it in a small in-memory mailbox so dev and tests can read
 * back exactly what would have been sent.
 *
 * https://resend.com/docs/api-reference/emails/send-email
 */

export interface OutboundEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export interface SendEmailResult {
  /** Provider message id in live mode, a local id in mock mode. */
  id: string;
  mode: "mock" | "live";
}

export interface SentEmail extends OutboundEmail {
  id: string;
  from: string;
  sentAt: Date;
}

export type MailTransport = (email: OutboundEmail) => Promise<SendEmailResult>;

const RESEND_ENDPOINT = "https://api.resend.com/emails";
/** The mailbox is a debugging aid, not a store; it must not grow unbounded. */
const MAILBOX_LIMIT = 100;

const mailbox: SentEmail[] = [];

let transport: MailTransport | null = null;

/** Tests and the dev harness substitute a transport here. */
export function setMailTransport(next: MailTransport | null): void {
  transport = next;
}

/** Newest last, so a test can read `at(-1)`. */
export function readMailbox(): readonly SentEmail[] {
  return mailbox;
}

export function clearMailbox(): void {
  mailbox.length = 0;
}

export async function sendEmail(
  email: OutboundEmail,
  log: Logger = logger,
): Promise<SendEmailResult> {
  log.info(
    {
      to: email.to,
      subject: email.subject,
      mode: transport ? "transport" : env.MAIL_OUTBOUND_MODE,
      from: env.MAIL_FROM,
      replyTo: email.replyTo ?? env.MAIL_REPLY_TO ?? null,
      htmlBytes: email.html.length,
      textBytes: email.text.length,
    },
    "mail send starting",
  );

  if (transport) return transport(email);
  if (env.MAIL_OUTBOUND_MODE === "mock") return sendMock(email, log);
  return sendViaResend(email, envConfig(), log);
}

export interface ResendConfig {
  apiKey: string | undefined;
  from: string;
  replyTo?: string;
}

/** Read at call time so a test can supply a config without touching the env. */
function envConfig(): ResendConfig {
  return {
    apiKey: env.MAIL_OUTBOUND_API_KEY,
    from: env.MAIL_FROM,
    replyTo: env.MAIL_REPLY_TO,
  };
}

function sendMock(email: OutboundEmail, log: Logger = logger): SendEmailResult {
  const id = newId("eml");
  mailbox.push({ ...email, id, from: env.MAIL_FROM, sentAt: new Date() });
  if (mailbox.length > MAILBOX_LIMIT) mailbox.splice(0, mailbox.length - MAILBOX_LIMIT);

  log.info(
    { to: email.to, subject: email.subject, id, mailboxSize: mailbox.length },
    "mail captured — MAIL_OUTBOUND_MODE=mock, nothing left the process",
  );
  // The rendered bodies only at debug: they are long, and a transactional mail
  // can carry a link that grants access.
  log.debug({ id, text: email.text }, "mail body (mock)");
  return { id, mode: "mock" };
}

interface ResendResponse {
  id?: string;
  message?: string;
  name?: string;
}

export async function sendViaResend(
  email: OutboundEmail,
  config: ResendConfig = envConfig(),
  log: Logger = logger,
): Promise<SendEmailResult> {
  const replyTo = email.replyTo ?? config.replyTo;
  const startedAt = Date.now();

  // The key itself is never logged — only whether one is present, which is the
  // part that actually explains a 401.
  log.debug(
    {
      endpoint: RESEND_ENDPOINT,
      from: config.from,
      to: email.to,
      subject: email.subject,
      replyTo: replyTo ?? null,
      apiKeyPresent: Boolean(config.apiKey),
    },
    "resend request",
  );

  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: config.from,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    log.error(
      { err: error, cause, endpoint: RESEND_ENDPOINT, to: email.to, ms: Date.now() - startedAt },
      "resend unreachable",
    );
    // Mail is an outbound channel, so it reuses the channel failure code
    // rather than inventing a second 502 that means the same thing.
    throw new AppError("CHANNEL_SEND_FAILED", "Could not reach the mail provider", { cause });
  }

  const raw = await response.text();
  let payload: ResendResponse = {};
  try {
    payload = raw ? (JSON.parse(raw) as ResendResponse) : {};
  } catch {
    log.warn({ status: response.status, raw: raw.slice(0, 500) }, "resend returned non-JSON");
  }

  if (!response.ok) {
    // Everything the provider said, verbatim: this is the only place the real
    // reason for a bounced send exists.
    log.error(
      {
        status: response.status,
        statusText: response.statusText,
        providerError: payload.name ?? null,
        providerMessage: payload.message ?? null,
        body: raw.slice(0, 1000),
        to: email.to,
        from: config.from,
        subject: email.subject,
        ms: Date.now() - startedAt,
      },
      "resend rejected the message",
    );

    throw new AppError(
      "CHANNEL_SEND_FAILED",
      payload.message ?? `Mail provider returned ${response.status}`,
      { status: response.status, providerError: payload.name ?? null },
    );
  }

  const id = payload.id ?? newId("eml");
  log.info(
    { id, status: response.status, to: email.to, subject: email.subject, ms: Date.now() - startedAt },
    "resend accepted the message",
  );
  return { id, mode: "live" };
}
