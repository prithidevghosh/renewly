import { AppError } from "../../lib/errors.js";
import { env, pravaApiBase } from "../../env.js";

/**
 * Prava is an agent-native payment rail: it collects the user's card once
 * behind a passkey, then mints a single-use, merchant-locked, amount-scoped
 * virtual credential that our checkout adapter charges. Wire format is
 * snake_case and matches https://docs.prava.space/api-reference.
 */

export interface CreateSessionInput {
  userId: string;
  userEmail: string;
  amount: string;
  currency: string;
  /** All three fields are required by POST /v1/sessions; `url` must be https. */
  merchant: { name: string; url: string; country_code_iso2: string };
  items: Array<{ description: string; unit_price: string; quantity: number }>;
  integration_type?: "full_checkout" | "embedding";
  externalOrderRef?: string;
}

export interface CreateSessionResult {
  sessionId: string;
  sessionToken: string;
  iframeUrl: string;
  orderId?: string;
  expiresAt?: string;
}

/** Single-use credentials. These never touch the database or a log line. */
export interface OneTimeCredentials {
  txnRefId: string;
  cardNumber: string;
  cvv: string;
  expMonth: number;
  expYear: number;
  last4?: string;
  brand?: string;
}

export type PaymentResultStatus = "pending" | "awaiting_result" | "completed" | "failed";

export interface PaymentResult {
  status: string;
  credentials?: OneTimeCredentials;
  raw?: unknown;
}

export interface ReportStatusInput {
  txnRefId: string;
  txnStatus: "APPROVED" | "DECLINED";
  /** Merchant-side authorisation code, max 128 chars. */
  authorizationCode?: string;
}

export interface ReportStatusResult {
  txnStatus: "APPROVED" | "DECLINED";
  /** Whether Prava managed to confirm the outcome with the network. */
  visaConfirmation?: "SUCCESS" | "FAILURE";
}

export interface PravaClient {
  readonly mode: "mock" | "sandbox" | "live";
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
  getPaymentResult(sessionId: string): Promise<PaymentResult>;
  reportStatus(sessionId: string, input: ReportStatusInput): Promise<ReportStatusResult>;
  /** Cancels a session that will never be completed. */
  revokeSession(sessionId: string): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                */
/* -------------------------------------------------------------------------- */

interface WireCreateSessionResponse {
  session_id?: string;
  session_token?: string;
  iframe_url?: string;
  order_id?: string;
  expires_at?: string;
}

/** The rail returns no brand or last4; both are derived from the PAN below. */
interface WireLineItem {
  txn_ref_id?: string;
  merchant_name?: string | null;
  merchant_url?: string | null;
  total_amount?: string;
  status?: string;
  token?: string | null;
  dynamic_cvv?: string | null;
  expiry_month?: string | null;
  expiry_year?: string | null;
  products?: unknown[];
}

interface WireReportStatusResponse {
  status?: string;
  txn_ref_id?: string;
  txn_status?: "APPROVED" | "DECLINED";
  visa_confirmation?: "SUCCESS" | "FAILURE";
}

interface WirePaymentResultResponse {
  session_id?: string;
  order_id?: string | null;
  status?: string;
  transactions?: Array<{
    txn_id?: string;
    status?: string;
    line_items?: WireLineItem[];
    error?: { code?: string; message?: string };
  }>;
}

/** Visa/Mastercard/Amex/Discover IIN ranges, enough to label a receipt. */
export function brandFromPan(pan: string): string {
  if (/^4/.test(pan)) return "visa";
  if (/^(5[1-5]|2[2-7])/.test(pan)) return "mastercard";
  if (/^3[47]/.test(pan)) return "amex";
  if (/^6(?:011|5)/.test(pan)) return "discover";
  return "unknown";
}

export function last4(pan: string): string {
  return pan.slice(-4);
}

/* -------------------------------------------------------------------------- */
/* HTTP implementation                                                        */
/* -------------------------------------------------------------------------- */

export class HttpPravaClient implements PravaClient {
  readonly mode: "sandbox" | "live";
  private readonly baseUrl: string;
  private readonly secretKey: string;

  constructor(options: { mode: "sandbox" | "live"; baseUrl?: string; secretKey?: string }) {
    this.mode = options.mode;
    this.baseUrl = (options.baseUrl ?? pravaApiBase()).replace(/\/$/, "");
    const key = options.secretKey ?? env.PRAVA_SECRET_KEY;
    if (!key) {
      throw new AppError("PRAVA_ERROR", "PRAVA_SECRET_KEY is not configured", {
        mode: options.mode,
      });
    }
    // sk_test_* is sandbox-only and sk_live_* is production-only; crossing them
    // returns an opaque AUTH_1001, so it is worth catching at construction.
    const expectedPrefix = options.mode === "live" ? "sk_live_" : "sk_test_";
    if (!key.startsWith(expectedPrefix)) {
      throw new AppError(
        "PRAVA_ERROR",
        `PRAVA_MODE=${options.mode} requires a ${expectedPrefix}* secret key`,
        { mode: options.mode },
      );
    }
    this.secretKey = key;
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    // merchant_details requires all three fields, and url must be https.
    if (!/^https:\/\//i.test(input.merchant.url)) {
      throw new AppError("PRAVA_ERROR", "Merchant url must be an https URL", {
        merchant: input.merchant.name,
        url: input.merchant.url,
      });
    }
    if (!/^[A-Z]{2}$/.test(input.merchant.country_code_iso2)) {
      throw new AppError("PRAVA_ERROR", "Merchant country must be a 2-letter ISO code", {
        merchant: input.merchant.name,
        country: input.merchant.country_code_iso2,
      });
    }

    const body = {
      user_id: input.userId,
      user_email: input.userEmail,
      total_amount: input.amount,
      currency: input.currency,
      integration_type: input.integration_type ?? "embedding",
      ...(input.externalOrderRef ? { external_order_ref: input.externalOrderRef } : {}),
      purchase_context: [
        {
          merchant_details: {
            name: input.merchant.name,
            url: input.merchant.url,
            country_code_iso2: input.merchant.country_code_iso2,
          },
          product_details: input.items.map((item) => ({
            description: item.description,
            unit_price: item.unit_price,
            quantity: item.quantity,
          })),
        },
      ],
    };

    const response = await this.request<WireCreateSessionResponse>("POST", "/v1/sessions", body);

    if (!response.session_id || !response.session_token || !response.iframe_url) {
      throw new AppError("PRAVA_ERROR", "Prava session response was missing required fields", {
        received: Object.keys(response),
      });
    }

    return {
      sessionId: response.session_id,
      sessionToken: response.session_token,
      iframeUrl: response.iframe_url,
      ...(response.order_id ? { orderId: response.order_id } : {}),
      ...(response.expires_at ? { expiresAt: response.expires_at } : {}),
    };
  }

  async getPaymentResult(sessionId: string): Promise<PaymentResult> {
    const response = await this.request<WirePaymentResultResponse>(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/payment-result`,
    );

    const status = response.status ?? "pending";
    const transaction = response.transactions?.[0];
    const lineItem = transaction?.line_items?.[0];

    if (transaction?.error?.code) {
      throw new AppError("PRAVA_ERROR", transaction.error.message ?? "Prava reported an error", {
        code: transaction.error.code,
      });
    }

    // Credentials are only populated on awaiting_result; anything else means
    // keep polling or the session is terminal.
    if (lineItem?.token && lineItem.dynamic_cvv && lineItem.txn_ref_id) {
      const pan = lineItem.token;
      return {
        status,
        credentials: {
          txnRefId: lineItem.txn_ref_id,
          cardNumber: pan,
          cvv: lineItem.dynamic_cvv,
          expMonth: Number(lineItem.expiry_month ?? "0"),
          expYear: Number(lineItem.expiry_year ?? "0"),
          last4: last4(pan),
          brand: brandFromPan(pan),
        },
        raw: redactResult(response),
      };
    }

    return { status, raw: redactResult(response) };
  }

  async reportStatus(sessionId: string, input: ReportStatusInput): Promise<ReportStatusResult> {
    const response = await this.request<WireReportStatusResponse>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/report-status`,
      {
        txn_ref_id: input.txnRefId,
        txn_status: input.txnStatus,
        ...(input.authorizationCode
          ? { authorization_code: input.authorizationCode.slice(0, 128) }
          : {}),
      },
    );

    return {
      txnStatus: response.txn_status ?? input.txnStatus,
      ...(response.visa_confirmation ? { visaConfirmation: response.visa_confirmation } : {}),
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/revoke`);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.secretKey}`,
          ...(body ? { "content-type": "application/json" } : {}),
          accept: "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new AppError("PRAVA_ERROR", "Could not reach Prava", {
        path,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const wire = parsed as {
        error?: { code?: string; message?: string; details?: unknown };
      } | null;
      throw new AppError(
        "PRAVA_ERROR",
        wire?.error?.message ?? `Prava returned ${response.status}`,
        {
          status: response.status,
          pravaCode: wire?.error?.code ?? null,
          // Prava stamps every response with this; support asks for it first.
          responseId: response.headers.get("x-response-id"),
          details: wire?.error?.details ?? null,
          path,
        },
      );
    }

    return (parsed ?? {}) as T;
  }
}

/** Strips credential fields before anything is stored or logged. */
function redactResult(response: WirePaymentResultResponse): unknown {
  return {
    ...response,
    transactions: response.transactions?.map((txn) => ({
      ...txn,
      line_items: txn.line_items?.map((item) => {
        const { token, dynamic_cvv, ...rest } = item;
        return { ...rest, token: token ? "[redacted]" : null, dynamic_cvv: undefined };
      }),
    })),
  };
}

