import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { authIdentities, emailVerificationCodes, users } from "../src/db/schema.js";
import { decryptSecret } from "../src/lib/crypto.js";
import { installMockOAuth } from "../src/test/doubles/oauth.js";
import {
  installGoogleIdTokenSigner,
  type GoogleIdTokenSigner,
} from "../src/test/doubles/googleIdToken.js";
import { signUpUnverified } from "../src/test/factories.js";
import { ApiClient, createHarness, expectErrorCode, type TestHarness } from "../src/test/helpers.js";

/**
 * Sign-in through Google and Microsoft, email verification, and the rules that
 * decide when a provider identity may be attached to an account that already
 * exists. Runs on the OAuth double from src/test/doubles, injected by the
 * harness, which drives the same code path as the live client — only the
 * network call differs.
 */

let harness: TestHarness;

beforeAll(async () => {
  harness = await createHarness();
});

beforeEach(() => {
  // Re-install rather than clear. Clearing used to be enough because
  // OAUTH_MODE=mock rebuilt the double on demand; there is no such mode now, so
  // a cleared registry means social sign-in is simply off.
  installMockOAuth();
});

afterAll(async () => {
  await harness.close();
});

/** Distinct per browser, so the per-IP credential limiter does not couple tests. */
let flowSeq = 0;
const nextIp = (): string => `172.16.${Math.floor((flowSeq += 1) / 250) % 250}.${flowSeq % 250}`;

/** Completes the whole redirect dance for a given provider subject and email. */
async function signInWith(
  provider: "google" | "microsoft",
  subject: string,
  email: string,
): Promise<{ client: ApiClient; status: number; body: Record<string, unknown> }> {
  const ip = nextIp();
  const client = new ApiClient(harness.app, { ip });

  const start = await harness.app.request(`http://localhost/v1/auth/oauth/${provider}/start`, {
    headers: { "x-forwarded-for": ip },
    redirect: "manual",
  });
  expect(start.status).toBe(302);

  const cookie = start.headers.get("set-cookie") ?? "";
  const flow = JSON.parse(
    decodeURIComponent(cookie.match(/renewly_oauth=([^;]+)/)![1]!),
  ) as { state: string };

  const callback = await harness.app.request(
    `http://localhost/v1/auth/oauth/${provider}/callback?state=${flow.state}&code=${encodeURIComponent(`mock:${subject}:${email}`)}`,
    { headers: { cookie, "x-forwarded-for": ip }, redirect: "manual" },
  );

  // The session arrives as a cookie on the redirect back to the app.
  const session = callback.headers.get("set-cookie")?.match(/renewly_session=([^;]+)/);
  if (session) client.setToken(decodeURIComponent(session[1]!));

  return { client, status: callback.status, body: {} };
}

describe("oauth sign-in", () => {
  it("creates an account, a workspace and a verified user on first sign-in", async () => {
    const { client, status } = await signInWith("google", "google-sub-1", "newuser@example.com");
    expect(status).toBe(302);

    const me = await client.get<{
      user: { email: string; emailVerified: boolean };
      workspace: { id: string };
    }>("/v1/me");

    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("newuser@example.com");
    // The provider already proved the address, so no code is sent.
    expect(me.body.user.emailVerified).toBe(true);
    expect(me.body.workspace.id).toMatch(/^wsp_/);

    // Verified means usable immediately — no gate.
    expect((await client.get("/v1/subscriptions")).status).toBe(200);
  });

  it("signs the same provider account back in without creating a second user", async () => {
    await signInWith("google", "google-sub-2", "repeat@example.com");
    const { client } = await signInWith("google", "google-sub-2", "repeat@example.com");

    const me = await client.get<{ user: { id: string } }>("/v1/me");
    expect(me.status).toBe(200);

    const rows = await harness.handle.db
      .select()
      .from(users)
      .where(eq(users.email, "repeat@example.com"));
    expect(rows).toHaveLength(1);
  });

  it("stores provider tokens encrypted, never in the clear", async () => {
    await signInWith("google", "google-sub-3", "tokens@example.com");

    const [identity] = await harness.handle.db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.providerAccountId, "google-sub-3"));

    expect(identity).toBeDefined();
    expect(identity!.accessToken).toBeTruthy();
    expect(identity!.accessToken).not.toContain("mock-access");
    // Sealed, but openable by the process that holds the key.
    expect(decryptSecret(identity!.accessToken!)).toContain("mock-access");
    expect(decryptSecret(identity!.refreshToken!)).toContain("mock-refresh");
  });


  it("refuses an unknown provider", async () => {
    const response = await harness.app.request("http://localhost/v1/auth/oauth/facebook/start", {
      headers: { "x-forwarded-for": nextIp() },
      redirect: "manual",
    });
    expect(response.status).toBe(404);
  });
});

describe("oauth state and PKCE", () => {
  it("rejects a callback whose state does not match the flow cookie", async () => {
    const ip = nextIp();
    const start = await harness.app.request("http://localhost/v1/auth/oauth/google/start", {
      headers: { "x-forwarded-for": ip },
      redirect: "manual",
    });
    const cookie = start.headers.get("set-cookie") ?? "";

    const response = await harness.app.request(
      "http://localhost/v1/auth/oauth/google/callback?state=forged&code=mock:x:x@example.com",
      { headers: { cookie, "x-forwarded-for": ip }, redirect: "manual" },
    );

    expect(response.status).toBe(401);
  });

  it("rejects a callback with no flow cookie at all", async () => {
    const response = await harness.app.request(
      "http://localhost/v1/auth/oauth/google/callback?state=anything&code=mock:x:x@example.com",
      { headers: { "x-forwarded-for": nextIp() }, redirect: "manual" },
    );
    expect(response.status).toBe(401);
  });

  it("sends the user back to the app when they cancel at the provider", async () => {
    const response = await harness.app.request(
      "http://localhost/v1/auth/oauth/google/callback?error=access_denied",
      { headers: { "x-forwarded-for": nextIp() }, redirect: "manual" },
    );

    // A cancelled consent is a normal outcome, not a 500.
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("error=access_denied");
  });

  it("will not turn redirectTo into an open redirect", async () => {
    const response = await harness.app.request(
      "http://localhost/v1/auth/oauth/google/start?redirectTo=https://evil.example.com",
      { headers: { "x-forwarded-for": nextIp() }, redirect: "manual" },
    );

    const cookie = response.headers.get("set-cookie") ?? "";
    const flow = JSON.parse(
      decodeURIComponent(cookie.match(/renewly_oauth=([^;]+)/)![1]!),
    ) as { redirectTo: string };

    expect(flow.redirectTo).toBe("/");
  });
});

describe("account linking", () => {
  it("links a provider to an existing password account with the same email", async () => {
    const client = new ApiClient(harness.app);
    const account = await signUpUnverified(client, { email: "linkme@example.com" });
    await client.post("/v1/auth/verify", {
      email: "linkme@example.com",
      code: account.verificationCode,
    });

    const { client: oauthClient } = await signInWith(
      "google",
      "google-link-sub",
      "linkme@example.com",
    );

    const me = await oauthClient.get<{ user: { id: string } }>("/v1/me");
    // Same account, reached two ways — not a second workspace.
    expect(me.body.user.id).toBe(account.userId);

    const identities = await harness.handle.db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.userId, account.userId));
    expect(identities.map((i) => i.provider).sort()).toEqual(["google", "password"]);
  });

  it("verifies a previously unverified account when the provider vouches for it", async () => {
    const client = new ApiClient(harness.app);
    const account = await signUpUnverified(client, { email: "unverified-link@example.com" });

    // Still gated before the provider gets involved.
    expect((await client.get("/v1/subscriptions")).status).toBe(403);

    const { client: oauthClient } = await signInWith(
      "google",
      "g-link-sub",
      "unverified-link@example.com",
    );

    const me = await oauthClient.get<{ user: { id: string; emailVerified: boolean } }>("/v1/me");
    expect(me.body.user.id).toBe(account.userId);
    expect(me.body.user.emailVerified).toBe(true);
  });

  it("refuses to log in with a password on an OAuth-only account", async () => {
    await signInWith("google", "google-nopass", "nopassword@example.com");

    const client = new ApiClient(harness.app);
    const response = await client.post("/v1/auth/login", {
      email: "nopassword@example.com",
      password: "anything-at-all",
    });

    expect(response.status).toBe(401);
  });
});

describe("email verification", () => {
  it("rejects a wrong code and counts the attempt", async () => {
    const client = new ApiClient(harness.app);
    const account = await signUpUnverified(client, { email: "wrongcode@example.com" });

    const bad = await client.post<{ error: { details: { attemptsRemaining: number } } }>(
      "/v1/auth/verify",
      { email: account.email, code: "000000" },
    );

    expect(bad.status).toBe(400);
    expect(expectErrorCode(bad.body)).toBe("VALIDATION_ERROR");
    // Still gated.
    expect((await client.get("/v1/subscriptions")).status).toBe(403);

    const good = await client.post("/v1/auth/verify", {
      email: account.email,
      code: account.verificationCode,
    });
    expect(good.status).toBe(200);
  });

  it("stops accepting guesses after the attempt ceiling", async () => {
    const client = new ApiClient(harness.app);
    const account = await signUpUnverified(client, { email: "bruteforce@example.com" });

    for (let i = 0; i < 5; i += 1) {
      await client.post("/v1/auth/verify", { email: account.email, code: "111111" });
    }

    // Even the correct code is refused once the ceiling is hit.
    const response = await client.post("/v1/auth/verify", {
      email: account.email,
      code: account.verificationCode,
    });
    expect(response.status).toBe(429);
    expect(expectErrorCode(response.body)).toBe("RATE_LIMITED");
  });

  it("refuses an expired code", async () => {
    const client = new ApiClient(harness.app);
    const account = await signUpUnverified(client, { email: "expired@example.com" });

    await harness.handle.db
      .update(emailVerificationCodes)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(emailVerificationCodes.email, account.email));

    const response = await client.post("/v1/auth/verify", {
      email: account.email,
      code: account.verificationCode,
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("expired");
  });

  it("is idempotent — verifying twice is not an error", async () => {
    const client = new ApiClient(harness.app);
    const account = await signUpUnverified(client, { email: "twice@example.com" });

    const first = await client.post<{ alreadyVerified: boolean }>("/v1/auth/verify", {
      email: account.email,
      code: account.verificationCode,
    });
    const second = await client.post<{ alreadyVerified: boolean }>("/v1/auth/verify", {
      email: account.email,
      code: account.verificationCode,
    });

    expect(first.body.alreadyVerified).toBe(false);
    expect(second.status).toBe(200);
    expect(second.body.alreadyVerified).toBe(true);
  });

  it("retires the old code when a new one is issued", async () => {
    const client = new ApiClient(harness.app);
    const account = await signUpUnverified(client, { email: "rotate@example.com" });

    // Bypass the cooldown; this test is about rotation, not throttling.
    await harness.handle.db
      .update(emailVerificationCodes)
      .set({ createdAt: new Date(Date.now() - 600_000) })
      .where(eq(emailVerificationCodes.email, account.email));

    const resent = await client.post("/v1/auth/resend-code", { email: account.email });
    expect(resent.status).toBe(200);

    // A stolen earlier code must not survive the user asking for a fresh one.
    const stale = await client.post("/v1/auth/verify", {
      email: account.email,
      code: account.verificationCode,
    });
    expect(stale.status).toBe(400);

    const newCode = harness.mailbox().at(-1)!.text.match(/\b(\d{6})\b/)![1]!;
    const ok = await client.post("/v1/auth/verify", { email: account.email, code: newCode });
    expect(ok.status).toBe(200);
  });

  it("throttles resend requests", async () => {
    const client = new ApiClient(harness.app);
    const account = await signUpUnverified(client, { email: "throttle@example.com" });

    const response = await client.post("/v1/auth/resend-code", { email: account.email });
    expect(response.status).toBe(429);
  });

  it("does not disclose whether an address exists", async () => {
    const client = new ApiClient(harness.app);
    const response = await client.post<{ ok: boolean }>("/v1/auth/resend-code", {
      email: "nobody-here@example.com",
    });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });
});

describe("the verification gate", () => {
  it("blocks protected routes but allows the ones the wait screen needs", async () => {
    const client = new ApiClient(harness.app);
    await signUpUnverified(client, { email: "gated@example.com" });

    for (const path of ["/v1/subscriptions", "/v1/settings", "/v1/agent/sessions/latest"]) {
      const response = await client.get(path);
      expect(response.status, path).toBe(403);
      expect(expectErrorCode(response.body), path).toBe("EMAIL_NOT_VERIFIED");
    }

    // These have to work from inside the "check your email" screen.
    expect((await client.get("/v1/me")).status).toBe(200);
    expect((await client.post("/v1/auth/logout")).status).toBe(200);
  });
});

describe("google one-tap (ID token)", () => {
  /*
   * These tokens are really signed and really verified. The signer installs a
   * local key set and mints genuine RS256 JWTs, so jwtVerify checks signature,
   * issuer, audience and expiry exactly as it does against Google. The previous
   * version of these tests posted the literal string
   * `mock:<sub>:<email>` into a branch that skipped verification entirely —
   * which meant the code path in front of real users was never tested here.
   */
  let signer: GoogleIdTokenSigner;

  beforeAll(async () => {
    signer = await installGoogleIdTokenSigner();
  });

  afterAll(() => {
    signer.restore();
  });

  it("exposes what the login screen needs, without any secret", async () => {
    const client = new ApiClient(harness.app);
    const response = await client.get<{
      googleClientId: string | null;
      providers: { password: boolean; googleOneTap: boolean };
      oauthMode: string;
    }>("/v1/auth/config");

    expect(response.status).toBe(200);
    expect(response.body.providers.password).toBe(true);
    expect(response.body.providers.googleOneTap).toBe(true);
    // A client id is public by design; a secret must never appear here.
    expect(JSON.stringify(response.body)).not.toContain("SECRET");
    expect(JSON.stringify(response.body)).not.toMatch(/client_?secret/i);
  });

  it("signs in with an ID token and creates a verified account", async () => {
    const client = new ApiClient(harness.app);
    const response = await client.post<{
      token: string;
      user: { email: string; emailVerified: boolean };
    }>("/v1/auth/google/id-token", {
      credential: await signer.sign({ sub: "onetap-sub", email: "onetap@example.com" }),
    });

    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe("onetap@example.com");
    expect(response.body.user.emailVerified).toBe(true);

    client.setToken(response.body.token);
    expect((await client.get("/v1/subscriptions")).status).toBe(200);
  });

  it("stores no access token, because One Tap issues none", async () => {
    const client = new ApiClient(harness.app);
    await client.post("/v1/auth/google/id-token", {
      credential: await signer.sign({
        sub: "onetap-notokens",
        email: "notokens@example.com",
      }),
    });

    const [identity] = await harness.handle.db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.providerAccountId, "onetap-notokens"));

    expect(identity).toBeDefined();
    expect(identity!.accessToken).toBeNull();
    expect(identity!.refreshToken).toBeNull();
  });

  it("lands on the same account as the redirect flow for one Google subject", async () => {
    const first = await signInWith("google", "shared-sub", "shared@example.com");
    const me1 = await first.client.get<{ user: { id: string } }>("/v1/me");

    const client = new ApiClient(harness.app);
    const response = await client.post<{ token: string }>("/v1/auth/google/id-token", {
      credential: await signer.sign({ sub: "shared-sub", email: "shared@example.com" }),
    });
    client.setToken(response.body.token);
    const me2 = await client.get<{ user: { id: string } }>("/v1/me");

    // Two entry points, one identity — not a duplicate account.
    expect(me2.body.user.id).toBe(me1.body.user.id);
  });

  it("rejects a malformed credential", async () => {
    const client = new ApiClient(harness.app);
    const response = await client.post("/v1/auth/google/id-token", {
      credential: "not-a-real-token",
    });
    expect(response.status).toBe(401);
  });

  it("rejects a token minted for another site", async () => {
    const client = new ApiClient(harness.app);
    const response = await client.post("/v1/auth/google/id-token", {
      credential: await signer.sign({
        sub: "replay-sub",
        email: "replay@example.com",
        audience: "some-other-client-id.apps.googleusercontent.com",
      }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const client = new ApiClient(harness.app);
    const response = await client.post("/v1/auth/google/id-token", {
      credential: await signer.sign({
        sub: "expired-sub",
        email: "expired@example.com",
        expiresIn: "-1m",
      }),
    });
    expect(response.status).toBe(401);
  });
});
