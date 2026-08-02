export type ApiErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "EMAIL_NOT_VERIFIED"
  | "NOT_FOUND"
  | "VALIDATION_ERROR"
  | "CONFLICT"
  | "RATE_LIMITED"
  | string;

export interface ApiErrorBody {
  error?: {
    code?: ApiErrorCode;
    message?: string;
    details?: Record<string, unknown>;
  };
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  avatarUrl: string | null;
  createdAt: string;
}

export interface WorkspaceSettings {
  workspaceId: string;
  aiMonthlyBudget: string | null;
  approvalMode: "always_ask" | "ask_above_ceiling" | "auto_within_envelope";
  spendCeiling: string | null;
  killSwitch: boolean;
  categoryCeilings: Record<string, string>;
  teamSize: number;
  quietHours: { start: string; end: string; tz: string } | null;
  primaryChannel: "imessage" | "whatsapp" | "simulator";
  policyVersion: number;
  currency: string;
  updatedAt: string;
}

export interface MeResponse {
  user: PublicUser;
  workspace: {
    id: string;
    name: string;
    ownerUserId: string;
    createdAt: string;
    role: "owner";
  };
  settings: WorkspaceSettings;
}

export interface MailboxConnection {
  id: string;
  provider: "gmail" | "outlook";
  emailAddress: string;
  status: "pending" | "active" | "revoked" | "error";
  scopes: string[];
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface SubscriptionDto {
  id: string;
  merchantName: string;
  merchantCanonical: string;
  planName: string | null;
  amount: string;
  currency: string;
  billingCycle: "monthly" | "yearly" | "weekly" | "unknown";
  annualCost: string;
  nextRenewalAt: string | null;
  status: "active" | "pending_cancel" | "cancelled" | "paused";
  criticality: "must_keep" | "nice_to_have" | "experimental";
  seatsTotal: number;
  seatsActive: number | null;
  lastSignalAt: string | null;
  requiresConfirmation: boolean;
  lowConfidenceFields: string[];
  priceChangeNote: string | null;
}

export interface AgentSession {
  id: string;
  kind: "onboarding" | "detect" | "decide" | "monthly_sweep";
  status: "running" | "awaiting_input" | "completed" | "failed" | "cancelled";
  currentStep: string | null;
  lastSeq: number;
  state: Record<string, unknown>;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface AgentPromptOption {
  value: string;
  label: string;
  description?: string;
}

export interface AgentPrompt {
  promptKey: string;
  question: string;
  options: AgentPromptOption[];
  freeText: boolean;
  skippable: boolean;
  eventSeq: number;
}

export interface AgentEvent {
  seq: number;
  type: string;
  step: string | null;
  payload: Record<string, unknown>;
  at: string;
}

export interface NewsArticle {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  company: string;
}
