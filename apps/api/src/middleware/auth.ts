import { getCookie } from "hono/cookie";
import type { MiddlewareHandler } from "hono";
import { AppError, unauthorized } from "../lib/errors.js";
import { resolveAuthContext } from "../modules/auth/service.js";
import { SESSION_COOKIE, verifyToken } from "../modules/auth/tokens.js";
import type { AppEnv } from "../types/context.js";

/**
 * Accepts `Authorization: Bearer <jwt>` (primary) or the `renewly_session`
 * cookie (browser convenience). The cookie is set by the auth routes with
 * httpOnly + sameSite=lax.
 *
 * An unverified account holds a valid session but reaches almost nothing. The
 * token exists so the client can check its own status and ask for another code;
 * everything else waits for the code. `allowUnverified` opens that door for the
 * handful of routes that have to work from inside the "check your email" screen.
 */
export const requireAuth =
  (options: { allowUnverified?: boolean } = {}): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const header = c.req.header("authorization");
    const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
    const token = bearer ?? getCookie(c, SESSION_COOKIE) ?? null;

    if (!token) throw unauthorized("Missing bearer token or session cookie");

    const claims = await verifyToken(token);
    const auth = await resolveAuthContext(claims.userId, claims.workspaceId);

    if (!options.allowUnverified && auth.user.emailVerifiedAt === null) {
      throw new AppError("EMAIL_NOT_VERIFIED", "Verify your email address to continue", {
        email: auth.user.email,
      });
    }

    c.set("auth", auth);
    // The email is here so a log line names a person rather than a ULID; the
    // ids stay for grepping and for joins against the database.
    c.set(
      "log",
      c.get("log").child({
        userId: auth.user.id,
        userEmail: auth.user.email,
        workspaceId: auth.workspace.id,
      }),
    );
    await next();
  };
