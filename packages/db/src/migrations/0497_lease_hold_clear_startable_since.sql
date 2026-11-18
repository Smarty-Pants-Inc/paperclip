-- paperclip:migration-compat online_compatible: Adds trigger functions that only write heartbeat_runs.startable_since; old releases ignore them.
-- Fork migration: a merge-down renumbers this file (byte-identical SQL body) if upstream ships its own 0497.
-- FIX16 (RFL ruling (a)): 0496 stamps only when cleanup_status becomes 'success'. The
-- run hold (execution-blocker.ts hasPendingRunCleanup) also clears through released_at,
-- status, pendingCleanupInFlight, the native release shape, a lease leaving the run,
-- the run's nativeWorkspaceFinalizationOwner and the native finalization row. Every
-- held -> not-held transition of those rows stamps the task's still-queued runs.
CREATE OR REPLACE FUNCTION paperclip_stamp_task_startable_since(company uuid, task uuid, held_run uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF task IS NULL THEN RETURN; END IF;
  UPDATE heartbeat_runs SET startable_since = greatest(coalesce(startable_since, now()), now())
    WHERE company_id = company AND issue_id = task AND status = 'queued' AND started_at IS NULL
      AND id IS DISTINCT FROM held_run;
END $$;
--> statement-breakpoint
-- The per-lease clause of hasPendingRunCleanup, verbatim (execution-blocker.ts:98-110).
CREATE OR REPLACE FUNCTION paperclip_lease_holds_run(l environment_leases, runtime_mode text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((l.released_at IS NULL AND NOT coalesce(
      l.status = 'retained' AND l.lease_policy = 'reuse_by_environment' AND l.cleanup_status = 'success', false))
    OR l.status IN ('active', 'pending_cleanup') OR l.cleanup_status = 'failed'
    OR coalesce(l.metadata->>'pendingCleanupInFlight', 'false') <> 'false'
    OR (runtime_mode = 'native' AND NOT coalesce(
      (l.status IN ('released', 'expired', 'failed') AND l.released_at IS NOT NULL AND (l.cleanup_status = 'success'
        OR (l.cleanup_status IS NULL AND (
          (l.provider = 'local' AND l.provider_lease_id IS NULL)
          OR (l.provider = 'ssh' AND l.metadata->>'driver' = 'ssh' AND l.provider_lease_id LIKE 'ssh://%')))))
      OR (l.status = 'retained' AND l.lease_policy = 'reuse_by_environment' AND l.cleanup_status = 'success'), false)), false)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_lease_hold_clear_startable_since() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE run heartbeat_runs%ROWTYPE;
BEGIN
  IF OLD.heartbeat_run_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO run FROM heartbeat_runs WHERE id = OLD.heartbeat_run_id;
  IF NOT FOUND OR NOT paperclip_lease_holds_run(OLD, run.runtime_mode) THEN RETURN NULL; END IF;
  -- A deleted lease, or one moved off the run, no longer holds it.
  IF TG_OP = 'UPDATE' AND NEW.heartbeat_run_id IS NOT DISTINCT FROM OLD.heartbeat_run_id
    AND paperclip_lease_holds_run(NEW, run.runtime_mode) THEN RETURN NULL; END IF;
  PERFORM paperclip_stamp_task_startable_since(OLD.company_id, coalesce(run.issue_id, OLD.issue_id), run.id);
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_lease_hold_clear_startable_since ON environment_leases;
--> statement-breakpoint
CREATE TRIGGER paperclip_lease_hold_clear_startable_since AFTER UPDATE OR DELETE ON environment_leases
  FOR EACH ROW EXECUTE FUNCTION paperclip_lease_hold_clear_startable_since();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_run_finalization_owner_clear_startable_since() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM paperclip_stamp_task_startable_since(NEW.company_id, NEW.issue_id, NEW.id);
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_run_finalization_owner_clear_startable_since ON heartbeat_runs;
--> statement-breakpoint
CREATE TRIGGER paperclip_run_finalization_owner_clear_startable_since AFTER UPDATE OF runner_profile_json ON heartbeat_runs
  FOR EACH ROW WHEN (OLD.runner_profile_json->>'nativeWorkspaceFinalizationOwner' IS NOT NULL
    AND NEW.runner_profile_json->>'nativeWorkspaceFinalizationOwner' IS NULL)
  EXECUTE FUNCTION paperclip_run_finalization_owner_clear_startable_since();
--> statement-breakpoint
-- The finalization clause (execution-blocker.ts:111-114): lease_owner set, or a phase not yet settled.
CREATE OR REPLACE FUNCTION paperclip_native_finalization_clear_startable_since() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (OLD.lease_owner IS NOT NULL OR OLD.phase NOT IN ('committed', 'applied', 'terminal_failure')) THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.run_id = OLD.run_id
    AND (NEW.lease_owner IS NOT NULL OR NEW.phase NOT IN ('committed', 'applied', 'terminal_failure')) THEN RETURN NULL; END IF;
  PERFORM paperclip_stamp_task_startable_since(r.company_id, r.issue_id, r.id)
    FROM heartbeat_runs r WHERE r.id = OLD.run_id;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_native_finalization_clear_startable_since ON native_run_finalizations;
--> statement-breakpoint
CREATE TRIGGER paperclip_native_finalization_clear_startable_since AFTER UPDATE OR DELETE ON native_run_finalizations
  FOR EACH ROW EXECUTE FUNCTION paperclip_native_finalization_clear_startable_since();
