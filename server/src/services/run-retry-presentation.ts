import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, agentTaskSessions, aiConnectionTaskPins, companySecrets, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { aiConnectionMetadataSchema, aiRuntimeConnectionBindingSchema } from "@paperclipai/shared";
import { resolveSessionContinuity, sessionCannotContinue, type RetryReasonCode } from "./native-runtime/continued-session.js";
import { findNativeSessionResumeRun } from "./native-runtime/native-session-resume.js";
import { isChatTask } from "./fresh-continuation-retry-fold.js";
import { proveRunProcessGone } from "./run-process-owner.js";
import { managedAiSessionIdentity, managedAiSessionIdentityCompatible } from "./ai-connection-session.js";
import { conflict } from "../errors.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export type RetryConsequence = { retryStartsNewSession: boolean; retryReasonCode?: RetryReasonCode; retryReason?: string; retryDisclosure?: string };
export function agentRetryStartsNewSession(config: Record<string, unknown> | null | undefined) {
  return resolveSessionContinuity(config?.provider, config?.sessionContinuity) !== "continuous";
}
export type RetrySelectorFacts = {
  adapterType: string; config: Record<string, unknown>; chat: boolean;
  run: { errorCode?: string | null; error?: string | null; resultJson?: unknown };
  requiresIsolatedWorkspace?: boolean; savedSessionExpected?: boolean; checkpointAvailable?: boolean;
  credentialCompatible?: boolean; hardResetCategories?: string[];
};
/** Read-only consequence, not permission to Retry. Admission consumes this exact
 * isolation predicate too; a continuity setting alone never authorizes sharing files. */
export function classifyRetryConsequence(facts: RetrySelectorFacts): RetryConsequence {
  const detail = record(facts.run.resultJson);
  const target = facts.chat ? "chat" : "task";
  const replay = facts.adapterType === "process" || facts.adapterType === "http" || facts.adapterType === "webhook";
  let retryReasonCode: RetryReasonCode | undefined;
  let retryReason: string | undefined;
  if (facts.run.errorCode === "native_provider_side_effect_pending" || detail.retryReasonCode === "side_effect_pending") {
    retryReasonCode = "side_effect_pending";
    retryReason = "The last action may or may not have run. Check it before you continue.";
  } else if (facts.credentialCompatible === false || detail.retryReasonCode === "credential_changed") {
    retryReasonCode = "credential_changed"; retryReason = "The credential for the saved session changed.";
  } else if (facts.hardResetCategories?.length || detail.retryReasonCode === "configuration_reset") {
    retryReasonCode = "configuration_reset";
    retryReason = typeof detail.retryReason === "string" ? detail.retryReason : `The saved session requires a configuration reset: ${facts.hardResetCategories?.join(", ") || "saved configuration changed"}.`;
  } else if (facts.run.errorCode === "saved_session_unavailable" || (facts.savedSessionExpected && facts.checkpointAvailable === false)) {
    retryReasonCode = "saved_session_unavailable"; retryReason = "The saved session could not be continued.";
  } else if (sessionCannotContinue(facts.run) || facts.requiresIsolatedWorkspace) {
    retryReasonCode = "session_cannot_continue";
    retryReason = facts.requiresIsolatedWorkspace ? "The earlier run's stop could not be confirmed." : "The earlier session cannot be resumed.";
  }
  // An action replay is not a conversational session replacement. Keep its
  // explicit replay warning, but never request a fresh-session soft reset.
  const retryStartsNewSession = !replay && Boolean(retryReasonCode || facts.requiresIsolatedWorkspace || agentRetryStartsNewSession(facts.config));
  const retryDisclosure = replay ? `Retry runs the configured ${facts.adapterType === "process" ? "process" : "webhook"} action again. Check its earlier effects before retrying.`
    : retryReasonCode === "side_effect_pending" ? "Start a new session anyway: it will be told the last action's outcome is unknown."
    : facts.requiresIsolatedWorkspace ? `Retry starts a new session for this ${target}. It copies readable current files at your press into a new, separate workspace; the earlier directory stays with the earlier run. If its box cannot be read, the last saved work is used instead: the earlier run may still be running and could change files. Its permission to write to this ${target} is revoked.`
    : `Retry starts a new session for this ${target}. It receives the earlier messages and available files as context, not the agent's tool steps; the old session is not resumed.`;
  return { retryStartsNewSession, ...(retryReasonCode ? { retryReasonCode, retryReason } : {}), ...(retryStartsNewSession || replay ? { retryDisclosure } : {}) };
}

const retryRunFields = {
  id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
  nativeIssueId: heartbeatRuns.nativeIssueId, issueId: heartbeatRuns.issueId,
  errorCode: heartbeatRuns.errorCode, error: heartbeatRuns.error, resultJson: heartbeatRuns.resultJson,
  contextSnapshot: sql<Record<string, unknown> | null>`jsonb_build_object('taskKey', ${heartbeatRuns.contextSnapshot}->'taskKey', 'taskId', ${heartbeatRuns.contextSnapshot}->'taskId', 'issueId', ${heartbeatRuns.contextSnapshot}->'issueId')`,
  processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId,
  processStartedAt: heartbeatRuns.processStartedAt, processHostHash: heartbeatRuns.processHostHash,
  responsibleUserId: heartbeatRuns.responsibleUserId,
};
type RetryRun = Pick<typeof heartbeatRuns.$inferSelect, keyof typeof retryRunFields>;
export async function readRetrySelectorFacts(db: Db, companyId: string, runId: string, selectedRun?: RetryRun): Promise<RetrySelectorFacts | null> {
  // The blocker already has this bounded row. Reuse it instead of reading the
  // full prompt/profile/output blobs a second time on every task poll.
  const run = selectedRun ?? (await db.select(retryRunFields).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId))))[0];
  if (!run || run.companyId !== companyId || run.id !== runId) return null;
  const [agent] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, run.agentId)));
  if (!agent) return null;
  const context = record(run.contextSnapshot);
  // Legacy issueId values can be adapter task keys rather than database UUIDs.
  const issueId = [run.nativeIssueId, run.issueId, context.issueId].find((value): value is string =>
    typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) ?? null;
  const [issue] = issueId ? await db.select({ assigneeAgentId: issues.assigneeAgentId, assigneeAdapterOverrides: issues.assigneeAdapterOverrides }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))) : [];
  const overrides = issue?.assigneeAgentId === agent.id ? record(record(issue.assigneeAdapterOverrides).adapterConfig) : {};
  let config = { ...record(agent.adapterConfig), ...overrides };
  const [hold] = issueId ? await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
    inArray(issueRecoveryActions.status, ["active", "escalated"]), sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`)).limit(1) : [];
  const requiresIsolatedWorkspace = Boolean(hold && ((await proveRunProcessGone(run, "retry_consequence"))?.verdict !== "gone" ||
    await (await import("./execution-blocker.js")).hasPendingRunCleanup(db, companyId, run.id)));
  const { deriveTaskKey } = await import("./heartbeat/run-preparation.js");
  const taskKey = deriveTaskKey(context, null) ?? issueId;
  const [taskSession] = taskKey ? await db.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, companyId),
    eq(agentTaskSessions.agentId, agent.id), eq(agentTaskSessions.adapterType, agent.adapterType), eq(agentTaskSessions.taskKey, taskKey))).limit(1) : [];
  const params = record(taskSession?.sessionParamsJson);
  const { getAdapterSessionCodec } = await import("./heartbeat/run-state.js");
  const decoded = record(getAdapterSessionCodec(agent.adapterType).deserialize(taskSession?.sessionParamsJson ?? null));
  const sessionId = typeof decoded.sessionId === "string" ? decoded.sessionId : null;
  const selected = sessionId && issueId ? await findNativeSessionResumeRun(db, { companyId, agentId: agent.id, issueId,
    normalizedSessionId: sessionId, currentRunId: "00000000-0000-4000-8000-000000000000", beforeCreatedAt: new Date() }) : null;
  const selectedProfile = record(selected?.runnerProfileJson);
  const checkpoint = record(selectedProfile.sessionCheckpoint);
  const managed = record(config.managedAiConnection);
  let credentialCompatible = typeof managed.sessionIdentity === "string" && typeof managed.identity === "string"
    ? managedAiSessionIdentityCompatible(params.paperclipAiCredentialIdentity, managed.sessionIdentity, managed.identity) : undefined;
  // Select metadata through the very same authorization/default-account owner as
  // dispatch. Never prepare a runtime, decrypt a credential, probe a provider or
  // allocate a pool member on this read path. A pinned pool already has a choice.
  const binding = aiRuntimeConnectionBindingSchema.safeParse(record(agent.runtimeConfig).aiConnection);
  if (taskSession && binding.success && config.homeMode !== "preconfigured") {
    try {
      let concrete = binding.data.mode !== "router" ? binding.data : undefined;
      let selectedConfig = config;
      if (binding.data.mode === "router" && taskKey) {
        const [pin] = await db.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.companyId, companyId),
          eq(aiConnectionTaskPins.poolId, binding.data.connectionId), eq(aiConnectionTaskPins.agentId, agent.id), eq(aiConnectionTaskPins.taskKey, taskKey))).limit(1);
        concrete = pin?.selection.binding;
        if (pin) selectedConfig = config = { ...config, ...pin.selection.runtimeConfig };
      }
      if (concrete) {
        const selection = await (await import("./ai-connections.js")).aiConnectionService(db).select({ companyId, agentId: agent.id,
          userId: run.responsibleUserId, adapterType: agent.adapterType, binding: concrete, model: selectedConfig.model,
          runnerProvider: selectedConfig.provider, acpxAgent: selectedConfig.acpxAgent });
        const noAuth = aiConnectionMetadataSchema.parse(selection.connection.config.ai).routing?.auth === "none";
        const ref = selection.grant.credentialSecretRefs.find(value => value.configPath === "ai.credential");
        const [freshness] = !noAuth && ref ? await db.select({ epoch: companySecrets.aiSessionEpoch }).from(companySecrets)
          .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, ref.secretId))) : [];
        if (noAuth || (ref && freshness)) {
          const identity = managedAiSessionIdentity(selection.grant.id, run.responsibleUserId, noAuth ? null : { secretId: ref!.secretId, epoch: freshness!.epoch });
          // Legacy byte-hash identities need dispatch's existing credential check;
          // reading a projection must not resolve secret material to reconstruct it.
          const legacy = typeof params.paperclipAiCredentialIdentity === "string" && params.paperclipAiCredentialIdentity.split(":").length === 3;
          credentialCompatible = legacy && identity.endsWith(":0") ? undefined : params.paperclipAiCredentialIdentity === identity;
        } else credentialCompatible = false;
      }
    } catch { credentialCompatible = false; }
  }
  const hardResetCategories: string[] = [];
  if (taskSession && config.provider === "pi_rpc" && !agentRetryStartsNewSession(config)) {
    const { buildEffectiveRunSessionConfigMetadata, readConfigFingerprintFromSessionParams } = await import("./heartbeat/workspaces.js");
    const stored = readConfigFingerprintFromSessionParams(params);
    const current = await buildEffectiveRunSessionConfigMetadata({ adapterType: agent.adapterType, effectiveAdapterConfig: config,
      agentRuntimeConfig: agent.runtimeConfig, issueOverrides: issue?.assigneeAgentId === agent.id ? issue.assigneeAdapterOverrides : null,
      workspaceConfig: null, environment: null, environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [] });
    if (!stored) hardResetCategories.push("fingerprint metadata is missing");
    else if (stored.version !== current.version) hardResetCategories.push(`fingerprint version changed from ${stored.version} to ${current.version}`);
    else for (const category of ["agentRuntimeConfig", "issueOverrides"] as const) {
      // A router's already-authorized account migration has exact alternative
      // fingerprints at dispatch; do not turn it into a blanket reset here.
      if (binding.success && binding.data.mode === "router") continue;
      if (stored.categoryFingerprints?.[category] && stored.categoryFingerprints[category] !== current.categoryFingerprints[category]) hardResetCategories.push(category);
    }
  }
  return { adapterType: agent.adapterType, config, chat: issueId ? await isChatTask(db, companyId, issueId) : false, run,
    requiresIsolatedWorkspace, savedSessionExpected: Boolean(taskSession && agent.adapterType === "paperclip_runner" && config.provider === "pi_rpc" && !agentRetryStartsNewSession(config)),
    checkpointAvailable: selected ? Boolean(checkpoint.sessionId && !sessionCannotContinue(selected) && selected.errorCode !== "native_provider_side_effect_pending") : !sessionId,
    credentialCompatible, hardResetCategories };
}
export async function readRetryConsequence(db: Db, companyId: string, runId: string): Promise<RetryConsequence> {
  const facts = await readRetrySelectorFacts(db, companyId, runId);
  return facts ? classifyRetryConsequence(facts) : { retryStartsNewSession: false };
}
/** Newly introduced refusal choices were never drawn by old clients. */
export function retryChoiceAllowsFresh(retry: RetryConsequence, expected: boolean | undefined) {
  const newlyDisclosed = retry.retryReasonCode && ["saved_session_unavailable", "side_effect_pending", "configuration_reset", "credential_changed"].includes(retry.retryReasonCode);
  return retry.retryStartsNewSession && (!newlyDisclosed || expected === true);
}
export async function assertRetryExpectation(db: Db, companyId: string, runId: string, expected: boolean | undefined) {
  const retry = await readRetryConsequence(db, companyId, runId);
  if (expected !== undefined && expected !== retry.retryStartsNewSession) throw conflict("retry_expectation_changed", { retry });
  return retry;
}
export async function withRetryConsequence<T extends { id: string }>(db: Db, companyId: string, run: T): Promise<T & RetryConsequence> {
  return { ...run, ...await readRetryConsequence(db, companyId, run.id) };
}
// Columns retain a stable query shape. All public projections are enriched from
// the same read-only selector above before returning them.
export const retryStartsNewSessionColumn = sql<boolean>`false`;
