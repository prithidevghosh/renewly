import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../../env.js";
import { AppError } from "../../lib/errors.js";
import { sha256 } from "../../lib/crypto.js";
import type { MailboxProvider } from "../../db/schema.js";
import {
  MAILBOX_SCOPES,
  type MailMessage,
  type MailboxClient,
  type MailboxGrant,
  type MailboxTokens,
  type SearchInput,
} from "./types.js";

/**
 * A mailbox that returns the repository's own email fixtures.
 *
 * This is not a stub returning lorem ipsum: it serves the same real renewal
 * notices the parser tests run against, so the detect pipeline can be built and
 * demoed end to end before anyone has consented to a real inbox — and so a
 * regression in parsing shows up here too.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, "..", "..", "..", "fixtures", "emails");

interface Fixture {
  name: string;
  raw: string;
}

let cache: Fixture[] | null = null;

function fixtures(): Fixture[] {
  cache ??= readdirSync(FIXTURES)
    .filter((name) => name.endsWith(".txt"))
    .sort()
    .map((name) => ({ name, raw: readFileSync(path.join(FIXTURES, name), "utf8") }));
  return cache;
}

function headerOf(raw: string, field: string): string | null {
  const match = raw.match(new RegExp(`^${field}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() ?? null;
}

export class MockMailboxClient implements MailboxClient {
  readonly mode = "mock" as const;

  constructor(readonly provider: MailboxProvider) {}

  authorizeUrl(input: { state: string; redirectUri: string }): string {
    const url = new URL(input.redirectUri);
    url.searchParams.set("state", input.state);
    url.searchParams.set("code", `mock:${this.provider}:demo@example.com`);
    url.searchParams.set("mock", "1");
    return url.toString();
  }

  async exchange(input: { code: string }): Promise<MailboxGrant> {
    const parts = input.code.split(":");
    if (parts[0] !== "mock") {
      throw new AppError("UNAUTHORIZED", "That authorization code is not valid");
    }
    const emailAddress = parts[2] || `demo@${this.provider}.example.com`;

    return {
      emailAddress,
      tokens: {
        accessToken: `mock-mailbox-access-${sha256(emailAddress).slice(0, 12)}`,
        refreshToken: `mock-mailbox-refresh-${sha256(emailAddress).slice(0, 12)}`,
        expiresIn: 3600,
        scopes: MAILBOX_SCOPES[this.provider],
      },
    };
  }

  async refresh(refreshToken: string): Promise<MailboxTokens> {
    return {
      // Distinct from the original so a test can prove a refresh actually ran.
      accessToken: `mock-mailbox-refreshed-${sha256(refreshToken).slice(0, 12)}`,
      refreshToken: null,
      expiresIn: 3600,
      scopes: MAILBOX_SCOPES[this.provider],
    };
  }

  async search(input: SearchInput): Promise<MailMessage[]> {
    const keywords = input.keywords.map((word) => word.toLowerCase());

    return fixtures()
      .map((fixture, index): MailMessage => {
        const date = headerOf(fixture.raw, "Date");
        const parsed = date ? new Date(date) : null;
        return {
          providerMessageId: `mock-${this.provider}-${fixture.name}`,
          subject: headerOf(fixture.raw, "Subject"),
          from: headerOf(fixture.raw, "From"),
          // Fixtures carry fixed dates; spread them through the window so the
          // "paid last month?" logic has something realistic to sort on.
          receivedAt:
            parsed && !Number.isNaN(parsed.getTime())
              ? parsed
              : new Date(Date.now() - index * 7 * 86_400_000),
          snippet: fixture.raw.slice(0, 160).replace(/\s+/g, " ").trim(),
          body: fixture.raw,
        };
      })
      .filter((message) => {
        const haystack = `${message.subject ?? ""} ${message.body}`.toLowerCase();
        return keywords.some((word) => haystack.includes(word));
      })
      .filter((message) => !message.receivedAt || message.receivedAt >= input.since)
      .sort((a, b) => (b.receivedAt?.getTime() ?? 0) - (a.receivedAt?.getTime() ?? 0))
      .slice(0, input.limit);
  }
}

const overrides = new Map<MailboxProvider, MailboxClient>();

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
  if (env.MAILBOX_MODE === "mock") return new MockMailboxClient(provider);

  if (provider === "gmail") {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Gmail access needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. The One Tap sign-in " +
          "credential is not enough: an ID token proves identity and grants no API access.",
        { provider },
      );
    }
    const { GmailClient } = await import("./gmail.js");
    return new GmailClient();
  }

  if (!env.MICROSOFT_CLIENT_ID || !env.MICROSOFT_CLIENT_SECRET) {
    throw new AppError("VALIDATION_ERROR", "Outlook access is not configured", { provider });
  }
  const { OutlookClient } = await import("./outlook.js");
  return new OutlookClient();
}
