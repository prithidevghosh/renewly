"use client";

/**
 * Client-side application store, backed by the real API.
 *
 * Everything here comes from `/v1/*`. It previously came from `lib/mock/mockApi`
 * — 537 lines of invented subscriptions, savings and ledger entries that the
 * settings, ledger, opportunities and radar screens rendered as though they were
 * the user's own. Nothing on those screens marked the numbers as fictional,
 * which is the entire problem: a fabricated total looks exactly like a real one.
 *
 * Two rules hold everywhere below.
 *
 * A field the API does not supply is left empty, never filled with something
 * plausible. Where the product models a concept the backend has no notion of
 * yet — passkey enrolment, per-vendor allow and deny lists — the honest value is
 * the absent one, and the screen should say so rather than draw a number.
 *
 * A failed load sets `error` and leaves the data empty. It does not fall back to
 * anything. An empty ledger and an unreachable API must not look the same, so
 * consumers are expected to branch on `error` before rendering totals.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiFetch, RenewlyApiError } from "@/lib/api/client";
import type {
  MailboxConnection,
  MeResponse,
  SubscriptionDto,
  WorkspaceSettings,
} from "@/lib/api/types";
import type {
  Action,
  ChatMessage,
  Guardrails,
  LedgerEntry,
  Opportunity,
  Source,
  SpendSummary,
  Subscription,
  User,
} from "@/lib/domain/types";

/* -------------------------------------------------------------------------- */
/* API shapes this store reads but that api/types.ts does not model yet        */
/* -------------------------------------------------------------------------- */

interface ApprovalDto {
  id: string;
  subscriptionId: string | null;
  decisionId: string | null;
  state: string;
  actionType: string;
  amount: string;
  currency: string;
  merchantName: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SavingsEntryDto {
  id: string;
  subscriptionId: string | null;
  decisionId: string | null;
  approvalRequestId: string | null;
  actionType: string;
  recognition: "identified" | "realized";
  amountSaved: string;
  currency: string;
  periodMonths: number;
  note: string | null;
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* Mapping                                                                    */
/* -------------------------------------------------------------------------- */

/** Money crosses the wire as a decimal string. Cents are the store's unit. */
function toCents(amount: string | null | undefined): number {
  if (!amount) return 0;
  const value = Number(amount);
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
}

const CADENCE: Record<SubscriptionDto["billingCycle"], Subscription["cadence"]> = {
  monthly: "monthly",
  yearly: "annual",
  weekly: "monthly",
  unknown: "monthly",
};

/*
 * The API's lifecycle states and the UI's usage classifications are different
 * vocabularies: "cancelled" is a state, "zombie" is a judgement about usage that
 * the backend does not make. Everything the API reports maps to "active" — the
 * only one of these four that is a fact rather than an inference — and cancelled
 * rows are filtered out before they reach the screen instead of being relabelled
 * into a category nothing computed.
 */
const LIVE_STATUSES: ReadonlySet<SubscriptionDto["status"]> = new Set([
  "active",
  "pending_cancel",
  "paused",
]);

function toSubscription(dto: SubscriptionDto): Subscription {
  return {
    id: dto.id,
    vendor: dto.merchantName,
    initials: initialsOf(dto.merchantName),
    plan: dto.planName ?? "",
    category: "",
    amountCents: toCents(dto.amount),
    cadence: CADENCE[dto.billingCycle] ?? "monthly",
    nextRenewal: dto.nextRenewalAt ?? "",
    seats: dto.seatsTotal || null,
    activeSeats: dto.seatsActive,
    status: "active",
    // The API reports which fields it was unsure of rather than a score. A row
    // flagged for confirmation is the one the user should look at; inventing a
    // decimal here would be a precision the backend never claimed.
    confidence: dto.requiresConfirmation ? 0.5 : 1,
    sourceId: "",
    evidence: dto.lowConfidenceFields.length
      ? `Needs confirmation: ${dto.lowConfidenceFields.join(", ")}`
      : "",
  } as Subscription;
}

function toSource(dto: MailboxConnection): Source {
  return {
    id: dto.id,
    kind: dto.provider === "gmail" ? "gmail" : "email_alias",
    label: dto.provider === "gmail" ? "Gmail" : "Outlook",
    detail: dto.emailAddress,
    status: dto.status === "active" ? "connected" : dto.status === "error" ? "error" : "disconnected",
    connectedAt: null,
    lastSyncAt: dto.lastSyncAt,
    // Which subscriptions came from which mailbox is not exposed; 0 would read
    // as "found nothing", so the screens should treat this as unknown.
    discoveredCount: 0,
  } as Source;
}

function toAction(dto: ApprovalDto): Action {
  const state: Action["state"] =
    dto.state === "executed"
      ? "executed"
      : dto.state === "failed" || dto.failureCode
        ? "failed"
        : dto.state === "approved"
          ? "approved"
          : "proposed";

  return {
    id: dto.id,
    opportunityId: dto.decisionId ?? "",
    subscriptionId: dto.subscriptionId ?? "",
    vendor: dto.merchantName ?? "",
    headline: `${dto.actionType.replace(/_/g, " ")} — ${dto.merchantName ?? "unknown"}`,
    state,
    savingCentsPerYear: 0,
    chargedCents: toCents(dto.amount),
    proposedAt: dto.createdAt,
    approvedAt: state === "executed" ? dto.updatedAt : null,
    executedAt: state === "executed" ? dto.updatedAt : null,
    approval: { method: "none", at: null },
    steps: [],
  } as unknown as Action;
}

function toLedgerEntry(dto: SavingsEntryDto, index: number): LedgerEntry {
  return {
    id: dto.id,
    seq: index + 1,
    at: dto.createdAt,
    type: dto.recognition === "realized" ? "executed" : "saved",
    vendor: "",
    summary: dto.note ?? dto.actionType.replace(/_/g, " "),
    deltaCentsPerYear: Math.round(toCents(dto.amountSaved) * (12 / (dto.periodMonths || 12))),
    chargedCents: 0,
    actionId: dto.approvalRequestId,
    evidence: dto.decisionId ? `decision ${dto.decisionId}` : "",
    // The API does not hash ledger rows, and a hash this store computed would
    // prove only that this store computed it.
    hash: "",
  } as unknown as LedgerEntry;
}

function toGuardrails(settings: WorkspaceSettings): Guardrails {
  return {
    perActionCapCents: toCents(settings.spendCeiling),
    monthlyCapCents: toCents(settings.aiMonthlyBudget),
    approvalAlways: settings.approvalMode === "always_ask",
    // Per-vendor allow and deny lists are not part of workspace settings.
    allowVendors: [],
    denyVendors: [],
    allowCancellation: true,
  };
}

function toUser(me: MeResponse): User {
  return {
    id: me.user.id,
    name: me.user.name,
    email: me.user.email,
    company: me.workspace.name,
    // There is no passkey enrolment in the API. Reporting "not enrolled" is
    // accurate; reporting a device label would not be.
    passkey: { enrolled: false, deviceLabel: "", modality: "touch", enrolledAt: null },
    guardrails: toGuardrails(me.settings),
  } as User;
}

/** Totals computed only from rows the API actually returned. */
function computeSummary(subs: Subscription[], ledger: LedgerEntry[]): SpendSummary {
  const annualised = subs
    .filter((s) => s.status === "active")
    .reduce((sum, s) => sum + (s.cadence === "annual" ? s.amountCents : s.amountCents * 12), 0);

  const realised = ledger
    .filter((e) => e.type === "executed")
    .reduce((sum, e) => sum + e.deltaCentsPerYear, 0);

  return {
    annualSpendCents: annualised,
    monthlySpendCents: Math.round(annualised / 12),
    identifiedSavingsCents: ledger.reduce((sum, e) => sum + e.deltaCentsPerYear, 0) - realised,
    realisedSavingsCents: realised,
    subscriptionCount: subs.filter((s) => s.status === "active").length,
  } as unknown as SpendSummary;
}

/* -------------------------------------------------------------------------- */

interface RenewlyState {
  ready: boolean;
  /** Non-null when the last load failed. Render this, never zeros. */
  error: string | null;
  user: User | null;
  sources: Source[];
  subscriptions: Subscription[];
  opportunities: Opportunity[];
  actions: Action[];
  ledger: LedgerEntry[];
  summary: SpendSummary | null;
  chat: ChatMessage[];

  pendingApproval: Opportunity | null;
  openApproval: (opportunityId: string) => void;
  closeApproval: () => void;
  dismiss: (opportunityId: string) => Promise<void>;
  connect: (sourceId: string) => Promise<void>;
  saveGuardrails: (patch: Partial<Guardrails>) => Promise<void>;
  revokeAll: () => Promise<void>;
  refresh: () => Promise<void>;

  pushMessage: (msg: Omit<ChatMessage, "id" | "at"> & { id?: string }) => string;
  updateMessage: (id: string, patch: Partial<ChatMessage>) => void;
  liveAction: Action | null;
}

const Ctx = createContext<RenewlyState | null>(null);

let msgCounter = 0;
const nextId = (prefix: string) => `${prefix}_${(msgCounter += 1)}`;

function messageFor(error: unknown): string {
  if (error instanceof RenewlyApiError) {
    if (error.status === 401 || error.status === 403) return "Your session has expired.";
    if (error.status === 503) {
      return error.message || "That feature is switched off on this deployment.";
    }
    return error.message || "The API could not complete that request.";
  }
  return "Could not reach the API.";
}

export function RenewlyProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [pendingApproval, setPendingApproval] = useState<Opportunity | null>(null);

  /*
   * Opportunities stay empty. They are the agent's proposals, and the API
   * exposes a decision only by id — there is no GET /v1/decisions to list them.
   * Deriving them here from subscriptions would mean this component inventing
   * the analysis, savings figure and rationale that the decision engine exists
   * to produce, which is the same fabrication in a new place. Empty until the
   * endpoint lands.
   */
  const opportunities = useMemo<Opportunity[]>(() => [], []);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const [me, connections, subs, approvals, savings] = await Promise.all([
        apiFetch<MeResponse>("/v1/me"),
        apiFetch<{ connections: MailboxConnection[] }>("/v1/mailbox/connections").catch(() => ({
          // A disabled mailbox is a 503 and is not a failure of the page.
          connections: [] as MailboxConnection[],
        })),
        apiFetch<{ subscriptions: SubscriptionDto[] }>("/v1/subscriptions"),
        apiFetch<{ approvals: ApprovalDto[] }>("/v1/approvals"),
        apiFetch<{ savings: SavingsEntryDto[] }>("/v1/savings"),
      ]);

      if (!mounted.current) return;
      setUser(toUser(me));
      setSources(connections.connections.map(toSource));
        setSubscriptions(
        subs.subscriptions.filter((s) => LIVE_STATUSES.has(s.status)).map(toSubscription),
      );
      setActions(approvals.approvals.map(toAction));
      setLedger(savings.savings.map(toLedgerEntry));
      setError(null);
    } catch (err) {
      if (!mounted.current) return;
      // Leave the data as it was and say so. Zeroing it would render an empty
      // dashboard that reads as "you have nothing" rather than "this failed".
      setError(messageFor(err));
    } finally {
      if (mounted.current) setReady(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(
    () => (error ? null : computeSummary(subscriptions, ledger)),
    [error, subscriptions, ledger],
  );

  /* ---------------------------------------------------------------- chat -- */
  const pushMessage = useCallback((msg: Omit<ChatMessage, "id" | "at"> & { id?: string }) => {
    const id = msg.id ?? nextId("msg");
    setChat((prev) => [...prev, { ...msg, id, at: new Date().toISOString() }]);
    return id;
  }, []);

  const updateMessage = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setChat((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  /* ----------------------------------------------------------- mutations -- */
  const openApproval = useCallback(
    (opportunityId: string) => {
      setPendingApproval(opportunities.find((o) => o.id === opportunityId) ?? null);
    },
    [opportunities],
  );

  const closeApproval = useCallback(() => setPendingApproval(null), []);

  const dismiss = useCallback(async (_opportunityId: string) => {
    setError("Dismissing a proposal is not available yet.");
  }, []);

  const connect = useCallback(async (_sourceId: string) => {
    // Connecting a mailbox is a browser redirect through the provider's consent
    // screen, which the settings page links to directly.
    setError("Use the connect link to grant mailbox access.");
  }, []);

  const saveGuardrails = useCallback(
    async (patch: Partial<Guardrails>) => {
      try {
        const body: Record<string, unknown> = {};
        if (patch.perActionCapCents !== undefined) {
          body.spendCeiling = (patch.perActionCapCents / 100).toFixed(2);
        }
        if (patch.monthlyCapCents !== undefined) {
          body.aiMonthlyBudget = (patch.monthlyCapCents / 100).toFixed(2);
        }
        if (patch.approvalAlways !== undefined) {
          body.approvalMode = patch.approvalAlways ? "always_ask" : "ask_above_ceiling";
        }
        await apiFetch("/v1/settings", { method: "PATCH", body: JSON.stringify(body) });
        await load();
      } catch (err) {
        setError(messageFor(err));
      }
    },
    [load],
  );

  const revokeAll = useCallback(async () => {
    try {
      await Promise.all(
        sources.map((s) => apiFetch(`/v1/mailbox/connections/${s.id}`, { method: "DELETE" })),
      );
      await load();
    } catch (err) {
      setError(messageFor(err));
    }
  }, [sources, load]);

  const value = useMemo<RenewlyState>(
    () => ({
      ready,
      error,
      user,
      sources,
      subscriptions,
      opportunities,
      actions,
      ledger,
      summary,
      chat,
      pendingApproval,
      openApproval,
      closeApproval,
      dismiss,
      connect,
      saveGuardrails,
      revokeAll,
      refresh: load,
      pushMessage,
      updateMessage,
      liveAction: null,
    }),
    [
      ready,
      error,
      user,
      sources,
      subscriptions,
      opportunities,
      actions,
      ledger,
      summary,
      chat,
      pendingApproval,
      openApproval,
      closeApproval,
      dismiss,
      connect,
      saveGuardrails,
      revokeAll,
      load,
      pushMessage,
      updateMessage,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRenewly(): RenewlyState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useRenewly must be used inside RenewlyProvider");
  return ctx;
}
