import type { AuthProvider } from "../../../db/schema.js";

/**
 * Social sign-in providers.
 *
 * Same shape as every other outbound integration in this codebase: an interface,
 * a live implementation written against the vendor's published reference, and a
 * mock that is the default. The mock is not a stub — it drives the identical
 * code path through account creation and linking, so the flow is exercised by
 * the test suite without anyone holding a Google credential.
 */

export type SocialProvider = Extract<AuthProvider, "google" | "microsoft">;

export interface OAuthProfile {
  /** The provider's stable subject id. Never the email — people change those. */
  providerAccountId: string;
  email: string;
  /** False when the provider will not vouch for the address. */
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
}

export interface OAuthTokens {
  /** Null for the Google Identity Services flow, which issues no access token. */
  accessToken: string | null;
  refreshToken: string | null;
  /** Seconds until the access token expires, when the provider says. */
  expiresIn: number | null;
  scopes: string[];
}

export interface OAuthExchange {
  profile: OAuthProfile;
  tokens: OAuthTokens;
}

export interface AuthorizeInput {
  state: string;
  /** PKCE challenge, derived from the verifier held in the flow cookie. */
  codeChallenge: string;
  redirectUri: string;
}

export interface ExchangeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface OAuthClient {
  readonly provider: SocialProvider;
  readonly mode: "mock" | "live";
  /** Where to send the browser. */
  authorizeUrl(input: AuthorizeInput): string;
  /** Trade the callback code for tokens and the user's profile. */
  exchange(input: ExchangeInput): Promise<OAuthExchange>;
}

/**
 * Login only. Mailbox read is a separate, later consent — asking for someone's
 * inbox on the sign-in screen is how an install gets abandoned, and Google's
 * restricted-scope review makes it expensive to ask for it before it is needed.
 */
export const LOGIN_SCOPES: Record<SocialProvider, string[]> = {
  google: ["openid", "email", "profile"],
  microsoft: ["openid", "email", "profile", "offline_access", "User.Read"],
};
