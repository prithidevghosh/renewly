import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { env } from "../../env.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { AppError } from "../../lib/errors.js";
import { requireAuth } from "../../middleware/auth.js";
import type { AppEnv } from "../../types/context.js";
import { verifyToken } from "../auth/tokens.js";
import { resolveAuthContext } from "../auth/service.js";
import { getMailboxClient } from "./mock.js";
import {
  fetchReceipts,
  getConnection,
  listConnections,
  revokeConnection,
  saveGrant,
  serializeConnection,
} from "./service.js";

/**
 * Mailbox consent and inspection.
 *
 * `/connect/:provider` and `/callback/:provider` are browser redirects, not API
 * calls. The callback cannot carry an Authorization header, so the flow cookie
 * carries the session token that started it — that is what ties the returning
 * browser back to a workspace without trusting anything in the query string.
 */

const MAILBOX_FLOW_COOKIE = "renewly_mailbox";
const FLOW_TTL_SECONDS = 600;

const providerParam = z.enum(["gmail", "outlook"]);

interface FlowCookie {
  state: string;
  verifier: string;
  provider: "gmail" | "outlook";
  token: string;
  redirectTo: string;
}

function codeChallengeFor(verifier: string): string {
  return Buffer.from(sha256(verifier), "hex").toString("base64url");
}

function redirectUriFor(provider: string): string {
  return `${env.API_URL}/v1/mailbox/callback/${provider}`;
}

export const mailboxRoutes = new Hono<AppEnv>();

/* -------------------------------------------------------------------------- */
/* Authenticated                                                              */
/* -------------------------------------------------------------------------- */

mailboxRoutes.get("/", requireAuth(), async (c) => {
  const { workspace } = c.get("auth");
  const rows = await listConnections(workspace.id);
  return c.json({ connections: rows.map(serializeConnection) });
});

mailboxRoutes.delete("/:id", requireAuth(), async (c) => {
  const { workspace, user } = c.get("auth");
  const row = await revokeConnection(workspace.id, c.req.param("id"), user.id);
  return c.json({ connection: serializeConnection(row) });
});

/**
 * A dry run of what the detector will read. Useful for the terminal's "we found
 * X receipts" step and for confirming a connection actually works before the
 * pipeline depends on it.
 */
mailboxRoutes.get("/:id/receipts", requireAuth(), async (c) => {
  const { workspace } = c.get("auth");
  const connection = await getConnection(workspace.id, c.req.param("id"));

  const monthsBack = Math.min(Number(c.req.query("months") ?? 3) || 3, 12);
  const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);

  const messages = await fetchReceipts({ connection, monthsBack, limit });

  return c.json({
    connection: serializeConnection(connection),
    monthsBack,
    count: messages.length,
    receipts: messages.map((message) => ({
      providerMessageId: message.providerMessageId,
      subject: message.subject,
      from: message.from,
      receivedAt: message.receivedAt?.toISOString() ?? null,
      snippet: message.snippet,
    })),
  });
});

/* -------------------------------------------------------------------------- */
/* Consent — browser redirects                                                */
/* -------------------------------------------------------------------------- */

mailboxRoutes.get("/connect/:provider", requireAuth(), async (c) => {
  const parsed = providerParam.safeParse(c.req.param("provider"));
  if (!parsed.success) throw new AppError("NOT_FOUND", "Unknown mailbox provider");
  const provider = parsed.data;

  const client = await getMailboxClient(provider);
  const state = randomToken(24);
  const verifier = randomToken(32);

  const requested = c.req.query("redirectTo") ?? "/";
  const redirectTo = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";

  // The session token rides in the cookie because the provider's callback
  // arrives as a plain browser navigation with no way to set a header.
  const header = c.req.header("authorization");
  const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
  const token = bearer ?? getCookie(c, "renewly_session") ?? "";

  const flow: FlowCookie = { state, verifier, provider, token, redirectTo };
  setCookie(c, MAILBOX_FLOW_COOKIE, JSON.stringify(flow), {
    httpOnly: true,
    sameSite: "Lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: FLOW_TTL_SECONDS,
  });

  return c.redirect(
    client.authorizeUrl({
      state,
      codeChallenge: codeChallengeFor(verifier),
      redirectUri: redirectUriFor(provider),
    }),
  );
});

mailboxRoutes.get("/callback/:provider", async (c) => {
  const parsed = providerParam.safeParse(c.req.param("provider"));
  if (!parsed.success) throw new AppError("NOT_FOUND", "Unknown mailbox provider");
  const provider = parsed.data;

  const providerError = c.req.query("error");
  const raw = getCookie(c, MAILBOX_FLOW_COOKIE);
  if (!raw) throw new AppError("UNAUTHORIZED", "Mailbox consent expired. Start again.");

  let flow: FlowCookie;
  try {
    flow = JSON.parse(raw) as FlowCookie;
  } catch {
    throw new AppError("UNAUTHORIZED", "Mailbox consent was malformed. Start again.");
  }
  deleteCookie(c, MAILBOX_FLOW_COOKIE, { path: "/" });

  if (providerError) {
    // Declining to share an inbox is a normal answer, not a failure.
    return c.redirect(
      `${env.APP_URL}${flow.redirectTo}?mailbox_error=${encodeURIComponent(providerError)}`,
    );
  }

  const state = c.req.query("state");
  const code = c.req.query("code");
  if (!state || state !== flow.state || flow.provider !== provider) {
    throw new AppError("UNAUTHORIZED", "Mailbox consent state did not match. Start again.");
  }
  if (!code) throw new AppError("UNAUTHORIZED", "The provider returned no authorization code");

  const claims = await verifyToken(flow.token);
  const auth = await resolveAuthContext(claims.userId, claims.workspaceId);

  const client = await getMailboxClient(provider);
  const grant = await client.exchange({
    code,
    codeVerifier: flow.verifier,
    redirectUri: redirectUriFor(provider),
  });

  const connection = await saveGrant({
    workspaceId: auth.workspace.id,
    userId: auth.user.id,
    provider,
    grant,
  });

  return c.redirect(
    `${env.APP_URL}${flow.redirectTo}?mailbox=connected&address=${encodeURIComponent(connection.emailAddress)}`,
  );
});
