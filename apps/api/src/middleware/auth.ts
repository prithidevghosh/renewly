import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { unauthorized } from "../lib/errors.js";
import { resolveAuthContext } from "../modules/auth/service.js";
import { SESSION_COOKIE, verifyToken } from "../modules/auth/tokens.js";
import type { AppEnv } from "../types/context.js";

/**
 * Accepts `Authorization: Bearer <jwt>` (primary) or the `renewly_session`
 * cookie (browser convenience). The cookie is set by the auth routes with
 * httpOnly + sameSite=lax.
 */
export const requireAuth = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const header = c.req.header("authorization");
  const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
  const token = bearer ?? getCookie(c, SESSION_COOKIE) ?? null;

  if (!token) throw unauthorized("Missing bearer token or session cookie");

  const claims = await verifyToken(token);
  const auth = await resolveAuthContext(claims.userId, claims.workspaceId);
  c.set("auth", auth);
  c.set("log", c.get("log").child({ userId: auth.user.id, workspaceId: auth.workspace.id }));
  await next();
};
