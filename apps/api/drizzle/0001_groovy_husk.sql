CREATE TYPE "public"."waitlist_email_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "waitlist_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"source" text DEFAULT 'web' NOT NULL,
	"referrer" text,
	"welcome_email_status" "waitlist_email_status" DEFAULT 'pending' NOT NULL,
	"welcome_email_sent_at" timestamp with time zone,
	"welcome_email_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_entries_email_unique" ON "waitlist_entries" USING btree ("email");--> statement-breakpoint
CREATE INDEX "waitlist_entries_created_idx" ON "waitlist_entries" USING btree ("created_at");