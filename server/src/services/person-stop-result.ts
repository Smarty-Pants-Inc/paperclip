import { heartbeatRuns } from "@paperclipai/db";
import { sql, type SQL } from "drizzle-orm";

/** A failure may have read the run before Stop committed. Merge at UPDATE time;
 * the durable return receipt and startup fence belong to Stop, not that snapshot. */
export function preservePersonStopResultSql(incoming: SQL) {
  return sql`(coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || coalesce(${incoming}, '{}'::jsonb) || (
    select coalesce(jsonb_object_agg(stop_field.key, stop_field.value), '{}'::jsonb)
    from jsonb_each(coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb)) as stop_field(key, value)
    where stop_field.key in ('personStop', 'startupCancellation')
  ))`;
}
