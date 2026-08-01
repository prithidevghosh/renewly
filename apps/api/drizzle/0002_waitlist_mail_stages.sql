ALTER TABLE "waitlist_entries" RENAME COLUMN "welcome_email_status" TO "mail_status";--> statement-breakpoint
ALTER TABLE "waitlist_entries" RENAME COLUMN "welcome_email_sent_at" TO "welcome_sent_at";--> statement-breakpoint
ALTER TABLE "waitlist_entries" RENAME COLUMN "welcome_email_error" TO "mail_error";--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD COLUMN "notice_sent_at" timestamp with time zone;
