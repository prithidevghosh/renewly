import { SignJWT, exportJWK, generateKeyPair, type JWTPayload } from "jose";
import { env } from "../../env.js";
import { setGoogleKeySet } from "../../modules/auth/oauth/googleIdToken.js";
import { assertTestOnly } from "./guard.js";

/**
 * A local stand-in for Google's signing keys.
 *
 * This is deliberately not a bypass. The old test path short-circuited
 * verification whenever OAUTH_MODE=mock, accepting the literal string
 * `mock:<subject>:<email>` — which meant the branch under test was the one that
 * skipped every check, and the real one, the only one that ever runs in front
 * of a user, was never exercised at all.
 *
 * Here a keypair is generated in-process, the public half is installed as the
 * key set, and the test signs a genuine RS256 JWT with it. `jwtVerify` then does
 * its full job: signature, issuer, audience and expiry are all really checked.
 * A token signed by the wrong key, addressed to another audience, or past its
 * expiry fails here exactly as it would in production.
 */
export interface GoogleIdTokenSigner {
  /** Mints a valid ID token for a subject and email. */
  sign(input: {
    sub: string;
    email: string;
    emailVerified?: boolean;
    name?: string;
    audience?: string;
    issuer?: string;
    expiresIn?: string;
  }): Promise<string>;
  /** Removes the key set, restoring the real remote one. */
  restore(): void;
}

export async function installGoogleIdTokenSigner(): Promise<GoogleIdTokenSigner> {
  assertTestOnly("installGoogleIdTokenSigner");

  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  jwk.alg = "RS256";

  // jose's key-set resolver is a function of (header, token); a single local key
  // answers every lookup.
  const keySet = (async () => publicKey) as unknown as Parameters<typeof setGoogleKeySet>[0];
  setGoogleKeySet(keySet);

  return {
    async sign(input) {
      const payload: JWTPayload = {
        email: input.email,
        email_verified: input.emailVerified ?? true,
        name: input.name ?? input.email.split("@")[0],
      };
      return new SignJWT(payload)
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setSubject(input.sub)
        .setIssuer(input.issuer ?? "https://accounts.google.com")
        .setAudience(input.audience ?? env.GOOGLE_CLIENT_ID ?? "test-client-id")
        .setIssuedAt()
        .setExpirationTime(input.expiresIn ?? "5m")
        .sign(privateKey);
    },
    restore() {
      setGoogleKeySet(null);
    },
  };
}
