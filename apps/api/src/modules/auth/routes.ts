import { Hono, type Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { env } from "../../env.js";
import { readJson } from "../../lib/http.js";
import { requireAuth } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import type { AppEnv } from "../../types/context.js";
import { recordAudit } from "../audit/service.js";
import { serializeSettings } from "../settings/serialize.js";
import { login, signup, toPublicUser, type AuthResult } from "./service.js";
import { SESSION_COOKIE } from "./tokens.js";

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
    },
    201,
  );
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

authRoutes.post("/logout", requireAuth(), async (c) => {
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

meRoutes.get("/", requireAuth(), (c) => {
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
