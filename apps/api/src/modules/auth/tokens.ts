import { SignJWT, jwtVerify } from "jose";
import { env } from "../../env.js";
import { unauthorized } from "../../lib/errors.js";

const ISSUER = "renewly-api";
const AUDIENCE = "renewly-app";

const secret = (): Uint8Array => new TextEncoder().encode(env.AUTH_SECRET);

export interface TokenClaims {
  userId: string;
  workspaceId: string;
}

export async function signToken(claims: TokenClaims): Promise<{ token: string; expiresAt: string }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + env.AUTH_TOKEN_TTL_SECONDS;
  const token = await new SignJWT({ wsp: claims.workspaceId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(secret());
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

export async function verifyToken(token: string): Promise<TokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const userId = payload.sub;
    const workspaceId = payload.wsp;
    if (typeof userId !== "string" || typeof workspaceId !== "string") {
      throw unauthorized("Malformed session token");
    }
    return { userId, workspaceId };
  } catch (error) {
    if (error instanceof Error && error.name === "AppError") throw error;
    throw unauthorized("Session token is invalid or expired");
  }
}

export const SESSION_COOKIE = "renewly_session";
