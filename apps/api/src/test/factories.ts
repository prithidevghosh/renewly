import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ApiClient } from "./helpers.js";
import { readMailbox } from "./doubles/mailer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, "..", "..", "fixtures");

export function fixture(relativePath: string): string {
  return readFileSync(path.join(FIXTURES, relativePath), "utf8");
}

export function jsonFixture<T = Record<string, unknown>>(relativePath: string): T {
  return JSON.parse(fixture(relativePath)) as T;
}

let counter = 0;

export interface SignedUpUser {
  token: string;
  userId: string;
  workspaceId: string;
  email: string;
  password: string;
}

/**
 * Signs up and completes email verification, because an unverified account
 * cannot reach anything and every journey below this needs a usable session.
 *
 * The code is taken from the signup response, which returns it only in mock
 * mail mode. That means the suite drives the real verification path rather than
 * a back door — if verification breaks, these fail.
 */
/**
 * Pulls the six-digit code out of the most recent verification mail for an
 * address. Fails loudly rather than returning undefined: "no code" almost
 * always means the transport was not installed, and a test that carried on
 * would fail somewhere much further from the cause.
 */
export function verificationCodeFor(email: string): string {
  const message = readMailbox()
    .slice()
    .reverse()
    .find((sent) => sent.to === email && /\b\d{6}\b/.test(sent.text));
  if (!message) {
    throw new Error(
      `no verification mail captured for ${email}. The harness installs a capture ` +
        "transport; check setMailTransport was not reset.",
    );
  }
  const code = message.text.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error(`verification mail for ${email} carried no six-digit code`);
  return code;
}

export async function signUp(
  client: ApiClient,
  overrides: Partial<{ email: string; password: string; name: string }> = {},
): Promise<SignedUpUser> {
  counter += 1;
  const email = overrides.email ?? `founder${counter}-${Date.now()}@example.com`;
  const password = overrides.password ?? "Sup3rSecret!";
  const name = overrides.name ?? "Test Founder";

  const response = await client.post<{
    token: string;
    workspaceId: string;
    user: { id: string };
  }>("/v1/auth/signup", { email, password, name });

  if (response.status !== 201) {
    throw new Error(`signup failed: ${response.status} ${JSON.stringify(response.body)}`);
  }

  client.setToken(response.body.token);

  // The code is never in the response any more — it goes to the inbox, and the
  // harness's capture transport is that inbox. Reading it here is the same
  // thing a person does: open the mail and copy the digits.
  const code = verificationCodeFor(email);

  const verified = await client.post("/v1/auth/verify", { email, code });
  if (verified.status !== 200) {
    throw new Error(`verify failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  }

  return {
    token: response.body.token,
    userId: response.body.user.id,
    workspaceId: response.body.workspaceId,
    email,
    password,
  };
}

/** Signs up without verifying, for tests that exercise the gate itself. */
export async function signUpUnverified(
  client: ApiClient,
  overrides: Partial<{ email: string; password: string; name: string }> = {},
): Promise<SignedUpUser & { verificationCode: string }> {
  counter += 1;
  const email = overrides.email ?? `unverified${counter}-${Date.now()}@example.com`;
  const password = overrides.password ?? "Sup3rSecret!";
  const name = overrides.name ?? "Test Founder";

  const response = await client.post<{
    token: string;
    workspaceId: string;
    user: { id: string };
  }>("/v1/auth/signup", { email, password, name });

  if (response.status !== 201) {
    throw new Error(`signup failed: ${response.status} ${JSON.stringify(response.body)}`);
  }

  client.setToken(response.body.token);
  return {
    token: response.body.token,
    userId: response.body.user.id,
    workspaceId: response.body.workspaceId,
    email,
    password,
    verificationCode: verificationCodeFor(email),
  };
}

/** Signs up and connects the simulator channel, which most journeys need. */
export async function signUpWithChannel(
  client: ApiClient,
  overrides: Partial<{ email: string; handle: string }> = {},
): Promise<SignedUpUser & { handle: string }> {
  const user = await signUp(client, overrides.email ? { email: overrides.email } : {});
  counter += 1;
  const handle = overrides.handle ?? `+1555010${String(counter).padStart(4, "0")}`;

  const response = await client.post("/v1/channels/connect", {
    channel: "simulator",
    externalId: handle,
  });
  if (response.status !== 201) {
    throw new Error(`connect failed: ${response.status} ${JSON.stringify(response.body)}`);
  }

  return { ...user, handle };
}

export interface SubscriptionShape {
  id: string;
  amount: string;
  currency: string;
  merchantName: string;
  seatsTotal: number;
  seatsActive: number | null;
  requiresConfirmation: boolean;
  confirmedAt: string | null;
  status: string;
  [key: string]: unknown;
}

export async function createSubscription(
  client: ApiClient,
  overrides: Record<string, unknown> = {},
): Promise<SubscriptionShape> {
  const response = await client.post<{ subscription: SubscriptionShape }>("/v1/subscriptions", {
    merchantName: "Anthropic",
    planName: "Claude Pro",
    amount: "20.00",
    currency: "USD",
    billingCycle: "monthly",
    criticality: "must_keep",
    jobCategory: "ai",
    usageNote: "Used daily for drafting.",
    nextRenewalAt: new Date(Date.now() + 12 * 86_400_000).toISOString(),
    ...overrides,
  });

  if (response.status !== 201) {
    throw new Error(
      `createSubscription failed: ${response.status} ${JSON.stringify(response.body)}`,
    );
  }
  return response.body.subscription;
}

export interface DecisionShape {
  id: string;
  recommendation: "renew" | "rightsize_seats" | "switch_term" | "switch_vendor" | "cancel" | "snooze";
  confidence: number;
  policyVersion: number;
  supersededAt: string | null;
  package: {
    amount_due: string;
    currency: string;
    diagnosis: string;
    seats_target: number | null;
    term_target: string | null;
    vendor_target: string | null;
    policy_version: number;
    counterfactuals: {
      do_nothing: { annual_cost: string; summary: string };
      recommended: { annual_cost: string; savings_vs_do_nothing: string; summary: string };
    };
    inputs_used: string[];
    policy_flags: string[];
    alternatives: Array<{ name: string; annual_cost: string }>;
    narrative_source: string;
    headline: string;
    narrative: string;
  };
  [key: string]: unknown;
}

export interface ApprovalShape {
  id: string;
  state: string;
  channel: string;
  actionType: string;
  amount: string;
  currency: string;
  merchantName: string;
  threadId: string | null;
  pravaPaymentSessionId: string | null;
  expiresAt: string;
  [key: string]: unknown;
}

export async function createDecision(
  client: ApiClient,
  subscriptionId: string,
  body: Record<string, unknown> = {},
): Promise<DecisionShape> {
  const response = await client.post<{ decision: DecisionShape }>(
    `/v1/subscriptions/${subscriptionId}/decisions`,
    body,
  );
  if (response.status !== 201) {
    throw new Error(`createDecision failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.decision;
}

/** Generates a decision and sends the proposal to the connected channel. */
export async function createDecisionAndNotify(
  client: ApiClient,
  subscriptionId: string,
): Promise<{ decision: DecisionShape; approval: ApprovalShape }> {
  const response = await client.post<{ decision: DecisionShape; approval: ApprovalShape }>(
    `/v1/subscriptions/${subscriptionId}/decisions`,
    { regenerate: true, notify: true },
  );
  if (response.status !== 201 || !response.body.approval) {
    throw new Error(`notify failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return { decision: response.body.decision, approval: response.body.approval };
}

export interface SimMessage {
  id: string;
  threadId: string;
  direction: "inbound" | "outbound" | "system";
  role: string;
  body: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export async function simulatorMessages(client: ApiClient): Promise<SimMessage[]> {
  const response = await client.get<{ messages: SimMessage[] }>("/v1/channels/simulator/messages");
  return response.body.messages ?? [];
}

export async function lastOutbound(client: ApiClient): Promise<SimMessage | null> {
  const messages = await simulatorMessages(client);
  const outbound = messages.filter((m) => m.direction === "outbound");
  return outbound[outbound.length - 1] ?? null;
}

/** Posts an inbound message through the simulator webhook, as a channel would. */
export async function sendInbound(
  client: ApiClient,
  handle: string,
  text: string,
  options: { tapback?: string; messageId?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  counter += 1;
  const response = await client.webhook<Record<string, unknown>>("/v1/webhooks/simulator", {
    from: handle,
    text,
    ...(options.tapback ? { tapback: options.tapback } : {}),
    messageId: options.messageId ?? `sim_in_${Date.now()}_${counter}`,
    threadId: `sim_thread_${handle}`,
  });
  return { status: response.status, body: response.body };
}

export interface AuditEventShape {
  id: string;
  type: string;
  entityType: string | null;
  entityId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export async function auditTypes(client: ApiClient): Promise<string[]> {
  const response = await client.get<{ events: AuditEventShape[] }>("/v1/audit?limit=200");
  return response.body.events.map((event) => event.type);
}

export async function auditEvents(client: ApiClient): Promise<AuditEventShape[]> {
  const response = await client.get<{ events: AuditEventShape[] }>("/v1/audit?limit=200");
  return response.body.events;
}
