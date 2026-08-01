import { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import { AppError, validationError } from "../../lib/errors.js";
import { parseWith } from "../../lib/http.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import type { AppEnv } from "../../types/context.js";
import { joinWaitlist } from "./service.js";

const joinSchema = z.object({
  email: z.string().trim().max(320).email(),
  name: z.string().trim().min(1).max(200).optional(),
  /** Free-form attribution: which section, campaign or surface sent them. */
  source: z.string().trim().min(1).max(60).optional(),
  referrer: z.string().trim().max(500).optional(),
});

/** Enough to see what was posted, bounded so a junk body cannot flood the log. */
const MAX_LOGGED_BODY = 1000;

export const waitlistRoutes = new Hono<AppEnv>();

// Public and unauthenticated, so it gets a tighter window than the global
// ceiling — but wide enough that a shared office address is not locked out by
// its own colleagues.
const joinLimiter = rateLimit({ limit: 20, windowMs: 60_000 });

waitlistRoutes.post("/", joinLimiter, async (c) => {
  // The request-scoped child logger already carries requestId, method and path,
  // so every line below correlates to one signup attempt.
  const log = c.get("log");

  // Read the body ourselves rather than via readJson, so what arrived is on the
  // record even when it never parses.
  const rawBody = await c.req.text();
  log.info(
    {
      contentType: c.req.header("content-type") ?? null,
      userAgent: c.req.header("user-agent") ?? null,
      referer: c.req.header("referer") ?? null,
      ip: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
      bodyBytes: rawBody.length,
      body: rawBody.slice(0, MAX_LOGGED_BODY),
    },
    "waitlist request received",
  );

  const input = parseWith(joinSchema, parseBody(rawBody, log));
  log.debug({ input }, "waitlist input accepted");

  try {
    const result = await joinWaitlist(
      {
        ...input,
        // The browser's own Referer is a reasonable fallback when the form does
        // not name its source, and is never trusted for anything but attribution.
        referrer: input.referrer ?? c.req.header("referer"),
      },
      undefined,
      log,
    );

    // Reached only when the row is written and both mails have gone out; the
    // service throws otherwise.
    const status = result.alreadyJoined ? 200 : 201;
    const body = {
      waitlist: {
        email: result.entry.email,
        position: result.position,
        alreadyJoined: result.alreadyJoined,
        mail: result.entry.mailStatus,
        joinedAt: result.entry.createdAt.toISOString(),
      },
    };

    log.info({ status, response: body }, "waitlist responding with success");
    return c.json(body, status);
  } catch (error) {
    // The error handler logs the failure generically; this logs the exact body
    // the caller is about to receive.
    if (error instanceof AppError) {
      log.error(
        { status: error.status, code: error.code, response: error.toBody() },
        "waitlist responding with an error",
      );
    }
    throw error;
  }
});

function parseBody(raw: string, log: Logger): unknown {
  if (raw.trim() === "") {
    log.warn("waitlist request had an empty body");
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    log.warn(
      { reason: error instanceof Error ? error.message : String(error) },
      "waitlist request body was not valid JSON",
    );
    throw validationError("Request body must be valid JSON");
  }
}
