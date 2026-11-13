import { sql } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, nativeRunResults, toolInvocations, type Db } from "@paperclipai/db";
/** Durable run events that prove a provider session did work in a run. */
export const NATIVE_PROVIDER_DURABLE_EVENT_TYPES = new Set([
  "harness.ready", "session.started", "session.resumed", "session.updated",
  "turn.started", "provider.event", "provider.rpc_result",
]);

/** No recorded provider work across every runner instance, never just the latest
 * runner. This is NOT proof that no process spawned or that a runner is gone.
 * A read failure or any provider event, tool call, or result denies the proof. */
export async function provesNoNativeRunProviderWork(db: Db, input: {
  companyId: string; runId: string; signal?: AbortSignal;
}): Promise<boolean> {
  input.signal?.throwIfAborted();
  const { companyId, runId } = input;
  const providerEvents = sql.join([...NATIVE_PROVIDER_DURABLE_EVENT_TYPES].map(value => sql`${value}`), sql`, `);
  const result = await db.execute(sql`select
    exists (select 1 from ${heartbeatRunEvents} event where event.company_id = ${companyId} and event.run_id = ${runId}
      and (event.source_event_id is not null or event.source_instance_id is not null
        or event.event_type in (${providerEvents})
        or event.event_type ~ '^(turn|item|tool|semantic_tool|run[.]result)[.]')) as "providerEvent",
    exists (select 1 from ${toolInvocations} invocation where invocation.company_id = ${companyId}
      and invocation.run_id = ${runId}) as "toolInvocation",
    exists (select 1 from ${nativeRunResults} result where result.company_id = ${companyId}
      and result.run_id = ${runId}) as "acceptedResult",
    exists (select 1 from ${nativeRunFinalizations} coordinator where coordinator.run_id = ${runId}
      and coordinator.result_id is not null) as "finalizedResult"`);
  input.signal?.throwIfAborted();
  const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as Array<Record<string, unknown>>;
  const row = rows[0];
  return Boolean(row && row.providerEvent === false && row.toolInvocation === false
    && row.acceptedResult === false && row.finalizedResult === false);
}

/** Affirmative durable PRE-SPAWN evidence, not an alternative process-death
 * predicate. The coordinator claim is the only dispatch gate. A never-claimed
 * coordinator or the server's prior-owner refusal proves this run did not
 * dispatch; any launch intent/attempt contradicts that proof and keeps it held.
 * Callers accepting copied process fields must separately bind them to their
 * exact source run. Process death after dispatch uses the existing local/remote
 * generation prover, never this absence-of-provider-work query. */
export async function provesNativeRunPreSpawnFailure(db: Db, input: {
  companyId: string; runId: string;
}): Promise<boolean> {
  const { companyId, runId } = input;
  const result = await db.execute(sql`select
    (coordinator.attempt = 0 and coordinator.controller_generation = 0
      and coordinator.controller_pid is null
      and run.process_pid is null and run.process_group_id is null and run.process_started_at is null
      and run.result_json#>>'{executionRecovery,kind}' = 'bootstrap'
      and run.result_json#>'{executionRecovery,providerWorkStarted}' = 'false'::jsonb) as "preClaim",
    exists (select 1 from ${heartbeatRunEvents} event where event.company_id = run.company_id
      and event.run_id = run.id and event.source_event_id is null and event.source_instance_id is null
      and event.event_type = 'native.prior_owner_fence_refused') as "fenceRefused",
    exists (select 1 from ${heartbeatRunEvents} event where event.company_id = run.company_id
      and event.run_id = run.id and (event.event_type in ('adapter.invoke', 'native.process_start_requested',
        'native.process_identity_recorded', 'native.process_started')
        or event.payload->>'span' = 'runner.process.dispatch')) as "launchAttempt"
    from ${heartbeatRuns} run inner join ${nativeRunFinalizations} coordinator
      on coordinator.run_id = run.id and coordinator.company_id = run.company_id
        and coordinator.issue_id = run.native_issue_id
    where run.company_id = ${companyId} and run.id = ${runId} and run.runtime_mode = 'native' and run.status = 'failed'
      and coordinator.phase = 'terminal_failure' and coordinator.result_id is null
      and coordinator.lease_owner is null and coordinator.lease_expires_at is null`);
  const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as Array<Record<string, unknown>>;
  const row = rows[0];
  return Boolean(row && row.launchAttempt === false && (row.preClaim === true || row.fenceRefused === true))
    && await provesNoNativeRunProviderWork(db, input);
}
