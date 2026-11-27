import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolveSessionContinuity } from "./continued-session.js";
import { OWN_PROCESS_START_EVENT_TYPES } from "../native-process-start-events.js";
import { and, desc, eq, exists, inArray, isNotNull, ne, not, notInArray, or, sql } from "drizzle-orm";
import {
  heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, nativeRunnerCheckpoints, nativeRunResults, type Db,
} from "@paperclipai/db";
import type {
  NativeExecutionInput,
  PersistedNativeSession,
} from "../../vendor/paperclip-runner/index.js";
import { canonicalNativeRuntimeContextDigest, parseNativeExecutionInput, type NativeRuntimeContextSnapshot } from "../../vendor/paperclip-runner/index.js";

export type NativeToolExecutionTargetKind = "local" | "remote";

/** Fence live ACPX owners when shared runtime semantics change, even if the
 * underlying native executable/profile did not change. Undefined preserves
 * the existing configuration digest for other provider transports.
 */
export function nativeRuntimeContractForProvider(
  provider: NativeExecutionInput["provider"],
): string | undefined {
  return provider.kind === "acpx" ? "paperclip.acpx-runtime-contract.v1" : undefined;
}

/**
 * Persisted provider threads retain their dynamic-tool declarations. This
 * fingerprint is part of checkpoint compatibility and must change whenever
 * the server-authorized native tool definitions or advertisement policy
 * changes. The execution target remains part of compatibility because local and
 * remote files use different server-bound readers.
 */
export type NativeToolContractVersion = "v19" | "v20";

// Retained provider threads keep the catalog they received at thread/start.
// Keep the previous policy executable: target/provider hashes are never pins.
export const NATIVE_TOOL_ADVERTISEMENT_POLICY_V19 = {
  readCurrentWakeComments: "always_advertised_binding_gated.v2",
  historicalChatAttachments: "always_advertised_conversation_binding_gated.v1",
  registerDeliverable: "verified_local_or_remote_workspace.v2",
  generateImage: "codex_openai_api_key_connection_server_key.v1",
  readChatAttachment: "always_advertised_run_scope_local_staging.v2",
  structuredHumanInput: "always_advertised_run_issue_agent_binding_gated_current_task_description.v2",
  semanticCompletion: "finish_accessible_deliverable_evidence.v4",
  opencodeAssignedMcpTools: "server_gateway_prp_on_demand_exact_names.v2",
  connectorTools: "assigned_resources_and_pinned_skill_bundle.v1",
  chatTaskTools: "durable_task_binding_and_accepted_origin.v1",
  githubResponses: "bound_working_comment_progress_and_final.v1",
  githubInstructionSkills: "trusted_configuration_native_selection.v1",
  assignedMcpTools: "codex_server_gateway_prp_relay.v1",
} as const;

export function nativeToolContractVersionForProfile(
  profile: unknown,
  target: NativeToolExecutionTargetKind,
  provider?: NativeExecutionInput["provider"]["kind"],
): NativeToolContractVersion {
  return record(profile).nativeToolContractFingerprint === nativeToolContractFingerprintForTarget(target, provider, "v19")
    ? "v19" : "v20";
}

export function nativeToolContractFingerprintForTarget(
  executionTargetKind: NativeToolExecutionTargetKind,
  providerKind?: NativeExecutionInput["provider"]["kind"],
  version: NativeToolContractVersion = "v20",
): string {
  const { readCurrentWakeComments, ...otherV19Policies } = NATIVE_TOOL_ADVERTISEMENT_POLICY_V19;
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        schema: `paperclip.native-tool-contract.${version}`,
        executionTargetKind,
        advertisementPolicy: {
          // Direct provider threads retain declarations from thread/start.
          // Keep this explicit so changing a tool from conditional to stable
          // advertisement rotates checkpoints even when its schema is unchanged.
          readCurrentWakeComments,
          ...(version === "v20" ? { readSavedAutomaticWakes: "always_advertised_active_run_paged_untrusted_data.v1" } : {}),
          ...otherV19Policies,
          // Undefined is omitted by JSON.stringify, preserving the deployed
          // property order and the provider-specific v19/v20 fingerprints.
          opencodeAssignedMcpTools: providerKind === "opencode"
            ? NATIVE_TOOL_ADVERTISEMENT_POLICY_V19.opencodeAssignedMcpTools : undefined,
        },
        tools: [
          { name: "register_deliverable", version: 2 },
          { name: "generate_image", semanticContract: "paperclip.server-openai-image-generation.v1", version: 1 },
          {
            name: "read_current_wake_comments",
            semanticContract: "paperclip.server-current-wake-comments.v1",
            version: 1,
          },
          {
            name: "list_chat_attachments",
            semanticContract: "paperclip.server-chat-attachment-reuse.v1",
            version: 1,
          },
          {
            name: "reuse_chat_attachment",
            semanticContract: "paperclip.server-chat-attachment-reuse.v1",
            version: 1,
          },
          {
            name: "read_chat_attachment",
            semanticContract: "paperclip.server-chat-attachment-read.v1",
            version: 1,
          },
          { name: "request_human_input", version: 1 },
          ...(version === "v20" ? [{ name: "read_saved_automatic_wakes", version: 1 }] : []),
        ],
      }),
    )
    .digest("hex")}`;
}

/** Default local-target fingerprint retained for callers and test fixtures. */
export const NATIVE_TOOL_CONTRACT_FINGERPRINT =
  nativeToolContractFingerprintForTarget("local");

/** The runner proved that this run's saved provider session cannot be
 * restored by the current runner build. Its checkpoint is not resumable. */
export const NATIVE_PROVIDER_STATE_INCOMPATIBLE = "native_provider_state_incompatible";
/**
 * `runnerProfileJson` key on a run whose result was accepted but whose
 * provider state backup was not saved. Its per-turn sandbox is released after
 * the run, so that backup was the only copy of the provider session. The next
 * run on the session starts a fresh provider session instead of resuming.
 * Records without the key, including every record written before it existed,
 * keep the ordinary resume path.
 */
export const NATIVE_PROVIDER_STATE_UNSAVED_KEY = "nativeProviderStateUnsaved";

export function isNativeProviderStateUnsaved(profile: unknown): boolean {
  return record(record(profile)[NATIVE_PROVIDER_STATE_UNSAVED_KEY]).code === NATIVE_PROVIDER_STATE_INCOMPATIBLE;
}
/** The saved session owned a side-effecting call without a delivered result.
 * Recovery requires an explicit reconciliation of that action. */
export const NATIVE_PROVIDER_SIDE_EFFECT_PENDING = "native_provider_side_effect_pending";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function isNativeSessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

const LEGACY_RETRY_SOURCE_TERMINAL_STATUSES = new Set([
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
]);

export type NativeSessionBootstrapState = {
  processPid: number | null;
  processGroupId: number | null;
  processStartedAt: Date | null;
  runnerProfileJson: unknown;
};

export function isUnusedNativeSessionBootstrap(
  run: NativeSessionBootstrapState,
  hasProviderEvents: boolean,
): boolean {
  return (
    run.processPid === null &&
    run.processGroupId === null &&
    run.processStartedAt === null &&
    record(run.runnerProfileJson).sessionCheckpoint == null &&
    !hasProviderEvents
  );
}

/** Newest-first rows for one exact task/session; never skip provider progress. */
export function selectNativeSessionResumeRun<
  T extends NativeSessionBootstrapState & {
    id: string;
    companyId: string;
    agentId: string;
    nativeIssueId: string | null;
    nativeSessionId: string | null;
    runtimeMode: string | null;
    status: string;
    createdAt: Date;
  },
>(input: {
  runs: readonly T[];
  companyId: string;
  agentId: string;
  issueId: string;
  normalizedSessionId: string;
  currentRunId: string;
  beforeCreatedAt: Date;
  providerEvidenceRunIds: ReadonlySet<string>;
}): T | null {
  for (const run of input.runs) {
    if (
      run.id === input.currentRunId ||
      run.companyId !== input.companyId ||
      run.agentId !== input.agentId ||
      run.nativeIssueId !== input.issueId ||
      run.nativeSessionId !== input.normalizedSessionId
    )
      continue;
    if (
      run.runtimeMode !== "native" ||
      !LEGACY_RETRY_SOURCE_TERMINAL_STATUSES.has(run.status)
    )
      return null;
    // Even an incompatible checkpoint is a progress barrier. The caller must
    // reject it or start a fresh session, not fall back to an older checkpoint.
    if (record(run.runnerProfileJson).sessionCheckpoint != null)
      return run.createdAt > input.beforeCreatedAt ? null : run;
    if (
      !isUnusedNativeSessionBootstrap(
        run,
        input.providerEvidenceRunIds.has(run.id),
      )
    )
      return null;
  }
  return null;
}

export const NATIVE_SESSION_PROVIDER_EVENT_TYPES = [
  "harness.ready",
  "session.started",
  "session.resumed",
  "session.updated",
  "turn.started",
  "provider.event",
  "provider.rpc_result",
];

export async function nativeSessionProviderEvidence(
  db: Pick<Db, "select">,
  runIds: string[],
): Promise<Set<string>> {
  if (!runIds.length) return new Set();
  const rows = await db
    .select({ runId: heartbeatRunEvents.runId })
    .from(heartbeatRunEvents)
    .where(
      and(
        inArray(heartbeatRunEvents.runId, runIds),
        inArray(heartbeatRunEvents.eventType, NATIVE_SESSION_PROVIDER_EVENT_TYPES),
      ),
    )
    .groupBy(heartbeatRunEvents.runId);
  return new Set(rows.map((row) => row.runId));
}

type NativeSessionResumeSelection = {
  companyId: string;
  agentId: string;
  issueId: string;
  normalizedSessionId: string;
  currentRunId?: string;
  beforeCreatedAt: Date;
  /** Recovery discovery must retain an ineligible newest progress barrier. */
  includeProgressBarrier?: boolean;
};

const NATIVE_RESUME_CANDIDATE_WINDOW = 32;
const INHERITED_CHECKPOINT_SOURCE_FIELDS = ["backendKind", "driverKind", "sessionId", "providerSessionId"] as const;

export async function findNativeSessionResumeRun(db: Db, input: NativeSessionResumeSelection) {
  if (!isNativeSessionId(input.normalizedSessionId)) return null;
  const barrier = await selectNativeSessionResumeBarrier(db, input, []);
  // A failed follow-up may have started a process/controller without a turn.
  // Select its inherited source only when every skipped run has no own
  // checkpoint, result or provider progress and inherited that exact session.
  const skipped: NonNullable<typeof barrier>[] = [];
  let selected = barrier;
  while (selected && skipped.length < NATIVE_RESUME_CANDIDATE_WINDOW &&
      await isUnstartedInheritedFollowUp(db, input, selected)) {
    skipped.push(selected);
    selected = await selectNativeSessionResumeBarrier(db, input, skipped.map(run => run.id));
  }
  if (!skipped.length) return selected;
  const source = record(selected?.runnerProfileJson.sessionCheckpoint);
  const inherited = selected !== null && typeof source.sessionId === "string" && skipped.every(run => {
    const checkpoint = record(run.runnerProfileJson.sessionCheckpoint);
    return INHERITED_CHECKPOINT_SOURCE_FIELDS.every(field => checkpoint[field] === source[field]) &&
      // A staged follower may inherit a non-null committed cursor. It is not
      // new progress, but it must still be the exact source cursor.
      (checkpoint.cursor == null || isDeepStrictEqual(checkpoint.cursor, source.cursor));
  });
  return inherited ? selected : barrier;
}

/** A process/controller startup is not a committed turn. Keep all provider
 * progress fences and prove no controller checkpoint parts belong to this run. */
async function isUnstartedInheritedFollowUp(
  db: Db,
  input: NativeSessionResumeSelection,
  run: { id: string; runtimeMode: string | null; status: string; processPid: number | null;
    processGroupId: number | null; processStartedAt: Date | null; runnerProfileJson: { sessionCheckpoint: unknown; nativeControllerRecovery: unknown } },
): Promise<boolean> {
  const checkpoint = record(run.runnerProfileJson.sessionCheckpoint);
  const identity = record(checkpoint.identity);
  if (run.runtimeMode !== "native" || !["failed", "cancelled"].includes(run.status) ||
      record(run.runnerProfileJson.nativeControllerRecovery).schema === "paperclip.native-controller-recovery.v1" ||
      identity.companyId !== input.companyId || identity.agentId !== input.agentId || identity.issueId !== input.issueId ||
      identity.sessionId !== input.normalizedSessionId || typeof identity.runId !== "string" ||
      checkpoint.activeTurnId != null || (Array.isArray(checkpoint.pendingRuntimeRequests) && checkpoint.pendingRuntimeRequests.length > 0)) return false;
  return nativeRunHasNoProviderWork(db, input, run.id, { allowDispatchHandoff: true, allowProcessStartup: true });
}

/** Shared negative-work proof for inherited-source selection and the preparation
 * owner's Stop settlement. A cancellation label or lease release alone is not proof.
 * Only source selection may allow dispatch/process/controller startup; Stop must
 * still prove no handoff or process/controller ownership. Neither may skip a turn. */
export async function nativeRunHasNoProviderWork(db: Db,
  input: Pick<NativeSessionResumeSelection, "companyId" | "agentId" | "issueId">, runId: string,
  options: { allowDispatchHandoff?: boolean; allowProcessStartup?: boolean } = {}): Promise<boolean> {
  const [evidence] = await db.select({
    processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId,
    processStartedAt: heartbeatRuns.processStartedAt, profile: heartbeatRuns.runnerProfileJson,
    dispatchHandedOffAt: sql<unknown>`${heartbeatRuns.usageJson}#>'{budgetDispatch,handedOffAt}'`,
    executionRecovery: sql<unknown>`${heartbeatRuns.resultJson}->'executionRecovery'`,
    phase: nativeRunFinalizations.phase,
    resultId: nativeRunFinalizations.resultId,
    leaseOwner: nativeRunFinalizations.leaseOwner,
    controllerPid: nativeRunFinalizations.controllerPid,
    processStart: sql<boolean>`exists (select 1 from ${heartbeatRunEvents}
      where ${heartbeatRunEvents.companyId} = ${heartbeatRuns.companyId} and ${heartbeatRunEvents.runId} = ${heartbeatRuns.id}
        and ${heartbeatRunEvents.eventType} in (${sql.join(OWN_PROCESS_START_EVENT_TYPES.map(type => sql`${type}`), sql`, `)}))`,
    committedTurn: sql<boolean>`exists (select 1 from ${heartbeatRunEvents}
      where ${heartbeatRunEvents.companyId} = ${heartbeatRuns.companyId} and ${heartbeatRunEvents.runId} = ${heartbeatRuns.id}
        and (${heartbeatRunEvents.eventType} in ('turn.started', 'turn.completed') or ${heartbeatRunEvents.eventType} like 'item.%'))`,
    controllerCheckpoint: sql<boolean>`exists (select 1 from ${nativeRunnerCheckpoints}
      where ${nativeRunnerCheckpoints.companyId} = ${heartbeatRuns.companyId} and ${nativeRunnerCheckpoints.runId} = ${heartbeatRuns.id})`,
    result: sql<boolean>`exists (select 1 from ${nativeRunResults}
      where ${nativeRunResults.companyId} = ${heartbeatRuns.companyId} and ${nativeRunResults.runId} = ${heartbeatRuns.id})`,
  }).from(heartbeatRuns).leftJoin(nativeRunFinalizations, and(
    eq(nativeRunFinalizations.runId, heartbeatRuns.id), eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId),
    eq(nativeRunFinalizations.issueId, input.issueId),
  )).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId),
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${input.issueId}`));
  // Stop before dispatch may have no coordinator and no executionRecovery
  // record at all. Absence of actual work, not the failure label, is the proof.
  const recovery = record(evidence?.executionRecovery);
  const checkpoint = record(evidence?.profile?.sessionCheckpoint);
  return Boolean(evidence && (options.allowProcessStartup || (evidence.processPid === null && evidence.processGroupId === null &&
    evidence.processStartedAt === null && evidence.leaseOwner === null && evidence.controllerPid === null && !evidence.processStart)) &&
    (options.allowDispatchHandoff || evidence.dispatchHandedOffAt == null) &&
    record(evidence.profile?.nativeControllerRecovery).schema !== "paperclip.native-controller-recovery.v1" &&
    checkpoint.activeTurnId == null &&
    (!Array.isArray(checkpoint.pendingRuntimeRequests) || checkpoint.pendingRuntimeRequests.length === 0) &&
    recovery.providerWorkStarted !== true &&
    (evidence.phase === null || ["observed", "terminal_failure"].includes(evidence.phase)) &&
    evidence.resultId === null && !evidence.committedTurn && !evidence.controllerCheckpoint && !evidence.result &&
    !(await nativeSessionProviderEvidence(db, [runId])).has(runId));
}

async function selectNativeSessionResumeBarrier(db: Db, input: NativeSessionResumeSelection, skippedRunIds: string[]) {
  const candidates = db.$with("native_resume_candidates").as(db
    .select({
      id: heartbeatRuns.id,
      runtimeMode: heartbeatRuns.runtimeMode,
      status: heartbeatRuns.status,
      createdAt: heartbeatRuns.createdAt,
      processPid: heartbeatRuns.processPid,
      processGroupId: heartbeatRuns.processGroupId,
      processStartedAt: heartbeatRuns.processStartedAt,
      hasCheckpoint: sql<boolean>`coalesce(${heartbeatRuns.runnerProfileJson}->'sessionCheckpoint' <> 'null'::jsonb, false)`.as("has_checkpoint"),
    })
    .from(heartbeatRuns)
    .where(
      and(
        input.currentRunId ? ne(heartbeatRuns.id, input.currentRunId) : undefined,
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.nativeIssueId, input.issueId),
        eq(heartbeatRuns.nativeSessionId, input.normalizedSessionId),
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
    .limit(NATIVE_RESUME_CANDIDATE_WINDOW));
  const terminalStatuses = [...LEGACY_RETRY_SOURCE_TERMINAL_STATUSES];
  const barrier = db.$with("native_resume_barrier").as(db
    .select()
    .from(candidates)
    .where(and(skippedRunIds.length ? notInArray(candidates.id, skippedRunIds) : undefined, or(
      ne(candidates.runtimeMode, "native"),
      not(inArray(candidates.status, terminalStatuses)),
      candidates.hasCheckpoint,
      isNotNull(candidates.processPid),
      isNotNull(candidates.processGroupId),
      isNotNull(candidates.processStartedAt),
      exists(db.select({ runId: heartbeatRunEvents.runId })
        .from(heartbeatRunEvents)
        .where(and(
          eq(heartbeatRunEvents.runId, candidates.id),
          inArray(heartbeatRunEvents.eventType, NATIVE_SESSION_PROVIDER_EVENT_TYPES),
        ))),
    )))
    .orderBy(desc(candidates.createdAt), desc(candidates.id))
    .limit(1));
  const [run] = await db.with(candidates, barrier)
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      runnerInstanceId: heartbeatRuns.runnerInstanceId,
      nativeSessionId: heartbeatRuns.nativeSessionId,
      nativeIssueId: heartbeatRuns.nativeIssueId,
      runtimeMode: heartbeatRuns.runtimeMode,
      status: heartbeatRuns.status,
      errorCode: heartbeatRuns.errorCode,
      createdAt: heartbeatRuns.createdAt,
      processPid: heartbeatRuns.processPid,
      processGroupId: heartbeatRuns.processGroupId,
      processStartedAt: heartbeatRuns.processStartedAt,
      runnerProfileJson: sql<{
        nativeToolContractFingerprint: unknown;
        nativeExecutionInput: unknown;
        sessionCheckpoint: unknown;
        nativeControllerRecovery: unknown;
        nativeProviderStateUnsaved?: unknown;
      }>`jsonb_build_object(
        'nativeToolContractFingerprint', ${heartbeatRuns.runnerProfileJson}->'nativeToolContractFingerprint',
        'nativeExecutionInput', ${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput',
        'sessionCheckpoint', ${heartbeatRuns.runnerProfileJson}->'sessionCheckpoint',
        'nativeControllerRecovery', ${heartbeatRuns.runnerProfileJson}->'nativeControllerRecovery',
        '${sql.raw(NATIVE_PROVIDER_STATE_UNSAVED_KEY)}', ${heartbeatRuns.runnerProfileJson}->'${sql.raw(NATIVE_PROVIDER_STATE_UNSAVED_KEY)}'
      )`,
      contextSnapshot: sql<{
        paperclipWake: unknown;
        paperclipIssue: unknown;
      }>`jsonb_build_object(
        'paperclipWake', ${heartbeatRuns.contextSnapshot}->'paperclipWake',
        'paperclipIssue', case when jsonb_typeof(${heartbeatRuns.contextSnapshot}->'paperclipIssue') = 'object'
          then (select coalesce(jsonb_object_agg(brief.key, brief.value), '{}'::jsonb)
            from jsonb_each(${heartbeatRuns.contextSnapshot}->'paperclipIssue') as brief
            where brief.key in ('id', 'title', 'description')) else ${heartbeatRuns.contextSnapshot}->'paperclipIssue' end
      )`,
    })
    .from(heartbeatRuns)
    .innerJoin(barrier, eq(heartbeatRuns.id, barrier.id))
    .where(and(
      ...(input.includeProgressBarrier ? [] : [
        eq(barrier.runtimeMode, "native"),
        inArray(barrier.status, terminalStatuses),
        eq(barrier.hasCheckpoint, true),
        sql`date_trunc('milliseconds', ${barrier.createdAt}) <= ${input.beforeCreatedAt.toISOString()}::timestamptz`,
      ]),
      sql`${heartbeatRuns.companyId}::text = ${input.companyId}`,
      sql`${heartbeatRuns.agentId}::text = ${input.agentId}`,
      sql`${heartbeatRuns.nativeIssueId}::text = ${input.issueId}`,
      sql`${heartbeatRuns.nativeSessionId}::text = ${input.normalizedSessionId}`,
    ));
  return run ?? null;
}

/** A preassigned session id may rotate only before immutable native admission. */
export function nativeSessionIdForBootstrapPersistence(input: {
  run: NativeSessionBootstrapState & { nativeSessionId: string | null };
  selectedSessionId: string;
  hasProviderEvents: boolean;
}): string {
  if (input.run.nativeSessionId === input.selectedSessionId)
    return input.selectedSessionId;
  if (
    record(input.run.runnerProfileJson).nativeExecutionInput !== undefined ||
    !isUnusedNativeSessionBootstrap(input.run, input.hasProviderEvents)
  ) {
    throw new Error("native_session_bootstrap_identity_conflict");
  }
  return input.selectedSessionId;
}

/** Caller holds the run row lock; recheck authority after waiting for that lock. */
export async function prepareNativeSessionBootstrapPersistence(
  db: Pick<Db, "select">,
  input: {
    run: NativeSessionBootstrapState & {
      id: string;
      nativeSessionId: string | null;
    };
    selectedSessionId: string;
    execution: NativeExecutionInput;
    restoringCheckpoint: boolean;
  },
) {
  const hasProviderEvents = (
    await nativeSessionProviderEvidence(db, [input.run.id])
  ).has(input.run.id);
  const profile = record(input.run.runnerProfileJson);
  if (
    profile.nativeExecutionInput !== undefined &&
    !isDeepStrictEqual(
      parseNativeExecutionInput(profile.nativeExecutionInput),
      input.execution,
    )
  ) {
    throw new Error("native_execution_input_persisted_binding_mismatch");
  }
  if (
    input.restoringCheckpoint &&
    !isUnusedNativeSessionBootstrap(input.run, hasProviderEvents)
  ) {
    throw new Error("native_session_bootstrap_identity_conflict");
  }
  return nativeSessionIdForBootstrapPersistence({
    ...input,
    hasProviderEvents,
  });
}

/**
 * Legacy compatibility is deliberately narrower than ordinary task-session
 * continuation: only a replacement row that never acquired any native process
 * or provider authority may be rebound to a terminal native source. The exact
 * checkpoint/session/workspace/provider binding is validated separately by
 * rebindNativeSessionCheckpoint.
 */
export function isUnusedLegacyNativeRetryReplacement(input: {
  replacement: {
    processPid: number | null;
    processGroupId: number | null;
    processStartedAt: Date | null;
    runnerProfileJson: unknown;
  };
  source: {
    runtimeMode: string | null;
    status: string;
    nativeSessionId: string | null;
  } | null;
  hasProviderEvents: boolean;
}): boolean {
  return Boolean(
    input.source?.runtimeMode === "native" &&
    LEGACY_RETRY_SOURCE_TERMINAL_STATUSES.has(input.source.status) &&
    isNativeSessionId(input.source.nativeSessionId) &&
    isUnusedNativeSessionBootstrap(input.replacement, input.hasProviderEvents),
  );
}

export function nativeSessionProvidersMatch(
  previous: NativeExecutionInput["provider"],
  current: NativeExecutionInput["provider"],
): boolean {
  if (previous.kind === "pi_rpc" && current.kind === "pi_rpc" &&
      resolveSessionContinuity(previous.kind, previous.sessionContinuity) === "continuous" &&
      resolveSessionContinuity(current.kind, current.sessionContinuity) === "continuous")
    return isDeepStrictEqual({ ...previous, model: undefined, piRpcThinkingLevel: undefined, sessionContinuity: undefined },
      { ...current, model: undefined, piRpcThinkingLevel: undefined, sessionContinuity: undefined });
  return JSON.stringify(previous) === JSON.stringify(current);
}

function nativeCheckpointWorkspaceScope(
  execution: NativeExecutionInput,
  owningRunId: string,
) {
  // Projectless work uses each heartbeat run id as a placeholder workspace id.
  // Continuity is safe only when both sides independently prove that shape and
  // their complete immutable workspace descriptors match. A real managed
  // workspace instead binds continuity to its durable workspace row id.
  return execution.binding.executionWorkspaceId === owningRunId
    ? {
        kind: "transient" as const,
        cwd: execution.workspace.cwd,
        repoUrl: execution.workspace.repoUrl,
        repoRef: execution.workspace.repoRef,
        branchName: execution.workspace.branchName,
      }
    : {
        kind: "managed" as const,
        id: execution.binding.executionWorkspaceId,
      };
}

function sameWorkspaceScope(input: {
  previousExecution: NativeExecutionInput;
  previousRunId: string;
  currentExecution: NativeExecutionInput;
}): boolean {
  return (
    JSON.stringify(
      nativeCheckpointWorkspaceScope(
        input.previousExecution,
        input.previousRunId,
      ),
    ) ===
    JSON.stringify(
      nativeCheckpointWorkspaceScope(
        input.currentExecution,
        input.currentExecution.binding.runId,
      ),
    )
  );
}

/** A resume delta is valid only if the provider checkpoint really can be used. */
export function buildNativeExecutionWithCheckpoint(input: {
  previousRun:
    Parameters<typeof rebindNativeSessionCheckpoint>[0]["previousRun"] | null;
  normalizedSessionId: string;
  sessionContinuity?: unknown;
  executionTargetKind?: NativeToolExecutionTargetKind;
  toolRefreshOnResume?: boolean;
  refreshTools?: boolean;
  buildExecution: (options: {
    normalizedSessionId: string;
    resumedSession: boolean;
    nativeToolContractVersion: NativeToolContractVersion;
  }) => NativeExecutionInput;
}): {
  execution: NativeExecutionInput;
  checkpoint: PersistedNativeSession | null;
  normalizedSessionId: string;
  nativeToolContractVersion: NativeToolContractVersion;
} {
  const previousProfile = record(input.previousRun?.runnerProfileJson);
  const previousProvider = record(record(previousProfile.nativeExecutionInput).provider).kind as NativeExecutionInput["provider"]["kind"] | undefined;
  const nativeToolContractVersion = nativeToolContractVersionForProfile(previousProfile, input.executionTargetKind ?? "local", previousProvider);
  const execution = input.buildExecution({
    normalizedSessionId: input.normalizedSessionId,
    resumedSession: input.previousRun !== null,
    nativeToolContractVersion,
  });
  // A presentation-only upgrade must not rotate a healthy provider session or
  // lose a durable goal. Keep its v4/v5 format until that session naturally ends.
  // All ordinary identity, workspace, provider, tool and recovery checks still apply.
  if (input.previousRun && (execution.schema === "paperclip.native-execution-input.v4" || execution.schema === "paperclip.native-execution-input.v5")) {
    const previousSchema = record(record(input.previousRun.runnerProfileJson).nativeExecutionInput).schema;
    if ((previousSchema === "paperclip.native-execution-input.v4" || previousSchema === "paperclip.native-execution-input.v5") && previousSchema !== execution.schema) {
      const { completionSources: _sources, ...common } = execution as typeof execution & { completionSources?: unknown };
      const retainedFormat = parseNativeExecutionInput({ ...common, schema: previousSchema });
      const retainedCheckpoint = rebindNativeSessionCheckpoint({
        previousRun: input.previousRun,
        currentExecution: retainedFormat,
        sessionContinuity: input.sessionContinuity,
        executionTargetKind: input.executionTargetKind,
        toolRefreshOnResume: input.toolRefreshOnResume,
        refreshTools: input.refreshTools,
      });
      if (retainedCheckpoint) return { execution: retainedFormat, checkpoint: retainedCheckpoint, normalizedSessionId: input.normalizedSessionId, nativeToolContractVersion };
    }
  }
  const checkpoint = input.previousRun
    ? rebindNativeSessionCheckpoint({
        previousRun: input.previousRun,
        currentExecution: execution,
        sessionContinuity: input.sessionContinuity,
        executionTargetKind: input.executionTargetKind,
        toolRefreshOnResume: input.toolRefreshOnResume,
        refreshTools: input.refreshTools,
      })
    : null;
  if (checkpoint)
    return {
      execution,
      checkpoint,
      normalizedSessionId: input.normalizedSessionId,
      nativeToolContractVersion,
    };
  // Rebuild both task context and wake instructions. Merely rotating the ID
  // leaves a fresh provider with a compact delta and missing task context.
  const normalizedSessionId = randomUUID();
  return {
    execution: input.buildExecution({
      normalizedSessionId,
      resumedSession: false,
      nativeToolContractVersion: "v20",
    }),
    checkpoint: null,
    normalizedSessionId,
    nativeToolContractVersion: "v20",
  };
}

export function nativeRuntimeContextsMatch(
  previous: NativeRuntimeContextSnapshot,
  current: NativeRuntimeContextSnapshot,
  toolRefreshOnResume?: boolean,
  instructionRefreshOnResume = false,
  packPromptRefreshOnResume = false,
  skillRefreshOnResume = false,
): boolean {
  return previous.aggregateDigest === current.aggregateDigest ||
    ((instructionRefreshOnResume || packPromptRefreshOnResume || skillRefreshOnResume || toolRefreshOnResume === true) && canonicalNativeRuntimeContextDigest({
      ...previous,
      ...(instructionRefreshOnResume ? { instructions: current.instructions } : {}),
      // Pack-owned execution framing may advance; account instructions and
      // tool assignments are still retained-session compatibility inputs.
      ...(packPromptRefreshOnResume ? { prompt: current.prompt } : {}),
      // A continuous Pi session takes a new skill list at its next launch.
      ...(skillRefreshOnResume ? { skills: current.skills } : {}),
      ...(toolRefreshOnResume === true ? { mcp: current.mcp } : {}),
    }) === current.aggregateDigest);
}

/**
 * Rebind a completed prior run's provider checkpoint to a new heartbeat run.
 * The provider/driver session identity is retained, while every per-turn and
 * per-event field is reset so the new run starts one clean turn via resume.
 */
export function rebindNativeSessionCheckpoint(input: {
  previousRun: {
    id: string;
    companyId: string;
    agentId: string;
    nativeSessionId: string | null;
    errorCode?: string | null;
    runnerProfileJson: unknown;
  };
  currentExecution: NativeExecutionInput;
  sessionContinuity?: unknown;
  executionTargetKind?: NativeToolExecutionTargetKind;
  toolRefreshOnResume?: boolean;
  refreshTools?: boolean;
}): PersistedNativeSession | null {
  if (input.refreshTools && input.toolRefreshOnResume !== true) return null;
  // The source is still the progress barrier. Its provider session cannot be
  // restored, so the next run starts a fresh session in the same workspace.
  if (input.previousRun.errorCode === NATIVE_PROVIDER_STATE_INCOMPATIBLE) return null;
  // The saved session still holds the unsettled call and refuses attachment.
  // Generic Retry is blocked until an operator reconciles that action; the
  // reconciled continuation then starts a fresh session in the same workspace.
  if (input.previousRun.errorCode === NATIVE_PROVIDER_SIDE_EFFECT_PENDING) return null;
  const previousProfile = record(input.previousRun.runnerProfileJson);
  // The source's result was accepted, but its provider state was never saved
  // and its sandbox is gone. Resuming would only fail, so start fresh now.
  if (isNativeProviderStateUnsaved(previousProfile)) return null;
  if (
    previousProfile.nativeToolContractFingerprint !==
    nativeToolContractFingerprintForTarget(input.executionTargetKind ?? "local", input.currentExecution.provider.kind) &&
    previousProfile.nativeToolContractFingerprint !==
    nativeToolContractFingerprintForTarget(input.executionTargetKind ?? "local", input.currentExecution.provider.kind, "v19")
  ) {
    return null;
  }
  const rawCheckpoint = record(previousProfile.sessionCheckpoint);
  const checkpointIdentity = record(rawCheckpoint.identity);
  const current = input.currentExecution;
  const normalizedSessionId = current.session.normalizedSessionId;
  const continuousPi = current.provider.kind === "pi_rpc" &&
    resolveSessionContinuity(current.provider.kind, current.provider.sessionContinuity) === "continuous";
  if (
    !isNativeSessionId(normalizedSessionId) ||
    input.previousRun.companyId !== current.binding.companyId ||
    input.previousRun.agentId !== current.binding.agentId ||
    input.previousRun.nativeSessionId !== normalizedSessionId ||
    typeof rawCheckpoint.sessionId !== "string" ||
    checkpointIdentity.runId !== input.previousRun.id ||
    checkpointIdentity.companyId !== current.binding.companyId ||
    checkpointIdentity.issueId !== current.binding.issueId ||
    checkpointIdentity.agentId !== current.binding.agentId ||
    checkpointIdentity.sessionId !== normalizedSessionId
  )
    return null;

  let previousExecution: NativeExecutionInput;
  try {
    previousExecution = parseNativeExecutionInput(
      previousProfile.nativeExecutionInput,
    );
  } catch {
    return null;
  }
  const localContinuousPi = current.provider.kind === "pi_rpc" &&
    resolveSessionContinuity(current.provider.kind, input.sessionContinuity) === "continuous" &&
    (input.executionTargetKind ?? "local") === "local";
  const workspaceChanged = !sameWorkspaceScope({ previousExecution, previousRunId: input.previousRun.id, currentExecution: current }) ||
    (localContinuousPi && previousExecution.workspace.cwd !== current.workspace.cwd);
  const workspaceContinuation = workspaceChanged && localContinuousPi &&
    (!rawCheckpoint.goal || record(rawCheckpoint.goal).status === "complete");
  if (
    previousExecution.binding.runId !== input.previousRun.id ||
    previousExecution.binding.companyId !== current.binding.companyId ||
    previousExecution.binding.issueId !== current.binding.issueId ||
    previousExecution.binding.agentId !== current.binding.agentId ||
    previousExecution.session.normalizedSessionId !== normalizedSessionId ||
    previousExecution.session.driverKind !== current.session.driverKind ||
    (workspaceChanged && !workspaceContinuation) ||
    previousExecution.task.workMode !== current.task.workMode ||
    ("executionMode" in previousExecution
      ? previousExecution.executionMode
      : "default") !==
      ("executionMode" in current ? current.executionMode : "default") ||
    !nativeSessionProvidersMatch(previousExecution.provider, current.provider) ||
    previousExecution.schema !== current.schema ||
    ("homeMode" in previousExecution ? previousExecution.homeMode : "isolated") !== ("homeMode" in current ? current.homeMode : "isolated") ||
    ("runtimeContext" in previousExecution && "runtimeContext" in current &&
      !nativeRuntimeContextsMatch(previousExecution.runtimeContext, current.runtimeContext, input.toolRefreshOnResume, continuousPi, continuousPi, continuousPi))
  )
    return null;

  const priorSemanticResult = record(rawCheckpoint.semanticResult);
  const priorContinuation = record(priorSemanticResult.continuation);
  const rawGoal = rawCheckpoint.goal;
  const hasUnfinishedGoal =
    rawGoal !== null &&
    rawGoal !== undefined &&
    record(rawGoal).status !== "complete";
  const providerRecoveryPolicy = hasUnfinishedGoal
    ? ("same_session_only" as const)
    : !input.refreshTools && priorSemanticResult.reportedWorkDisposition === "yielded" &&
        priorContinuation.kind === "response_wake"
      ? ("allow_replacement_after_governed_wait" as const)
      : ("allow_replacement_after_resume_failure" as const);

  return {
    ...(structuredClone(rawCheckpoint) as unknown as PersistedNativeSession),
    identity: {
      runId: current.binding.runId,
      sessionId: normalizedSessionId,
      companyId: current.binding.companyId,
      issueId: current.binding.issueId,
      agentId: current.binding.agentId,
    },
    ...(workspaceContinuation ? { workingDirectory: current.workspace.cwd ?? undefined } : {}),
    cursor: null,
    semanticResult: null,
    terminal: null,
    activeTurnId: null,
    terminalTurns: [],
    pendingRuntimeRequests: [],
    dispositionOnlyRecoveryConsumed: false,
    dispositionOnlyRecoveryTurnId: null,
    // Settlement evidence belongs to the prior heartbeat run, even when the
    // provider session is reused for the user's response.
    governedWait: undefined,
    providerRecoveryPolicy,
  };
}
