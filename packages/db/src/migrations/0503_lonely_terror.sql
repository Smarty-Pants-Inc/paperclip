-- paperclip:migration-compat online_compatible: Nullable marker without a default, backfill, or index; the five-second lock timeout bounds lock acquisition and leaves previous releases compatible.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "terminal_plugin_event_id" uuid;