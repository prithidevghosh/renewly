import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../../lib/errors.js";
import { sha256 } from "../../lib/crypto.js";
import {
  MAILBOX_SCOPES,
  type MailMessage,
  type MailboxClient,
  type MailboxGrant,
  type MailboxTokens,
  type SearchInput,
} from "../../modules/mailbox/types.js";
import { resetMailboxClients, setMailboxClient } from "../../modules/mailbox/registry.js";
import { assertTestOnly } from "./guard.js";

/**
 * A mailbox that returns the repository's own email fixtures, for tests only.
 *
 * It serves the same real renewal notices the parser tests run against, so the
 * detect pipeline is exercised end to end without anyone consenting to a real
 * inbox, and a regression in parsing shows up here too.
 *
 * It was previously reachable from a running app via MAILBOX_MODE=mock, where
 * it handed one person fixture data dressed as their own mail — including the
 * `demo@example.com` address that appeared during onboarding. Now it can only
 * be installed deliberately, by a test, through setMailboxClient.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, "..", "..", "..", "fixtures", "emails");

interface Fixture {
  name: string;
  raw: string;
}

let cache: Fixture[] | null = null;

function fixtures(): Fixture[] {
  if (cache) return cache;

  // Missing fixtures means the deployment is wrong, so say that rather than
  // returning an empty inbox. "You have no receipts" and "this build is broken"
  // look identical to a user and must not be reported the same way.
  if (!existsSync(FIXTURES)) {
    throw new AppError(
      "INTERNAL_ERROR",
      `Mock mailbox fixtures are missing at ${FIXTURES}. This build cannot serve mock mail.`,
    );
  }

  cache = readdirSync(FIXTURES)
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

  constructor(readonly provider: "gmail" = "gmail") {
    assertTestOnly("MockMailboxClient");
  }

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

/**
 * Installs this double for Gmail, the only supported mailbox, and returns the
 * undo. The registry that chooses a client lives in the mailbox module; only
 * the fixture-backed implementation lives here, and it arrives by injection.
 */
export function installMockMailbox(): () => void {
  setMailboxClient("gmail", new MockMailboxClient("gmail"));
  return () => resetMailboxClients();
}
