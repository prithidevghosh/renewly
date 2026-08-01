import {
  boolean,
  char,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/* -------------------------------------------------------------------------- */
/* Enums                                                                      */
/* -------------------------------------------------------------------------- */

export const approvalModeEnum = pgEnum("approval_mode", [
  "always_ask",
  "ask_above_ceiling",
  "auto_within_envelope",
]);

export const billingCycleEnum = pgEnum("billing_cycle", [
  "monthly",
  "yearly",
  "weekly",
  "unknown",
]);

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "active",
  "pending_cancel",
  "cancelled",
  "paused",
]);

export const criticalityEnum = pgEnum("criticality", [
  "must_keep",
  "nice_to_have",
  "experimental",
]);

export const sourceTypeEnum = pgEnum("source_type", ["manual", "email", "file", "csv"]);

export const workspaceRoleEnum = pgEnum("workspace_role", ["owner", "viewer"]);

export const candidateStatusEnum = pgEnum("candidate_status", [
  "pending",
  "accepted",
  "rejected",
]);

/**
 * The actions the agent can take. `rightsize_seats` and `switch_term` are the
 * two that actually move the needle for a small team; `snooze` exists so the
 * engine can decline to act without pretending it has nothing to say.
 */
export const recommendationEnum = pgEnum("recommendation", [
  "renew",
  "rightsize_seats",
  "switch_term",
  "switch_vendor",
  "cancel",
  "snooze",
]);

export const paymentSessionStatusEnum = pgEnum("payment_session_status", [
  "created",
  "awaiting_collection",
  "awaiting_result",
  "completed",
  "failed",
  "revoked",
]);

export const transactionStatusEnum = pgEnum("transaction_status", [
  "approved",
  "declined",
  "error",
]);

export const savingsActionTypeEnum = pgEnum("savings_action_type", [
  "cancel",
  "rightsize",
  "term_switch",
  "switch_vendor",
  "renew",
  "other",
]);

/**
 * `identified` is what the agent believes is available; `realized` is what has
 * actually been banked. Conflating the two is how savings dashboards start
 * lying, so they are separate rows and separate totals.
 */
export const savingsRecognitionEnum = pgEnum("savings_recognition", [
  "identified",
  "realized",
]);

export const channelEnum = pgEnum("channel", ["imessage", "whatsapp", "simulator"]);

export const channelStatusEnum = pgEnum("channel_status", ["pending", "active", "revoked"]);

export const threadStatusEnum = pgEnum("thread_status", ["active", "closed"]);

export const messageDirectionEnum = pgEnum("message_direction", [
  "inbound",
  "outbound",
  "system",
]);

export const messageRoleEnum = pgEnum("message_role", ["agent", "user", "system"]);

/** See modules/conversations/stateMachine.ts for the legal transitions. */
export const approvalStateEnum = pgEnum("approval_state", [
  "drafted",
  "notified",
  "awaiting_intent",
  "awaiting_payment_auth",
  "executing",
  "proved",
  "failed",
  "expired",
  "cancelled_by_user",
]);

export const outboxStatusEnum = pgEnum("outbox_status", ["pending", "sent", "failed"]);

export const jobStatusEnum = pgEnum("job_status", [
  "pending",
  "running",
  "done",
  "failed",
]);

export const jobTypeEnum = pgEnum("job_type", [
  "parse_inbound_email",
  "send_outbound",
  "poll_prava",
  "expire_approvals",
  "notify_decision",
]);

export const parseStatusEnum = pgEnum("parse_status", [
  "pending",
  "parsed",
  "failed",
  "duplicate",
]);

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_unique").on(t.email)],
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workspaces_owner_idx").on(t.ownerUserId)],
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: workspaceRoleEnum("role").notNull().default("owner"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workspace_members_unique").on(t.workspaceId, t.userId),
    index("workspace_members_user_idx").on(t.userId),
  ],
);

export const workspaceSettings = pgTable("workspace_settings", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  aiMonthlyBudget: numeric("ai_monthly_budget", { precision: 14, scale: 2 }),
  approvalMode: approvalModeEnum("approval_mode").notNull().default("always_ask"),
  /** Per-action ceiling. Null means no ceiling, which auto_within_envelope forbids. */
  spendCeiling: numeric("spend_ceiling", { precision: 14, scale: 2 }).default("50.00"),
  killSwitch: boolean("kill_switch").notNull().default(false),
  categoryCeilings: jsonb("category_ceilings")
    .$type<Record<string, string>>()
    .notNull()
    .default({}),
  /** { start: "22:00", end: "08:00", tz: "UTC" }. Outbound is deferred, never dropped. */
  quietHoursJson: jsonb("quiet_hours_json").$type<QuietHours | null>(),
  primaryChannel: channelEnum("primary_channel").notNull().default("simulator"),
  /** Bumped on every policy change so decisions can pin what they were judged against. */
  policyVersion: integer("policy_version").notNull().default(1),
  currency: char("currency", { length: 3 }).notNull().default("USD"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export interface QuietHours {
  start: string;
  end: string;
  tz: string;
}

/* -------------------------------------------------------------------------- */
/* Inventory                                                                  */
/* -------------------------------------------------------------------------- */

export type FieldConfidence = Record<string, number>;

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    merchantName: text("merchant_name").notNull(),
    merchantCanonical: text("merchant_canonical").notNull(),
    planName: text("plan_name"),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    billingCycle: billingCycleEnum("billing_cycle").notNull().default("monthly"),
    nextRenewalAt: timestamp("next_renewal_at", { withTimezone: true }),
    cancelByAt: timestamp("cancel_by_at", { withTimezone: true }),
    status: subscriptionStatusEnum("status").notNull().default("active"),
    criticality: criticalityEnum("criticality").notNull().default("nice_to_have"),
    jobCategory: text("job_category"),
    usageNote: text("usage_note"),
    seatsTotal: integer("seats_total").notNull().default(1),
    /** Seats the team actually touches. Null means unknown, not zero. */
    seatsActive: integer("seats_active"),
    merchantId: text("merchant_id"),
    /** Stable hash of the identifying fields, used to dedupe repeat intake. */
    contentHash: text("content_hash"),
    /** Last time any source confirmed this subscription still exists. */
    lastSignalAt: timestamp("last_signal_at", { withTimezone: true }),
    sourceType: sourceTypeEnum("source_type").notNull().default("manual"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    fieldConfidence: jsonb("field_confidence").$type<FieldConfidence>().notNull().default({}),
    priceChangeNote: text("price_change_note"),
    rawExcerpt: text("raw_excerpt"),
    notes: text("notes"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("subscriptions_workspace_idx").on(t.workspaceId),
    index("subscriptions_renewal_idx").on(t.workspaceId, t.nextRenewalAt),
  ],
);

export const renewalEvents = pgTable(
  "renewal_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subscriptionId: text("subscription_id").references(() => subscriptions.id, {
      onDelete: "set null",
    }),
    rawText: text("raw_text").notNull(),
    rawExcerpt: text("raw_excerpt").notNull(),
    parsedJson: jsonb("parsed_json").$type<Record<string, unknown>>().notNull().default({}),
    parseConfidence: numeric("parse_confidence", { precision: 4, scale: 3 })
      .notNull()
      .default("0.000"),
    sourceType: sourceTypeEnum("source_type").notNull().default("email"),
    parserUsed: text("parser_used").notNull().default("heuristic"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("renewal_events_workspace_idx").on(t.workspaceId),
    index("renewal_events_subscription_idx").on(t.subscriptionId),
  ],
);

export const csvImports = pgTable(
  "csv_imports",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    rowCount: integer("row_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("csv_imports_workspace_idx").on(t.workspaceId)],
);

export const csvCandidates = pgTable(
  "csv_candidates",
  {
    id: text("id").primaryKey(),
    importId: text("import_id")
      .notNull()
      .references(() => csvImports.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    merchantGuess: text("merchant_guess").notNull(),
    merchantCanonical: text("merchant_canonical").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    date: timestamp("date", { withTimezone: true }),
    billingCycle: billingCycleEnum("billing_cycle").notNull().default("monthly"),
    occurrences: integer("occurrences").notNull().default(1),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull().default("0.000"),
    rawRow: jsonb("raw_row").$type<Record<string, unknown>>().notNull().default({}),
    status: candidateStatusEnum("status").notNull().default("pending"),
    linkedSubscriptionId: text("linked_subscription_id").references(() => subscriptions.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("csv_candidates_workspace_idx").on(t.workspaceId),
    index("csv_candidates_import_idx").on(t.importId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Decisions                                                                  */
/* -------------------------------------------------------------------------- */

export const decisionPackages = pgTable(
  "decision_packages",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    recommendation: recommendationEnum("recommendation").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    modelId: text("model_id"),
    policyVersion: integer("policy_version").notNull().default(1),
    /** Amount the package was built around; a change invalidates the decision. */
    pricedAmount: numeric("priced_amount", { precision: 14, scale: 2 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("decision_packages_workspace_idx").on(t.workspaceId),
    index("decision_packages_subscription_idx").on(t.subscriptionId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Payments                                                                   */
/* -------------------------------------------------------------------------- */

export const paymentSessions = pgTable(
  "payment_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    decisionId: text("decision_id")
      .notNull()
      .references(() => decisionPackages.id, { onDelete: "cascade" }),
    pravaSessionId: text("prava_session_id").notNull(),
    pravaOrderId: text("prava_order_id"),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    merchantName: text("merchant_name").notNull(),
    status: paymentSessionStatusEnum("status").notNull().default("created"),
    mode: text("mode").notNull().default("mock"),
    iframeUrl: text("iframe_url"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payment_sessions_prava_session_unique").on(t.pravaSessionId),
    index("payment_sessions_workspace_idx").on(t.workspaceId),
    index("payment_sessions_decision_idx").on(t.decisionId),
  ],
);

export const transactions = pgTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    paymentSessionId: text("payment_session_id")
      .notNull()
      .references(() => paymentSessions.id, { onDelete: "cascade" }),
    status: transactionStatusEnum("status").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    merchantName: text("merchant_name").notNull(),
    pravaTxnRefId: text("prava_txn_ref_id"),
    // Only ever the last four digits. The PAN and CVV are held in memory for the
    // duration of the checkout call and never written anywhere.
    cardLast4: text("card_last4"),
    cardBrand: text("card_brand"),
    cardExpMonth: integer("card_exp_month"),
    cardExpYear: integer("card_exp_year"),
    checkoutReference: text("checkout_reference"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("transactions_workspace_idx").on(t.workspaceId),
    index("transactions_session_idx").on(t.paymentSessionId),
  ],
);

export const receipts = pgTable(
  "receipts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("receipts_workspace_idx").on(t.workspaceId),
    uniqueIndex("receipts_transaction_unique").on(t.transactionId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Ledger + audit                                                             */
/* -------------------------------------------------------------------------- */

export const savingsEntries = pgTable(
  "savings_entries",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subscriptionId: text("subscription_id").references(() => subscriptions.id, {
      onDelete: "set null",
    }),
    decisionId: text("decision_id").references(() => decisionPackages.id, {
      onDelete: "set null",
    }),
    actionType: savingsActionTypeEnum("action_type").notNull(),
    recognition: savingsRecognitionEnum("recognition").notNull().default("realized"),
    approvalRequestId: text("approval_request_id"),
    amountSaved: numeric("amount_saved", { precision: 14, scale: 2 }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    periodMonths: integer("period_months").notNull().default(12),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("savings_entries_workspace_idx").on(t.workspaceId),
    index("savings_entries_recognition_idx").on(t.workspaceId, t.recognition),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_events_workspace_created_idx").on(t.workspaceId, t.createdAt.desc()),
    index("audit_events_type_idx").on(t.workspaceId, t.type),
  ],
);

/* -------------------------------------------------------------------------- */
/* Merchant graph                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One row per real-world vendor. Statements, receipts and typing all produce
 * different strings for the same company; this is where they converge.
 */
export const merchants = pgTable(
  "merchants",
  {
    id: text("id").primaryKey(),
    /** Null for the seeded global catalog; set for workspace-local overrides. */
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    canonicalName: text("canonical_name").notNull(),
    /** Canonicalised alternate spellings seen in the wild. */
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    website: text("website"),
    cancelUrl: text("cancel_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("merchants_workspace_idx").on(t.workspaceId),
    index("merchants_canonical_idx").on(t.canonicalName),
  ],
);

/* -------------------------------------------------------------------------- */
/* Channels and conversations                                                 */
/* -------------------------------------------------------------------------- */

export const channelConnections = pgTable(
  "channel_connections",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channel: channelEnum("channel").notNull(),
    /** Phone number or platform handle. */
    externalId: text("external_id").notNull(),
    status: channelStatusEnum("status").notNull().default("pending"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("channel_connections_unique").on(t.workspaceId, t.channel, t.externalId),
    index("channel_connections_lookup_idx").on(t.channel, t.externalId),
  ],
);

export const conversationThreads = pgTable(
  "conversation_threads",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channel: channelEnum("channel").notNull(),
    channelThreadId: text("channel_thread_id").notNull(),
    participantExternalId: text("participant_external_id").notNull(),
    status: threadStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("conversation_threads_external_unique").on(t.channel, t.channelThreadId),
    index("conversation_threads_workspace_idx").on(t.workspaceId),
  ],
);

export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => conversationThreads.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    direction: messageDirectionEnum("direction").notNull(),
    role: messageRoleEnum("role").notNull(),
    body: text("body").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    externalMessageId: text("external_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("conversation_messages_thread_idx").on(t.threadId, t.createdAt),
    index("conversation_messages_workspace_idx").on(t.workspaceId),
    index("conversation_messages_external_idx").on(t.externalMessageId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Approvals — the spine binding decision, message and payment                */
/* -------------------------------------------------------------------------- */

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    subscriptionId: text("subscription_id")
      .notNull()
      .references(() => subscriptions.id, { onDelete: "cascade" }),
    decisionId: text("decision_id")
      .notNull()
      .references(() => decisionPackages.id, { onDelete: "cascade" }),
    threadId: text("thread_id").references(() => conversationThreads.id, {
      onDelete: "set null",
    }),
    outboundMessageId: text("outbound_message_id"),
    state: approvalStateEnum("state").notNull().default("drafted"),
    channel: channelEnum("channel").notNull(),
    pravaPaymentSessionId: text("prava_payment_session_id"),
    pravaHostedUrl: text("prava_hosted_url"),
    /** Single-use token in the pay link; hashed, never stored in the clear. */
    payTokenHash: text("pay_token_hash"),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    merchantName: text("merchant_name").notNull(),
    actionType: recommendationEnum("action_type").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Scopes every side effect of this approval, so a replayed webhook is inert. */
    idempotencyKey: text("idempotency_key").notNull(),
    failureCode: text("failure_code"),
    resultPayload: jsonb("result_payload").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("approval_requests_idempotency_unique").on(t.idempotencyKey),
    index("approval_requests_state_expiry_idx").on(t.state, t.expiresAt),
    index("approval_requests_workspace_idx").on(t.workspaceId),
    index("approval_requests_thread_idx").on(t.threadId),
  ],
);

/* -------------------------------------------------------------------------- */
/* Infrastructure: idempotency, outbox, jobs, inbound mail                    */
/* -------------------------------------------------------------------------- */

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    responseHash: text("response_hash"),
    responseBody: jsonb("response_body").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("idempotency_scope_key_unique").on(t.scope, t.key)],
);

export const outboxMessages = pgTable(
  "outbox_messages",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id").references(() => conversationThreads.id, {
      onDelete: "set null",
    }),
    approvalRequestId: text("approval_request_id"),
    channel: channelEnum("channel").notNull(),
    destination: text("destination").notNull(),
    body: text("body").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: outboxStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    /** Dedupes a send that is retried after an ambiguous failure. */
    dedupeKey: text("dedupe_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("outbox_status_idx").on(t.status, t.nextAttemptAt),
    index("outbox_workspace_idx").on(t.workspaceId),
    uniqueIndex("outbox_dedupe_unique").on(t.dedupeKey),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    type: jobTypeEnum("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatusEnum("status").notNull().default("pending"),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lastError: text("last_error"),
    /** Collapses duplicate enqueues of the same logical work. */
    dedupeKey: text("dedupe_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("jobs_status_runat_idx").on(t.status, t.runAt),
    uniqueIndex("jobs_dedupe_unique").on(t.dedupeKey),
  ],
);

export const inboundEmails = pgTable(
  "inbound_emails",
  {
    id: text("id").primaryKey(),
    /** Null until plus-address or token routing resolves an owner. */
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    messageId: text("message_id"),
    fromAddr: text("from_addr").notNull(),
    toAddr: text("to_addr").notNull(),
    subject: text("subject"),
    rawText: text("raw_text").notNull(),
    /** Hash of the normalised body, so a forwarded duplicate is recognised. */
    contentHash: text("content_hash").notNull(),
    parseStatus: parseStatusEnum("parse_status").notNull().default("pending"),
    parseError: text("parse_error"),
    renewalEventId: text("renewal_event_id"),
    provider: text("provider").notNull().default("generic"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("inbound_emails_workspace_idx").on(t.workspaceId),
    uniqueIndex("inbound_emails_message_unique").on(t.messageId),
    index("inbound_emails_hash_idx").on(t.workspaceId, t.contentHash),
  ],
);

/* -------------------------------------------------------------------------- */
/* Inferred row types                                                         */
/* -------------------------------------------------------------------------- */

export type User = typeof users.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceSettings = typeof workspaceSettings.$inferSelect;
export type Subscription = typeof subscriptions.$inferSelect;
export type RenewalEvent = typeof renewalEvents.$inferSelect;
export type CsvImport = typeof csvImports.$inferSelect;
export type CsvCandidate = typeof csvCandidates.$inferSelect;
export type DecisionPackageRow = typeof decisionPackages.$inferSelect;
export type PaymentSession = typeof paymentSessions.$inferSelect;
export type Transaction = typeof transactions.$inferSelect;
export type Receipt = typeof receipts.$inferSelect;
export type SavingsEntry = typeof savingsEntries.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type Merchant = typeof merchants.$inferSelect;
export type ChannelConnection = typeof channelConnections.$inferSelect;
export type ConversationThread = typeof conversationThreads.$inferSelect;
export type ConversationMessage = typeof conversationMessages.$inferSelect;
export type ApprovalRequest = typeof approvalRequests.$inferSelect;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
export type OutboxMessage = typeof outboxMessages.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type InboundEmail = typeof inboundEmails.$inferSelect;

export type ChannelName = (typeof channelEnum.enumValues)[number];
export type ApprovalState = (typeof approvalStateEnum.enumValues)[number];
export type ActionType = (typeof recommendationEnum.enumValues)[number];
export type JobType = (typeof jobTypeEnum.enumValues)[number];
