import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { env } from "../../env.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { AppError } from "../../lib/errors.js";
import { readJson } from "../../lib/http.js";
import { requireAuth } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import type { AppEnv } from "../../types/context.js";
import { recordAudit } from "../audit/service.js";
import { serializeSettings } from "../settings/serialize.js";
import { verifyGoogleIdToken } from "./oauth/googleIdToken.js";
import { getOAuthClient } from "./oauth/providers.js";
import type { SocialProvider } from "./oauth/types.js";
import { login, signInWithProvider, signup, toPublicUser, type AuthResult } from "./service.js";
import { SESSION_COOKIE } from "./tokens.js";
import { resendVerificationCode, verifyCode } from "./verification.js";

const signupSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(200),
  workspaceName: z.string().min(1).max(200).optional(),
});

const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

export const authRoutes = new Hono<AppEnv>();

// Credential endpoints are the cheapest thing to brute force, so they get their
// own window independent of the global limiter.
const credentialLimiter = rateLimit({ limit: 10, windowMs: 60_000 });

function attachSession(c: Context<AppEnv>, result: AuthResult): void {
  setCookie(c, SESSION_COOKIE, result.token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: env.AUTH_TOKEN_TTL_SECONDS,
  });
}

authRoutes.post("/signup", credentialLimiter, async (c) => {
  const input = await readJson(c, signupSchema);
  const result = await signup(input);
  attachSession(c, result);
  return c.json(
    {
      user: result.user,
      workspaceId: result.workspaceId,
      token: result.token,
      expiresAt: result.expiresAt,
      verificationRequired: true,
      // Mock mail mode only, so a local developer or the test suite can finish a
      // signup without a mail provider. Always null when mail is live.
    },
    201,
  );
});

/* -------------------------------------------------------------------------- */
/* Email verification                                                         */
/* -------------------------------------------------------------------------- */

authRoutes.post("/verify", credentialLimiter, async (c) => {
  const input = await readJson(
    c,
    z.object({
      email: z.string().email().max(320),
      code: z.string().min(4).max(12),
    }),
  );

  const { user, alreadyVerified } = await verifyCode(input);
  // No new token: the gate reads `emailVerifiedAt` from the database on every
  // request, so the session the client already holds starts working the moment
  // this succeeds.
  return c.json({ user: toPublicUser(user), alreadyVerified });
});

authRoutes.post("/resend-code", credentialLimiter, async (c) => {
  const input = await readJson(c, z.object({ email: z.string().email().max(320) }));
  const outcome = await resendVerificationCode(input.email);
  // The same response whether or not the address exists: a resend endpoint that
  // distinguishes them is an account-enumeration oracle.
  return c.json({ ok: true, retryAfterSeconds: outcome.retryAfterSeconds });
});

authRoutes.post("/login", credentialLimiter, async (c) => {
  const input = await readJson(c, loginSchema);
  const result = await login(input);
  attachSession(c, result);
  return c.json({
    user: result.user,
    workspaceId: result.workspaceId,
    token: result.token,
    expiresAt: result.expiresAt,
  });
});

/* -------------------------------------------------------------------------- */
/* Google Identity Services — popup / One Tap                                 */
/* -------------------------------------------------------------------------- */

/**
 * What the login screen needs before it can render anything. Public on purpose:
 * a Google client id is embedded in the frontend bundle by design, and the
 * booleans only say which buttons to draw.
 */
authRoutes.get("/config", (c) =>
  c.json({
    googleClientId: env.GOOGLE_CLIENT_ID ?? null,
    providers: {
      password: true,
      // The popup flow needs only a client id, so it is available whenever one
      // is configured — no secret, no registered redirect URI.
      // Report only what will actually work, so the client never draws a button
      // that 400s. `disabled` hides them entirely.
      googleOneTap: env.OAUTH_MODE === "live" && Boolean(env.GOOGLE_CLIENT_ID),
      googleRedirect: env.OAUTH_MODE === "live" && Boolean(env.GOOGLE_CLIENT_SECRET),
    },
    oauthMode: env.OAUTH_MODE,
  }),
);

/**
 * Exchanges the ID token from `google.accounts.id` for a Renewly session.
 * Same account creation, linking and workspace rules as the redirect flow.
 */
authRoutes.post("/google/id-token", credentialLimiter, async (c) => {
  const input = await readJson(c, z.object({ credential: z.string().min(1).max(8000) }));

  const exchange = await verifyGoogleIdToken(input.credential);
  const result = await signInWithProvider({ provider: "google", exchange });
  attachSession(c, result);

  return c.json({
    user: result.user,
    workspaceId: result.workspaceId,
    token: result.token,
    expiresAt: result.expiresAt,
  });
});

/* -------------------------------------------------------------------------- */
/* OAuth — Google                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The CSRF state and the PKCE verifier live in a short-lived httpOnly cookie
 * rather than a database table. They are single-use, scoped to one browser and
 * worthless after the callback, so a row would be pure overhead — and a table
 * would need sweeping.
 */
const OAUTH_FLOW_COOKIE = "renewly_oauth";
const OAUTH_FLOW_TTL_SECONDS = 600;

const providerParam = z.enum(["google"]);

interface FlowCookie {
  state: string;
  verifier: string;
  provider: SocialProvider;
  redirectTo: string;
}

/** RFC 7636 S256: the challenge is the base64url SHA-256 of the verifier. */
function codeChallengeFor(verifier: string): string {
  return Buffer.from(sha256(verifier), "hex").toString("base64url");
}

function redirectUriFor(provider: SocialProvider): string {
  return `${env.API_URL}/v1/auth/oauth/${provider}/callback`;
}

authRoutes.get("/oauth/:provider/start", credentialLimiter, (c) => {
  const parsed = providerParam.safeParse(c.req.param("provider"));
  if (!parsed.success) throw new AppError("NOT_FOUND", "Unknown sign-in provider");
  const provider = parsed.data;

  const client = getOAuthClient(provider);
  const state = randomToken(24);
  const verifier = randomToken(32);

  // Only same-origin destinations, so `?redirectTo=` cannot be turned into an
  // open redirect that launders a phishing link through our domain.
  const requested = c.req.query("redirectTo") ?? "/";
  const redirectTo = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";

  const flow: FlowCookie = { state, verifier, provider, redirectTo };
  setCookie(c, OAUTH_FLOW_COOKIE, JSON.stringify(flow), {
    httpOnly: true,
    sameSite: "Lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: OAUTH_FLOW_TTL_SECONDS,
  });

  return c.redirect(
    client.authorizeUrl({
      state,
      codeChallenge: codeChallengeFor(verifier),
      redirectUri: redirectUriFor(provider),
    }),
  );
});

authRoutes.get("/oauth/:provider/callback", credentialLimiter, async (c) => {
  const parsed = providerParam.safeParse(c.req.param("provider"));
  if (!parsed.success) throw new AppError("NOT_FOUND", "Unknown sign-in provider");
  const provider = parsed.data;

  const providerError = c.req.query("error");
  if (providerError) {
    // The user pressed cancel, or consent was refused. Not an exception.
    return c.redirect(`${env.APP_URL}/login?error=${encodeURIComponent(providerError)}`);
  }

  const raw = getCookie(c, OAUTH_FLOW_COOKIE);
  if (!raw) throw new AppError("UNAUTHORIZED", "Sign-in session expired. Start again.");

  let flow: FlowCookie;
  try {
    flow = JSON.parse(raw) as FlowCookie;
  } catch {
    throw new AppError("UNAUTHORIZED", "Sign-in session was malformed. Start again.");
  }

  const state = c.req.query("state");
  const code = c.req.query("code");
  // The state check is the entire CSRF defence for this flow.
  if (!state || state !== flow.state || flow.provider !== provider) {
    throw new AppError("UNAUTHORIZED", "Sign-in state did not match. Start again.");
  }
  if (!code) throw new AppError("UNAUTHORIZED", "The provider returned no authorization code");

  deleteCookie(c, OAUTH_FLOW_COOKIE, { path: "/" });

  const client = getOAuthClient(provider);
  const exchange = await client.exchange({
    code,
    codeVerifier: flow.verifier,
    redirectUri: redirectUriFor(provider),
  });

  const result = await signInWithProvider({ provider, exchange });
  attachSession(c, result);

  return c.redirect(`${env.APP_URL}${flow.redirectTo}`);
});

authRoutes.post("/logout", requireAuth({ allowUnverified: true }), async (c) => {
  const { user, workspace } = c.get("auth");
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  await recordAudit({
    workspaceId: workspace.id,
    actorUserId: user.id,
    type: "auth.logout",
    entityType: "user",
    entityId: user.id,
  });
  return c.json({ ok: true });
});

export const meRoutes = new Hono<AppEnv>();

// Reachable while unverified on purpose: the "check your email" screen needs to
// poll its own status, and a client that cannot read `emailVerified` has no way
// to know when to move on.
meRoutes.get("/", requireAuth({ allowUnverified: true }), (c) => {
  const { user, workspace, settings } = c.get("auth");
  return c.json({
    user: toPublicUser(user),
    workspace: {
      id: workspace.id,
      name: workspace.name,
      ownerUserId: workspace.ownerUserId,
      createdAt: workspace.createdAt.toISOString(),
      role: "owner" as const,
    },
    settings: serializeSettings(settings),
  });
});
