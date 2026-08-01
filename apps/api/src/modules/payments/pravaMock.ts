import { AppError } from "../../lib/errors.js";
import { env } from "../../env.js";
import type {
  CreateSessionInput,
  CreateSessionResult,
  PaymentResult,
  PravaClient,
  ReportStatusInput,
  ReportStatusResult,
} from "./pravaClient.js";

/**
 * In-process stand-in for the Prava rail. It follows the same state machine as
 * the real service — created, awaiting_result with credentials, completed after
 * report-status — so the code path under test is the production one.
 *
 * MOCK_PRAVA_FAIL injects a failure:
 *   mandate — session creation is rejected as out of policy
 *   card    — the collection step never yields credentials
 *   decline — credentials are issued for a PAN the checkout adapter declines
 */
export type MockFailureMode = "mandate" | "card" | "decline";

interface MockSession {
  id: string;
  orderId: string;
  amount: string;
  currency: string;
  merchantName: string;
  merchantUrl: string;
  merchantCountry: string;
  status: "pending" | "awaiting_result" | "completed" | "failed" | "revoked";
  txnRefId: string;
  reported: "APPROVED" | "DECLINED" | null;
  /** Calls to getPaymentResult before credentials appear, mirroring collection latency. */
  pollsBeforeCredentials: number;
  polls: number;
}

// A test PAN. It is not a real card number and no network sees it.
const MOCK_PAN = "4111111111111111";
// The checkout adapter declines this BIN, which is how the decline path is exercised.
const DECLINE_PAN = "4000000000000002";
const MOCK_CVV = "123";

export class MockPravaClient implements PravaClient {
  readonly mode = "mock" as const;
  private readonly sessions = new Map<string, MockSession>();
  private counter = 0;

  constructor(
    private readonly options: {
      failureMode?: MockFailureMode | undefined;
      pollsBeforeCredentials?: number;
    } = {},
  ) {}

  private get failureMode(): MockFailureMode | undefined {
    return this.options.failureMode ?? env.MOCK_PRAVA_FAIL;
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    if (this.failureMode === "mandate") {
      throw new AppError("PRAVA_ERROR", "Mandate is not valid for this merchant or amount", {
        pravaCode: "MANDATE_INVALID",
        merchant: input.merchant.name,
      });
    }

    // The real API validates merchant_details before anything else, so the mock
    // does too: a session that would 400 in sandbox must not pass here.
    if (!/^https:\/\//i.test(input.merchant.url ?? "")) {
      throw new AppError("PRAVA_ERROR", "merchant_details.url must be an https URL", {
        pravaCode: "VAL_2001",
      });
    }
    if (!/^[A-Z]{2}$/.test(input.merchant.country_code_iso2 ?? "")) {
      throw new AppError("PRAVA_ERROR", "merchant_details.country_code_iso2 must be ISO 3166-1", {
        pravaCode: "VAL_2001",
      });
    }

    this.counter += 1;
    const id = `sess_mock_${Date.now().toString(36)}_${this.counter}`;
    const session: MockSession = {
      id,
      orderId: `ord_mock_${this.counter}`,
      amount: input.amount,
      currency: input.currency,
      merchantName: input.merchant.name,
      merchantUrl: input.merchant.url,
      merchantCountry: input.merchant.country_code_iso2,
      status: "pending",
      txnRefId: `tli_mock_${this.counter}`,
      reported: null,
      pollsBeforeCredentials: this.options.pollsBeforeCredentials ?? 0,
      polls: 0,
    };
    this.sessions.set(id, session);

    return {
      sessionId: id,
      sessionToken: `tok_mock_${this.counter}`,
      iframeUrl: "https://pay.prava.space/mock",
      orderId: session.orderId,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
  }

  async getPaymentResult(sessionId: string): Promise<PaymentResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new AppError("PRAVA_ERROR", "Unknown session", { pravaCode: "NOT_FOUND", sessionId });
    }

    session.polls += 1;

    if (this.failureMode === "card") {
      // The user abandoned the iframe, so the session never leaves pending.
      return { status: "pending", raw: { session_id: sessionId, status: "pending" } };
    }

    if (session.status === "completed") {
      return { status: "completed", raw: { session_id: sessionId, status: "completed" } };
    }

    if (session.status === "revoked") {
      throw new AppError("PRAVA_ERROR", "Session was revoked", {
        pravaCode: "AUTH_1004",
        sessionId,
      });
    }

    if (session.polls <= session.pollsBeforeCredentials) {
      return { status: "pending", raw: { session_id: sessionId, status: "pending" } };
    }

    session.status = "awaiting_result";
    const pan = this.failureMode === "decline" ? DECLINE_PAN : MOCK_PAN;

    return {
      status: "awaiting_result",
      credentials: {
        txnRefId: session.txnRefId,
        cardNumber: pan,
        cvv: MOCK_CVV,
        expMonth: 12,
        expYear: new Date().getUTCFullYear() + 3,
        last4: pan.slice(-4),
        brand: "visa",
      },
      raw: { session_id: sessionId, status: "awaiting_result" },
    };
  }

  async reportStatus(sessionId: string, input: ReportStatusInput): Promise<ReportStatusResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new AppError("PRAVA_ERROR", "Unknown session", { pravaCode: "NOT_FOUND", sessionId });
    }
    if (input.txnRefId !== session.txnRefId) {
      throw new AppError("PRAVA_ERROR", "txn_ref_id does not belong to this session", {
        pravaCode: "INVALID_STATE",
      });
    }
    session.reported = input.txnStatus;
    session.status = input.txnStatus === "APPROVED" ? "completed" : "failed";
    return { txnStatus: input.txnStatus, visaConfirmation: "SUCCESS" };
  }

  async revokeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new AppError("PRAVA_ERROR", "Unknown session", { pravaCode: "NOT_FOUND", sessionId });
    }
    if (session.status === "completed") {
      throw new AppError("PRAVA_ERROR", "Session already completed", {
        pravaCode: "INVALID_STATE",
      });
    }
    session.status = "revoked";
  }

  /** Test helper: what the rail believes happened. */
  inspect(sessionId: string): Readonly<MockSession> | undefined {
    return this.sessions.get(sessionId);
  }
}
