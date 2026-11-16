import { and, eq, ne, sql } from "drizzle-orm";
import { environments, environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, nativeRunResults, nativeRunnerCheckpoints, toolInvocations, type Db } from "@paperclipai/db";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { EnvironmentRuntimeService, EnvironmentDriverExecuteInput } from "../environment-runtime.js";
import { hasNativeExecutionStartEvidence } from "./native-restart-recovery.js";
import { hasNativePreDispatchFailureRecord } from "../heartbeat/run-failure-cause.js";
/** Durable run events that prove a provider session did work in a run. */
export const NATIVE_PROVIDER_DURABLE_EVENT_TYPES = new Set([
  "harness.ready", "session.started", "session.resumed", "session.updated",
  "turn.started", "provider.event", "provider.rpc_result",
]);

/** No recorded provider work across every runner instance, never just the latest
 * runner. This is NOT proof that no process spawned or that a runner is gone.
 * A read failure or any provider event, tool call, or result denies the proof. */
export async function provesNoNativeRunProviderWork(db: Pick<Db, "execute">, input: {
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

/** Item kinds a provider only thinks, writes or accounts with. Any other item
 * kind (a command, a tool, a file change, an MCP or dynamic tool call, or a kind
 * this list does not know yet) counts as tool work: the proof fails closed. */
export const NATIVE_INERT_ITEM_KINDS = ["agentMessage", "reasoning", "usage", "userMessage", "contextCompaction", "warning"] as const;

/** Item event types; each proves only with an inert item kind (above). */
export const NATIVE_ITEM_EVENT_TYPES = ["item.started", "item.delta", "item.updated", "item.completed", "item.failed"] as const;

/**
 * CLOSED allow-list of run event types known to be INERT: controller, Runner,
 * harness, session and turn lifecycle, accounting and diagnostics, none of
 * which acts outside the provider's own conversation (review-fleet-3 F7-1).
 * Every other event type, including any type this list does not know yet,
 * denies the proof: a tool, semantic tool, delegation, MCP app, terminal or
 * hook event, an issue, workspace diff/change/file, artifact, research,
 * runtime request, interaction, attention, status decision, external
 * provider, run result/terminal, response publication, task-history or
 * child-task read, tool-gateway delivery, goal or plan. The list per emitted
 * literal (inert / side-effecting) is in the F7 result (TL08).
 */
export const NATIVE_INERT_RUN_EVENT_TYPES = [
  "lifecycle",
  "turn.submitted", "turn.accepted", "turn.started", "turn.completed", "turn.failed", "turn.interrupted", "turn.cancelled",
  "session.starting", "session.started", "session.resuming", "session.resumed", "session.reconciled", "session.updated",
  "session.failed", "session.closed", "session.capabilities.updated",
  "harness.starting", "harness.ready", "harness.diagnostic", "harness.exited",
  "runner.connected", "runner.reconnected", "runner.disconnected", "runner.diagnostic", "runner.suspending",
  "runner.suspended", "runner.reconciled", "runner.attachment.settled", "runner.backpressure", "runner.draining",
  "runner.stopped",
  "run.attached", "run.detached", "run.performance.budget_exceeded",
  "usage.reported", "context.compacted", "model.route.changed", "model.verification.updated", "runtime.phase.changed",
  "provider.notice.recorded", "sandbox.metric", "workspace.ready",
  "native.process_start_requested", "native.process_identity_recorded", "native.recovery.transition",
  "native.recovery.execution_reclaimed", "native.diagnostic",
] as const;

/** The event type of Paperclip's own run spans (native-run-trace.ts). It is NOT
 * inert as a type: Paperclip records a tool execution server-side as
 * run.performance.span { span: "tool.execute" } (native-tool-trace.ts), while
 * the tool events themselves ride the Runner stream a lost box cuts
 * (review-fleet-5 C1). A span row proves only with an inert span name below. */
export const NATIVE_RUN_SPAN_EVENT_TYPE = "run.performance.span";

/**
 * CLOSED allow-list of span names known to be INERT: task, environment,
 * provider-pack, harness-state, Runner startup/transport, provider session and
 * turn timings, none of which records a tool call or a result. Every other
 * span name denies the proof, including the action spans tool.execute,
 * tool.request.input_stream, completion.request.first (a finish/block tool
 * started), completion.tool_accepted, completion.result_committed and
 * native.result.finalize, and any name this list does not know yet. The list
 * per emitted name (inert / action, by line) is in the C1 result (TL08).
 */
export const NATIVE_INERT_RUN_SPAN_NAMES = [
  "task.run", "task.run.measured", "task.provider_session", "task.provider_session.measured", "task.prepare",
  "task.settle", "skills.prepare", "heartbeat.queue", "heartbeat.prepare_before_environment",
  "heartbeat.prepare_after_environment", "comment.to_run_created", "question_response.to_run_created",
  "environment.acquire", "environment.startup", "environment.workspace.realize", "sandbox.lease.acquisition",
  "native.coordinator.claim", "native.session.execute", "native.controller.warm_owner_identity_check",
  "provider_pack.select", "provider_pack.discover", "provider_pack.verify", "provider_pack.verify_preinstalled",
  "provider_pack.verify_uploaded", "provider_pack.link_preinstalled", "provider_pack.clear_stale",
  "provider_pack.upload", "provider_pack.verify_memo_hit", "provider_pack.source", "provider_pack.directory.verify",
  "provider_pack.archive.verify", "provider_pack.archive.probe", "provider_pack.archive.reuse",
  "provider_pack.archive.verify_missing", "provider_pack.archive.transfer", "provider_pack.archive.extract",
  "harness_state.inspect", "harness_state.path_check", "harness_state.launch_material", "harness_state.reuse",
  "stage.asset.runtime_context", "stage.asset.codex_skills.verify", "stage.asset.codex_skills", "stage.asset.ca_bundle",
  "runner.artifact.discover", "runner.artifact.prepare", "runner.prp.authenticate", "runner.prp.route.register",
  "runner.runtime.stage", "runner.launch.prepare", "runner.control_plane.open", "runner.process.dispatch",
  "runner.process.launch", "runner.process.identity_failure_cleanup", "runner.port_holders.retire",
  "runner.session.startup", "runner.session.bootstrap", "runner.session.resume", "runner.transport.connect",
  "runner.transport.attach", "runner.transport.selected", "runner.turn.submit", "runner.turn.submitted_to_started",
  "runner.event.persist", "runner.pi.attach", "runner.pi.bind", "runner.pi.begin_turn", "runner.pi.interrupt_wait",
  "runner.pi.prompt_to_started", "runner.pi.admission.get_state", "runner.pi.admission.set_model",
  "runner.pi.admission.get_available_thinking_levels", "runner.pi.admission.set_thinking_level",
  "runner.pi.open.total", "runner.pi.open.native_mcp_config", "pi.request.sent",
  "provider.runtime", "provider.session.load", "provider.session.resume", "provider.session.continuity_break",
  "provider.turn.queue", "provider.time_to_first_agent_event", "agent.turn", "task.time_to_first_agent_activity",
  "task.time_to_first_token", "response.first_nonempty_text",
] as const;

/** Controller waits measured only inside the resume and submit windows, before
 * turn.started (native-controller-step-timing.ts flush: native.controller.<phase>.<step>). */
export const NATIVE_INERT_RUN_SPAN_PREFIXES = ["native.controller.resume.", "native.controller.submit."] as const;

/** No recorded tool call or side-effecting provider work across every runner
 * instance of this run. Unlike provesNoNativeRunProviderWork, a turn that only
 * started, thought and wrote text still proves it. Every run event must be on
 * the closed inert list (an item only with an inert kind); anything else,
 * known side-effecting or unknown, denies the proof. An empty
 * pendingRuntimeRequests alone is NOT this proof. A read failure denies it. */
export async function provesNoNativeRunToolWork(db: Pick<Db, "execute">, input: {
  companyId: string; runId: string; signal?: AbortSignal;
}): Promise<boolean> {
  input.signal?.throwIfAborted();
  const { companyId, runId } = input;
  const list = (values: readonly string[]) => sql.join(values.map(value => sql`${value}`), sql`, `);
  const result = await db.execute(sql`select
    exists (select 1 from ${heartbeatRunEvents} event where event.company_id = ${companyId} and event.run_id = ${runId}
      and not (event.event_type in (${list(NATIVE_INERT_RUN_EVENT_TYPES)})
        or (event.event_type in (${list(NATIVE_ITEM_EVENT_TYPES)})
          and coalesce(event.payload->'prpEvent'->'payload'->>'kind', '') in (${list(NATIVE_INERT_ITEM_KINDS)}))
        or (event.event_type = ${NATIVE_RUN_SPAN_EVENT_TYPE}
          and (coalesce(event.payload->>'span', '') in (${list(NATIVE_INERT_RUN_SPAN_NAMES)})
            or ${sql.join(NATIVE_INERT_RUN_SPAN_PREFIXES.map(prefix =>
              sql`starts_with(coalesce(event.payload->>'span', ''), ${prefix})`), sql` or `)})))) as "toolEvent",
    exists (select 1 from ${toolInvocations} invocation where invocation.company_id = ${companyId}
      and invocation.run_id = ${runId}) as "toolInvocation"`);
  input.signal?.throwIfAborted();
  const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as Array<Record<string, unknown>>;
  const row = rows[0];
  return Boolean(row && row.toolEvent === false && row.toolInvocation === false);
}

export type FailedNativePredecessorProbe = Pick<EnvironmentRuntimeService, "execute"> &
  Partial<Pick<EnvironmentRuntimeService, "readPredecessorSandboxRecord">>;
type ProofDb = Pick<Db, "select" | "execute">;
type Predecessor = typeof heartbeatRuns.$inferSelect;

/** P1 switch. Off until the generation-loss helper is judged same-box and
 * fail-closed (Image C); with it off, a failed predecessor that has execution
 * start evidence stays HELD with its visible notice. P2 alone frees the
 * claimed, never-launched rows (SMA-43 shape). */
export const FAILED_PREDECESSOR_P1_ENABLED = false;

/** ONE failed-predecessor gate, shared by resume selection and legacy identity
 * walk-back. P1 proves the old physical generation gone; P2 proves no execution
 * ever started. A claim (attempt/generation > 0) is not execution evidence.
 * Existing caller fences still apply; unknown/missing evidence stays held. */
export async function canBypassFailedNativePredecessor(db: ProofDb, input: {
  companyId: string; runId: string; predecessorEnvironmentRuntime?: FailedNativePredecessorProbe;
}): Promise<boolean> {
  const [row] = await db.select({ run: heartbeatRuns, owner: nativeRunFinalizations })
    .from(heartbeatRuns).leftJoin(nativeRunFinalizations, and(
      eq(nativeRunFinalizations.runId, heartbeatRuns.id)))
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  if (!row || row.run.runtimeMode !== "native" || row.run.status !== "failed" || !row.run.finishedAt
    || (row.owner && (row.owner.companyId !== row.run.companyId || row.owner.issueId !== row.run.nativeIssueId))) return false;
  // A controller-owned pre-dispatch receipt speaks about THIS attempt, not
  // every previous successful turn in the conversation. Keep its real source.
  if (hasNativePreDispatchFailureRecord(row.run.resultJson)) {
    return preDispatchWithoutAllocationOrExecution(db, row.run, row.owner);
  }
  if (!row.owner || row.owner.phase !== "terminal_failure" || row.owner.leaseOwner !== null || row.owner.leaseExpiresAt !== null) return false;
  return (FAILED_PREDECESSOR_P1_ENABLED && await predecessorGenerationLost(db, row.run, input.predecessorEnvironmentRuntime))
    || await terminalCompleteWithoutExecutionStart(db, row.run); // P1 OR P2
}

/** The failure owner records this only when its dispatch gate was explicitly
 * never entered (run-completion.ts). A terminal run fences later admission, so
 * unlike legacy P2 this does not infer a negative from a closed telemetry log.
 * Old rows without the receipt keep P2's stricter carried-session checks.
 * Any contradictory allocation, claim, start, checkpoint, result or provider
 * event wins over the receipt. HTTP status and missing snapshot are irrelevant. */
async function preDispatchWithoutAllocationOrExecution(db: ProofDb, run: Predecessor,
  owner: typeof nativeRunFinalizations.$inferSelect | null): Promise<boolean> {
  if (!hasNativePreDispatchFailureRecord(run.resultJson) || !run.nativeIssueId || run.sessionIdAfter !== null) return false;
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const profile = object(run.runnerProfileJson);
  if (profile.nativeControllerRecovery != null) return false;
  if (profile.sessionCheckpoint != null) {
    // Selection can rebind an idle source snapshot before dispatch. That is
    // not a new runner snapshot, but a cursor/result/active turn would be.
    const checkpoint = object(profile.sessionCheckpoint), identity = object(checkpoint.identity);
    const recovery = object(run.resultJson?.executionRecovery);
    const noProcess = run.processPid === null && run.processGroupId === null && run.processStartedAt === null;
    const bootstrap = noProcess && recovery.kind === "bootstrap" && recovery.providerWorkStarted === false;
    const idle = checkpoint.activeTurnId === null
      && Array.isArray(checkpoint.pendingRuntimeRequests) && checkpoint.pendingRuntimeRequests.length === 0
      && Array.isArray(checkpoint.terminalTurns) && checkpoint.terminalTurns.length === 0
      && checkpoint.terminal === null && checkpoint.semanticResult === null && object(checkpoint.goal).status !== "active";
    if (identity.runId !== run.id || identity.companyId !== run.companyId || identity.agentId !== run.agentId
      || identity.issueId !== run.nativeIssueId || identity.sessionId !== run.nativeSessionId
      || checkpoint.cursor !== null || !idle || (!bootstrap && checkpoint.driverKind !== "pi_rpc")) return false;
  }
  if (owner && (!["observed", "terminal_failure"].includes(owner.phase) || owner.attempt !== 0
    || owner.controllerBootId !== null || owner.controllerPid !== null || owner.leaseOwner !== null
    || owner.leaseExpiresAt !== null || owner.resultId !== null)) return false;
  const [evidence] = await db.select({
    allocation: sql<boolean>`exists (select 1 from ${environmentLeases} lease
      where lease.company_id = ${run.companyId} and lease.heartbeat_run_id = ${run.id}
        and lease.provider_lease_id is not null)`,
    checkpoint: sql<boolean>`exists (select 1 from ${nativeRunnerCheckpoints} checkpoint
      where checkpoint.company_id = ${run.companyId} and checkpoint.run_id = ${run.id})`,
    launched: sql<boolean>`exists (select 1 from ${heartbeatRunEvents} event
      where event.company_id = ${run.companyId} and event.run_id = ${run.id} and event.event_type = 'native.process_started')`,
    inheritedProcess: sql<boolean>`exists (select 1 from ${heartbeatRuns} prior
      join ${nativeRunFinalizations} finalization on finalization.company_id = prior.company_id and finalization.run_id = prior.id
      join ${heartbeatRuns} current on current.id = ${run.id} and current.company_id = prior.company_id
      where prior.id::text = ${run.runnerProfileJson?.inheritedProcessIdentityRunId ?? null}
        and prior.id <> ${run.id} and prior.company_id = ${run.companyId} and prior.agent_id = ${run.agentId}
        and prior.native_issue_id = ${run.nativeIssueId} and prior.native_session_id = ${run.nativeSessionId}
        and prior.created_at < (select created_at from ${heartbeatRuns} where id = ${run.id} and company_id = ${run.companyId})
        and prior.status = 'succeeded' and finalization.phase = 'committed' and finalization.result_id is not null
        and prior.process_pid is not distinct from current.process_pid
        and prior.process_group_id is not distinct from current.process_group_id
        and prior.process_started_at is not distinct from current.process_started_at)`,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id)));
  if (!evidence || evidence.allocation || evidence.checkpoint || evidence.launched) return false;
  if ((run.processPid !== null || run.processGroupId !== null || run.processStartedAt !== null) && !evidence.inheritedProcess) return false;
  if (await hasNativeExecutionStartEvidence(db, run)) return false;
  return provesNoNativeRunProviderWork(db, { companyId: run.companyId, runId: run.id });
}

/** Never probe the successor's box. Resolve the predecessor's exact saved lease
 * and cwd, and execute read-only marker/process checks there, without acquire,
 * resume, close, or fallback to a replacement allocation. */
async function predecessorGenerationLost(db: ProofDb, run: Predecessor, runtime?: FailedNativePredecessorProbe): Promise<boolean> {
  if (!runtime || !run.nativeSessionId || !run.runnerInstanceId || !run.nativeIssueId) return false;
  const leases = await db.select({ lease: environmentLeases, environment: environments }).from(environmentLeases)
    .innerJoin(environments, eq(environments.id, environmentLeases.environmentId)).where(and(
      eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
      eq(environmentLeases.issueId, run.nativeIssueId)));
  if (leases.length !== 1) return false;
  const { lease, environment } = leases[0]!;
  const remoteCwd = lease.metadata?.remoteCwd;
  if (environment.driver !== "sandbox" || !lease.providerLeaseId || typeof remoteCwd !== "string" || !remoteCwd.startsWith("/")) return false;
  try {
    const { remoteRunnerGenerationLost } = await import("./native-session-executor.js");
    const runner = { execute: request => runtime.execute({ ...request,
      environment: environment as EnvironmentDriverExecuteInput["environment"],
      lease: lease as EnvironmentDriverExecuteInput["lease"] }) } as CommandManagedRuntimeRunner;
    return await remoteRunnerGenerationLost({ runner, remoteCwd,
      identity: { runnerInstanceId: run.runnerInstanceId, normalizedSessionId: run.nativeSessionId } });
  } catch { return false; }
}

async function terminalCompleteWithoutExecutionStart(db: ProofDb, run: Predecessor): Promise<boolean> {
  // Absence of start telemetry cannot contradict a persisted process identity.
  if (!run.nativeSessionId || run.processPid !== null || run.processGroupId !== null || run.processStartedAt !== null) return false;
  const [evidence] = await db.select({
    measured: sql<boolean>`exists (select 1 from ${heartbeatRunEvents} event where event.company_id = ${run.companyId}
      and event.run_id = ${run.id} and event.event_type = 'lifecycle' and event.message = 'task.run.measured'
      and event.source_event_id is null and event.source_instance_id is null)`,
    checkpoint: sql<boolean>`exists (select 1 from ${nativeRunnerCheckpoints} checkpoint
      where checkpoint.company_id = ${run.companyId} and checkpoint.run_id = ${run.id})`,
    result: sql<boolean>`exists (select 1 from ${nativeRunResults} result
      where result.company_id = ${run.companyId} and result.run_id = ${run.id})`,
    finalizedResult: nativeRunFinalizations.resultId,
  }).from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id)));
  if (!evidence?.measured || evidence.checkpoint || evidence.result || evidence.finalizedResult !== null) return false;
  // P2 invariant: native-session-executor's onSessionAdmission AWAITS
  // appendHeartbeatRunEvent(PROCESS_START_REQUESTED), and executeNativeSession
  // (packages/paperclip-runner/src/native-session-runtime.ts) AWAITS that
  // admission before ANY attach/open/spawn. task.run.measured closes the log;
  // absence in a truncated log is NOT proof. Do not filter controller generation:
  // an earlier run carried into this native session can own the same process.
  if (await hasNativeExecutionStartEvidence(db, run)) return false;
  const carriedRuns = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
    processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId,
    processStartedAt: heartbeatRuns.processStartedAt }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId), ne(heartbeatRuns.id, run.id),
    eq(heartbeatRuns.nativeIssueId, run.nativeIssueId!), eq(heartbeatRuns.nativeSessionId, run.nativeSessionId),
    // Compare in Postgres: a JS Date truncates microseconds and can exclude the
    // predecessor's own row (or an earlier carried run in that millisecond).
    sql`${heartbeatRuns.createdAt} <= (select created_at from ${heartbeatRuns} where id = ${run.id} and company_id = ${run.companyId})`));
  for (const carried of carriedRuns) {
    if (carried.processPid !== null || carried.processGroupId !== null || carried.processStartedAt !== null
      || await hasNativeExecutionStartEvidence(db, carried)) return false;
  }
  return await provesNoNativeRunProviderWork(db, { companyId: run.companyId, runId: run.id });
}
