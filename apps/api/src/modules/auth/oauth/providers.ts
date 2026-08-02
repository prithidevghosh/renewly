import { env } from "../../../env.js";
import { AppError } from "../../../lib/errors.js";
import { sha256 } from "../../../lib/crypto.js";
import {
  LOGIN_SCOPES,
  type AuthorizeInput,
  type ExchangeInput,
  type OAuthClient,
  type OAuthExchange,
  type SocialProvider,
} from "./types.js";

/**
 * Google, plain OAuth 2.0 + OIDC with PKCE. Microsoft has been removed.
 *
 * Written against:
 *   https://developers.google.com/identity/protocols/oauth2/web-server
 *
 * `OAUTH_MODE=live` with a client id and secret is the only way this runs.
 * There is no mode that stands in for the provider: the double that tests use
 * lives in src/test/doubles and is injected through setOAuthClient below.
 */

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

interface GoogleUserInfo {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

abstract class BaseOAuthClient implements OAuthClient {
  readonly mode = "live" as const;
  abstract readonly provider: SocialProvider;
  protected abstract readonly authorizeEndpoint: string;
  protected abstract readonly tokenEndpoint: string;
  protected abstract readonly clientId: string;
  protected abstract readonly clientSecret: string;

  authorizeUrl(input: AuthorizeInput): string {
    const url = new URL(this.authorizeEndpoint);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", LOGIN_SCOPES[this.provider].join(" "));
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    this.decorate(url);
    return url.toString();
  }

  /** Provider-specific query parameters on the authorize URL. */
  protected decorate(_url: URL): void {}

  async exchange(input: ExchangeInput): Promise<OAuthExchange> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code: input.code,
      code_verifier: input.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    });

    const token = await this.postForm(this.tokenEndpoint, body);
    if (!token.access_token) {
      throw new AppError("UNAUTHORIZED", "The identity provider issued no access token", {
        provider: this.provider,
        providerError: token.error ?? null,
      });
    }

    const profile = await this.fetchProfile(token.access_token);

    return {
      profile,
      tokens: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? null,
        expiresIn: token.expires_in ?? null,
        scopes: token.scope ? token.scope.split(" ").filter(Boolean) : LOGIN_SCOPES[this.provider],
      },
    };
  }

  protected abstract fetchProfile(accessToken: string): Promise<OAuthExchange["profile"]>;

  protected async postForm(url: string, body: URLSearchParams): Promise<TokenResponse> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body,
      });
    } catch (error) {
      throw new AppError("CHANNEL_SEND_FAILED", `Could not reach ${this.provider}`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const payload = (await response.json().catch(() => ({}))) as TokenResponse;
    if (!response.ok) {
      throw new AppError(
        "UNAUTHORIZED",
        payload.error_description ?? payload.error ?? `${this.provider} returned ${response.status}`,
        { provider: this.provider, status: response.status },
      );
    }
    return payload;
  }

  protected async getJson<T>(url: string, accessToken: string): Promise<T> {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    if (!response.ok) {
      throw new AppError("UNAUTHORIZED", `${this.provider} rejected the profile request`, {
        status: response.status,
      });
    }
    return (await response.json()) as T;
  }
}

class GoogleOAuthClient extends BaseOAuthClient {
  readonly provider = "google" as const;
  protected readonly authorizeEndpoint = "https://accounts.google.com/o/oauth2/v2/auth";
  protected readonly tokenEndpoint = "https://oauth2.googleapis.com/token";
  protected readonly clientId = env.GOOGLE_CLIENT_ID ?? "";
  protected readonly clientSecret = env.GOOGLE_CLIENT_SECRET ?? "";

  protected override decorate(url: URL): void {
    // Without these Google silently omits the refresh token on every consent
    // after the first, which only shows up when a token expires in production.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  }

  protected async fetchProfile(accessToken: string): Promise<OAuthExchange["profile"]> {
    const info = await this.getJson<GoogleUserInfo>(
      "https://openidconnect.googleapis.com/v1/userinfo",
      accessToken,
    );
    if (!info.sub || !info.email) {
      throw new AppError("UNAUTHORIZED", "Google returned no subject or email");
    }
    return {
      providerAccountId: info.sub,
      email: info.email,
      emailVerified: info.email_verified ?? false,
      name: info.name ?? null,
      avatarUrl: info.picture ?? null,
    };
  }
}


const overrides = new Map<SocialProvider, OAuthClient>();

/** Tests substitute a client here. */
export function setOAuthClient(provider: SocialProvider, client: OAuthClient | null): void {
  if (client) overrides.set(provider, client);
  else overrides.delete(provider);
}

export function resetOAuthClients(): void {
  overrides.clear();
}

export function getOAuthClient(provider: SocialProvider): OAuthClient {
  const override = overrides.get(provider);
  if (override) return override;

  if (env.OAUTH_MODE === "disabled") {
    throw new AppError(
      "FEATURE_DISABLED",
      "Social sign-in is turned off on this deployment. Set OAUTH_MODE=live and " +
        "configure the provider's client id and secret to enable it.",
      { provider },
    );
  }

  const configured = Boolean(env.GOOGLE_CLIENT_ID);
  if (!configured) {
    throw new AppError("FEATURE_DISABLED", `${provider} sign-in is not configured`, { provider });
  }

  return new GoogleOAuthClient();
}
