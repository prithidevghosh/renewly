import { env } from "../../env.js";
import { sha256 } from "../../lib/crypto.js";
import { resetOAuthClients, setOAuthClient } from "../../modules/auth/oauth/providers.js";
import { LOGIN_SCOPES } from "../../modules/auth/oauth/types.js";
import type {
  AuthorizeInput,
  ExchangeInput,
  OAuthClient,
  OAuthExchange,
  SocialProvider,
} from "../../modules/auth/oauth/types.js";
import { assertTestOnly } from "./guard.js";

/**
 * Deterministic stand-in for a social provider, for tests only.
 *
 * The profile is derived from the authorization code, so a test can drive "the
 * same Google account signs in twice" or "a different account collides on
 * email" simply by choosing the code it sends back.
 *
 * Format: `mock:<subject>:<email>` — anything else yields a stable fallback.
 *
 * This was previously selectable as OAUTH_MODE=mock. That mode authenticated
 * anyone who could name an address: POSTing `code=mock:x:ceo@yourdomain.com` to
 * the callback returned a valid session for that person, with no password, no
 * Google and no consent. It is reachable now only by a test that installs it.
 */
export class MockOAuthClient implements OAuthClient {
  readonly mode = "mock" as const;

  constructor(readonly provider: SocialProvider) {
    assertTestOnly("MockOAuthClient");
  }

  authorizeUrl(input: AuthorizeInput): string {
    const url = new URL(`${env.API_URL}/v1/auth/oauth/${this.provider}/callback`);
    url.searchParams.set("state", input.state);
    url.searchParams.set("code", `mock:${this.provider}-subject:${this.provider}@example.com`);
    url.searchParams.set("mock", "1");
    return url.toString();
  }

  async exchange(input: ExchangeInput): Promise<OAuthExchange> {
    const parts = input.code.split(":");
    const subject = parts[1] || `${this.provider}-subject`;
    const email = parts[2] || `${this.provider}@example.com`;

    return {
      profile: {
        providerAccountId: subject,
        email,
        emailVerified: true,
        name: email.split("@")[0] ?? "Mock User",
        avatarUrl: null,
      },
      tokens: {
        // Distinct per subject so a test can prove the right token was stored.
        accessToken: `mock-access-${sha256(subject).slice(0, 16)}`,
        refreshToken: `mock-refresh-${sha256(email).slice(0, 16)}`,
        expiresIn: 3600,
        scopes: LOGIN_SCOPES[this.provider],
      },
    };
  }
}

/** Installs the double for Google, and returns the undo. */
export function installMockOAuth(): () => void {
  const providers: SocialProvider[] = ["google"];
  for (const provider of providers) setOAuthClient(provider, new MockOAuthClient(provider));
  return () => resetOAuthClients();
}
