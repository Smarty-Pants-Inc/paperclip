-- paperclip:migration-compat online_compatible: Adds one nullable timestamp column and a lease trigger that only writes it; old releases ignore both.
-- Fork migration: a merge-down renumbers this file (byte-identical SQL body) if upstream ships its own 0496.
-- RFL 01:00Z ruling (a): one "startable since" stamp on the queued run. The person
-- start bound counts from the LATER of created_at and this stamp, so a hold that
-- clears never flashes failed + Retry before the dispatcher takes the run.
ALTER TABLE "heartbeat_runs" ADD COLUMN "startable_since" timestamp with time zone;
--> statement-breakpoint
-- Writer for the sandbox cleanup hold: every path that settles a lease's cleanup
-- (cleanup_status becomes 'success') stamps the task's still-queued runs. Latest wins.
CREATE OR REPLACE FUNCTION paperclip_lease_cleanup_startable_since() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE task uuid;
BEGIN
  task := coalesce(NEW.issue_id, (SELECT issue_id FROM heartbeat_runs WHERE id = NEW.heartbeat_run_id));
  IF task IS NOT NULL THEN
    UPDATE heartbeat_runs SET startable_since = greatest(coalesce(startable_since, now()), now())
      WHERE company_id = NEW.company_id AND issue_id = task AND status = 'queued' AND started_at IS NULL
        AND id IS DISTINCT FROM NEW.heartbeat_run_id;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_lease_cleanup_startable_since ON environment_leases;
--> statement-breakpoint
CREATE TRIGGER paperclip_lease_cleanup_startable_since AFTER UPDATE OF cleanup_status ON environment_leases
  FOR EACH ROW WHEN (NEW.cleanup_status = 'success' AND OLD.cleanup_status IS DISTINCT FROM 'success')
  EXECUTE FUNCTION paperclip_lease_cleanup_startable_since();
