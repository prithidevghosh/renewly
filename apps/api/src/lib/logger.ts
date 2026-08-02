import { createRequire } from "node:module";
import { pino, type Logger, type LoggerOptions } from "pino";
import { env } from "../env.js";

/**
 * Card credentials and secrets must never reach a log sink. Redaction is
 * declared here rather than at call sites so a new logger call cannot leak by
 * omission.
 */
const REDACT_PATHS = [
  "password",
  "*.password",
  "*.passwordHash",
  "password_hash",
  "*.password_hash",
  "cardNumber",
  "*.cardNumber",
  "card_number",
  "*.card_number",
  "cvv",
  "*.cvv",
  "dynamic_cvv",
  "*.dynamic_cvv",
  "token",
  "*.token",
  "sessionToken",
  "*.sessionToken",
  "session_token",
  "*.session_token",
  "credentials",
  "*.credentials",
  "authorization",
  "req.headers.authorization",
  "headers.authorization",
  "PRAVA_SECRET_KEY",
  "LLM_API_KEY",
  "AUTH_SECRET",
];

/**
 * Colourised, human-readable lines in development; single-line JSON everywhere
 * else, because a log shipper wants the JSON and a person does not.
 *
 * pino-pretty is a devDependency, so a production install will not have it.
 * Resolving it first means a `NODE_ENV=development` boot against a pruned
 * install degrades to JSON rather than crashing in a worker thread.
 */
function prettyTransport(): LoggerOptions["transport"] {
  if (env.NODE_ENV !== "development") return undefined;
  try {
    createRequire(import.meta.url).resolve("pino-pretty");
  } catch {
    return undefined;
  }
  return {
    target: "pino-pretty",
    options: {
      colorize: true,
      // Milliseconds matter when you are looking at why a request took 900ms.
      translateTime: "SYS:HH:MM:ss.l",
      /*
       * The message already carries the interesting facts, so the object that
       * follows is context rather than the headline. Hidden here:
       *  - pid/hostname/service/env  constant for the whole process
       *  - method/path               already in the message for request lines
       *  - requestId                 shown, but last, via messageFormat below
       */
      ignore: "pid,hostname,service,env,method,path",
      messageKey: "msg",
      errorLikeObjectKeys: ["err", "error"],
      // One line per event unless there is an error to expand.
      singleLine: true,
      // A short request-id tag lets you follow one request through the log
      // without the full ULID taking up half the width.
      messageFormat: "{if requestId}[2m[{requestId}][0m {end}{msg}",
    },
  };
}

export const logger: Logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.NODE_ENV === "production" ? "info" : "debug",
  redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  base: { service: "renewly-api", env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: prettyTransport(),
});

export const childLogger = (bindings: Record<string, unknown>): Logger => logger.child(bindings);
