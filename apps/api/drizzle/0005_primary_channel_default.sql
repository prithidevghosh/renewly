-- The default pointed at "simulator", which has no adapter outside the test
-- doubles, so every workspace was created addressed to a channel production
-- refuses to construct, and the sweep skipped it for life.
ALTER TABLE "workspace_settings" ALTER COLUMN "primary_channel" SET DEFAULT 'imessage';
--> statement-breakpoint
-- Rows still carrying the old default are in exactly that broken state, and
-- nothing is lost by moving them: a "simulator" row could never deliver
-- anything. This does not invent a connection — delivery still depends on one.
-- It only stops the settings row naming a channel that cannot exist.
UPDATE "workspace_settings" SET "primary_channel" = 'imessage' WHERE "primary_channel" = 'simulator';
