import { and, eq, sql } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";

/** Only normalized failed stage names leave the run log, never event/provider text.
 * Child failures are written before their enclosing spans; ingress/connect share
 * a category, so either receipt identifies the same failed connection step. */
export function failedRunStage() {
  // Explicit qualifiers survive Drizzle's single-table selected-SQL rewriting.
  return sql<string | null>`(select "heartbeat_run_events"."payload"->>'span' from ${heartbeatRunEvents}
    where "heartbeat_run_events"."company_id" = "heartbeat_runs"."company_id"
      and "heartbeat_run_events"."run_id" = "heartbeat_runs"."id"
      and "heartbeat_runs"."error_code" = 'native_session_interrupted'
      and "heartbeat_run_events"."event_type" = 'run.performance.span'
      and "heartbeat_run_events"."payload"->>'schema' = 'paperclip.run-performance-span.v1'
      and "heartbeat_run_events"."payload"->>'outcome' = 'failed'
      and "heartbeat_run_events"."payload"->>'span' in
        ('runner.ingress.acquire', 'runner.transport.connect', 'environment.acquire', 'environment.resume')
    order by "heartbeat_run_events"."id" desc limit 1)`;
}

/** Historical releases wrapped the predecessor fence in native_session_interrupted.
 * Recognize its fixed phrase without loading or exposing the stored diagnostic. */
export function previousSessionUnconfirmed() {
  return sql<boolean>`coalesce(${heartbeatRuns.errorCode} = 'native_predecessor_retirement_unproven'
    or (${heartbeatRuns.errorCode} = 'native_session_interrupted'
      and ${heartbeatRuns.error} like '%could not be retired%'), false)`;
}

export async function readRunFailureStage(db: Pick<Db, "select">, companyId: string, runId: string) {
  const [facts] = await db.select({ failedStage: failedRunStage(), previousSessionUnconfirmed: previousSessionUnconfirmed() })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)))
    .limit(1);
  return facts;
}
