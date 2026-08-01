import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { AppError, type ErrorBody } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import type { AppEnv } from "../types/context.js";

function body(code: ErrorBody["error"]["code"], message: string, details = {}): ErrorBody {
  return { error: { code, message, details } };
}

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  const log = safeLogger(c);

  if (err instanceof AppError) {
    // 4xx are expected control flow (policy blocks, validation); 5xx are not.
    if (err.status >= 500) log.error({ err, code: err.code }, err.message);
    else log.info({ code: err.code, details: err.details }, err.message);
    return c.json(err.toBody(), err.status as 400);
  }

  if (err instanceof ZodError) {
    log.info({ issues: err.issues }, "response validation failed");
    return c.json(
      body("VALIDATION_ERROR", "Request failed validation", {
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      }),
      400,
    );
  }

  if (err instanceof HTTPException) {
    const code = err.status === 401 ? "UNAUTHORIZED" : err.status === 404 ? "NOT_FOUND" : "VALIDATION_ERROR";
    log.info({ status: err.status }, err.message);
    return c.json(body(code, err.message), err.status);
  }

  log.error({ err }, "unhandled error");
  return c.json(body("INTERNAL_ERROR", "Something went wrong"), 500);
};

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) =>
  c.json(body("NOT_FOUND", `No route for ${c.req.method} ${c.req.path}`), 404);

function safeLogger(c: Context<AppEnv>) {
  try {
    return c.get("log") ?? logger;
  } catch {
    return logger;
  }
}
