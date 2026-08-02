CREATE TYPE "public"."agent_session_kind" AS ENUM('onboarding', 'detect', 'decide', 'monthly_sweep');--> statement-breakpoint
CREATE TYPE "public"."agent_session_status" AS ENUM('running', 'awaiting_input', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."auth_provider" AS ENUM('password', 'google', 'microsoft');--> statement-breakpoint
CREATE TYPE "public"."finding_kind" AS ENUM('category_over_cap', 'purpose_overlap', 'annual_switch', 'renewal_due');--> statement-breakpoint
CREATE TYPE "public"."mailbox_provider" AS ENUM('gmail', 'outlook');--> statement-breakpoint
CREATE TYPE "public"."mailbox_status" AS ENUM('pending', 'active', 'revoked', 'error');--> statement-breakpoint
CREATE TABLE "agent_events" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"step" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_prompts" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"event_seq" integer NOT NULL,
	"prompt_key" text NOT NULL,
	"question" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"free_text" boolean DEFAULT false NOT NULL,
	"skippable" boolean DEFAULT false NOT NULL,
	"answer" text,
	"answered_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" "agent_session_kind" NOT NULL,
	"status" "agent_session_status" DEFAULT 'running' NOT NULL,
	"current_step" text,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" "auth_provider" NOT NULL,
	"provider_account_id" text NOT NULL,
	"email" text,
	"access_token" text,
	"refresh_token" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "category_caps" (
	"workspace_id" text NOT NULL,
	"category" text NOT NULL,
	"max_monthly" numeric(14, 2),
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"asked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" "finding_kind" NOT NULL,
	"subject_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"category" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"impact_annual" numeric(14, 2),
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"agent_session_id" text,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_verification_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"mailbox_connection_id" text,
	"provider_message_id" text NOT NULL,
	"subject" text,
	"from_addr" text,
	"received_at" timestamp with time zone,
	"snippet" text,
	"is_saas" boolean DEFAULT false NOT NULL,
	"merchant_canonical" text,
	"amount" numeric(14, 2),
	"currency" char(3),
	"billing_cycle" "billing_cycle",
	"parsed" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"subscription_id" text,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider" "mailbox_provider" NOT NULL,
	"email_address" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"status" "mailbox_status" DEFAULT 'pending' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"sync_cursor" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "purpose" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "plan_details" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "active_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "last_paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_url" text;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_prompts" ADD CONSTRAINT "agent_prompts_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_prompts" ADD CONSTRAINT "agent_prompts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_caps" ADD CONSTRAINT "category_caps_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_findings" ADD CONSTRAINT "decision_findings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_verification_codes" ADD CONSTRAINT "email_verification_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_receipts" ADD CONSTRAINT "mail_receipts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_receipts" ADD CONSTRAINT "mail_receipts_mailbox_connection_id_mailbox_connections_id_fk" FOREIGN KEY ("mailbox_connection_id") REFERENCES "public"."mailbox_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_receipts" ADD CONSTRAINT "mail_receipts_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_connections" ADD CONSTRAINT "mailbox_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_connections" ADD CONSTRAINT "mailbox_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_events_seq_unique" ON "agent_events" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "agent_events_session_idx" ON "agent_events" USING btree ("session_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_prompts_key_unique" ON "agent_prompts" USING btree ("session_id","prompt_key");--> statement-breakpoint
CREATE INDEX "agent_prompts_open_idx" ON "agent_prompts" USING btree ("session_id","answered_at");--> statement-breakpoint
CREATE INDEX "agent_sessions_workspace_idx" ON "agent_sessions" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "agent_sessions_user_idx" ON "agent_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_provider_unique" ON "auth_identities" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "auth_identities_user_idx" ON "auth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "category_caps_pk" ON "category_caps" USING btree ("workspace_id","category");--> statement-breakpoint
CREATE INDEX "decision_findings_workspace_idx" ON "decision_findings" USING btree ("workspace_id","kind");--> statement-breakpoint
CREATE INDEX "decision_findings_live_idx" ON "decision_findings" USING btree ("workspace_id","superseded_at");--> statement-breakpoint
CREATE INDEX "email_verification_user_idx" ON "email_verification_codes" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_receipts_message_unique" ON "mail_receipts" USING btree ("workspace_id","provider_message_id");--> statement-breakpoint
CREATE INDEX "mail_receipts_merchant_idx" ON "mail_receipts" USING btree ("workspace_id","merchant_canonical");--> statement-breakpoint
CREATE INDEX "mail_receipts_received_idx" ON "mail_receipts" USING btree ("workspace_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_connections_unique" ON "mailbox_connections" USING btree ("workspace_id","provider","email_address");--> statement-breakpoint
CREATE INDEX "mailbox_connections_workspace_idx" ON "mailbox_connections" USING btree ("workspace_id");