import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types/context.js";

/**
 * One line per request, after it finishes.
 *
 * Without this the only visible logs are the ones a route author remembered to
 * write, so most of the API was silent: a request could arrive, be rejected by
 * a guard and leave, and nothing said it happened. An access log is the floor
 * everything else builds on — it means every endpoint has at least a heartbeat,
 * and a request id to pull the rest of the story together with.
 *
 * Level follows the outcome, so a scan for warnings finds the failures:
 *   2xx/3xx  info      the normal case
 *   4xx      warn      the caller did something wrong
 *   5xx      error     we did
 * Health probes are debug: Railway hits /health continuously and would
 * otherwise bury everything worth reading.
 */

/** Endpoints that fire on a timer and say nothing useful when they succeed. */
const QUIET_PATHS = new Set(["/health", "/v1/demo/status"]);

export const accessLog = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const startedAt = Date.now();

  // The stream holds the connection open for as long as the agent runs, so
  // logging it on completion would report a 30-minute request. Announce it on
  // the way in instead.
  const isStream = c.req.path.endsWith("/stream");
  if (isStream) {
    c.get("log").info({ method: c.req.method, path: c.req.path }, "stream opened");
  }

  try {
    await next();
  } finally {
    const durationMs = Date.now() - startedAt;
    const status = c.res?.status ?? 500;

    // requireAuth sets these once it has resolved a session, so a request that
    // got past the door can be traced to whose it was.
    const auth = c.get("auth");

    const payload: Record<string, unknown> = {
      method: c.req.method,
      path: c.req.path,
      status,
      durationMs,
    };
    if (auth) {
      payload.userId = auth.user.id;
      payload.workspaceId = auth.workspace.id;
    }

    const log = c.get("log");
    const message = `${c.req.method} ${c.req.path} ${status} ${durationMs}ms`;

    if (QUIET_PATHS.has(c.req.path)) log.debug(payload, message);
    else if (status >= 500) log.error(payload, message);
    else if (status >= 400) log.warn(payload, message);
    else log.info(payload, message);
  }
};
