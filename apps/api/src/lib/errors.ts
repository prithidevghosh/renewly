/**
 * Domain error codes. These are part of the public API contract — see
 * README "Error codes". Every code maps to exactly one HTTP status.
 */
export type ErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "EMAIL_NOT_VERIFIED"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "FEATURE_DISABLED"
  | "KILL_SWITCH_ENABLED"
  | "CONFIRMATION_REQUIRED"
  | "APPROVAL_REQUIRED"
  | "INVALID_DECISION_STATE"
  | "PRAVA_ERROR"
  | "CHECKOUT_DECLINED"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "INVALID_STATE_TRANSITION"
  | "CHANNEL_NOT_CONNECTED"
  | "CHANNEL_SEND_FAILED"
  | "APPROVAL_EXPIRED"
  | "DUPLICATE_IDEMPOTENCY"
  | "WEBHOOK_INVALID_SIGNATURE";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  // 403 rather than 401: the session is valid, the account simply is not usable
  // yet. A 401 would send well-behaved clients back to the login screen, which
  // is exactly the wrong place — the code is in their inbox.
  EMAIL_NOT_VERIFIED: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  // 503, not 500: the integration is switched off by configuration, not broken.
  // The request was fine and retrying it unchanged will keep failing until
  // somebody supplies a credential, which is what this status says.
  FEATURE_DISABLED: 503,
  KILL_SWITCH_ENABLED: 409,
  CONFIRMATION_REQUIRED: 409,
  APPROVAL_REQUIRED: 409,
  INVALID_DECISION_STATE: 409,
  PRAVA_ERROR: 502,
  CHECKOUT_DECLINED: 402,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  INVALID_STATE_TRANSITION: 409,
  CHANNEL_NOT_CONNECTED: 409,
  CHANNEL_SEND_FAILED: 502,
  APPROVAL_EXPIRED: 409,
  DUPLICATE_IDEMPOTENCY: 409,
  WEBHOOK_INVALID_SIGNATURE: 401,
};

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details: Record<string, unknown>;
  };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const unauthorized = (message = "Authentication required"): AppError =>
  new AppError("UNAUTHORIZED", message);

export const forbidden = (message = "Not permitted"): AppError => new AppError("FORBIDDEN", message);

export const notFound = (resource: string): AppError =>
  new AppError("NOT_FOUND", `${resource} not found`);

export const validationError = (
  message: string,
  details: Record<string, unknown> = {},
): AppError => new AppError("VALIDATION_ERROR", message, details);

export const conflict = (message: string, details: Record<string, unknown> = {}): AppError =>
  new AppError("CONFLICT", message, details);

export const statusForCode = (code: ErrorCode): number => STATUS_BY_CODE[code];
