-- paperclip:migration-compat online_compatible: nullable draft defaults do not change existing agents; backfill is limited to companies with one unambiguous owned non-local active environment.
ALTER TABLE "companies" ADD COLUMN "default_environment_id" uuid;
--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_default_environment_id_environments_id_fk" FOREIGN KEY ("default_environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action NOT VALID;
--> statement-breakpoint
UPDATE companies AS company
SET default_environment_id = candidate.environment_id
FROM (
  SELECT company_id, (array_agg(id))[1] AS environment_id
  FROM environments
  WHERE company_id IS NOT NULL AND driver <> 'local' AND status = 'active'
  GROUP BY company_id
  HAVING count(*) = 1
) AS candidate
WHERE company.id = candidate.company_id AND company.default_environment_id IS NULL;