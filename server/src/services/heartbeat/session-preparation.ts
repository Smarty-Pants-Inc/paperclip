import { isNativeSessionId } from "../native-runtime/index.js";
import { and, desc, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import { agentConfigRevisions, heartbeatRunEvents, heartbeatRuns, issues, type Db, type agents, type agentTaskSessions, type projects } from "@paperclipai/db";
import type { AiConnectionBinding, AiRuntimeConnectionBinding, ExecutionContinuationEnvelope } from "@paperclipai/shared";
import { getServerAdapter } from "../../adapters/index.js";
import type { prepareManagedAiRuntime } from "../ai-connection-runtime.js";
import { aiConnectionSessionCompatibilityInputs, managedAiSessionIdentityCompatible } from "../ai-connection-session.js";
import { createNativeSessionHandoffLoader } from "../native-runtime/native-session-handoff.js";
import { decideNativeContinuation, isWarmRecoveryRefusal, resolveSessionContinuity, sessionCannotContinue } from "../native-runtime/continued-session.js";
import { isChatTask } from "../fresh-continuation-retry-fold.js";
import { issueService } from "../issues.js";
import { instanceSettingsService } from "../instance-settings.js";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { logger } from "../../middleware/logger.js";
import { keyValueRow, runLinkRow, systemNoticePresentation } from "../recovery/notice-format.js";
import { deriveTaskKey } from "./run-preparation.js";
import { queuedCommentIdsFromRunContext } from "../../lib/queued-comment-context.js";
import { agentInstructionsService } from "../agent-instructions.js";
import {
  describeSessionResetReason, shouldResetTaskSessionForWake, isCanonicalSessionIdForAdapter,
  normalizeResumeParamsForAdapter, normalizeSessionParams, requiresCanonicalSessionIds,
  truncateDisplayId, type createHeartbeatRunState, type getAdapterSessionCodec,
} from "./run-state.js";
import {
  buildEffectiveRunSessionConfigMetadata, readConfigFingerprintFromSessionParams,
  readConfiguredModelFromAdapterConfig, resolveTaskSessionConfigFreshness,
  stripPaperclipSessionMetadataFromSessionParams,
} from "./workspaces.js";
import type { HeartbeatWorkspacePreparationInput, prepareHeartbeatWorkspace } from "./workspace-preparation.js";
import type { prepareHeartbeatTaskContext } from "./task-context.js";

type RunState = ReturnType<typeof createHeartbeatRunState>;
type WorkspaceInput = HeartbeatWorkspacePreparationInput;
type PreparedWorkspace = Awaited<ReturnType<typeof prepareHeartbeatWorkspace>>;
type TaskContext = Awaited<ReturnType<typeof prepareHeartbeatTaskContext>>;
type SessionMetadataInput = Parameters<typeof buildEffectiveRunSessionConfigMetadata>[0];
type ManagedAiRuntime = Awaited<ReturnType<typeof prepareManagedAiRuntime>>;
type TaskSession = typeof agentTaskSessions.$inferSelect | null;
type SessionCodec = ReturnType<typeof getAdapterSessionCodec>;

export interface HeartbeatSessionPreparationInput {
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "createdAt">;
  agent: typeof agents.$inferSelect;
  task: {
    context: Record<string, unknown>;
    issueRef: Pick<typeof issues.$inferSelect, "id"> | null;
    issueContext: Pick<typeof issues.$inferSelect, "updatedAt"> | null;
    taskProjectContext: Pick<typeof projects.$inferSelect, "env"> | null;
    workspaceProjectContext: Pick<typeof projects.$inferSelect, "updatedAt"> | null;
    wakeCommentId: string | null;
    acceptedPlanContinuationWake: boolean;
    acceptedPlanWakeRoutingDecision: unknown;
  };
  session: {
    taskSession: TaskSession;
    taskSessionDecodedParams: Record<string, unknown> | null;
    explicitResumeSessionParams: Record<string, unknown> | null;
    explicitResumeSessionDisplayId: string | null;
    sessionCodec: SessionCodec;
  };
  config: {
    runtimeConfig: Record<string, unknown>;
    agentIdentity: { keyId: string } | undefined;
    issueAssigneeOverrides: unknown;
    originalAiIssueOverrides: unknown;
    managedAiRuntime: ManagedAiRuntime | undefined;
    aiBinding: AiConnectionBinding | undefined;
    requestedAiBinding: AiRuntimeConnectionBinding | undefined;
    secretManifest: SessionMetadataInput["secretManifest"];
    runtimeSkillEntries: SessionMetadataInput["runtimeSkills"];
    routineEnvContext: { env: unknown };
  };
  workspace: Pick<WorkspaceInput["policy"], "requestedExecutionWorkspaceMode" | "effectiveExecutionWorkspaceMode" | "projectExecutionWorkspacePolicy" | "issueExecutionWorkspaceSettings" | "executionPolicy"> & {
    requestedReusableExecutionWorkspaceConfig: NonNullable<WorkspaceInput["reuse"]["reusableExistingExecutionWorkspace"]>["config"] | null;
    reusableExistingExecutionWorkspace: WorkspaceInput["reuse"]["reusableExistingExecutionWorkspace"];
  };
  environment: Pick<WorkspaceInput["environment"], "environmentResolution" | "selectedEnvironmentId" | "selectedEnvironmentForConfig">;
  getLatestAgentConfigRevision: RunState["getLatestAgentConfigRevision"];
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Selects a resumable session before workspace preparation; acquires no runtime resources. */
export async function prepareHeartbeatSession(db: Db, input: HeartbeatSessionPreparationInput) {
  const { run, agent, getLatestAgentConfigRevision } = input;
  const { context, issueRef, issueContext, taskProjectContext, workspaceProjectContext, wakeCommentId, acceptedPlanContinuationWake, acceptedPlanWakeRoutingDecision } = input.task;
  const { taskSession, taskSessionDecodedParams, explicitResumeSessionParams, explicitResumeSessionDisplayId, sessionCodec } = input.session;
  const { runtimeConfig, agentIdentity, issueAssigneeOverrides, originalAiIssueOverrides, managedAiRuntime, aiBinding, requestedAiBinding, secretManifest, runtimeSkillEntries, routineEnvContext } = input.config;
  const { requestedExecutionWorkspaceMode, effectiveExecutionWorkspaceMode, projectExecutionWorkspacePolicy, issueExecutionWorkspaceSettings, executionPolicy, requestedReusableExecutionWorkspaceConfig, reusableExistingExecutionWorkspace } = input.workspace;
  const { environmentResolution, selectedEnvironmentId, selectedEnvironmentForConfig } = input.environment;
  const latestAgentConfigRevision = await getLatestAgentConfigRevision(
    agent.companyId,
    agent.id,
  );
  const sessionConfigMetadataInput = {
      agentIdentityKeyId: agentIdentity?.keyId,
      adapterType: agent.adapterType,
      effectiveAdapterConfig: runtimeConfig,
      managedInstructions: await agentInstructionsService(db).getManagedEntryFingerprint({ ...agent, adapterConfig: runtimeConfig }),
      managedAiHome: managedAiRuntime?.home,
      agentRuntimeConfig: agent.runtimeConfig,
      issueOverrides: issueAssigneeOverrides,
      workspaceConfig: {
        requestedMode: requestedExecutionWorkspaceMode,
        effectiveMode: effectiveExecutionWorkspaceMode,
        issueConfigRevisionAt:
          issueContext?.updatedAt instanceof Date
            ? issueContext.updatedAt.toISOString()
            : (issueContext?.updatedAt ?? null),
        projectConfigRevisionAt:
          workspaceProjectContext?.updatedAt instanceof Date
            ? workspaceProjectContext.updatedAt.toISOString()
            : (workspaceProjectContext?.updatedAt ?? null),
        projectPolicy: projectExecutionWorkspacePolicy,
        issueSettings: issueExecutionWorkspaceSettings,
        reusableExecutionWorkspaceConfig:
          requestedReusableExecutionWorkspaceConfig,
        existingExecutionWorkspace: reusableExistingExecutionWorkspace
          ? {
              id: reusableExistingExecutionWorkspace.id,
              mode: reusableExistingExecutionWorkspace.mode,
              strategyType: reusableExistingExecutionWorkspace.strategyType,
              projectWorkspaceId:
                reusableExistingExecutionWorkspace.projectWorkspaceId,
              repoUrl: reusableExistingExecutionWorkspace.repoUrl,
              baseRef: reusableExistingExecutionWorkspace.baseRef,
              branchName: reusableExistingExecutionWorkspace.branchName,
              config: reusableExistingExecutionWorkspace.config,
            }
          : null,
      },
      environment: {
        selectionSource: environmentResolution.source,
        selectedEnvironmentId,
        selectedEnvironment: selectedEnvironmentForConfig
          ? {
              id: selectedEnvironmentForConfig.id,
              driver: selectedEnvironmentForConfig.driver,
              config: selectedEnvironmentForConfig.config,
              configRevisionAt:
                selectedEnvironmentForConfig.updatedAt instanceof Date
                  ? selectedEnvironmentForConfig.updatedAt.toISOString()
                  : (selectedEnvironmentForConfig.updatedAt ?? null),
            }
          : null,
        executionPolicy,
      },
      environmentEnv: selectedEnvironmentForConfig?.envVars ?? null,
      projectEnv: taskProjectContext?.env ?? null,
      routineEnv: routineEnvContext.env,
      secretManifest,
      runtimeSkills: runtimeSkillEntries,
      agentConfigRevision: latestAgentConfigRevision
        ? {
            id: latestAgentConfigRevision.id,
            changedKeys: latestAgentConfigRevision.changedKeys,
            configRevisionAt:
              latestAgentConfigRevision.createdAt.toISOString(),
          }
        : null,
    };
  const sessionConfigMetadata = await buildEffectiveRunSessionConfigMetadata(sessionConfigMetadataInput);
  const storedFingerprint = taskSession ? readConfigFingerprintFromSessionParams(taskSession.sessionParamsJson)?.fingerprint : undefined;
  const storedFingerprintDiffers = Boolean(taskSession) && storedFingerprint !== sessionConfigMetadata.fingerprint;
  const compatibleInputs: SessionMetadataInput[] = [];
  const importedManagedInstructions = Boolean(storedFingerprintDiffers && sessionConfigMetadataInput.managedInstructions?.contentHash);
  if (importedManagedInstructions) {
    compatibleInputs.push({ ...sessionConfigMetadataInput, retainManagedInstructionPaths: true });
  }
  if (managedAiRuntime && aiBinding && taskSession && storedFingerprintDiffers) {
    const revisions = requestedAiBinding?.mode === "router"
      ? await db.select().from(agentConfigRevisions).where(and(eq(agentConfigRevisions.companyId, agent.companyId), eq(agentConfigRevisions.agentId, agent.id))).orderBy(desc(agentConfigRevisions.createdAt), desc(agentConfigRevisions.id)).limit(21)
      : [];
    const candidates = aiConnectionSessionCompatibilityInputs({
      effectiveAdapterConfig: runtimeConfig, agentRuntimeConfig: agent.runtimeConfig,
      agentConfigRevision: sessionConfigMetadataInput.agentConfigRevision,
      issueOverrides: issueAssigneeOverrides, originalIssueOverrides: originalAiIssueOverrides,
      binding: aiBinding, router: requestedAiBinding?.mode === "router",
      storedIdentity: taskSession.sessionParamsJson?.paperclipAiCredentialIdentity,
      sessionIdentity: managedAiRuntime.sessionIdentity, credentialIdentity: managedAiRuntime.identity, revisions,
    });
    compatibleInputs.push(...candidates.flatMap(candidate => [
      { ...sessionConfigMetadataInput, ...candidate },
      ...(importedManagedInstructions ? [{ ...sessionConfigMetadataInput, ...candidate, retainManagedInstructionPaths: true }] : []),
    ]));
  }
  const continuousPi = runtimeConfig.provider === "pi_rpc" &&
    resolveSessionContinuity(runtimeConfig.provider, runtimeConfig.sessionContinuity) === "continuous";
  const historicalInputs: SessionMetadataInput[] = [];
  if (storedFingerprintDiffers && agent.adapterType === "paperclip_runner" && continuousPi) {
    const previousCompositions = [
      { retainSkillKeys: true },
      { retainAdapterConfigEnvironment: true, retainSkillKeys: true },
      { continuousPiFingerprintComposition: "issue_overrides" as const, retainAdapterConfigEnvironment: true, retainSkillKeys: true },
      { continuousPiFingerprintComposition: "model_inputs" as const },
    ];
    // Category compatibility uses only old shapes of the current inputs, never
    // alternate account/revision candidates that could mask a real change.
    historicalInputs.push(...previousCompositions.map(composition => ({ ...sessionConfigMetadataInput, ...composition })));
    compatibleInputs.push(...compatibleInputs.flatMap(candidate =>
      previousCompositions.map(composition => ({ ...candidate, ...composition })),
    ));
  }
  const legacyInputs = storedFingerprintDiffers
    ? [sessionConfigMetadataInput, ...compatibleInputs, ...historicalInputs].map(candidate => ({ ...candidate, legacyComposition: true }))
    : [];
  const [compatibleConfigMetadata, historicalConfigMetadata] = await Promise.all([
    Promise.all([...compatibleInputs, ...legacyInputs].map(candidate => buildEffectiveRunSessionConfigMetadata(candidate))),
    Promise.all(historicalInputs.map(candidate => buildEffectiveRunSessionConfigMetadata(candidate))),
  ]);
  const configuredModel =
    readConfiguredModelFromAdapterConfig(runtimeConfig);
  if (context.refreshTools === true && agent.adapterType !== "paperclip_runner") {
    const capability = getServerAdapter(agent.adapterType).supportsToolRefreshOnResume;
    const canRefresh = typeof capability === "function" ? capability(runtimeConfig) : capability === true;
    if (!canRefresh) context.forceFreshSession = true;
  }
  const wakeSessionResetReason = describeSessionResetReason(context);
  const sessionConfigFreshness = resolveTaskSessionConfigFreshness({
    hasTaskSession: taskSession != null,
    configuredModel,
    preserveSessionOnModelChange: runtimeConfig.provider === "pi_rpc" && resolveSessionContinuity(runtimeConfig.provider, runtimeConfig.sessionContinuity) === "continuous",
    taskSessionParams:
      taskSession?.sessionParamsJson ?? taskSessionDecodedParams,
    configMetadata: sessionConfigMetadata,
    compatibleConfigMetadata: [...compatibleConfigMetadata, ...historicalConfigMetadata],
    compatibleCategoryMetadata: historicalConfigMetadata,
    wakeResetReason: wakeSessionResetReason,
    preserveLegacySessionWithoutConfigMetadata:
      acceptedPlanContinuationWake && !acceptedPlanWakeRoutingDecision && !agentIdentity,
  });
  // Adapter config exemptions are per-key in the fingerprint, never per-category.
  // Instruction content, environment/binding/secret revisions and skill lists may advance here;
  // each run resolves current values; missing/versioned metadata and mixed changes still reset.
  const continuableConfigChange = continuousPi && sessionConfigFreshness.changedCategories.length > 0 &&
    sessionConfigFreshness.changedCategories.every(category =>
      ["instructions", "environment", "envBindings", "secrets", "runtimeSkills"].includes(category));
  let warmRecoveryResetRequired = false;
  let warmRecoveryRetainSessionId: string | null = null;
  let warmRecoveryReplacementSessionId: string | null = null;
  if (continuousPi && issueRef && context.forceFreshSession === true &&
      context.explicitFreshSession !== true && context.conversationReset !== true &&
      (context.source === "execution.reconciled" || context.wakeReason === "issue_recovery_action_restored") &&
      !(await isChatTask(db, agent.companyId, issueRef.id))) {
    // The first fresh attempt can fail BEFORE publishing a task-session
    // pointer. Keep the bound on its durable run, not that lagging/empty pointer
    // or a recovery action (which stock may replace on every retry).
    const [event] = await db.select({ id: heartbeatRuns.id, createdAt: heartbeatRuns.createdAt, status: heartbeatRuns.status,
      nativeSessionId: heartbeatRuns.nativeSessionId, sessionIdAfter: heartbeatRuns.sessionIdAfter,
      context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id), ne(heartbeatRuns.id, run.id),
      lte(heartbeatRuns.createdAt, run.createdAt), or(eq(heartbeatRuns.issueId, issueRef.id), eq(heartbeatRuns.nativeIssueId, issueRef.id)),
      or(eq(heartbeatRuns.status, "succeeded"),
        sql`${heartbeatRuns.contextSnapshot}#>>'{warmRecoveryFreshSession,runId}' = ${heartbeatRuns.id}::text`),
    )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
    // Success ends the incident; otherwise require an explicit fresh request
    // (including a forceFreshSession wake), stock's reset receipt, or its run-bound
    // stored-credential reset receipt AND a different session actually started.
    // A plain wake resuming an older session through a lagging pointer is neither.
    // Native selection alone precedes startup: require its session.started receipt.
    // Legacy adapters publish sessionIdAfter on completion, not at selection.
    let incident = event?.status !== "succeeded" ? event : undefined;
    const marker = incident?.context?.warmRecoveryFreshSession as Record<string, unknown> | undefined;
    const incidentSessionId = incident?.nativeSessionId ?? incident?.sessionIdAfter ?? readNonEmptyString(marker?.retainedSessionId);
    const [replacement] = incident && incidentSessionId ? await db.select({
      nativeSessionId: heartbeatRuns.nativeSessionId, sessionIdAfter: heartbeatRuns.sessionIdAfter,
    }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id), ne(heartbeatRuns.id, run.id),
      lte(heartbeatRuns.createdAt, run.createdAt), or(eq(heartbeatRuns.issueId, issueRef.id), eq(heartbeatRuns.nativeIssueId, issueRef.id)),
      sql`(${heartbeatRuns.createdAt}, ${heartbeatRuns.id}) > (${incident.createdAt.toISOString()}::timestamptz, ${incident.id}::uuid)`,
      or(sql`${heartbeatRuns.contextSnapshot}->>'explicitFreshSession' = 'true'`,
        sql`${heartbeatRuns.resultJson}#>>'{configFreshness,session,reset}' = 'true'`,
        sql`${heartbeatRuns.resultJson}#>>'{configFreshness,session,credentialIdentityResetRunId}' = ${heartbeatRuns.id}::text`),
      or(and(isNull(heartbeatRuns.nativeSessionId), sql`${heartbeatRuns.sessionIdAfter} is not null`), sql`exists (select 1 from ${heartbeatRunEvents}
        where ${heartbeatRunEvents.companyId} = ${heartbeatRuns.companyId} and ${heartbeatRunEvents.runId} = ${heartbeatRuns.id}
          and ${heartbeatRunEvents.eventType} = 'session.started'
          and ${heartbeatRunEvents.payload}#>>'{prpEvent,normalizedSessionId}' = ${heartbeatRuns.nativeSessionId}::text)`),
      sql`coalesce(${heartbeatRuns.nativeSessionId}::text, ${heartbeatRuns.sessionIdAfter}) <> ${incidentSessionId}`,
    )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1) : [];
    if (replacement) {
      incident = undefined;
      warmRecoveryReplacementSessionId = replacement.nativeSessionId ?? replacement.sessionIdAfter;
    }
    if (incident) warmRecoveryRetainSessionId = incidentSessionId;
    const retainedSessionId = warmRecoveryReplacementSessionId ?? warmRecoveryRetainSessionId ??
      readNonEmptyString(taskSessionDecodedParams?.sessionId) ?? taskSession?.sessionDisplayId;
    // lastRunId can lag a refused pre-claim turn. The newest run on this exact
    // session (or its unpublished first fresh attempt) decides, never an older refusal.
    const [previous] = retainedSessionId ? await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, error: heartbeatRuns.error,
      errorCode: heartbeatRuns.errorCode, resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id), ne(heartbeatRuns.id, run.id),
      lte(heartbeatRuns.createdAt, run.createdAt), or(eq(heartbeatRuns.issueId, issueRef.id), eq(heartbeatRuns.nativeIssueId, issueRef.id)),
      or(incident ? eq(heartbeatRuns.id, incident.id) : undefined,
        isNativeSessionId(retainedSessionId) ? eq(heartbeatRuns.nativeSessionId, retainedSessionId) : undefined,
        and(isNull(heartbeatRuns.nativeSessionId), or(eq(heartbeatRuns.sessionIdBefore, retainedSessionId), eq(heartbeatRuns.sessionIdAfter, retainedSessionId)))),
    )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1) : [];
    if (isWarmRecoveryRefusal(previous)) {
      if (incident) {
        const reason = "warm_recovery_fresh_session_already_attempted";
        context.warmRecoveryNoticeReason = reason;
        // Record once per incident, atomically with the receipt. This is a
        // notice, NOT a new recovery owner or wake: stock's bound stays intact.
        const publications: ActivityPublication[] = [];
        try {
          await db.transaction(async tx => {
            // addComment updates issues.updatedAt even for a system notice. Take
            // the issue fence FIRST, matching admission/mutation's issue -> run
            // order; holding only the incident run here would invert that order.
            const [issue] = await tx.select({ id: issues.id }).from(issues).where(and(
              eq(issues.companyId, agent.companyId), eq(issues.id, issueRef.id),
            )).for("update");
            if (!issue) return;
            const [started] = await tx.select({ context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
              eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.id, incident.id),
            )).for("update");
            const marker = started?.context?.warmRecoveryFreshSession as Record<string, unknown> | undefined;
            if (!marker || marker.noticeRecorded === true) return;
            // This caller-owned system_notice has no agent/user/run author and
            // bypasses HTTP/plugin comment wake delivery. addComment itself only
            // persists it; system notices are not actionable continuation input.
            await issueService(db).addComment(issueRef.id,
              "This task's saved session could not be resumed. Paperclip already tried one new session without a successful turn, " +
              "so automatic recovery will not request another new session for this incident. Other session-reset rules still apply. " +
              "Retry on the task starts a new session when the failed run reports that its saved session cannot continue; " +
              "otherwise it tries the saved session again.", {}, {
                authorType: "system",
                presentation: systemNoticePresentation({ tone: "warning", title: "Fresh-session recovery already attempted" }),
                // A dated record, not a live execution blocker: TaskChatThread
                // hides system-owned recovery notices and obsolete sourceRunId
                // diagnostics. Keep the durable run link in the detail rows.
                metadata: { version: 1, sections: [{
                  title: "Recovery", rows: [keyValueRow("Reason", reason),
                    runLinkRow("Fresh-session attempt", { id: incident.id, status: incident.status, agentId: agent.id })],
                }] },
              }, tx);
            await tx.update(heartbeatRuns).set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) ||
              ${JSON.stringify({ warmRecoveryFreshSession: { ...marker, noticeRecorded: true } })}::jsonb` })
              .where(and(eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.id, incident.id)));
            await logActivity(tx as unknown as Db, { companyId: agent.companyId, actorType: "system", actorId: "recovery",
              action: "issue.warm_recovery_fresh_session_already_attempted", entityType: "issue", entityId: issueRef.id,
              details: { reason, freshSessionRunId: incident.id, refusedRunId: previous!.id } }, publications);
          });
          // Nothing escapes a rolled-back transaction. The receipt and notice
          // commit together, just like the existing New session marker.
          for (const publication of publications) publishActivity(publication);
        } catch (err) {
          logger.warn({ err, runId: run.id, issueId: issueRef.id }, "Could not record recovery notice; continuing recovery");
        }
      } else if (sessionCannotContinue(previous) &&
          (await instanceSettingsService(db).getExperimentalReadOnly()).autoFreshSessionOnRecovery === true) {
        // Spend only on a session that can never resume, not a self-clearing refusal.
        // For incidents opened while ON, boundaries, receipts and authorized-newer
        // selection remain active when the setting is later switched OFF.
        warmRecoveryResetRequired = true;
        context.warmRecoveryFreshSession = { runId: run.id, refusedRunId: previous!.id, retainedSessionId };
        // Write before workspace/provider startup can fail, and merge rather
        // than replace unrelated admission context. Re-preparation is idempotent.
        await db.update(heartbeatRuns).set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) ||
          ${JSON.stringify({ warmRecoveryFreshSession: context.warmRecoveryFreshSession })}::jsonb` })
          .where(and(eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.id, run.id)));
      }
    }
  }
  let resetTaskSession =
    context.workspaceSelectionChanged === true || shouldResetTaskSessionForWake(context) || sessionConfigFreshness.reset;
  if (decideNativeContinuation({
    provider: runtimeConfig.provider, sessionContinuity: runtimeConfig.sessionContinuity, hasSession: taskSession != null || warmRecoveryRetainSessionId != null, wakeReset: true,
    resetRequired: warmRecoveryResetRequired || context.explicitFreshSession === true || context.conversationReset === true ||
      (context.workspaceSelectionChanged === true && (agent.adapterType !== "paperclip_runner" || runtimeConfig.provider !== "pi_rpc")) ||
      sessionConfigFreshness.reasons.some(reason => reason !== wakeSessionResetReason &&
        !(continuableConfigChange && reason.startsWith("effective run configuration changed: "))) ||
      (context.wakeReason === "heartbeat_timer" && !deriveTaskKey(context, null)),
  }).continue) resetTaskSession = false;
  const sessionResetReason =
    sessionConfigFreshness.reasons.join("; ") || null;
  const taskSessionForRun = resetTaskSession ? null : taskSession;
  const taskSessionCredentialCompatible = !managedAiRuntime || managedAiSessionIdentityCompatible(
    taskSession?.sessionParamsJson?.paperclipAiCredentialIdentity,
    managedAiRuntime.sessionIdentity,
    managedAiRuntime.identity,
  );
  // Missing task-session identity is not a credential change: the first fresh
  // try may have failed before publishing that row. Keep its pin in that case.
  // A real stored identity change must let stock choose a new native session.
  const credentialIdentityResetRunId = taskSession?.sessionParamsJson?.paperclipAiCredentialIdentity != null &&
    !taskSessionCredentialCompatible ? run.id : null;
  if (resetTaskSession || credentialIdentityResetRunId) {
    warmRecoveryRetainSessionId = null;
  }
  // Boundary recognition must reach dispatch, not only refusal classification.
  // Stock reset and credential compatibility still decide whether any resume is safe.
  const warmRecoveryResumeSessionId = warmRecoveryReplacementSessionId ?? warmRecoveryRetainSessionId;
  const taskSessionId = readNonEmptyString(taskSessionDecodedParams?.sessionId);
  const taskResumeSessionId = !resetTaskSession && taskSessionCredentialCompatible && isNativeSessionId(warmRecoveryResumeSessionId)
    ? warmRecoveryResumeSessionId
    : taskSessionCredentialCompatible && taskSessionForRun?.lastRunId &&
      taskSessionForRun.lastRunId !== run.id && isNativeSessionId(taskSessionId) ? taskSessionId : null;
  const getFreshSessionHandoff = issueRef ? createNativeSessionHandoffLoader({
    db, companyId: agent.companyId, issueId: issueRef.id, agentId: agent.id, before: run.createdAt,
    continuation: context.executionContinuation as ExecutionContinuationEnvelope | undefined,
    mode: resolveSessionContinuity(runtimeConfig.provider, runtimeConfig.sessionContinuity) === "continuous" ? "whole" : "bounded",
    throughCommentId: readNonEmptyString(context.conversationReplayThroughCommentId) ?? (context.interactionKind ? null : wakeCommentId),
    excludeCommentIds: [...new Set([...queuedCommentIdsFromRunContext(context),
      ...[wakeCommentId, readNonEmptyString(context.wakeCommentId), readNonEmptyString(context.commentId)]
        .filter((id): id is string => id !== null)])],
  }) : undefined;
  const previousSessionParams =
    explicitResumeSessionParams ??
    (!resetTaskSession && taskSessionCredentialCompatible && warmRecoveryResumeSessionId
      ? { sessionId: warmRecoveryResumeSessionId } : null) ??
    (isCanonicalSessionIdForAdapter(
      agent.adapterType,
      explicitResumeSessionDisplayId,
    )
      ? { sessionId: explicitResumeSessionDisplayId }
      : null) ??
    normalizeResumeParamsForAdapter(
      agent.adapterType,
      stripPaperclipSessionMetadataFromSessionParams(
        sessionCodec.deserialize(
          taskSessionForRun?.sessionParamsJson ?? null,
        ),
      ),
    );
  // Legacy plugins can consume the existing context field on a known-fresh
  // dispatch. Built-ins also load lazily if their resume attempt fails.
  if (agent.adapterType !== "paperclip_runner" && !previousSessionParams && getFreshSessionHandoff) {
    const handoff = await getFreshSessionHandoff();
    if (handoff) context.paperclipFreshSessionHandoffMarkdown = handoff;
  }
  return { sessionConfigMetadata, configuredModel, sessionConfigFreshness, resetTaskSession, sessionResetReason, taskSessionForRun,
    taskSessionCredentialCompatible, credentialIdentityResetRunId, taskResumeSessionId, warmRecoveryRetainSessionId, getFreshSessionHandoff, previousSessionParams };
}

export interface HeartbeatAdapterSessionInput {
  agent: typeof agents.$inferSelect;
  task: {
    context: Record<string, unknown>;
    taskKey: string | null;
    issueId: string | null;
    continuationSummary: TaskContext["continuationSummary"];
    executionContinuation: TaskContext["executionContinuation"];
  };
  session: {
    runtime: { sessionId: string | null };
    taskSession: TaskSession;
    sessionCodec: SessionCodec;
    explicitResumeSessionDisplayId: string | null;
    runtimeSessionParams: Record<string, unknown> | null;
    managedAiRuntime: ManagedAiRuntime | undefined;
    prepared: Awaited<ReturnType<typeof prepareHeartbeatSession>>;
  };
  workspace: Pick<PreparedWorkspace, "latestWorkspaceConfigMetadata" | "workspaceConfigFreshness" | "reusedExecutionWorkspace" | "resolvedWorkspaceReusePolicy" | "persistedExecutionWorkspace"> & {
    runtimeWorkspaceWarnings: string[];
    requestedShouldReuseExisting: boolean;
    workspaceReuseRequest: WorkspaceInput["reuse"]["workspaceReuseRequest"];
  };
  evaluateSessionCompaction: RunState["evaluateSessionCompaction"];
}

/** Resolves adapter identity after workspace preparation, retaining in-place context and delta updates. */
export async function resolveHeartbeatAdapterSession(input: HeartbeatAdapterSessionInput) {
  const { agent, evaluateSessionCompaction } = input;
  const { context, taskKey, issueId, continuationSummary, executionContinuation } = input.task;
  const { runtime, taskSession, sessionCodec, explicitResumeSessionDisplayId, runtimeSessionParams, managedAiRuntime, prepared } = input.session;
  const { sessionConfigMetadata, sessionConfigFreshness, resetTaskSession, taskSessionForRun, taskSessionCredentialCompatible, previousSessionParams } = prepared;
  const { latestWorkspaceConfigMetadata, workspaceConfigFreshness, reusedExecutionWorkspace, resolvedWorkspaceReusePolicy, persistedExecutionWorkspace, runtimeWorkspaceWarnings, requestedShouldReuseExisting, workspaceReuseRequest } = input.workspace;
  const runtimeSessionFallback =
    taskKey || resetTaskSession
      ? null
      : isCanonicalSessionIdForAdapter(agent.adapterType, runtime.sessionId)
        ? runtime.sessionId
        : null;
  const runtimeSessionDisplayId = truncateDisplayId(
    explicitResumeSessionDisplayId ??
      taskSessionForRun?.sessionDisplayId ??
      (sessionCodec.getDisplayId
        ? sessionCodec.getDisplayId(runtimeSessionParams)
        : null) ??
      readNonEmptyString(runtimeSessionParams?.sessionId) ??
      runtimeSessionFallback,
  );
  let previousSessionDisplayId = requiresCanonicalSessionIds(
    agent.adapterType,
  )
    ? truncateDisplayId(
        readNonEmptyString(previousSessionParams?.sessionId) ??
          (isCanonicalSessionIdForAdapter(
            agent.adapterType,
            runtimeSessionDisplayId,
          )
            ? runtimeSessionDisplayId
            : null) ??
          runtimeSessionFallback,
      )
    : runtimeSessionDisplayId;
  let runtimeSessionIdForAdapter =
    readNonEmptyString(runtimeSessionParams?.sessionId) ??
    runtimeSessionFallback;
  let runtimeSessionParamsForAdapter = normalizeSessionParams(
    stripPaperclipSessionMetadataFromSessionParams(runtimeSessionParams),
  );

  const sessionCompaction = await evaluateSessionCompaction({
    agent,
    sessionId: previousSessionDisplayId ?? runtimeSessionIdForAdapter,
    issueId,
    continuationSummaryBody: continuationSummary?.body ?? null,
  });
  if (sessionCompaction.rotate) {
    context.paperclipSessionHandoffMarkdown =
      sessionCompaction.handoffMarkdown;
    context.paperclipSessionRotationReason = sessionCompaction.reason;
    context.paperclipPreviousSessionId =
      previousSessionDisplayId ?? runtimeSessionIdForAdapter;
    runtimeSessionIdForAdapter = null;
    runtimeSessionParamsForAdapter = null;
    previousSessionDisplayId = null;
    if (sessionCompaction.reason) {
      runtimeWorkspaceWarnings.push(
        `Starting a fresh session because ${sessionCompaction.reason}.`,
      );
    }
  } else {
    delete context.paperclipSessionHandoffMarkdown;
    delete context.paperclipSessionRotationReason;
    delete context.paperclipPreviousSessionId;
  }

  if (managedAiRuntime) {
    sessionConfigMetadata.aiCredentialIdentity = managedAiRuntime.sessionIdentity;
    if (!taskSessionCredentialCompatible) {
      runtimeSessionIdForAdapter = null;
      runtimeSessionParamsForAdapter = null;
      previousSessionDisplayId = null;
      delete executionContinuation?.resumeDelta;
    }
  }
  const runtimeForAdapter = {
    sessionId: runtimeSessionIdForAdapter,
    sessionParams: runtimeSessionParamsForAdapter,
    sessionDisplayId: previousSessionDisplayId,
    taskKey,
  };
  // A delta is safe only when the selected provider session is exactly the
  // task session whose last dispatch supplied the baseline history.
  if (
    executionContinuation?.resumeDelta &&
    (!taskSessionForRun ||
      !taskSession?.sessionDisplayId ||
      runtimeForAdapter.sessionDisplayId !== taskSession.sessionDisplayId ||
      resetTaskSession)
  ) {
    delete executionContinuation.resumeDelta;
  }
  const configFreshnessResultMetadata = {
    version: sessionConfigMetadata.version,
    session: {
      fingerprintVersion: sessionConfigMetadata.version,
      categories: sessionConfigMetadata.categories,
      reset: resetTaskSession,
      // This identity-only reset is independent of configuration freshness.
      // Bind its authority to this run; a matching start receipt is still required.
      credentialIdentityResetRunId: prepared.credentialIdentityResetRunId,
      resetReasons: sessionConfigFreshness.reasons,
      changedCategories: sessionConfigFreshness.changedCategories,
      taskSessionAvailable: taskSession != null,
      taskSessionReused: taskSessionForRun != null,
      storedFingerprintPresent: Boolean(
        sessionConfigFreshness.storedFingerprint,
      ),
      nextFingerprint: sessionConfigFreshness.nextFingerprint,
    },
    workspace: {
      fingerprintVersion: latestWorkspaceConfigMetadata.version,
      categories: latestWorkspaceConfigMetadata.categories,
      action: workspaceConfigFreshness.action,
      changedCategories: workspaceConfigFreshness.changedCategories,
      reasons: workspaceConfigFreshness.reasons,
      reuseRequested: requestedShouldReuseExisting,
      workspaceReused: Boolean(reusedExecutionWorkspace),
      configSnapshotRefreshed:
        resolvedWorkspaceReusePolicy.shouldRefreshWorkspaceConfigSnapshot,
      storedFingerprintPresent:
        workspaceConfigFreshness.storedFingerprintPresent,
      storedFingerprint: workspaceConfigFreshness.storedFingerprint,
      inferredFingerprint: workspaceConfigFreshness.inferredFingerprint,
      nextFingerprint: workspaceConfigFreshness.nextFingerprint,
      previousWorkspaceId:
        workspaceReuseRequest.requestedExecutionWorkspaceId,
      activeWorkspaceId: persistedExecutionWorkspace?.id ?? null,
    },
  };

  return { previousSessionDisplayId, runtimeSessionParamsForAdapter, runtimeForAdapter, configFreshnessResultMetadata, sessionCompaction };
}
