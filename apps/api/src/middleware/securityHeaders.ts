import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types/context.js";

/**
 * The API serves JSON only, so the policy is deliberately severe: nothing is
 * allowed to load, frame or sniff a response.
 */
export const securityHeaders = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header("x-frame-options", "DENY");
  c.header("referrer-policy", "no-referrer");
  c.header("cross-origin-opener-policy", "same-origin");
  c.header("cross-origin-resource-policy", "same-origin");
  c.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  c.header("permissions-policy", "geolocation=(), microphone=(), camera=()");
  c.header("strict-transport-security", "max-age=31536000; includeSubDomains");
};
