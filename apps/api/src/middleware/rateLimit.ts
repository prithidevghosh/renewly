import type { MiddlewareHandler } from "hono";
import { AppError } from "../lib/errors.js";
import type { AppEnv } from "../types/context.js";

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * In-memory fixed-window limiter. Sufficient for V1's single-process deploy;
 * a multi-instance deploy needs a shared store.
 */
export function rateLimit(options: {
  limit: number;
  windowMs: number;
  key?: (ip: string, path: string) => string;
}): MiddlewareHandler<AppEnv> {
  const buckets = new Map<string, Bucket>();

  return async (c, next) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      "unknown";
    const key = options.key ? options.key(ip, c.req.path) : `${ip}:${c.req.path}`;
    const now = Date.now();

    const existing = buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    } else {
      existing.count += 1;
      if (existing.count > options.limit) {
        const retryAfter = Math.ceil((existing.resetAt - now) / 1000);
        c.header("retry-after", String(retryAfter));
        throw new AppError("RATE_LIMITED", "Too many requests, slow down", { retryAfter });
      }
    }

    // Opportunistic sweep so the map cannot grow without bound.
    if (buckets.size > 5000) {
      for (const [k, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(k);
    }

    await next();
  };
}
