-- paperclip:migration-compat online_compatible: Replaces/adds trigger functions that only write heartbeat_runs.startable_since; old releases ignore them.
-- Fork migration: a merge-down renumbers this file (byte-identical SQL body) if upstream ships its own 0498.
-- FIX18 (RFL 02:16Z, ruling (a)): the last two hold clears of execution-blocker.ts hasPendingRunCleanup.
-- (1) :81 the manual admission hold (native-runner-ownership.ts nativeManualAdmissionHoldMatches):
--     a native_run_finalizations row in phase terminal_failure, failure_code native_restart_recovery_blocked
--     or native_retry_cancelled, no result, failure_detail.systemRecovery exhausted for this run. Whatever
--     writer releases it (failure_detail, failure_code, phase, result_id, or the row going away), the
--     task's still-queued runs are stamped at the release.
CREATE OR REPLACE FUNCTION paperclip_manual_admission_hold(f native_run_finalizations) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(f.phase = 'terminal_failure' AND f.result_id IS NULL
    AND f.failure_code IN ('native_restart_recovery_blocked', 'native_retry_cancelled')
    AND f.failure_detail->'systemRecovery'->>'state' = 'exhausted'
    AND f.failure_detail->'systemRecovery'->>'sourceRunId' = f.run_id::text, false)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_manual_admission_release_startable_since() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT paperclip_manual_admission_hold(OLD) THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.run_id = OLD.run_id AND paperclip_manual_admission_hold(NEW) THEN RETURN NULL; END IF;
  PERFORM paperclip_stamp_task_startable_since(r.company_id, r.issue_id, r.id)
    FROM heartbeat_runs r WHERE r.id = OLD.run_id;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_manual_admission_release_startable_since ON native_run_finalizations;
--> statement-breakpoint
CREATE TRIGGER paperclip_manual_admission_release_startable_since AFTER UPDATE OR DELETE ON native_run_finalizations
  FOR EACH ROW EXECUTE FUNCTION paperclip_manual_admission_release_startable_since();
--> statement-breakpoint
-- (2) :84-87 the recovered-stopped exclusion: a lease carrying workspaceRecoveryCleanup for its own run,
--     released, in pending_cleanup/released/expired/failed, no longer holds the run (its stop receipt is
--     checked in TypeScript, hasRecoveredCleanupStopReceipt). Its writers (workspace-recovery.ts:598,
--     environment-retained-orphan-settlement.ts:232) write that receipt in the same UPDATE that can end the
--     hold (for example a lease still pendingCleanupInFlight). 0497's lease trigger saw the NEW row as still
--     holding (pending_cleanup) and stamped nothing. NEW in that recovered-stopped shape now counts as not
--     holding; the receipt's provider binding stays a TypeScript check, so a shape with a bad receipt
--     can stamp early (the safe side: the bound only restarts).
CREATE OR REPLACE FUNCTION paperclip_lease_recovered_stopped(l environment_leases) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(l.metadata->'workspaceRecoveryCleanup' IS NOT NULL
    AND l.metadata->'workspaceRecoveryCleanup'->>'runId' = l.heartbeat_run_id::text
    AND l.released_at IS NOT NULL AND l.status IN ('pending_cleanup', 'released', 'expired', 'failed')
    AND l.metadata->'workspaceRecoveryCleanup'->'stopReceipt' IS NOT NULL
    AND jsonb_typeof(l.metadata->'workspaceRecoveryCleanup'->'stopReceipt') = 'object', false)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_lease_hold_clear_startable_since() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE run heartbeat_runs%ROWTYPE;
BEGIN
  IF OLD.heartbeat_run_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO run FROM heartbeat_runs WHERE id = OLD.heartbeat_run_id;
  IF NOT FOUND OR NOT paperclip_lease_holds_run(OLD, run.runtime_mode) THEN RETURN NULL; END IF;
  -- A deleted lease, one moved off the run, or one that became recovered-stopped no longer holds it.
  IF TG_OP = 'UPDATE' AND NEW.heartbeat_run_id IS NOT DISTINCT FROM OLD.heartbeat_run_id
    AND paperclip_lease_holds_run(NEW, run.runtime_mode)
    AND NOT (paperclip_lease_recovered_stopped(NEW) AND NOT paperclip_lease_recovered_stopped(OLD)) THEN RETURN NULL; END IF;
  PERFORM paperclip_stamp_task_startable_since(OLD.company_id, coalesce(run.issue_id, OLD.issue_id), run.id);
  RETURN NULL;
END $$;
