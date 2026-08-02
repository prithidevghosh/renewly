import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "../../../env.js";
import { AppError } from "../../../lib/errors.js";
import type { OAuthExchange } from "./types.js";

/**
 * Google Identity Services — the popup / One Tap flow.
 *
 * The browser gets an **ID token** straight from Google and posts it here; we
 * verify its signature against Google's public keys and trust the claims. There
 * is no code exchange, so there is **no client secret** — the client id is
 * public by design and is embedded in the frontend bundle.
 *
 * That is why this exists alongside the redirect flow in `providers.ts`: it
 * needs nothing but a client id, and no redirect URI has to be registered. The
 * redirect flow is still the only option for Microsoft, and the only one that
 * can obtain a refresh token for reading a mailbox later.
 *
 * https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
 */

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const VALID_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

interface GoogleIdClaims {
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
}

// Created once: the set caches Google's signing keys and refreshes them on
// rotation, so this is not a network round trip per sign-in.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function keySet(): ReturnType<typeof createRemoteJWKSet> {
  jwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return jwks;
}

/** Test seam, so a suite can verify without reaching Google. */
export function setGoogleKeySet(next: ReturnType<typeof createRemoteJWKSet> | null): void {
  jwks = next;
}

/**
 * Verifies a Google ID token and returns it in the same shape the redirect flow
 * produces, so both paths converge on one account-creation routine.
 *
 * The credential is always verified against Google's published keys. There is
 * no bypass: this path mints a session, and a branch that accepted a formatted
 * string instead of a signature once returned a valid session for any address
 * the caller chose to type.
 */
export async function verifyGoogleIdToken(credential: string): Promise<OAuthExchange> {
  if (env.OAUTH_MODE === "disabled") {
    throw new AppError(
      "FEATURE_DISABLED",
      "Google sign-in is turned off on this deployment. Set OAUTH_MODE=live and " +
        "configure GOOGLE_CLIENT_ID to enable it.",
    );
  }

  if (!env.GOOGLE_CLIENT_ID) {
    throw new AppError("FEATURE_DISABLED", "Google sign-in is not configured", {
      missing: "GOOGLE_CLIENT_ID",
    });
  }

  let claims: GoogleIdClaims;
  try {
    const { payload } = await jwtVerify(credential, keySet(), {
      issuer: VALID_ISSUERS,
      // Binding the audience to our own client id is what stops a token minted
      // for some other site being replayed here.
      audience: env.GOOGLE_CLIENT_ID,
    });
    claims = payload as GoogleIdClaims;
  } catch (error) {
    throw new AppError("UNAUTHORIZED", "That Google credential is not valid", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (!claims.sub || !claims.email) {
    throw new AppError("UNAUTHORIZED", "Google returned no subject or email");
  }

  return {
    profile: {
      providerAccountId: claims.sub,
      email: claims.email,
      // Google sends this as a boolean or the string "true" depending on path.
      emailVerified: claims.email_verified === true || claims.email_verified === "true",
      name: claims.name ?? null,
      avatarUrl: claims.picture ?? null,
    },
    // GIS issues no access or refresh token: the ID token is the whole result,
    // and it is a proof of identity, not a key to anything. Nothing to store.
    tokens: { accessToken: null, refreshToken: null, expiresIn: null, scopes: [] },
  };
}
