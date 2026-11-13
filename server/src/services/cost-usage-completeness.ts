import { costEvents, heartbeatRuns } from "@paperclipai/db";
import { sql } from "drizzle-orm";

export const aggregateAccountingUsageLost = sql<boolean>`coalesce(bool_or(exists (
  select 1 from ${heartbeatRuns} usage_run
  where usage_run.id = ${costEvents}.${sql.identifier(costEvents.heartbeatRunId.name)}
    and usage_run.company_id = ${costEvents}.${sql.identifier(costEvents.companyId.name)}
    and usage_run.usage_json->>'accountingUsageLost' = 'true'
)), false)`;
