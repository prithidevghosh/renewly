CREATE TYPE "public"."approval_mode" AS ENUM('always_ask', 'ask_above_ceiling', 'auto_within_envelope');--> statement-breakpoint
CREATE TYPE "public"."approval_state" AS ENUM('drafted', 'notified', 'awaiting_intent', 'awaiting_payment_auth', 'executing', 'proved', 'failed', 'expired', 'cancelled_by_user');--> statement-breakpoint
CREATE TYPE "public"."billing_cycle" AS ENUM('monthly', 'yearly', 'weekly', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."candidate_status" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('imessage', 'whatsapp', 'simulator');--> statement-breakpoint
CREATE TYPE "public"."channel_status" AS ENUM('pending', 'active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."criticality" AS ENUM('must_keep', 'nice_to_have', 'experimental');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('parse_inbound_email', 'send_outbound', 'poll_prava', 'expire_approvals', 'notify_decision');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound', 'system');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('agent', 'user', 'system');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."parse_status" AS ENUM('pending', 'parsed', 'failed', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."payment_session_status" AS ENUM('created', 'awaiting_collection', 'awaiting_result', 'completed', 'failed', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."recommendation" AS ENUM('renew', 'rightsize_seats', 'switch_term', 'switch_vendor', 'cancel', 'snooze');--> statement-breakpoint
CREATE TYPE "public"."savings_action_type" AS ENUM('cancel', 'rightsize', 'term_switch', 'switch_vendor', 'renew', 'other');--> statement-breakpoint
CREATE TYPE "public"."savings_recognition" AS ENUM('identified', 'realized');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('manual', 'email', 'file', 'csv');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('active', 'pending_cancel', 'cancelled', 'paused');--> statement-breakpoint
CREATE TYPE "public"."thread_status" AS ENUM('active', 'closed');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('approved', 'declined', 'error');--> statement-breakpoint
CREATE TYPE "public"."workspace_role" AS ENUM('owner', 'viewer');--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"decision_id" text NOT NULL,
	"thread_id" text,
	"outbound_message_id" text,
	"state" "approval_state" DEFAULT 'drafted' NOT NULL,
	"channel" "channel" NOT NULL,
	"prava_payment_session_id" text,
	"prava_hosted_url" text,
	"pay_token_hash" text,
	"amount" numeric(14, 2) NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"merchant_name" text NOT NULL,
	"action_type" "recommendation" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	"failure_code" text,
	"result_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_user_id" text,
	"type" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"channel" "channel" NOT NULL,
	"external_id" text NOT NULL,
	"status" "channel_status" DEFAULT 'pending' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"direction" "message_direction" NOT NULL,
	"role" "message_role" NOT NULL,
	"body" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"channel" "channel" NOT NULL,
	"channel_thread_id" text NOT NULL,
	"participant_external_id" text NOT NULL,
	"status" "thread_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "csv_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"import_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"merchant_guess" text NOT NULL,
	"merchant_canonical" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"date" timestamp with time zone,
	"billing_cycle" "billing_cycle" DEFAULT 'monthly' NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"confidence" numeric(4, 3) DEFAULT '0.000' NOT NULL,
	"raw_row" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "candidate_status" DEFAULT 'pending' NOT NULL,
	"linked_subscription_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "csv_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"filename" text NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"recommendation" "recommendation" NOT NULL,
	"payload" jsonb NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"model_id" text,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"priced_amount" numeric(14, 2),
	"expires_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"response_hash" text,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_emails" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"message_id" text,
	"from_addr" text NOT NULL,
	"to_addr" text NOT NULL,
	"subject" text,
	"raw_text" text NOT NULL,
	"content_hash" text NOT NULL,
	"parse_status" "parse_status" DEFAULT 'pending' NOT NULL,
	"parse_error" text,
	"renewal_event_id" text,
	"provider" text DEFAULT 'generic' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"type" "job_type" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"last_error" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"canonical_name" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"website" text,
	"cancel_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"thread_id" text,
	"approval_request_id" text,
	"channel" "channel" NOT NULL,
	"destination" text NOT NULL,
	"body" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"decision_id" text NOT NULL,
	"prava_session_id" text NOT NULL,
	"prava_order_id" text,
	"amount" numeric(14, 2) NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"merchant_name" text NOT NULL,
	"status" "payment_session_status" DEFAULT 'created' NOT NULL,
	"mode" text DEFAULT 'mock' NOT NULL,
	"iframe_url" text,
	"expires_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "renewal_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"subscription_id" text,
	"raw_text" text NOT NULL,
	"raw_excerpt" text NOT NULL,
	"parsed_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"parse_confidence" numeric(4, 3) DEFAULT '0.000' NOT NULL,
	"source_type" "source_type" DEFAULT 'email' NOT NULL,
	"parser_used" text DEFAULT 'heuristic' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "savings_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"subscription_id" text,
	"decision_id" text,
	"action_type" "savings_action_type" NOT NULL,
	"recognition" "savings_recognition" DEFAULT 'realized' NOT NULL,
	"approval_request_id" text,
	"amount_saved" numeric(14, 2) NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"period_months" integer DEFAULT 12 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"merchant_name" text NOT NULL,
	"merchant_canonical" text NOT NULL,
	"plan_name" text,
	"amount" numeric(14, 2) NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"billing_cycle" "billing_cycle" DEFAULT 'monthly' NOT NULL,
	"next_renewal_at" timestamp with time zone,
	"cancel_by_at" timestamp with time zone,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"criticality" "criticality" DEFAULT 'nice_to_have' NOT NULL,
	"job_category" text,
	"usage_note" text,
	"seats_total" integer DEFAULT 1 NOT NULL,
	"seats_active" integer,
	"merchant_id" text,
	"content_hash" text,
	"last_signal_at" timestamp with time zone,
	"source_type" "source_type" DEFAULT 'manual' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"field_confidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"price_change_note" text,
	"raw_excerpt" text,
	"notes" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"payment_session_id" text NOT NULL,
	"status" "transaction_status" NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"merchant_name" text NOT NULL,
	"prava_txn_ref_id" text,
	"card_last4" text,
	"card_brand" text,
	"card_exp_month" integer,
	"card_exp_year" integer,
	"checkout_reference" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "workspace_role" DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_settings" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"ai_monthly_budget" numeric(14, 2),
	"approval_mode" "approval_mode" DEFAULT 'always_ask' NOT NULL,
	"spend_ceiling" numeric(14, 2) DEFAULT '50.00',
	"kill_switch" boolean DEFAULT false NOT NULL,
	"category_ceilings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"quiet_hours_json" jsonb,
	"primary_channel" "channel" DEFAULT 'simulator' NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decision_id_decision_packages_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decision_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."conversation_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."conversation_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_candidates" ADD CONSTRAINT "csv_candidates_import_id_csv_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."csv_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_candidates" ADD CONSTRAINT "csv_candidates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_candidates" ADD CONSTRAINT "csv_candidates_linked_subscription_id_subscriptions_id_fk" FOREIGN KEY ("linked_subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_imports" ADD CONSTRAINT "csv_imports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_packages" ADD CONSTRAINT "decision_packages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_packages" ADD CONSTRAINT "decision_packages_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_emails" ADD CONSTRAINT "inbound_emails_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_thread_id_conversation_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."conversation_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_sessions" ADD CONSTRAINT "payment_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_sessions" ADD CONSTRAINT "payment_sessions_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_sessions" ADD CONSTRAINT "payment_sessions_decision_id_decision_packages_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decision_packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewal_events" ADD CONSTRAINT "renewal_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewal_events" ADD CONSTRAINT "renewal_events_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_entries" ADD CONSTRAINT "savings_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_entries" ADD CONSTRAINT "savings_entries_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_entries" ADD CONSTRAINT "savings_entries_decision_id_decision_packages_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decision_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_payment_session_id_payment_sessions_id_fk" FOREIGN KEY ("payment_session_id") REFERENCES "public"."payment_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_idempotency_unique" ON "approval_requests" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "approval_requests_state_expiry_idx" ON "approval_requests" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "approval_requests_workspace_idx" ON "approval_requests" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "approval_requests_thread_idx" ON "approval_requests" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "audit_events_workspace_created_idx" ON "audit_events" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_type_idx" ON "audit_events" USING btree ("workspace_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_connections_unique" ON "channel_connections" USING btree ("workspace_id","channel","external_id");--> statement-breakpoint
CREATE INDEX "channel_connections_lookup_idx" ON "channel_connections" USING btree ("channel","external_id");--> statement-breakpoint
CREATE INDEX "conversation_messages_thread_idx" ON "conversation_messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "conversation_messages_workspace_idx" ON "conversation_messages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "conversation_messages_external_idx" ON "conversation_messages" USING btree ("external_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_threads_external_unique" ON "conversation_threads" USING btree ("channel","channel_thread_id");--> statement-breakpoint
CREATE INDEX "conversation_threads_workspace_idx" ON "conversation_threads" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "csv_candidates_workspace_idx" ON "csv_candidates" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "csv_candidates_import_idx" ON "csv_candidates" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "csv_imports_workspace_idx" ON "csv_imports" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "decision_packages_workspace_idx" ON "decision_packages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "decision_packages_subscription_idx" ON "decision_packages" USING btree ("subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_scope_key_unique" ON "idempotency_keys" USING btree ("scope","key");--> statement-breakpoint
CREATE INDEX "inbound_emails_workspace_idx" ON "inbound_emails" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_emails_message_unique" ON "inbound_emails" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "inbound_emails_hash_idx" ON "inbound_emails" USING btree ("workspace_id","content_hash");--> statement-breakpoint
CREATE INDEX "jobs_status_runat_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_unique" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "merchants_workspace_idx" ON "merchants" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "merchants_canonical_idx" ON "merchants" USING btree ("canonical_name");--> statement-breakpoint
CREATE INDEX "outbox_status_idx" ON "outbox_messages" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "outbox_workspace_idx" ON "outbox_messages" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_dedupe_unique" ON "outbox_messages" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_sessions_prava_session_unique" ON "payment_sessions" USING btree ("prava_session_id");--> statement-breakpoint
CREATE INDEX "payment_sessions_workspace_idx" ON "payment_sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "payment_sessions_decision_idx" ON "payment_sessions" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "receipts_workspace_idx" ON "receipts" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_transaction_unique" ON "receipts" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "renewal_events_workspace_idx" ON "renewal_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "renewal_events_subscription_idx" ON "renewal_events" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "savings_entries_workspace_idx" ON "savings_entries" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "savings_entries_recognition_idx" ON "savings_entries" USING btree ("workspace_id","recognition");--> statement-breakpoint
CREATE INDEX "subscriptions_workspace_idx" ON "subscriptions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "subscriptions_renewal_idx" ON "subscriptions" USING btree ("workspace_id","next_renewal_at");--> statement-breakpoint
CREATE INDEX "transactions_workspace_idx" ON "transactions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "transactions_session_idx" ON "transactions" USING btree ("payment_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_unique" ON "workspace_members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "workspace_members_user_idx" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "workspaces_owner_idx" ON "workspaces" USING btree ("owner_user_id");