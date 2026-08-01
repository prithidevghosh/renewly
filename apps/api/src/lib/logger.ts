import { pino, type Logger } from "pino";
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

export const logger: Logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.NODE_ENV === "production" ? "info" : "debug",
  redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  base: { service: "renewly-api", env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export const childLogger = (bindings: Record<string, unknown>): Logger => logger.child(bindings);
