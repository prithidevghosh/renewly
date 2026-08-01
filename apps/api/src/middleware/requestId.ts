import type { MiddlewareHandler } from "hono";
import { newId } from "../lib/id.js";
import { logger } from "../lib/logger.js";
import type { AppEnv } from "../types/context.js";

export const requestId = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const incoming = c.req.header("x-request-id");
  const id = incoming && incoming.length <= 128 ? incoming : newId("evt");
  c.set("requestId", id);
  c.set("log", logger.child({ requestId: id, method: c.req.method, path: c.req.path }));
  c.header("x-request-id", id);
  await next();
};
