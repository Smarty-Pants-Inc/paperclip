-- paperclip:migration-compat online_compatible: Replace only nonunique worker-selection indexes concurrently; no row rewrite, and previous readers remain valid.
DROP INDEX CONCURRENTLY IF EXISTS "agent_instruction_copies_collection_idx";--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "agent_instruction_copies_cleanup_idx";--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_instruction_copies_collection_v2_idx" ON "agent_instruction_working_copies" USING btree ("run_id","company_id") WHERE NOT (coalesce("agent_instruction_working_copies"."receipt", '{}'::jsonb) ? 'cleanupParked')
      AND NOT (coalesce("agent_instruction_working_copies"."receipt", '{}'::jsonb) ? 'cleanupTerminal')
      AND NOT (coalesce("agent_instruction_working_copies"."receipt", '{}'::jsonb) ? 'retainedByRunId') AND (
      ("agent_instruction_working_copies"."attempts" < 3 AND ("agent_instruction_working_copies"."state" IN ('prepared', 'pending_collection', 'unchanged_turn', 'warm_saved')
        OR ("agent_instruction_working_copies"."state" = 'preparing' AND "agent_instruction_working_copies"."receipt"->>'schema' = 'paperclip.agent-files.v1')))
      OR ("agent_instruction_working_copies"."state" = 'unavailable' AND "agent_instruction_working_copies"."process_stopped_at" IS NULL
        AND "agent_instruction_working_copies"."location" LIKE 'remote:%' AND "agent_instruction_working_copies"."receipt"->>'schema' = 'paperclip.agent-files.v1'));--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_instruction_copies_cleanup_v2_idx" ON "agent_instruction_working_copies" USING btree ("run_id","company_id") WHERE NOT (coalesce("agent_instruction_working_copies"."receipt", '{}'::jsonb) ? 'cleanupParked')
      AND NOT (coalesce("agent_instruction_working_copies"."receipt", '{}'::jsonb) ? 'cleanupTerminal')
      AND "agent_instruction_working_copies"."state" IN ('saved', 'unchanged', 'resolved', 'unavailable')
      AND "agent_instruction_working_copies"."process_stopped_at" IS NOT NULL
      AND "agent_instruction_working_copies"."receipt"->>'schema' = 'paperclip.agent-files.v1'
      AND coalesce("agent_instruction_working_copies"."receipt"->>'retainedByRunId', '') = ''
      AND "agent_instruction_working_copies"."receipt"->>'cleanupPending' IS DISTINCT FROM 'false'
      AND ("agent_instruction_working_copies"."receipt" ? 'baseline' OR "agent_instruction_working_copies"."receipt"->>'cleanupPending' = 'true');