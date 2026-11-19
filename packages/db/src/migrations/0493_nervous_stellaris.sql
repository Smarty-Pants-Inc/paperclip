-- paperclip:migration-compat online_compatible: nullable ownership leaves old readers/writers and all saved agent selections intact; the backfill updates only environment rows from existing indexed agent references.
ALTER TABLE "environments" ADD COLUMN "company_id" uuid;
--> statement-breakpoint
-- Local is always instance-shared. Unused and multiply-used environments stay
-- shared; never guess an exclusive owner from ambiguous historical usage.
UPDATE "environments" AS environment
SET "company_id" = usage.company_id
FROM (
  SELECT default_environment_id AS environment_id,
         (array_agg(DISTINCT company_id))[1] AS company_id
  FROM agents
  WHERE default_environment_id IS NOT NULL
  GROUP BY default_environment_id
  HAVING count(DISTINCT company_id) = 1
) AS usage
WHERE environment.id = usage.environment_id AND environment.driver <> 'local';