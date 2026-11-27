import { issueService } from "../issues.js";
import { nativeResponsePresentationWork } from "./native-response-presentation-work.js";
import { prepareHeartbeatSession, type HeartbeatSessionPreparationInput } from "../heartbeat/session-preparation.js";
import { instanceSettingsService } from "../instance-settings.js";
import { getAdapterSessionCodec } from "../heartbeat/run-state.js";
import { attachPaperclipSessionMetadataToSessionParams } from "../heartbeat/workspaces.js";
import * as issueCommentWrites from "../issue-comment-writes.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { plugins } from "@paperclipai/db";
import { readTaskPanelActivations } from "../plugin-task-panels.js";
import { startServerMetrics, stopServerMetrics } from "../server-metrics.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { ONBOARDING_FIRST_TASK_ORIGIN_KIND } from "@paperclipai/shared";
import { readCompletedAssistantMessageCandidate, resolveHeartbeatRunResponse, selectHeartbeatRunFinalAgentMessage } from "../heartbeat-run-summary.js";
import {
  activityLog,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  assets,
  authUsers,
  companies,
  companyMemberships,
  chatCompletionDeliveries,
  chatTaskHandoffs,
  completionContracts,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  routineRuns,
  routines,
  statusDecisionEffects,
  statusDecisions,
  userCompanyPreferences,
  workAssessments,
} from "@paperclipai/db";
import {
  executeNativeSession,
  parseNativeExecutionInput,
  type NativeSessionBackend,
  type PrpEvent,
  type PrpStructuredRunResult,
  type PrpTerminalState,
} from "../../vendor/paperclip-runner/index.js";
import {
  CONTROL_PLANE_CONFORMANCE_RESULT,
  CONTROL_PLANE_CONFORMANCE_TERMINAL,
  CONTROL_PLANE_CONFORMANCE_OPEN,
  runControlPlanePortConformance,
} from "../../vendor/paperclip-runner/testing.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { secretEnvironmentValues } from "../agent-identity-redaction.js";
import { nativeSha256 } from "./canonical.js";
import { NativeRunCoordinatorStore } from "./native-run-coordinator-store.js";
import { finalizeNativeRun, repairCommittedNativeChatResponse } from "./native-run-finalizer.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { documentService } from "../documents.js";
import { claimNativeReviewExecutionLock, getNativeReviewAssignment } from "./native-review-participant.js";
import { claimQueuedNativeReviewRun } from "./native-review-dispatch.js";
import { stageNativeRunnerWakeAttachments } from "./native-runner-file-handoff.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { nativeCompletionFeedback } from "./native-completion-feedback.js";
import { buildNativeContinuationPrompt } from "./native-continuation.js";
import { buildPaperclipWakePayload } from "../heartbeat/run-preparation.js";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { buildNativeModelEnvelope } from "../../vendor/paperclip-runner/index.js";
import { ensureNativeCompletionContract, nativeCompletionSource } from "./completion-contracts.js";
import { commitNativeStatusDecision } from "./status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "./status-arbiter.js";
import { createStorageService } from "../../storage/service.js";
import { createLocalDiskStorageProvider } from "../../storage/local-disk-provider.js";
import { buildOnboardingFirstTaskOpeningQuestion, ONBOARDING_FIRST_TASK_OPENING_QUESTION_ID } from "../onboarding-first-task-assets.js";
import { assertCurrentWakeCommentsRead } from "./current-wake-comments.js";
import { buildExecutionContinuation } from "../execution-continuation.js";
import { childReviewOutcomes } from "./child-review-outcomes.js";
import { createPostgresRunDispatchAdapter } from "../../modules/run-dispatch/adapters/postgres.js";
import { createGovernedWaitEventObservation, materializeRuntimeQuestionFallback, nativeGovernedWaitResult } from "./native-session-executor.js";
import {
  subscribeAllCompanyLiveEvents,
  subscribeCompanyLiveEvents,
} from "../live-events.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_CONTROL_PLANE_TEST_DATABASE_URL");

describe("PaperclipControlPlanePort conformance", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>> | null = null;
  let outputStorageRoot: string;
  let db: ReturnType<typeof createDb>;
  const contractId = "00000000-0000-4000-8000-000000000004";
  const contractSha = "phase6-conformance-contract";
  const taskIssueId = "00000000-0000-4000-8000-000000000008";
  const taskContractId = "00000000-0000-4000-8000-000000000009";
  const taskRunId = "00000000-0000-4000-8000-000000000010";
  const taskSessionId = "00000000-0000-4000-8000-000000000018";
  const taskWorkProductId = "00000000-0000-4000-8000-000000000017";
  const workspaceFailureIssueId = "00000000-0000-4000-8000-000000000011";
  const workspaceFailureContractId = "00000000-0000-4000-8000-000000000012";
  const workspaceFailureRunId = "00000000-0000-4000-8000-000000000013";
  const governanceIssueId = "00000000-0000-4000-8000-000000000014";
  const governanceContractId = "00000000-0000-4000-8000-000000000015";
  const governanceRunId = "00000000-0000-4000-8000-000000000016";
  const conformanceRunnerId = "00000000-0000-4000-8000-000000000005";
  const taskRunnerId = "00000000-0000-4000-8000-000000000019";
  const workspaceFailureRunnerId = "00000000-0000-4000-8000-000000000020";
  const governanceRunnerId = "00000000-0000-4000-8000-000000000021";

  beforeAll(async () => {
    outputStorageRoot = await mkdtemp(join(tmpdir(), "paperclip-native-port-output-"));
    if (external) db = createDb(external);
    else {
      temporary = await startRecoveryPostgres("paperclip-native-port-");
      db = createDb(temporary.connectionString);
    }
    await instanceSettingsService(db).updateExperimental({ autoFreshSessionOnRecovery: true });
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    await db.insert(companies).values({ id: identity.companyId, name: "Phase 6", issuePrefix: "P6C" });
    await db.insert(agents).values({
      id: identity.agentId,
      companyId: identity.companyId,
      name: "Native conformance",
      adapterType: "codex_local",
      status: "running",
    });
    await db.insert(issues).values({
      id: identity.issueId,
      companyId: identity.companyId,
      title: "Native conformance",
      status: "in_progress",
      assigneeAgentId: identity.agentId,
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: contractId,
      companyId: identity.companyId,
      issueId: identity.issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "phase6-v1",
        objective: "Conformance",
        criteria: [{ id: "objective", requirement: "Complete conformance" }],
      },
      canonicalSha256: contractSha,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: identity.runId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: identity.issueId,
      nativeSessionId: identity.sessionId,
      runnerInstanceId: conformanceRunnerId,
      completionContractId: contractId,
      completionContractSha256: contractSha,
      contextSnapshot: { issueId: identity.issueId },
    });
    await db.insert(issues).values({
      id: taskIssueId,
      companyId: identity.companyId,
      title: "Complete one native task",
      status: "in_progress",
      assigneeAgentId: identity.agentId,
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: taskContractId,
      companyId: identity.companyId,
      issueId: taskIssueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "phase6-v1",
        objective: "Complete one native task",
        criteria: [{ id: "objective", requirement: "Complete the task" }],
      },
      canonicalSha256: "phase6-task-contract",
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: taskRunId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      status: "running",
      runtimeMode: "native",
      runtimeModeResolverVersion: "phase6-v1",
      runtimeModeReason: "eligible_opt_in",
      nativeIssueId: taskIssueId,
      nativeSessionId: taskSessionId,
      runnerInstanceId: taskRunnerId,
      completionContractId: taskContractId,
      completionContractSha256: "phase6-task-contract",
      contextSnapshot: { issueId: taskIssueId },
    });
    await db.insert(issueWorkProducts).values({
      id: taskWorkProductId,
      companyId: identity.companyId,
      issueId: taskIssueId,
      type: "artifact",
      provider: "paperclip",
      title: "Verified native task result",
      status: "ready_for_review",
      reviewState: "approved",
      createdByRunId: taskRunId,
    });
    await db.insert(issues).values({
      id: workspaceFailureIssueId,
      companyId: identity.companyId,
      title: "Preserve status after workspace failure",
      status: "in_progress",
      assigneeAgentId: identity.agentId,
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: workspaceFailureContractId,
      companyId: identity.companyId,
      issueId: workspaceFailureIssueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "phase6-v1",
        objective: "Preserve status after workspace failure",
        criteria: [{ id: "objective", requirement: "Preserve the result" }],
      },
      canonicalSha256: "phase6-workspace-failure-contract",
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: workspaceFailureRunId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: workspaceFailureIssueId,
      nativeSessionId: identity.sessionId,
      runnerInstanceId: workspaceFailureRunnerId,
      completionContractId: workspaceFailureContractId,
      completionContractSha256: "phase6-workspace-failure-contract",
      contextSnapshot: { issueId: workspaceFailureIssueId },
    });
    await db.insert(issues).values({
      id: governanceIssueId,
      companyId: identity.companyId,
      title: "Respect pending governance",
      status: "in_review",
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: governanceContractId,
      companyId: identity.companyId,
      issueId: governanceIssueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "phase6-v1",
        objective: "Respect pending governance",
        criteria: [{ id: "objective", requirement: "Respect pending governance" }],
      },
      canonicalSha256: "phase6-governance-contract",
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: governanceRunId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: governanceIssueId,
      nativeSessionId: identity.sessionId,
      runnerInstanceId: governanceRunnerId,
      completionContractId: governanceContractId,
      completionContractSha256: "phase6-governance-contract",
      contextSnapshot: { issueId: governanceIssueId },
    });
    await db.insert(issueThreadInteractions).values({
      companyId: identity.companyId,
      issueId: governanceIssueId,
      kind: "request_confirmation",
      status: "pending",
      payload: { version: 1, prompt: "Approve completion?" },
    });
  }, 30_000);

  afterAll(async () => {
    if (temporary) {
      await db.delete(activityLog);
      await db.update(heartbeatRuns).set({ wakeupRequestId: null });
      await db.delete(agentWakeupRequests);
      await db.delete(statusDecisionEffects);
      await db.delete(nativeRunFinalizations);
      await db.delete(statusDecisions);
      await db.delete(workAssessments);
      await db.delete(nativeRunResults);
      await db.delete(issueThreadInteractions);
      await db.delete(issueWorkProducts);
      await db.delete(issueRelations);
      await db.delete(heartbeatRunEvents);
      await db.delete(agentTaskSessions);
      await db.delete(heartbeatRuns);
      await db.delete(completionContracts);
      await db.delete(routineRuns);
      await db.delete(routines);
      await db.delete(issues);
      await db.delete(assets);
      await db.delete(agents);
      await db.delete(companyMemberships);
      await db.delete(companies);
      await db.delete(authUsers);
      await temporary.cleanup();
    }
    await rm(outputStorageRoot, { recursive: true, force: true });
  });

  it.each(["settles", "checkpoint timeout", "unscoped terminal", "verified shutdown"] as const)("settles a durable governed wait through its recorded terminal or shutdown: %s", async mode => {
    const identity = { ...CONTROL_PLANE_CONFORMANCE_OPEN.identity, issueId: randomUUID(), runId: randomUUID(), sessionId: randomUUID() };
    const runnerId = randomUUID();
    const fixtureContractId = randomUUID();
    await db.insert(issues).values({ id: identity.issueId, companyId: identity.companyId, title: "Human-only waiting checkpoint",
      status: "in_progress", assigneeAgentId: identity.agentId });
    const [baseContract] = await db.select().from(completionContracts).where(eq(completionContracts.id, contractId));
    await db.insert(completionContracts).values({ ...baseContract!, id: fixtureContractId, issueId: identity.issueId });
    await db.insert(heartbeatRuns).values({ id: identity.runId, companyId: identity.companyId, agentId: identity.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: identity.issueId, nativeSessionId: identity.sessionId,
      runnerInstanceId: runnerId, completionContractId: fixtureContractId, completionContractSha256: contractSha });
    const interaction = await issueThreadInteractionService(db).create({ id: identity.issueId, companyId: identity.companyId }, {
      kind: "ask_user_questions", title: "Choose the format", resolverPolicy: "human_only", continuationPolicy: "none",
      sourceRunId: identity.runId, payload: { version: 1, title: "Choose the format", questions: [{ id: "format",
        prompt: "Which format?", required: true, selectionMode: "single", options: [{ id: "onsite", label: "On site" }] }] },
    }, { agentId: identity.agentId, runId: identity.runId });
    let releaseObserver!: () => void;
    const observerGate = new Promise<void>(resolve => { releaseObserver = resolve; });
    let terminalWasRecorded = false;
    let terminalRecorded!: () => void;
    const recorded = new Promise<void>(resolve => { terminalRecorded = resolve; });
    let observerFinished!: () => void;
    const observerDone = new Promise<void>(resolve => { observerFinished = resolve; });
    const observation = createGovernedWaitEventObservation(async () => {
      const [pending] = await db.select().from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.id, interaction.id), eq(issueThreadInteractions.companyId, identity.companyId),
        eq(issueThreadInteractions.sourceRunId, identity.runId), eq(issueThreadInteractions.status, "pending"),
      ));
      return pending?.status === "pending" && pending.sourceRunId === identity.runId
        ? nativeGovernedWaitResult({ interaction: pending, completionContract: contract }) : null;
    });
    let triggerConsumed = false;
    const port = new PaperclipControlPlanePort(db, { ...identity,
      completionContractId: fixtureContractId, completionContractSha256: contractSha,
      sourceInstanceId: runnerId, controlPlaneSourceInstanceId: "park-control" }, {
      async onCommittedEvent(event) {
        await observation.observe(event, event.eventType === "item.completed");
        if (event.eventType === "turn.interrupted") { terminalWasRecorded = true; terminalRecorded(); try { await observerGate; } finally { observerFinished(); } }
      },
    });
    const contract = { revision: "phase6-v1", objective: "Conformance", criteria: [{ id: "objective", requirement: "Complete conformance" }] };
    const yielded = nativeGovernedWaitResult({ interaction: { id: interaction.id,
      title: interaction.title ?? null, summary: interaction.summary ?? null }, completionContract: contract });
    const event = (sourceSeq: number, eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent => ({
      schema: "paperclip.prp.event.v1", sourceEventId: `${runnerId}:${sourceSeq}`, sourceInstanceId: runnerId, sourceSeq,
      sourceKind: "runner", runId: identity.runId, normalizedSessionId: identity.sessionId, ...(mode === "unscoped terminal" ? {} : { turnId: "park-turn" }),
      eventType, schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), payload,
    });
    let starts = 0, terminalEmitted = false;
    const backend: NativeSessionBackend = {
      async descriptor() { return { kind: "mock", name: "park-observer", version: "1",
        capabilities: { resume: false, typedEvents: true, steering: false, interruption: true, structuredResult: true } }; },
      async openSession() { return { identity: () => identity,
        async capabilities() { return { resume: false, typedEvents: true, steering: false, interruption: true, structuredResult: true }; },
        async startTurn() { starts++; return { turnId: "park-turn" }; },
        cancel() { return { cleanup: Promise.resolve() }; },
        async settleCancelledTurn() { return { runId: identity.runId, normalizedSessionId: identity.sessionId, turnId: "park-turn" }; },
        async *events() { yield event(1, "item.completed", { kind: "dynamicToolCall" }); terminalEmitted = true;
          if (mode !== "verified shutdown") yield event(2, "turn.interrupted", { status: "interrupted", error: null }); },
        async snapshot() { return { backendKind: "mock", sessionId: identity.sessionId, identity,
          activeTurnId: terminalEmitted ? null : "park-turn", cursor: terminalEmitted && mode !== "verified shutdown" ? "2" : "1" }; },
        async result() { return null; }, async close() {},
      }; },
    };
    const options = { backend, controlPlane: port, timeoutMs: 2_000,
      ...(mode === "checkpoint timeout" ? { checkpointTimeoutMs: 1_000 } : {}),
      runnerInstanceId: runnerId, controlPlaneInstanceId: "park-control",
      input: parseNativeExecutionInput({ schema: "paperclip.native-execution-input.v1", binding: {
        companyId: identity.companyId, runId: identity.runId, issueId: identity.issueId, agentId: identity.agentId, executionWorkspaceId: "park-workspace" },
        task: { identifier: "PARK-1", title: "Wait for a human", description: null, prompt: "Wait for a human", workMode: "standard" },
        workspace: { cwd: process.cwd(), repoUrl: null, repoRef: null, branchName: null },
        session: { normalizedSessionId: identity.sessionId, driverKind: "codex_app_server", protocolVersion: 1 },
        provider: { kind: "codex", model: null }, interactionResponses: [], credentialBindings: [],
        completionContract: { id: fixtureContractId, sha256: contractSha, schemaVersion: "paperclip.completion-contract.v1", contract } }),
      resolveGovernedWait: ({ event }: { event: PrpEvent }) => {
        const result = observation.consume(event);
        triggerConsumed ||= result !== null;
        return result;
      },
    };
    if (mode === "unscoped terminal") releaseObserver();
    const execution = executeNativeSession(options);
    const outcome = execution.then(value => ({ value }), error => ({ error }));
    try {
      if (mode === "verified shutdown") {
        expect(await outcome).toMatchObject({ value: { result: yielded, terminal: { runTerminalState: "succeeded" } } });
        expect(starts).toBe(1);
        expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, identity.runId))).toHaveLength(1);
        expect((await port.loadSessionCheckpoint())?.governedWait?.settlement).toEqual({
          runId: identity.runId, normalizedSessionId: identity.sessionId, turnId: "park-turn",
        });
        expect((await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, identity.runId)))
          .some(row => row.eventType.startsWith("turn."))).toBe(false);
        expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id)))[0])
          .toMatchObject({ status: "pending", result: null, effectiveResolverPolicy: "human_only", sourceRunId: identity.runId });
        return;
      }
      await Promise.race([recorded, outcome.then(result => { if ("error" in result) throw result.error; throw new Error("run settled before recording terminal"); })]);
      const rows = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, identity.runId));
      expect(rows.some(row => row.eventType === "turn.interrupted")).toBe(true);
      expect(triggerConsumed).toBe(true);
      if (mode !== "unscoped terminal") {
        if (mode === "settles") await new Promise(resolve => setTimeout(resolve, 700));
        else expect(await outcome).toMatchObject({ error: { message: "native session checkpoint timed out after 1000ms" } });
        expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, identity.runId))).toEqual([]);
        releaseObserver();
        await observerDone;
        if (mode === "settles") expect(await outcome).not.toHaveProperty("error");
        else {
          expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, identity.runId))).toEqual([]);
          const restored = new PaperclipControlPlanePort(db, { ...identity, completionContractId: fixtureContractId,
            completionContractSha256: contractSha, sourceInstanceId: runnerId, controlPlaneSourceInstanceId: "park-control" });
          const checkpoint = await restored.loadSessionCheckpoint();
          expect(checkpoint?.governedWait?.sourceEvent).toMatchObject({ sourceSeq: 1, turnId: "park-turn" });
          const session = await backend.openSession({ identity });
          const recovering = { ...backend, async recoverSession() { return { recovered: true as const, session }; } };
          await expect(executeNativeSession({ ...options, checkpointTimeoutMs: 1_000, controlPlane: restored,
            backend: recovering, persistedSession: checkpoint })).resolves.toMatchObject({ result: yielded });
        }
      } else {
        expect(await outcome).not.toHaveProperty("error");
        expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, identity.runId))).toHaveLength(1);
      }
      expect(starts).toBe(1);
      expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id)))[0]).toMatchObject({
        status: "pending", result: null, effectiveResolverPolicy: "human_only", continuationPolicy: "none", sourceRunId: identity.runId,
      });
    } finally { releaseObserver(); await outcome; if (terminalWasRecorded) await observerDone; }
  });

  it.each((["no wake", "wake", "clamp"] as const).flatMap(mode =>
    [false, true].map(taskRecovery => ({ mode, taskRecovery }))))(
    "marks a fresh start after a prior session once, but never a resume: $mode (automatic task recovery=$taskRecovery)", async ({ mode, taskRecovery }) => {
    const { companyId, agentId } = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const issueId = randomUUID(), fixtureContractId = randomUUID();
    const workspaceContinuity = mode === "clamp"
      ? { mode: "fresh_isolated_workspace", sourceRunId: randomUUID(), contentOrigin: "configured_source" }
      : mode === "wake" ? { mode: "reuse_current_workspace", sourceRunId: null, contentOrigin: "existing_workspace" }
        : { mode: "unknown", sourceRunId: null, contentOrigin: "unknown" };
    const continuityContext = mode === "no wake" ? {} : { workspaceContinuity };
    const firstRunAt = new Date("2026-01-01T00:00:00.000Z");
    const wakeAt = new Date("2026-01-01T00:00:19.000Z");
    const previousReplyAt = mode === "clamp" ? wakeAt : new Date("2026-01-01T00:00:10.000Z");
    const markers = () => db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId),
      sql`${issueComments.presentation}->>'kind' = 'system_notice'`));
    await db.insert(issues).values({ id: issueId, companyId, title: "Fresh-session disclosure",
      assigneeAgentId: agentId, ...(!taskRecovery ? {
        conversationAgentId: agentId, conversationUserId: randomUUID(), conversationState: "active",
      } : {}) });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.id, contractId));
    await db.insert(completionContracts).values({ ...contract!, id: fixtureContractId, issueId });
    let replayFirst: () => Promise<unknown> = async () => {};
    let previousSessionId: string | null = null;
    let recoveryInput: HeartbeatSessionPreparationInput | undefined;
    for (const [index, eventType] of (["session.started", "session.started", "session.resumed", "session.started"] as const).entries()) {
      const runId = randomUUID(), sessionId = randomUUID(), runnerId = randomUUID();
      const identity = { companyId, agentId, issueId, runId, sessionId };
      const runAt = new Date(firstRunAt.getTime() + index * 20_000);
      let wakeCommentId: string | undefined;
      if (index === 1 && mode !== "no wake") {
        const [wake] = await db.insert(issueComments).values({ companyId, issueId, body: "Start the next session",
          authorType: "user", authorUserId: "board", createdAt: wakeAt }).returning();
        wakeCommentId = wake!.id;
      }
      const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
        nativeIssueId: issueId, nativeSessionId: sessionId, runnerInstanceId: runnerId,
        completionContractId: fixtureContractId, completionContractSha256: contractSha, createdAt: runAt,
        contextSnapshot: { issueId, conversationSessionGeneration: 0, ...continuityContext, ...(wakeCommentId ? { wakeCommentId } : {}),
          ...(taskRecovery && index === 3 ? { explicitFreshSession: true } : {}) } }).returning();
      if (taskRecovery && index === 1) {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
        const runtimeConfig = { provider: "pi_rpc", model: "fixture/model", sessionContinuity: "continuous" };
        const context = { issueId, forceFreshSession: true, source: "execution.reconciled", conversationSessionGeneration: 0, ...continuityContext };
        recoveryInput = {
          run, agent: { ...agent, adapterType: "paperclip_runner", adapterConfig: runtimeConfig },
          task: { context, issueRef: { id: issueId }, issueContext: null, taskProjectContext: null, workspaceProjectContext: null,
            wakeCommentId: null, acceptedPlanContinuationWake: false, acceptedPlanWakeRoutingDecision: null },
          session: { taskSession: null, taskSessionDecodedParams: { sessionId: previousSessionId }, explicitResumeSessionParams: null,
            explicitResumeSessionDisplayId: null, sessionCodec: getAdapterSessionCodec("paperclip_runner") },
          config: { runtimeConfig, agentIdentity: undefined, issueAssigneeOverrides: null, originalAiIssueOverrides: null,
            managedAiRuntime: undefined, aiBinding: undefined, requestedAiBinding: undefined, secretManifest: [],
            runtimeSkillEntries: [], routineEnvContext: { env: null } },
          workspace: { requestedExecutionWorkspaceMode: "shared_workspace", effectiveExecutionWorkspaceMode: "shared_workspace",
            projectExecutionWorkspacePolicy: null, issueExecutionWorkspaceSettings: null, executionPolicy: {} as never,
            requestedReusableExecutionWorkspaceConfig: null, reusableExistingExecutionWorkspace: null },
          environment: { environmentResolution: { environmentId: null, source: "default" }, selectedEnvironmentId: null,
            selectedEnvironmentForConfig: null },
          getLatestAgentConfigRevision: async () => ({ id: agent.id, changedKeys: [], createdAt: run.createdAt }),
        };
        const prepared = await prepareHeartbeatSession(db, recoveryInput);
        expect(prepared.resetTaskSession).toBe(true);
        expect(prepared.taskResumeSessionId).toBeNull();
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].contextSnapshot)
          .toMatchObject({ warmRecoveryFreshSession: { runId } });
      }
      const port = new PaperclipControlPlanePort(db, { ...identity, completionContractId: fixtureContractId,
        completionContractSha256: contractSha, sourceInstanceId: runnerId, controlPlaneSourceInstanceId: "marker-control" });
      await port.openRun({ identity, backendKind: "mock", sourceInstanceId: runnerId });
      const event: PrpEvent = { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceEventId: `${runnerId}:1`,
        sourceInstanceId: runnerId, sourceSeq: 1, sourceKind: "runner", runId, normalizedSessionId: sessionId,
        eventType, priority: 0, emittedAt: new Date(runAt.getTime() + 5_000).toISOString(), payload: {} };
      if (index === 3) {
        const markerWrite = vi.spyOn(issueCommentWrites, "insertIssueComment").mockRejectedValueOnce(new Error("marker write failed"));
        try { await expect(port.appendEvent(event)).resolves.toMatchObject({ disposition: "committed" }); }
        finally { markerWrite.mockRestore(); }
        expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId))).toHaveLength(1);
      } else await port.appendEvent(event);
      // CHPORT: consume the REAL port-written session.started receipt, not a
      // hand-shaped DB event. The explicit fresh request starts S2 after the
      // automatic S1 incident, and preparation must anchor its next incident on S2.
      if (taskRecovery && index === 3) {
        expect(recoveryInput).toBeDefined();
        const baseline = await prepareHeartbeatSession(db, { ...recoveryInput!,
          task: { ...recoveryInput!.task, context: {} } });
        const [boundary] = await db.update(heartbeatRuns).set({ status: "failed", error: "ordinary provider failure" })
          .where(eq(heartbeatRuns.id, runId)).returning();
        const [current] = await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: issueId,
          status: "queued", createdAt: new Date(boundary.createdAt.getTime() + 1), contextSnapshot: { issueId },
        }).returning();
        // C34A8-PORT: S2 really started, but publication still points at S1.
        const [incident] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, recoveryInput!.run.id));
        const s1 = incident.nativeSessionId!;
        const [lagging] = await db.insert(agentTaskSessions).values({ companyId, agentId, adapterType: "paperclip_runner", taskKey: issueId,
          lastRunId: recoveryInput!.run.id, sessionDisplayId: s1,
          sessionParamsJson: attachPaperclipSessionMetadataToSessionParams({ sessionId: s1 }, baseline.configuredModel, baseline.sessionConfigMetadata),
        }).returning();
        const nextInput = { ...recoveryInput!, run: current,
          task: { ...recoveryInput!.task, context: { forceFreshSession: true, source: "execution.reconciled" } },
          session: { ...recoveryInput!.session, taskSession: lagging, taskSessionDecodedParams: { sessionId: s1 } },
        };
        await instanceSettingsService(db).updateExperimental({ autoFreshSessionOnRecovery: false });
        const ordinary = await prepareHeartbeatSession(db, nextInput);
        await instanceSettingsService(db).updateExperimental({ autoFreshSessionOnRecovery: true });
        process.stdout.write(`C34A8-PORT ${JSON.stringify({ s1, s2: sessionId, boundaryRunId: runId,
          nextRunId: current.id, resumes: ordinary.taskResumeSessionId, pin: ordinary.warmRecoveryRetainSessionId,
          reset: ordinary.resetTaskSession })}\n`);
        expect(ordinary.resetTaskSession).toBe(false);
        expect(ordinary.warmRecoveryRetainSessionId).toBeNull();
        expect(ordinary.taskResumeSessionId).toBe(sessionId);
        // Preserve CHPORT's existing refusal/new-incident check too.
        await db.update(heartbeatRuns).set({ error: "native_controller_recovery_missing_evidence:retained_sandbox_binding" }).where(eq(heartbeatRuns.id, runId));
        const next = await prepareHeartbeatSession(db, nextInput);
        const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, current.id));
        expect(next.resetTaskSession).toBe(true);
        expect(next.warmRecoveryRetainSessionId).toBeNull();
        expect(saved.contextSnapshot).toMatchObject({ warmRecoveryFreshSession: { runId: current.id, retainedSessionId: sessionId } });
        const [receipt] = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
        expect(receipt.payload).toMatchObject({ prpEvent: { normalizedSessionId: sessionId } });
        process.stdout.write(`CHPORT ${JSON.stringify({ boundaryRunId: runId, sessionId, eventType: receipt.eventType,
          nextRunId: current.id, nextIncident: saved.contextSnapshot?.warmRecoveryFreshSession })}\n`);
      }
      if (index === 0) {
        replayFirst = () => port.appendEvent(event);
        previousSessionId = sessionId;
        await db.insert(issueComments).values({ companyId, issueId, body: "Previous session reply", authorType: "agent",
          authorAgentId: agentId, createdByRunId: runId, createdAt: previousReplyAt });
        if (taskRecovery) await db.update(heartbeatRuns).set({ status: "failed",
          error: "native_controller_recovery_missing_evidence:retained_sandbox_binding" })
          .where(eq(heartbeatRuns.id, runId));
      }
      const comments = await markers();
      expect(comments).toHaveLength(index === 0 ? 0 : 1);
      if (index === 1) {
        expect(comments[0]).toMatchObject({ authorType: "system", authorAgentId: null, authorUserId: null,
          body: "New session · Earlier messages and files are still available.",
          createdByRunId: null, conversationSessionGeneration: 0, metadata: { sourceRunId: runId, workspaceContinuity },
          presentation: { kind: "system_notice", tone: "neutral" } });
        // Marker time orders the input, not the later session.started receipt.
        const expectedAt = mode === "no wake" ? run!.createdAt
          : new Date(Math.max(wakeAt.getTime() - 1, previousReplyAt.getTime() + 1));
        expect(comments[0]!.createdAt).toEqual(expectedAt);
        const [receipt] = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
        const [startedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        if (taskRecovery) {
          expect(startedRun.contextSnapshot).toMatchObject({ warmRecoveryFreshSession: { runId } });
          expect(receipt).toMatchObject({ runId, eventType: "session.started" });
          expect(comments[0]!.metadata).toMatchObject({ sourceRunId: receipt!.runId });
          process.stdout.write(`RECOVERY_RESET_START_MARKER ${JSON.stringify({ runId,
            reset: startedRun.contextSnapshot?.warmRecoveryFreshSession, sessionId: startedRun.nativeSessionId,
            event: { runId: receipt!.runId, eventType: receipt!.eventType },
            comment: { id: comments[0]!.id, body: comments[0]!.body, metadata: comments[0]!.metadata } })}\n`);
        }
        // Without a wake, preserve the original recovery marker's run-creation assertion.
        if (mode === "no wake") expect(comments[0]!.createdAt).toEqual(startedRun.createdAt);
        expect(comments[0]!.createdAt.getTime()).toBeLessThanOrEqual(receipt!.createdAt.getTime());
        await db.update(issueComments).set({ deletedAt: new Date(runAt.getTime() + 10_000) }).where(eq(issueComments.id, comments[0]!.id));
        await port.appendEvent(event);
        await port.appendEvent({ ...event, sourceEventId: `${runnerId}:2`, sourceSeq: 2 });
        expect(await markers()).toHaveLength(1);
      }
    }
    await replayFirst(); // A later session must not turn the original first start into a marker on replay.
    expect(await markers()).toHaveLength(1);
    const activities = await db.select().from(activityLog).where(and(eq(activityLog.entityId, issueId),
      eq(activityLog.action, "issue.conversation_session_started")));
    expect(activities).toHaveLength(1);
    expect(activities[0]!.details).toMatchObject({ automatic: true, generation: 0, workspaceContinuity });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toMatchObject({ conversationSessionGeneration: 0, conversationBoundaryCommentId: null });
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId), sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`))).toHaveLength(0);
  }, 30_000);

  it.each(["single", "batch", "clamp", "no wake", "foreign wake"] as const)("orders the fresh-session marker against its first input: %s", async mode => {
    const { companyId, agentId } = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const issueId = randomUUID(), fixtureContractId = randomUUID();
    const runAt = new Date("2026-01-01T00:00:10.000Z"), wakeAt = new Date(runAt.getTime() - 1_000);
    await db.insert(issues).values({ id: issueId, companyId, title: "Marker ordering", assigneeAgentId: agentId,
      conversationAgentId: agentId, conversationUserId: randomUUID(), conversationState: "active" });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.id, contractId));
    await db.insert(completionContracts).values({ ...contract!, id: fixtureContractId, issueId });
    const priorRunId = randomUUID(), runId = randomUUID(), sharedSessionId = randomUUID();
    const previousAt = new Date(mode === "clamp" ? wakeAt.getTime() : wakeAt.getTime() - 2_000);
    let markerRun!: typeof heartbeatRuns.$inferSelect;
    for (const [index, id] of [priorRunId, runId].entries()) {
      const sessionId = mode === "clamp" ? sharedSessionId : randomUUID(), runnerId = randomUUID();
      const identity = { companyId, agentId, issueId, runId: id, sessionId };
      let context: Record<string, unknown> = { issueId, conversationSessionGeneration: 0 };
      if (index === 1 && mode !== "no wake") {
        const [wake] = await db.insert(issueComments).values({ companyId,
          issueId: mode === "foreign wake" ? CONTROL_PLANE_CONFORMANCE_OPEN.identity.issueId : issueId,
          body: "First new-session input", authorType: "user", authorUserId: "board", createdAt: wakeAt }).returning();
        context.wakeCommentId = wake!.id;
        if (mode === "batch") {
          const [later] = await db.insert(issueComments).values({ companyId, issueId, body: "Later input",
            authorType: "user", authorUserId: "board", createdAt: new Date(wakeAt.getTime() + 500) }).returning();
          context = { ...context, wakeCommentId: later!.id, wakeCommentIds: [later!.id, wake!.id] };
        }
      }
      const [run] = await db.insert(heartbeatRuns).values({ id, companyId, agentId, status: "running", runtimeMode: "native",
        nativeIssueId: issueId, nativeSessionId: sessionId, runnerInstanceId: runnerId,
        completionContractId: fixtureContractId, completionContractSha256: contractSha, contextSnapshot: context,
        createdAt: index === 0 ? new Date(previousAt.getTime() - 1_000) : runAt }).returning();
      const port = new PaperclipControlPlanePort(db, { ...identity, completionContractId: fixtureContractId,
        completionContractSha256: contractSha, sourceInstanceId: runnerId, controlPlaneSourceInstanceId: "order-control" });
      await port.openRun({ identity, backendKind: "mock", sourceInstanceId: runnerId });
      await port.appendEvent({ schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceEventId: `${runnerId}:1`,
        sourceInstanceId: runnerId, sourceSeq: 1, sourceKind: "runner", runId: id, normalizedSessionId: sessionId,
        eventType: "session.started", priority: 0, emittedAt: runAt.toISOString(), payload: {} });
      if (index === 0) await db.insert(issueComments).values({ companyId, issueId, body: "Previous session answer",
        authorType: "agent", authorAgentId: agentId, createdByRunId: id, createdAt: previousAt });
      else markerRun = run!;
    }
    const thread = await issueService(db).listComments(issueId, { companyId, order: "asc" });
    const [storedMarker] = await db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId),
      sql`${issueComments.metadata}->>'sourceRunId' = ${runId}`));
    const marker = thread.find(comment => comment.id === storedMarker?.id)!;
    expect(marker).toBeDefined();
    expect(storedMarker).toMatchObject({ conversationSessionGeneration: 0, presentation: { kind: "system_notice" },
      metadata: { version: 1, sourceRunId: runId, sections: [] } });
    const expected = mode === "no wake" || mode === "foreign wake" ? markerRun.createdAt
      : new Date(Math.max(previousAt.getTime() + 1, wakeAt.getTime() - 1));
    expect(marker.createdAt).toEqual(expected);
    expect(thread.findIndex(comment => comment.body === "Previous session answer")).toBeLessThan(thread.indexOf(marker));
    if (mode === "single" || mode === "batch") {
      expect(marker.createdAt.getTime()).toBeLessThan(wakeAt.getTime());
      expect(thread.indexOf(marker)).toBeLessThan(thread.findIndex(comment => comment.body === "First new-session input"));
    }
  });

  async function terminalObserverFixture(options: {
    secrets?: readonly string[];
    onCommittedEvent?: (event: PrpEvent) => Promise<void>;
    onDuplicateEvent?: (event: PrpEvent) => Promise<void>;
    assertControllerActive?: () => void;
  } = {}) {
    const identity = { ...CONTROL_PLANE_CONFORMANCE_OPEN.identity, runId: randomUUID(), sessionId: randomUUID() };
    const runnerId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: identity.runId, companyId: identity.companyId, agentId: identity.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: identity.issueId, nativeSessionId: identity.sessionId,
      runnerInstanceId: runnerId, completionContractId: contractId, completionContractSha256: contractSha });
    const binding = { ...identity, completionContractId: contractId, completionContractSha256: contractSha,
      sourceInstanceId: runnerId, controlPlaneSourceInstanceId: "observer-control" };
    const port = new PaperclipControlPlanePort(db, binding, options);
    await port.openRun({ identity, backendKind: "mock", sourceInstanceId: runnerId });
    const event: PrpEvent = { schema: "paperclip.prp.event.v1", sourceEventId: `${runnerId}:1`, sourceInstanceId: runnerId,
      sourceSeq: 1, sourceKind: "runner", runId: identity.runId, normalizedSessionId: identity.sessionId,
      turnId: "observer-turn", eventType: "turn.interrupted", schemaVersion: 1, priority: 0,
      emittedAt: new Date().toISOString(), payload: { status: "interrupted", error: null } };
    const snapshot = { backendKind: "mock" as const, sessionId: identity.sessionId, identity };
    const result = { result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL };
    return { identity, runnerId, binding, port, event, snapshot, result };
  }

  it("masks the rest of a secret that arrives after a controller restart between deltas", async () => {
    const identity = { ...CONTROL_PLANE_CONFORMANCE_OPEN.identity, runId: randomUUID(), sessionId: randomUUID() };
    const runnerId = randomUUID();
    const secret = "abcdefgh1234567890";
    await db.insert(heartbeatRuns).values({
      id: identity.runId, companyId: identity.companyId, agentId: identity.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: identity.issueId,
      nativeSessionId: identity.sessionId, runnerInstanceId: runnerId,
      completionContractId: contractId, completionContractSha256: contractSha,
      contextSnapshot: { issueId: identity.issueId },
    });
    const binding = { ...identity, completionContractId: contractId, completionContractSha256: contractSha,
      sourceInstanceId: runnerId, controlPlaneSourceInstanceId: `restart-${identity.runId}` };
    const delta = (sourceSeq: number, text: string): PrpEvent => ({
      schema: "paperclip.prp.event.v1", sourceEventId: `${runnerId}:${sourceSeq}`, sourceSeq,
      sourceInstanceId: runnerId, sourceKind: "runner", runId: identity.runId,
      normalizedSessionId: identity.sessionId, turnId: "restart-turn", itemId: "restart-item",
      eventType: "item.delta", schemaVersion: 1, priority: 1, emittedAt: new Date().toISOString(),
      payload: { itemId: "restart-item", kind: "commandExecution", text, update: { delta: text } },
    });
    const before = new PaperclipControlPlanePort(db, binding, { secrets: [secret] });
    await before.openRun({ identity, backendKind: "mock", sourceInstanceId: runnerId });
    await before.appendEvent(delta(1, `echo ${secret.slice(0, 8)}`));
    const after = new PaperclipControlPlanePort(db, binding, { secrets: [secret] });
    await after.appendEvent(delta(2, `${secret.slice(8)} done`));
    const persisted = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, identity.runId));
    expect(JSON.stringify(persisted)).not.toContain(secret.slice(8));
    expect(JSON.stringify(persisted)).not.toContain(secret.slice(0, 8));
    expect(JSON.stringify(persisted)).toContain('"text":"echo "');
    expect(JSON.stringify(persisted)).toContain('"text":"***REDACTED*** done"');
  });

  it("keeps a held fragment of a resumed secret masked when the turn ends", async () => {
    const identity = { ...CONTROL_PLANE_CONFORMANCE_OPEN.identity, runId: randomUUID(), sessionId: randomUUID() };
    const runnerId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: identity.runId, companyId: identity.companyId, agentId: identity.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: identity.issueId,
      nativeSessionId: identity.sessionId, runnerInstanceId: runnerId,
      completionContractId: contractId, completionContractSha256: contractSha,
      contextSnapshot: { issueId: identity.issueId },
    });
    const observed: PrpEvent[] = [];
    const port = new PaperclipControlPlanePort(db, { ...identity, completionContractId: contractId, completionContractSha256: contractSha,
      sourceInstanceId: runnerId, controlPlaneSourceInstanceId: `ending-${identity.runId}` },
      { secrets: ["old-prefix-XYZabcdef", "abcdefghij"], onCommittedEvent: async event => { observed.push(event); } });
    await port.openRun({ identity, backendKind: "mock", sourceInstanceId: runnerId });
    const delta: PrpEvent = { schema: "paperclip.prp.event.v1", sourceEventId: `${runnerId}:1`, sourceSeq: 1,
      sourceInstanceId: runnerId, sourceKind: "runner", runId: identity.runId, normalizedSessionId: identity.sessionId,
      turnId: "ending-turn", itemId: "ending-item", eventType: "item.delta", schemaVersion: 1, priority: 1,
      emittedAt: new Date().toISOString(), payload: { itemId: "ending-item", kind: "commandExecution", text: "XYZabcdef" } };
    const terminal: PrpEvent = { schema: "paperclip.prp.event.v1", sourceEventId: `${runnerId}:2`, sourceSeq: 2,
      sourceInstanceId: runnerId, sourceKind: "runner", runId: identity.runId, normalizedSessionId: identity.sessionId,
      turnId: "ending-turn", eventType: "turn.completed", schemaVersion: 1, priority: 0,
      emittedAt: new Date().toISOString(), payload: { status: "completed" } };
    await port.appendEvent(delta);
    await port.appendEvent(terminal);
    const persisted = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, identity.runId));
    for (const value of [persisted, observed]) {
      expect(JSON.stringify(value)).not.toContain("abcdef");
      expect(JSON.stringify(value)).not.toContain("XYZ");
    }
    expect(observed.at(-1)?.payload.outputTails).toEqual([{ itemId: "ending-item",
      payload: { itemId: "ending-item", kind: "commandExecution", text: "***REDACTED***" } }]);
  });

  it("records the lateness of each committed runner event once for the server metrics", async () => {
    const metrics = startServerMetrics();
    try {
      const f = await terminalObserverFixture();
      const event = { ...f.event, emittedAt: new Date(Date.now() - 2_000).toISOString() };
      await f.port.appendEvent(event);
      await f.port.appendEvent(event);
      const snapshot = metrics.snapshot();
      expect(snapshot.runEventLatenessSamples).toBe(1);
      expect(snapshot.runEventLatenessP99Ms).toBeGreaterThanOrEqual(1_900);
    } finally {
      stopServerMetrics(metrics);
    }
  });

  it("completes a native run when a bound secret equals a protocol word", async () => {
    const observed: PrpEvent[] = [];
    const f = await terminalObserverFixture({ secrets: ["interrupted", "completed", "succeeded", "satisfied"],
      async onCommittedEvent(event) { observed.push(event); } });
    await f.port.appendEvent(f.event);
    await f.port.checkpointSession(f.snapshot);
    await f.port.completeRun(f.result);
    expect(observed.map(event => [event.eventType, event.payload.status])).toEqual([["turn.interrupted", "interrupted"]]);
    const [result] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.identity.runId));
    expect(JSON.stringify(result)).toContain('"turnTerminalState":"completed"');
    expect(JSON.stringify(result)).toContain('"runTerminalState":"succeeded"');
    expect(JSON.stringify(result)).toContain('"status":"satisfied"');
  });

  it.each(["default", "deferred"] as const)("keeps %s terminal observation owned before checkpoint and result acceptance", async mode => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let observed = 0;
    const f = await terminalObserverFixture({ async onCommittedEvent() { observed++; await gate; } });
    const signal = new AbortController().signal;
    let appendSettled = false;
    const append = f.port.appendEvent(f.event, { signal, ...(mode === "deferred" ? { deferPostCommitObservers: true } : {}) })
      .then(receipt => { appendSettled = true; return receipt; });
    let checkpointSettled = false, resultSettled = false;
    try {
      if (mode === "deferred") {
        expect(await append).toMatchObject({ disposition: "committed" });
        const checkpoint = f.port.checkpointSession(f.snapshot, { signal }).then(() => { checkpointSettled = true; });
        const result = f.port.completeRun(f.result, { signal }).then(() => { resultSettled = true; });
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(checkpointSettled).toBe(false);
        expect(resultSettled).toBe(false);
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.identity.runId)))[0]!.runnerProfileJson?.sessionCheckpoint).toBeUndefined();
        expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.identity.runId))).toEqual([]);
        release(); await Promise.all([checkpoint, result]);
      } else {
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(appendSettled).toBe(false);
      }
    } finally { release(); await append; }
    expect(observed).toBe(1);
  });

  it("returns the default committed receipt when cancellation arrives during its postcommit observer", async () => {
    let release!: () => void, observed!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { observed = resolve; });
    const f = await terminalObserverFixture({ async onCommittedEvent() { observed(); await gate; } });
    const controller = new AbortController();
    const outcome = f.port.appendEvent(f.event, { signal: controller.signal }).then(receipt => ({ receipt }), error => ({ error }));
    try {
      await started;
      expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.identity.runId))).toHaveLength(1);
      const cancellation = new Error("cancelled after event transaction committed");
      controller.abort(cancellation);
      release();
      expect(await outcome).toMatchObject({ receipt: { disposition: "committed" } });
      await expect(f.port.checkpointSession(f.snapshot, { signal: controller.signal })).rejects.toBe(cancellation);
      await expect(f.port.completeRun(f.result, { signal: controller.signal })).rejects.toBe(cancellation);
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.identity.runId))).toEqual([]);
    } finally { release(); await outcome; }
  });

  it("retains the original deferred observer rejection for checkpoint and result acceptance", async () => {
    let reject!: (error: Error) => void;
    const gate = new Promise<void>((_resolve, no) => { reject = no; });
    const original = new Error("accounting persistence rejected");
    const f = await terminalObserverFixture({ async onCommittedEvent() { await gate; } });
    const signal = new AbortController().signal;
    await f.port.appendEvent(f.event, { signal, deferPostCommitObservers: true });
    const checkpoint = f.port.checkpointSession(f.snapshot, { signal }).catch(error => error);
    const result = f.port.completeRun(f.result, { signal }).catch(error => error);
    reject(original);
    expect(await checkpoint).toBe(original); expect(await result).toBe(original);
    await expect(f.port.completeRun(f.result)).rejects.toBe(original);
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.identity.runId))).toEqual([]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.identity.runId)))[0]!.runnerProfileJson?.sessionCheckpoint).toBeUndefined();
  });

  it.each(["abort", "detach"] as const)("revokes a checkpoint and result waiting for deferred observation on %s", async reason => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let detached = false;
    const original = new Error("controller authority revoked");
    const f = await terminalObserverFixture({ async onCommittedEvent() { await gate; },
      assertControllerActive() { if (detached) throw original; } });
    const controller = new AbortController();
    await f.port.appendEvent(f.event, { signal: controller.signal, deferPostCommitObservers: true });
    const checkpoint = f.port.checkpointSession(f.snapshot, { signal: controller.signal }).catch(error => error);
    const result = f.port.completeRun(f.result, { signal: controller.signal }).catch(error => error);
    if (reason === "abort") controller.abort(original); else detached = true;
    release();
    expect(await checkpoint).toBe(original); expect(await result).toBe(original);
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.identity.runId))).toEqual([]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.identity.runId)))[0]!.runnerProfileJson?.sessionCheckpoint).toBeUndefined();
  });

  it("keeps a later observer error visible after an aborted checkpoint stops waiting", async () => {
    let reject!: (error: Error) => void;
    const gate = new Promise<void>((_resolve, no) => { reject = no; });
    const f = await terminalObserverFixture({ async onCommittedEvent() { await gate; } });
    const controller = new AbortController();
    await f.port.appendEvent(f.event, { signal: controller.signal, deferPostCommitObservers: true });
    const checkpoint = f.port.checkpointSession(f.snapshot, { signal: controller.signal }).catch(error => error);
    const stop = new Error("checkpoint authority revoked");
    controller.abort(stop);
    expect(await checkpoint).toBe(stop);
    const original = new Error("retained accounting failure after revocation");
    reject(original);
    await expect(f.port.completeRun(f.result)).rejects.toBe(original);
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.identity.runId))).toEqual([]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.identity.runId)))[0]!.runnerProfileJson?.sessionCheckpoint).toBeUndefined();
  });

  it("joins the exact deferred observer on duplicate append and replays it after a new port opens", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let observed = 0, replayed = 0;
    const f = await terminalObserverFixture({ async onCommittedEvent() { observed++; await gate; },
      async onDuplicateEvent() { throw new Error("must join the original owned observation"); } });
    const signal = new AbortController().signal;
    await f.port.appendEvent(f.event, { signal, deferPostCommitObservers: true });
    let duplicateSettled = false;
    const duplicate = f.port.appendEvent(f.event, { signal }).then(value => { duplicateSettled = true; return value; });
    try {
      await new Promise(resolve => setTimeout(resolve, 30)); expect(duplicateSettled).toBe(false);
      release(); expect(await duplicate).toMatchObject({ disposition: "duplicate" });
      expect(observed).toBe(1);
      const restored = new PaperclipControlPlanePort(db, f.binding, { async onDuplicateEvent() { replayed++; } });
      await restored.openRun({ identity: f.identity, backendKind: "mock", sourceInstanceId: f.runnerId });
      await expect(restored.appendEvent(f.event)).resolves.toMatchObject({ disposition: "duplicate" });
      expect(replayed).toBe(1);
      expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.identity.runId))).toHaveLength(1);
    } finally { release(); await duplicate; }
  });

  it("joins the deferred observer it saw on arrival even when that observer settles during the duplicate's persistence", async () => {
    let release!: () => void, unlock!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const unlocked = new Promise<void>(resolve => { unlock = resolve; });
    const lockHeld = new Promise<void>(resolve => { locked = resolve; });
    let observed = 0, duplicates = 0;
    const f = await terminalObserverFixture({ async onCommittedEvent() { observed++; await gate; },
      async onDuplicateEvent() { duplicates++; } });
    const signal = new AbortController().signal;
    await f.port.appendEvent(f.event, { signal, deferPostCommitObservers: true });
    const lock = db.transaction(async tx => {
      await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, f.identity.runId)).for("update");
      locked(); await unlocked;
    });
    let duplicate: Promise<unknown> | undefined;
    try {
      await lockHeld;
      duplicate = f.port.appendEvent(f.event, { signal });
      release(); await new Promise(resolve => setTimeout(resolve, 0));
      unlock(); await lock;
      expect(await duplicate).toMatchObject({ disposition: "duplicate" });
      expect(observed).toBe(1);
      expect(duplicates).toBe(0);
    } finally { release(); unlock(); await lock; await duplicate?.catch(() => {}); }
  });

  it.each(["company", "agent", "run", "session", "source", "failed", "unproven", "nonterminal", "unscoped"] as const)("does not grant deferred terminal authority to %s evidence", async fault => {
    const f = await terminalObserverFixture();
    const event = { ...f.event,
      ...(fault === "run" ? { runId: randomUUID() } : {}),
      ...(fault === "session" ? { normalizedSessionId: randomUUID() } : {}),
      ...(fault === "source" ? { sourceInstanceId: randomUUID() } : {}),
      ...(fault === "failed" ? { eventType: "turn.failed" as const } : {}),
      ...(fault === "unproven" ? { payload: { providerTerminalObserved: false } } : {}),
      ...(fault === "nonterminal" ? { eventType: "item.completed" as const } : {}),
      ...(fault === "unscoped" ? { turnId: undefined } : {}),
    };
    const port = fault === "company" || fault === "agent" ? new PaperclipControlPlanePort(db, { ...f.binding,
      ...(fault === "company" ? { companyId: randomUUID() } : { agentId: randomUUID() }) }) : f.port;
    await expect(port.appendEvent(event, { signal: new AbortController().signal, deferPostCommitObservers: true })).rejects.toThrow();
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.identity.runId))).toEqual([]);
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.identity.runId))).toEqual([]);
  });

  it("publishes native recovery metadata in the existing snapshot transaction and fences stale generations", async () => {
    const identity = { ...CONTROL_PLANE_CONFORMANCE_OPEN.identity, runId: randomUUID(), sessionId: randomUUID() };
    const runnerId = randomUUID();
    const owner = { ...identity, authorityRunId: identity.runId, bootId: randomUUID(), generation: 1, leaseOwner: "snapshot-owner" };
    await db.insert(heartbeatRuns).values({ id: identity.runId, companyId: identity.companyId, agentId: identity.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: identity.issueId, nativeSessionId: identity.sessionId,
      runnerInstanceId: runnerId, completionContractId: contractId, completionContractSha256: contractSha,
      runnerProfileJson: { unrelated: "preserve" } });
    await db.insert(nativeRunFinalizations).values({ runId: identity.runId, companyId: identity.companyId, issueId: identity.issueId,
      phase: "observed",
      controllerBootId: owner.bootId, controllerGeneration: owner.generation, leaseOwner: owner.leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000) });
    const port = new PaperclipControlPlanePort(db, { ...identity, completionContractId: contractId,
      completionContractSha256: contractSha, sourceInstanceId: runnerId, controlPlaneSourceInstanceId: "snapshot-control" }, {
      nativeRecovery: { owner, compatibility: { configDigest: `sha256:${"a".repeat(64)}`, processConfigDigest: null } },
    });
    await port.openRun({ identity, backendKind: "mock", sourceInstanceId: runnerId });
    const snapshot = { backendKind: "mock" as const, sessionId: identity.sessionId, identity };
    const statements: string[] = [];
    const previousDebug = db.$client.options.debug;
    db.$client.options.debug = (_connection, statement) => { statements.push(statement); };
    try { await port.checkpointSession(snapshot); }
    finally { db.$client.options.debug = previousDebug; }
    expect(statements.filter(statement => /^begin\b/i.test(statement.trim()))).toHaveLength(1);
    expect(statements.filter(statement => /^update\s+"heartbeat_runs"/i.test(statement.trim()))).toHaveLength(1);
    expect(statements.filter(statement => /^(?:with|select)\b/i.test(statement.trim()))).toHaveLength(1);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, identity.runId));
    expect(saved.runnerProfileJson).toMatchObject({ unrelated: "preserve", sessionCheckpoint: snapshot,
      nativeControllerRecovery: { schema: "paperclip.native-controller-recovery.v1", snapshotSha256: nativeSha256(saved.runnerProfileJson?.sessionCheckpoint),
        checkpoint: null, processConfigDigest: null } });
    // Missing PRP is an explicit incomplete publication, never fabricated authority.
    await db.update(nativeRunFinalizations).set({ controllerGeneration: 2 }).where(eq(nativeRunFinalizations.runId, identity.runId));
    await expect(port.checkpointSession({ ...snapshot, providerSessionId: "stale" })).rejects.toThrow("checkpoint_owner_lost");
    await expect(port.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL }))
      .rejects.toThrow("checkpoint_owner_lost");
    const [unchanged] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, identity.runId));
    expect(unchanged.runnerProfileJson).toEqual(saved.runnerProfileJson);
    // A valid coordinator lock does not certify a lease that expires while the
    // subsequent run-row lock waits. Recheck time at the actual write boundary.
    await db.update(nativeRunFinalizations).set({ controllerGeneration: 1, leaseExpiresAt: new Date(Date.now() + 150) })
      .where(eq(nativeRunFinalizations.runId, identity.runId));
    let locked!: () => void, release!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const blocker = db.transaction(async tx => {
      await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, identity.runId)).for("update");
      locked();
      await held;
    });
    await acquired;
    const waiting = port.checkpointSession(snapshot);
    const rejected = expect(waiting).rejects.toThrow("checkpoint_owner_lost");
    try { await new Promise(resolve => setTimeout(resolve, 200)); }
    finally { release(); await blocker; }
    await rejected;
  });

  it("permits only read-only admission while an existing startup drains", async () => {
    const identity = { ...CONTROL_PLANE_CONFORMANCE_OPEN.identity, runId: randomUUID(), sessionId: randomUUID() };
    const runnerId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: identity.runId, companyId: identity.companyId, agentId: identity.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: identity.issueId,
      nativeSessionId: identity.sessionId, runnerInstanceId: runnerId,
      completionContractId: contractId, completionContractSha256: contractSha,
    });
    let awaitingStartup = true;
    const port = new PaperclipControlPlanePort(db, {
      ...identity, completionContractId: contractId, completionContractSha256: contractSha,
      sourceInstanceId: runnerId, controlPlaneSourceInstanceId: `draining-${identity.runId}`,
    }, {
      assertControllerActive: () => { throw new Error("controller_detached"); },
      assertRunAdmissionActive: () => { if (!awaitingStartup) throw new Error("controller_detached"); },
    });
    const open = { identity, backendKind: "mock" as const, sourceInstanceId: runnerId };
    await expect(port.openRun({ ...open, sourceInstanceId: randomUUID() })).rejects.toThrow("native_open_run_binding_mismatch");
    await db.update(heartbeatRuns).set({ runnerInstanceId: randomUUID() }).where(eq(heartbeatRuns.id, identity.runId));
    await expect(port.openRun(open)).rejects.toThrow("native_open_run_not_authorized");
    await db.update(heartbeatRuns).set({ runnerInstanceId: runnerId }).where(eq(heartbeatRuns.id, identity.runId));
    await expect(port.openRun(open)).resolves.toBeUndefined();
    await expect(port.checkpointSession({ backendKind: "mock", sessionId: identity.sessionId, identity })).rejects.toThrow("controller_detached");
    await expect(port.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL })).rejects.toThrow("controller_detached");
    awaitingStartup = false;
    await expect(port.openRun(open)).rejects.toThrow("controller_detached");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, identity.runId));
    expect(run.runnerProfileJson?.sessionCheckpoint).toBeUndefined();
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, identity.runId))).toEqual([]);
  });

  it.each([
    ["checkpoint", "detach"], ["result", "detach"], ["event", "detach"],
    ["checkpoint", "abort"], ["result", "abort"], ["event", "abort"],
    ["deferred event", "detach"], ["deferred event", "abort"],
  ] as const)("revokes an in-flight %s on %s", async (operation, reason) => {
    const identity = { ...CONTROL_PLANE_CONFORMANCE_OPEN.identity, runId: randomUUID(), sessionId: randomUUID() };
    const runnerId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: identity.runId, companyId: identity.companyId, agentId: identity.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: identity.issueId,
      nativeSessionId: identity.sessionId, runnerInstanceId: runnerId,
      completionContractId: contractId, completionContractSha256: contractSha,
      contextSnapshot: { issueId: identity.issueId },
    });
    const binding = { ...identity, completionContractId: contractId, completionContractSha256: contractSha,
      sourceInstanceId: runnerId, controlPlaneSourceInstanceId: `detached-${identity.runId}` };
    let detached = false;
    const controller = new AbortController();
    const port = new PaperclipControlPlanePort(db, binding, {
      assertControllerActive: () => { if (detached) throw new Error("controller_detached"); },
    });
    await port.openRun({ identity, backendKind: "mock", sourceInstanceId: runnerId });
    const mutate = () => operation === "event" || operation === "deferred event" ? port.appendEvent({
      schema: "paperclip.prp.event.v1", sourceEventId: `${runnerId}:1`, sourceSeq: 1,
      sourceInstanceId: runnerId, sourceKind: "runner", runId: identity.runId,
      normalizedSessionId: identity.sessionId, eventType: "turn.interrupted", schemaVersion: 1,
      turnId: "revoked-turn",
      priority: 0, emittedAt: new Date().toISOString(), payload: { reason: "governed_wait" },
    }, { signal: controller.signal, ...(operation === "deferred event" ? { deferPostCommitObservers: true } : {}) }) : operation === "checkpoint"
      ? port.checkpointSession({ backendKind: "mock", sessionId: identity.sessionId, identity }, { signal: controller.signal })
      : port.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL }, { signal: controller.signal });
    let pending: Promise<unknown> | undefined;
    await db.transaction(async tx => {
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, identity.runId)).for("update");
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`) as unknown as Array<{ pid: number }>;
      pending = mutate().then(() => null, error => error);
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [state] = await db.execute(sql`select exists (
          select 1 from pg_stat_activity where ${backend.pid} = any(pg_blocking_pids(pid))
        ) as waiting`) as unknown as Array<{ waiting: boolean }>;
        if (state.waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      if (reason === "detach") detached = true;
      else controller.abort(new Error("controller_detached"));
    });
    expect(await pending).toMatchObject({ message: "controller_detached" });
    await expect(mutate()).rejects.toThrow("controller_detached");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, identity.runId));
    expect(run.runnerProfileJson?.sessionCheckpoint).toBeUndefined();
    expect(run.nextEventSeq).toBe(1);
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, identity.runId))).toEqual([]);
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, identity.runId))).toEqual([]);
    expect(await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, identity.runId))).toEqual([]);
    // A new controller's independently authorized port can still settle it.
    const replacement = new PaperclipControlPlanePort(db, binding);
    await replacement.openRun({ identity, backendKind: "mock", sourceInstanceId: runnerId });
    await expect(replacement.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL })).resolves.toBeUndefined();
  });

  it("persists panel activation under the authenticated run and recovers it across source replay", async () => {
    await db.insert(plugins).values({ pluginKey: "example.live-view", packageName: "example-live-view", version: "1.0.0", status: "ready",
      manifestJson: { ui: { slots: [{ type: "detailTab", id: "screen", entityTypes: ["agent"], taskSidePanel: { availabilityPath: "/agents/:entityId/ready", activation: { namespace: "example.runtime", activityKey: "desktop.used" } } }] } } as never });
    const identity = { ...CONTROL_PLANE_CONFORMANCE_OPEN.identity, runId: randomUUID(), sessionId: randomUUID() };
    const runnerId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: identity.runId, companyId: identity.companyId, agentId: identity.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: identity.issueId,
      nativeSessionId: identity.sessionId, runnerInstanceId: runnerId,
      completionContractId: contractId, completionContractSha256: contractSha,
      contextSnapshot: { issueId: identity.issueId },
    });
    const binding = { ...identity, completionContractId: contractId, completionContractSha256: contractSha,
      sourceInstanceId: runnerId, controlPlaneSourceInstanceId: `panel-${identity.runId}` };
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1", sourceEventId: `${runnerId}:1`, sourceSeq: 1,
      sourceInstanceId: runnerId, sourceKind: "runner", runId: identity.runId,
      normalizedSessionId: identity.sessionId, eventType: "runtime.activity.recorded", schemaVersion: 1,
      priority: 1, emittedAt: new Date().toISOString(),
      payload: { namespace: "example.runtime", activityKey: "desktop.used" },
    };
    const port = new PaperclipControlPlanePort(db, binding);
    const replayBinding = structuredClone(binding);
    binding.runId = randomUUID();
    await port.openRun({ identity, backendKind: "mock", sourceInstanceId: runnerId });
    const notifications: string[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(identity.companyId, event => {
      if (event.type === "heartbeat.run.event" && event.payload.runId === identity.runId) notifications.push(String(event.payload.eventType));
    });
    try { await port.appendEvent(event); } finally { unsubscribe(); }
    expect(notifications).toEqual(["runtime.activity.recorded"]);
    expect(await readTaskPanelActivations(db, identity.companyId, identity.runId)).toEqual([{ pluginKey: "example.live-view", slotId: "screen" }]);
    const restarted = new PaperclipControlPlanePort(db, replayBinding);
    expect((await restarted.appendEvent(event)).disposition).toBe("duplicate");
    const activations = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, identity.runId));
    expect(activations.filter(row => row.eventType === "runtime.activity.recorded")).toHaveLength(1);
    expect(await readTaskPanelActivations(db, identity.companyId, CONTROL_PLANE_CONFORMANCE_OPEN.identity.runId)).toEqual([]);
    expect(await readTaskPanelActivations(db, randomUUID(), identity.runId)).toEqual([]);
  });

  it("persists each streamed event in one statement and rejects the receipt of a writer revoked while it commits", async () => {
    const identity = { ...CONTROL_PLANE_CONFORMANCE_OPEN.identity, runId: randomUUID(), sessionId: randomUUID() };
    const runnerId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: identity.runId, companyId: identity.companyId, agentId: identity.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: identity.issueId,
      nativeSessionId: identity.sessionId, runnerInstanceId: runnerId,
      completionContractId: contractId, completionContractSha256: contractSha,
      contextSnapshot: { issueId: identity.issueId },
    });
    let active = true;
    const committed: number[] = [];
    const port = new PaperclipControlPlanePort(db, {
      ...identity, completionContractId: contractId, completionContractSha256: contractSha,
      sourceInstanceId: runnerId, controlPlaneSourceInstanceId: `stream-${identity.runId}`,
    }, {
      assertControllerActive: () => { if (!active) throw new Error("controller_revoked"); },
      onCommittedEvent: async (_event, cursor) => { committed.push(cursor); },
    });
    await port.openRun({ identity, backendKind: "mock", sourceInstanceId: runnerId });
    const emittedAt = new Date().toISOString();
    const delta = (sourceSeq: number): PrpEvent => ({
      schema: "paperclip.prp.event.v1", sourceEventId: `${runnerId}:${sourceSeq}`, sourceSeq,
      sourceInstanceId: runnerId, sourceKind: "runner", runId: identity.runId,
      normalizedSessionId: identity.sessionId, turnId: "stream-turn", itemId: "stream-message",
      eventType: "item.delta", schemaVersion: 1, priority: 1, emittedAt,
      payload: { kind: "agentMessage", text: `chunk ${sourceSeq}` },
    });
    // Every statement the driver sends, transaction control included.
    const options = db.$client.options as { debug?: unknown };
    const statements: string[] = [];
    options.debug = (_connection: number, text: string) => { statements.push(text.trim().replace(/\s+/g, " ")); };
    try {
      for (const sourceSeq of [1, 2, 3]) {
        statements.length = 0;
        await expect(port.appendEvent(delta(sourceSeq))).resolves.toEqual({
          cursor: sourceSeq, highestContiguousSourceSeq: sourceSeq, disposition: "committed",
        });
        expect(statements).toHaveLength(1);
        expect(statements[0]).toMatch(/^with snapshot_run as /);
      }
      statements.length = 0;
      await expect(port.appendEvent(delta(2))).resolves.toEqual({ cursor: 2, highestContiguousSourceSeq: 3, disposition: "duplicate" });
      expect(statements).toHaveLength(5);
      active = false;
      statements.length = 0;
      await expect(port.appendEvent(delta(4))).rejects.toThrow("controller_revoked");
      expect(statements).toEqual([]);
      active = true;
      options.debug = (_connection: number, text: string) => { if (/^with snapshot_run as /.test(text.trim())) active = false; };
      await expect(port.appendEvent(delta(4))).rejects.toThrow("controller_revoked");
    } finally { options.debug = undefined; }
    active = true;
    expect(committed).toEqual([1, 2, 3]);
    const stored = () => db.select({ seq: heartbeatRunEvents.seq, sourceSeq: heartbeatRunEvents.sourceSeq })
      .from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, identity.runId)).orderBy(asc(heartbeatRunEvents.seq));
    expect(await stored()).toEqual([1, 2, 3, 4].map(seq => ({ seq, sourceSeq: seq })));
    const replacement = new PaperclipControlPlanePort(db, {
      ...identity, completionContractId: contractId, completionContractSha256: contractSha,
      sourceInstanceId: runnerId, controlPlaneSourceInstanceId: `stream-${identity.runId}`,
    });
    await replacement.openRun({ identity, backendKind: "mock", sourceInstanceId: runnerId });
    await expect(replacement.appendEvent(delta(4))).resolves.toEqual({ cursor: 4, highestContiguousSourceSeq: 4, disposition: "duplicate" });
    await expect(replacement.appendEvent(delta(5))).resolves.toEqual({ cursor: 5, highestContiguousSourceSeq: 5, disposition: "committed" });
    expect(await stored()).toEqual([1, 2, 3, 4, 5].map(seq => ({ seq, sourceSeq: seq })));
  });

  const streamingFixture = async (options: ConstructorParameters<typeof PaperclipControlPlanePort>[2] = {}) => {
    const identity = { ...CONTROL_PLANE_CONFORMANCE_OPEN.identity, runId: randomUUID(), sessionId: randomUUID() };
    const runnerId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: identity.runId, companyId: identity.companyId, agentId: identity.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: identity.issueId,
      nativeSessionId: identity.sessionId, runnerInstanceId: runnerId,
      completionContractId: contractId, completionContractSha256: contractSha,
      contextSnapshot: { issueId: identity.issueId },
    });
    const binding = { ...identity, completionContractId: contractId, completionContractSha256: contractSha,
      sourceInstanceId: runnerId, controlPlaneSourceInstanceId: `stream-${identity.runId}` };
    const port = new PaperclipControlPlanePort(db, binding, options);
    await port.openRun({ identity, backendKind: "mock", sourceInstanceId: runnerId });
    const emittedAt = new Date().toISOString();
    const event = (sourceSeq: number, eventType: PrpEvent["eventType"] = "item.delta", text = `chunk ${sourceSeq}`): PrpEvent => ({
      schema: "paperclip.prp.event.v1", sourceEventId: `${runnerId}:${sourceSeq}`, sourceSeq,
      sourceInstanceId: runnerId, sourceKind: "runner", runId: identity.runId,
      normalizedSessionId: identity.sessionId, turnId: "stream-turn", itemId: "stream-message",
      eventType, schemaVersion: 1, priority: eventType === "item.delta" ? 1 : 0, emittedAt,
      payload: eventType === "item.delta" ? { kind: "agentMessage", text } : {
        schema: "paperclip.tool.execution.v1", executionId: `tool-${sourceSeq}`, transport: "builtin",
        operation: "execute", name: "diagnostic", target: null, namespace: null, readOnly: true,
        status: "running", durationMs: null, exitCode: null, progress: null,
        output: null, outputBytes: 0, outputTruncated: false, outputDigest: null,
      },
    });
    const streamed = { signal: new AbortController().signal, streaming: true as const };
    const stored = () => db.select({ seq: heartbeatRunEvents.seq, sourceSeq: heartbeatRunEvents.sourceSeq })
      .from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, identity.runId)).orderBy(asc(heartbeatRunEvents.seq));
    return { port, binding, identity, runnerId, event, stored, streamed };
  };

  it("measures every row of a streaming batch from the batch commit, not after earlier rows' observers", async () => {
    const metrics = startServerMetrics();
    const recorded: number[] = [];
    const record = metrics.recordRunEventLatenessMs.bind(metrics);
    metrics.recordRunEventLatenessMs = (ms: number) => { recorded.push(ms); record(ms); };
    try {
      const f = await streamingFixture({ streamingBatchMs: 600_000, onCommittedEvent: async (event) => {
        if (event.sourceSeq === 2) await new Promise(resolve => setTimeout(resolve, 1_200));
      } });
      await f.port.appendEvent(f.event(1), f.streamed);
      const deltas = [2, 3, 4].map(sourceSeq => f.port.appendEvent(f.event(sourceSeq), f.streamed));
      await f.port.appendEvent(f.event(5, "tool.execution.started"));
      await Promise.all(deltas);
      const batch = recorded.slice(1, 4);
      expect(batch).toHaveLength(3);
      expect(Math.max(...batch) - Math.min(...batch)).toBeLessThan(500);
    } finally {
      stopServerMetrics(metrics);
    }
  });

  it("commits the first text delta at once and later deltas in one batch before the next other event", async () => {
    const committed: number[] = [];
    // A timer this long would time the test out: only the first delta and the
    // next other event may commit the queued deltas.
    const f = await streamingFixture({ streamingBatchMs: 600_000, onCommittedEvent: async (event) => { committed.push(event.sourceSeq); } });
    await expect(f.port.appendEvent(f.event(1), f.streamed)).resolves.toEqual({ cursor: 1, highestContiguousSourceSeq: 1, disposition: "committed" });
    const options = db.$client.options as { debug?: unknown };
    const statements: string[] = [];
    options.debug = (_connection: number, text: string) => { statements.push(text.trim().replace(/\s+/g, " ")); };
    try {
      const settled: number[] = [];
      const deltas = [2, 3, 4, 5, 6].map(sourceSeq => f.port.appendEvent(f.event(sourceSeq), f.streamed).then(receipt => { settled.push(sourceSeq); return receipt; }));
      await new Promise(resolve => setTimeout(resolve, 50));
      // Queued deltas are neither stored nor acknowledged yet.
      expect(settled).toEqual([]);
      expect(await f.stored()).toEqual([{ seq: 1, sourceSeq: 1 }]);
      statements.length = 0;
      const boundary = f.port.appendEvent(f.event(7, "tool.execution.started"));
      expect(await Promise.all(deltas)).toEqual([2, 3, 4, 5, 6].map(sourceSeq => ({
        cursor: sourceSeq, highestContiguousSourceSeq: sourceSeq, disposition: "committed" })));
      await expect(boundary).resolves.toMatchObject({ cursor: 7, highestContiguousSourceSeq: 7, disposition: "committed" });
      expect(settled).toEqual([2, 3, 4, 5, 6]);
      const inserts = statements.filter(text => text.includes("insert into heartbeat_run_events"));
      expect(inserts).toHaveLength(2);
      expect(statements[0]).toMatch(/^with snapshot_run as /);
      expect(statements.indexOf(inserts[1]!)).toBeGreaterThan(0);
    } finally { options.debug = undefined; }
    expect(committed).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(await f.stored()).toEqual([1, 2, 3, 4, 5, 6, 7].map(seq => ({ seq, sourceSeq: seq })));
    // After another event, the next delta commits at once again.
    await expect(f.port.appendEvent(f.event(8), f.streamed)).resolves.toMatchObject({ cursor: 8, disposition: "committed" });
    // A caller that waits for each receipt never waits for the timer.
    await expect(f.port.appendEvent(f.event(9))).resolves.toMatchObject({ cursor: 9, disposition: "committed" });
    // A delta without text does not end the immediate commits: the first text still commits at once.
    await f.port.appendEvent(f.event(10, "tool.execution.started"));
    await expect(f.port.appendEvent(f.event(11, "item.delta", ""), f.streamed)).resolves.toMatchObject({ cursor: 11 });
    await expect(f.port.appendEvent(f.event(12), f.streamed)).resolves.toMatchObject({ cursor: 12 });
  });

  it("commits progress events that arrive while a batch commits in the next single batch", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await streamingFixture({ streamingBatchMs: 600_000, onCommittedEvent: async (event) => {
      if (event.sourceSeq === 1) await gate;
    } });
    const first = f.port.appendEvent(f.event(1, "tool.execution.progressed"), f.streamed);
    await vi.waitFor(async () => expect(await f.stored()).toHaveLength(1));
    const options = db.$client.options as { debug?: unknown };
    const statements: string[] = [];
    options.debug = (_connection: number, text: string) => { statements.push(text.trim().replace(/\s+/g, " ")); };
    try {
      const later = [2, 3, 4].map(sourceSeq => f.port.appendEvent(f.event(sourceSeq, "tool.execution.progressed"), f.streamed));
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(statements.filter(text => /^begin/i.test(text))).toHaveLength(0);
      release();
      await expect(first).resolves.toMatchObject({ cursor: 1, disposition: "committed" });
      expect((await Promise.all(later)).map(receipt => receipt.cursor)).toEqual([2, 3, 4]);
      expect(statements.filter(text => /^begin/i.test(text))).toHaveLength(1);
    } finally { options.debug = undefined; }
    const boundary = await f.port.appendEvent(f.event(5, "tool.execution.started"));
    expect(boundary).toMatchObject({ cursor: 5, disposition: "committed" });
    expect(await f.stored()).toEqual([1, 2, 3, 4, 5].map(seq => ({ seq, sourceSeq: seq })));
  });

  it("observes every committed delta of a batch when one observer fails", async () => {
    const observed: number[] = [];
    const f = await streamingFixture({ streamingBatchMs: 600_000, onCommittedEvent: async (event) => {
      if (event.sourceSeq === 3) throw new Error("log write failed");
      observed.push(event.sourceSeq);
    } });
    await f.port.appendEvent(f.event(1), f.streamed);
    const receipts = [2, 3, 4].map(sourceSeq => f.port.appendEvent(f.event(sourceSeq), f.streamed));
    f.port.flushStreamingEvents();
    await expect(receipts[0]).resolves.toMatchObject({ cursor: 2 });
    await expect(receipts[1]).rejects.toThrow("log write failed");
    await expect(receipts[2]).resolves.toMatchObject({ cursor: 4 });
    expect(observed).toEqual([1, 2, 4]);
    expect(await f.stored()).toEqual([1, 2, 3, 4].map(seq => ({ seq, sourceSeq: seq })));
  });

  it("collects the deltas that arrive while a batch commits into one next batch, before the next other event", async () => {
    const f = await streamingFixture({ streamingBatchMs: 5 });
    await f.port.appendEvent(f.event(1), f.streamed);
    let release!: () => void, locked!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const lockedRun = new Promise<void>(resolve => { locked = resolve; });
    const holder = db.transaction(async tx => {
      await tx.execute(sql`select id from heartbeat_runs where id = ${f.identity.runId} for update`);
      locked();
      await released;
    });
    await lockedRun;
    const options = db.$client.options as { debug?: unknown };
    const statements: string[] = [];
    options.debug = (_connection: number, text: string) => { statements.push(text.trim().replace(/\s+/g, " ")); };
    const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    let boundary: Promise<unknown> | undefined;
    const deltas: Promise<unknown>[] = [];
    try {
      deltas.push(f.port.appendEvent(f.event(2), f.streamed));
      await pause(30);
      for (const sourceSeq of [3, 4, 5, 6, 7, 8]) {
        deltas.push(f.port.appendEvent(f.event(sourceSeq), f.streamed));
        await pause(15);
      }
      boundary = f.port.appendEvent(f.event(9, "tool.execution.started"));
      await pause(20);
    } finally {
      release();
      await holder;
    }
    try {
      expect((await Promise.all(deltas)).map(receipt => (receipt as { cursor: number }).cursor)).toEqual([2, 3, 4, 5, 6, 7, 8]);
      await expect(boundary).resolves.toMatchObject({ cursor: 9, disposition: "committed" });
      expect(statements.filter(text => text.includes("insert into heartbeat_run_events"))).toHaveLength(3);
    } finally { options.debug = undefined; }
    expect(await f.stored()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(seq => ({ seq, sourceSeq: seq })));
  });

  it("flushes queued deltas on the timer and before a replay read, and rejects every delta of a failed batch", async () => {
    let active = true;
    const f = await streamingFixture({ streamingBatchMs: 20, assertControllerActive: () => { if (!active) throw new Error("controller_revoked"); } });
    await f.port.appendEvent(f.event(1), f.streamed);
    // Later deltas commit on the timer when no other event follows.
    expect((await Promise.all([2, 3].map(sourceSeq => f.port.appendEvent(f.event(sourceSeq), f.streamed)))).map(receipt => receipt.cursor)).toEqual([2, 3]);
    // Replay reads include queued deltas.
    const queued = f.port.appendEvent(f.event(4), f.streamed);
    const replay = await f.port.replayEvents({ runId: f.identity.runId, sourceInstanceId: f.runnerId, afterSourceSeq: 0, limit: 10 });
    expect(replay.highestContiguousSourceSeq).toBe(4);
    await expect(queued).resolves.toMatchObject({ cursor: 4 });
    // The controller loses the run before the batch commits: every queued delta
    // fails and nothing is stored, so the runner's resend commits them.
    const failing = [5, 6, 7].map(sourceSeq => f.port.appendEvent(f.event(sourceSeq), f.streamed));
    active = false;
    for (const receipt of failing) await expect(receipt).rejects.toThrow("controller_revoked");
    active = true;
    expect((await f.stored()).map(row => row.sourceSeq)).toEqual([1, 2, 3, 4]);
    const replacement = new PaperclipControlPlanePort(db, f.binding, { streamingBatchMs: 20 });
    await replacement.openRun({ identity: f.identity, backendKind: "mock", sourceInstanceId: f.runnerId });
    const resent = await Promise.all([4, 5, 6, 7].map(sourceSeq => replacement.appendEvent(f.event(sourceSeq), f.streamed)));
    expect(resent.map(receipt => [receipt.cursor, receipt.disposition])).toEqual([[4, "duplicate"], [5, "committed"], [6, "committed"], [7, "committed"]]);
    expect(await f.stored()).toEqual([1, 2, 3, 4, 5, 6, 7].map(seq => ({ seq, sourceSeq: seq })));
  });

  it("omits API credentials from persisted tool events and checkpoints without changing wire results", async () => {
    const identity = { ...CONTROL_PLANE_CONFORMANCE_OPEN.identity, runId: randomUUID(), sessionId: randomUUID() };
    const runnerId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: identity.runId, companyId: identity.companyId, agentId: identity.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: identity.issueId,
      nativeSessionId: identity.sessionId, runnerInstanceId: runnerId,
      completionContractId: contractId, completionContractSha256: contractSha,
      contextSnapshot: { issueId: identity.issueId },
    });
    const observed: PrpEvent[] = [];
    const port = new PaperclipControlPlanePort(db, {
      ...identity, completionContractId: contractId, completionContractSha256: contractSha,
      sourceInstanceId: runnerId, controlPlaneSourceInstanceId: `api-${identity.runId}`,
    }, { onCommittedEvent: async event => { observed.push(event); } });
    await port.openRun({ identity, backendKind: "mock", sourceInstanceId: runnerId });
    const result = { operationId: "call_api", apiOperationId: "POST /api/companies/{companyId}/exports", callId: "private-export",
      status: 200, ok: true, data: { credentials: "private-history-fixture-value" } };
    const wireResult = { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] };
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1", sourceEventId: `${runnerId}:1`, sourceSeq: 1,
      sourceInstanceId: runnerId, sourceKind: "runner", runId: identity.runId,
      normalizedSessionId: identity.sessionId, eventType: "item.completed", schemaVersion: 1,
      priority: 0, emittedAt: new Date().toISOString(),
      payload: { kind: "dynamicToolCall", item: { type: "tool_result", id: "private-export", tool_use_id: "private-export", result: wireResult } },
    };
    await port.appendEvent(event);
    expect((await port.appendEvent(event)).disposition).toBe("duplicate");
    expect(port.normalizeReplayPayload(event.payload)).toEqual(observed[0]?.payload);
    expect(port.normalizeReplayPayload(observed[0]!.payload)).toEqual(observed[0]?.payload);
    await expect(port.appendEvent({ ...event, payload: { ...event.payload, item: {
      ...(event.payload.item as object), result: { success: true, contentItems: [{ type: "inputText",
        text: JSON.stringify({ ...result, data: { credentials: "different-history-fixture-value" } }),
      }] },
    } } })).rejects.toThrow();
    await port.checkpointSession({ backendKind: "mock", sessionId: identity.sessionId, identity,
      semanticResult: { ...CONTROL_PLANE_CONFORMANCE_RESULT, summary: JSON.stringify(result) },
    });
    const persisted = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, identity.runId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, identity.runId));
    for (const saved of [persisted, observed, run.runnerProfileJson]) {
      expect(JSON.stringify(saved)).not.toContain("private-history-fixture-value");
      expect(JSON.stringify(saved)).toContain("apiPayloadRedacted");
    }
    expect(result.data.credentials).toBe("private-history-fixture-value");
  });

  it.each(["call_api", "create_case"])("retains bounded %s schema-denial guidance through persistence and replay", async operationId => {
    const identity = { ...CONTROL_PLANE_CONFORMANCE_OPEN.identity, runId: randomUUID(), sessionId: randomUUID() };
    const runnerId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: identity.runId, companyId: identity.companyId, agentId: identity.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: identity.issueId,
      nativeSessionId: identity.sessionId, runnerInstanceId: runnerId,
      completionContractId: contractId, completionContractSha256: contractSha,
      contextSnapshot: { issueId: identity.issueId },
    });
    const observed: PrpEvent[] = [];
    const port = new PaperclipControlPlanePort(db, {
      ...identity, completionContractId: contractId, completionContractSha256: contractSha,
      sourceInstanceId: runnerId, controlPlaneSourceInstanceId: `api-${identity.runId}`,
    }, { onCommittedEvent: async event => { observed.push(event); } });
    await port.openRun({ identity, backendKind: "mock", sourceInstanceId: runnerId });
    const payload = {
      provider: "codex", code: "semantic_tool_denied", operationId, callId: "schema-denied",
      message: `provider arguments for ${operationId} failed JSON Schema validation`, paperclipExecuted: false,
      inputSchemaGuidance: "Invalid tool arguments. Check these input schema locations: /required (missing title).",
    };
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1", sourceEventId: `${runnerId}:1`, sourceSeq: 1,
      sourceInstanceId: runnerId, sourceKind: "runner", runId: identity.runId,
      normalizedSessionId: identity.sessionId, eventType: "harness.diagnostic", schemaVersion: 1,
      priority: 0, emittedAt: new Date().toISOString(), payload,
      debug: { operationId, data: { value: "private-diagnostic-debug" } },
    };
    await port.appendEvent(event);
    expect(observed[0]?.payload).toEqual(payload);
    expect(observed[0]?.debug).toMatchObject({ apiPayloadRedacted: true });
    expect(JSON.stringify(observed[0])).not.toContain("private-diagnostic-debug");
    expect((await port.appendEvent(event)).disposition).toBe("duplicate");
    expect(port.normalizeReplayPayload(payload)).toEqual(port.normalizeReplayPayload(observed[0]!.payload));
    const saved = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, identity.runId));
    expect(saved).toHaveLength(1);
    expect((saved[0]!.payload?.prpEvent as unknown as PrpEvent).payload).toEqual(payload);
    expect(JSON.stringify(saved)).not.toContain("private-diagnostic-debug");
    await expect(port.appendEvent({ ...event, payload: {
      ...payload, inputSchemaGuidance: "Invalid tool arguments. Check these input schema locations: /properties/title/type.",
    } })).rejects.toThrow();
  });

  it("redacts identity private material before persisting native events and checkpoints", async () => {
    const identity = { ...CONTROL_PLANE_CONFORMANCE_OPEN.identity, runId: randomUUID(), sessionId: randomUUID() };
    const runnerId = randomUUID();
    const privateKeyPem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const keyBody = privateKeyPem.split("\n")[1];
    await db.insert(heartbeatRuns).values({
      id: identity.runId, companyId: identity.companyId, agentId: identity.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: identity.issueId,
      nativeSessionId: identity.sessionId, runnerInstanceId: runnerId,
      completionContractId: contractId, completionContractSha256: contractSha,
      contextSnapshot: { issueId: identity.issueId },
    });
    const observed: PrpEvent[] = [];
    const port = new PaperclipControlPlanePort(db, {
      ...identity, completionContractId: contractId, completionContractSha256: contractSha,
      sourceInstanceId: runnerId, controlPlaneSourceInstanceId: `identity-${identity.runId}`,
    }, { privateKeyPem, onCommittedEvent: async event => { observed.push(event); } });
    await port.openRun({ identity, backendKind: "mock", sourceInstanceId: runnerId });
    await port.appendEvent({
      schema: "paperclip.prp.event.v1", sourceEventId: `${runnerId}:1`, sourceSeq: 1,
      sourceInstanceId: runnerId, sourceKind: "runner", runId: identity.runId,
      normalizedSessionId: identity.sessionId, eventType: "tool.execution.started", schemaVersion: 1,
      priority: 0, emittedAt: new Date().toISOString(), payload: {
        schema: "paperclip.tool.execution.v1", executionId: "identity-output", transport: "builtin",
        operation: "execute", name: "diagnostic", target: null, namespace: null, readOnly: true,
        status: "running", durationMs: null, exitCode: null, progress: null,
        output: privateKeyPem, outputBytes: Buffer.byteLength(privateKeyPem), outputTruncated: false,
        outputDigest: `sha256:${"a".repeat(64)}`,
      },
    });
    await port.checkpointSession({ backendKind: "mock", sessionId: identity.sessionId, identity,
      semanticResult: { ...CONTROL_PLANE_CONFORMANCE_RESULT, summary: privateKeyPem },
    });
    let sourceSeq = 2;
    for (const [itemId, chunks] of [
      ["halves", [keyBody.slice(0, 31), keyBody.slice(31)]],
      ["bytes", [...keyBody]],
    ] as const) {
      for (const [index, chunk] of chunks.entries()) {
        const event: PrpEvent = {
          schema: "paperclip.prp.event.v1", sourceEventId: `${runnerId}:${sourceSeq}`, sourceSeq: sourceSeq++,
          sourceInstanceId: runnerId, sourceKind: "runner", runId: identity.runId,
          normalizedSessionId: identity.sessionId, turnId: "identity-turn", itemId,
          eventType: "item.delta", schemaVersion: 1, priority: 1, emittedAt: new Date().toISOString(),
          payload: { itemId, kind: "commandExecution", text: chunk, update: { delta: chunk } },
        };
        await port.appendEvent(event);
        expect((await port.appendEvent(event)).disposition).toBe("duplicate");
        if (index === 0) await port.appendEvent({
          ...event, sourceEventId: `${runnerId}:${sourceSeq}`, sourceSeq: sourceSeq++,
          payload: { itemId: "another-provider-item", kind: "commandExecution", text: "Unrelated output\n", update: { delta: "Unrelated output\n" } },
        });
      }
    }
    await port.appendEvent({
      schema: "paperclip.prp.event.v1", sourceEventId: `${runnerId}:${sourceSeq}`, sourceSeq: sourceSeq++,
      sourceInstanceId: runnerId, sourceKind: "runner", runId: identity.runId,
      normalizedSessionId: identity.sessionId, turnId: "tail-turn", itemId: "reasoning-item",
      eventType: "item.delta", schemaVersion: 1, priority: 1, emittedAt: new Date().toISOString(),
      payload: { kind: "reasoning", text: "Thinking-" },
    });
    const terminal: PrpEvent = {
      schema: "paperclip.prp.event.v1", sourceEventId: `${runnerId}:${sourceSeq}`, sourceSeq: sourceSeq++,
      sourceInstanceId: runnerId, sourceKind: "runner", runId: identity.runId,
      normalizedSessionId: identity.sessionId, turnId: "tail-turn",
      eventType: "turn.completed", schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(),
      payload: { status: "completed" },
    };
    await port.appendEvent(terminal);
    expect((await port.appendEvent(terminal)).disposition).toBe("duplicate");
    expect(observed.at(-1)?.payload.outputTails).toEqual([{ itemId: "reasoning-item", payload: { kind: "reasoning", text: "-" } }]);
    const persistedEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, identity.runId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, identity.runId));
    for (const value of [persistedEvents, observed, run.runnerProfileJson]) {
      expect(JSON.stringify(value)).not.toContain(keyBody);
      expect(JSON.stringify(value)).toContain("***REDACTED***");
    }
    for (const itemId of ["halves", "bytes"]) {
      const deltas = observed.filter(event => event.payload.itemId === itemId).map(event => event.payload);
      expect(deltas.map(delta => delta.text).join("")).toBe("***REDACTED***");
      expect(deltas.map(delta => (delta.update as { delta: string }).delta).join("")).toBe("***REDACTED***");
    }
  });

  it("masks secret-bound environment values in persisted native events and leaves plain values", async () => {
    const identity = { ...CONTROL_PLANE_CONFORMANCE_OPEN.identity, runId: randomUUID(), sessionId: randomUUID() };
    const runnerId = randomUUID();
    const secret = `sk_test_synthetic_${randomUUID()}`;
    const plain = "https://plain.example.test/api";
    await db.insert(heartbeatRuns).values({
      id: identity.runId, companyId: identity.companyId, agentId: identity.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: identity.issueId,
      nativeSessionId: identity.sessionId, runnerInstanceId: runnerId,
      completionContractId: contractId, completionContractSha256: contractSha,
      contextSnapshot: { issueId: identity.issueId },
    });
    const observed: PrpEvent[] = [];
    const port = new PaperclipControlPlanePort(db, {
      ...identity, completionContractId: contractId, completionContractSha256: contractSha,
      sourceInstanceId: runnerId, controlPlaneSourceInstanceId: `secret-env-${identity.runId}`,
    }, {
      secrets: secretEnvironmentValues({ STRIPE_KEY: secret, SHORT_PIN: "pin42", PLAIN_URL: plain },
        ["STRIPE_KEY", "SHORT_PIN"]),
      onCommittedEvent: async event => { observed.push(event); },
    });
    await port.openRun({ identity, backendKind: "mock", sourceInstanceId: runnerId });
    const envOutput = `STRIPE_KEY=${secret}\nSHORT_PIN=pin42\nPLAIN_URL=${plain}\n`;
    await port.appendEvent({
      schema: "paperclip.prp.event.v1", sourceEventId: `${runnerId}:1`, sourceSeq: 1,
      sourceInstanceId: runnerId, sourceKind: "runner", runId: identity.runId,
      normalizedSessionId: identity.sessionId, eventType: "tool.execution.started", schemaVersion: 1,
      priority: 0, emittedAt: new Date().toISOString(), payload: {
        schema: "paperclip.tool.execution.v1", executionId: "secret-env-output", transport: "builtin",
        operation: "execute", name: "env", target: null, namespace: null, readOnly: true,
        status: "running", durationMs: null, exitCode: null, progress: null,
        output: envOutput, outputBytes: Buffer.byteLength(envOutput), outputTruncated: false,
        outputDigest: `sha256:${"a".repeat(64)}`,
      },
    });
    let sourceSeq = 2;
    for (const chunk of [`echo ${secret.slice(0, 15)}`, `${secret.slice(15)} done`]) {
      await port.appendEvent({
        schema: "paperclip.prp.event.v1", sourceEventId: `${runnerId}:${sourceSeq}`, sourceSeq: sourceSeq++,
        sourceInstanceId: runnerId, sourceKind: "runner", runId: identity.runId,
        normalizedSessionId: identity.sessionId, turnId: "secret-turn", itemId: "secret-item",
        eventType: "item.delta", schemaVersion: 1, priority: 1, emittedAt: new Date().toISOString(),
        payload: { itemId: "secret-item", kind: "commandExecution", text: chunk, update: { delta: chunk } },
      });
    }
    const persistedEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, identity.runId));
    for (const value of [persistedEvents, observed]) {
      expect(JSON.stringify(value)).not.toContain(secret.slice(15));
      expect(JSON.stringify(value)).toContain("***REDACTED***");
      expect(JSON.stringify(value)).toContain(plain);
      expect(JSON.stringify(value)).toContain("SHORT_PIN=pin42");
    }
    const deltas = observed.filter(event => event.payload.itemId === "secret-item").map(event => event.payload.text);
    expect(deltas.join("")).toBe("echo ***REDACTED*** done");
  });

  it("runs the unchanged package conformance suite against Paperclip persistence", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const committedEventIds: string[] = [];
    const duplicateEventIds: string[] = [];
    const port = new PaperclipControlPlanePort(
      db,
      {
        companyId: identity.companyId,
        issueId: identity.issueId,
        runId: identity.runId,
        agentId: identity.agentId,
        sessionId: identity.sessionId,
        completionContractId: contractId,
        completionContractSha256: contractSha,
        sourceInstanceId: conformanceRunnerId,
        controlPlaneSourceInstanceId: "control-conformance",
      },
      {
        onCommittedEvent: async (event) => {
          committedEventIds.push(event.sourceEventId);
        },
        onDuplicateEvent: async (event) => {
          duplicateEventIds.push(event.sourceEventId);
        },
      },
    );
    await expect(runControlPlanePortConformance({ port })).resolves.toEqual({
      eventCount: 3,
      highestContiguousSourceSeq: 3,
      duplicateDisposition: "duplicate",
      terminalReplayIdempotent: true,
      openBindingRejected: true,
      eventIdMutationRejected: true,
      eventSequenceMutationRejected: true,
      replayBindingRejected: true,
      resultMutationRejected: true,
    });
    expect(committedEventIds).toEqual([
      "00000000-0000-4000-8000-000000000005:event:1",
      "00000000-0000-4000-8000-000000000005:event:3",
      "00000000-0000-4000-8000-000000000005:event:2",
    ]);
    expect(duplicateEventIds).toEqual([
      "00000000-0000-4000-8000-000000000005:event:2",
    ]);
    await expect(db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, identity.runId))).resolves.toHaveLength(1);
    await finalizeNativeRun({
      db,
      runId: identity.runId,
      workspaceFinalizeStatus: "succeeded",
    });
    await expect(db.select().from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, identity.runId))).resolves.toEqual([
      expect.objectContaining({ phase: "committed" }),
    ]);
    // Completion and restart reconciliation must retain the contract even if
    // the originating heartbeat never returns from its adapter completion.
    const [completedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, identity.runId));
    expect(completedRun.resultJson?.nativeTerminal).toEqual(CONTROL_PLANE_CONFORMANCE_TERMINAL);
    await expect(db.select().from(issues).where(eq(issues.id, identity.issueId))).resolves.toEqual([
      expect.objectContaining({ status: "in_progress", statusVersion: 1 }),
    ]);
    await expect(db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, identity.runId))).resolves.toEqual([
      expect.objectContaining({ phase: "committed" }),
    ]);
    await expect(db.select().from(statusDecisions).where(eq(statusDecisions.issueId, identity.issueId))).resolves.toEqual([
      expect.objectContaining({ toStatus: "in_progress", reasonCode: "completion_evidence_incomplete", applicationState: "applied" }),
    ]);
    await expect(db.select().from(activityLog).where(eq(activityLog.entityId, identity.issueId))).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ action: "issue.updated" })]),
    );
  });

  it("streams committed native rows and deltas after visibility without repeating receipts", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const issueId = "40000000-0000-4000-8000-000000000042";
    const runId = "41000000-0000-4000-8000-000000000042";
    const sessionId = "42000000-0000-4000-8000-000000000042";
    const runnerInstanceId = "43000000-0000-4000-8000-000000000042";
    const localContractId = "44000000-0000-4000-8000-000000000042";
    const localContractSha = "safe-progress-signal-contract";
    await db.insert(issues).values({
      id: issueId,
      companyId: identity.companyId,
      title: "Signal committed safe progress",
      status: "in_progress",
      assigneeAgentId: identity.agentId,
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: localContractId,
      companyId: identity.companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "phase6-v1",
        objective: "Signal committed safe progress",
        criteria: [{ id: "objective", requirement: "Signal progress" }],
      },
      canonicalSha256: localContractSha,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      nativeSessionId: sessionId,
      runnerInstanceId,
      completionContractId: localContractId,
      completionContractSha256: localContractSha,
      contextSnapshot: { issueId },
    });
    const observerDb = createDb(external ?? temporary!.connectionString);
    const observed: Array<Record<string, unknown>> = [];
    const committedCallbacks: string[] = [];
    let visibilityCheck: Promise<Array<{ eventType: string }>> | null = null;
    const unsubscribe = subscribeAllCompanyLiveEvents((event) => {
      if (
        event.companyId !== identity.companyId ||
        event.type !== "heartbeat.run.event" ||
        event.payload.runId !== runId
      ) return;
      observed.push(event.payload);
      visibilityCheck = observerDb
        .select({ eventType: heartbeatRunEvents.eventType })
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId));
    });
    const port = new PaperclipControlPlanePort(db, {
      companyId: identity.companyId,
      issueId,
      runId,
      agentId: identity.agentId,
      sessionId,
      completionContractId: localContractId,
      completionContractSha256: localContractSha,
      sourceInstanceId: runnerInstanceId,
      controlPlaneSourceInstanceId: `safe-progress-control-${runId}`,
    }, {
      onCommittedEvent: async (event) => {
        committedCallbacks.push(event.sourceEventId);
      },
    });
    await port.openRun({
      identity: { ...identity, issueId, runId, sessionId },
      backendKind: "mock",
      sourceInstanceId: runnerInstanceId,
    });
    const progressEvent: PrpEvent = {
      schema: "paperclip.prp.event.v1",
      sourceEventId: "safe-progress-signal:1",
      sourceSeq: 1,
      sourceInstanceId: runnerInstanceId,
      sourceKind: "runner",
      runId,
      normalizedSessionId: sessionId,
      turnId: "safe-progress-signal-turn",
      eventType: "tool.execution.started",
      schemaVersion: 1,
      priority: 0,
      emittedAt: "2026-09-08T10:30:00.000Z",
      payload: {
        schema: "paperclip.tool.execution.v1",
        executionId: "safe-progress-execution",
        transport: "builtin",
        operation: "execute",
        name: "must-not-cross-live-signal",
        target: null,
        namespace: null,
        readOnly: false,
        status: "running",
        durationMs: null,
        exitCode: null,
        progress: null,
        output: "must-not-cross-live-signal",
        outputBytes: 26,
        outputTruncated: false,
        outputDigest: `sha256:${"a".repeat(64)}`,
      },
    };
    try {
      await expect(port.appendEvent(progressEvent)).resolves.toMatchObject({
        disposition: "committed",
      });
      await expect(visibilityCheck).resolves.toEqual([
        { eventType: "tool.execution.started" },
      ]);
      expect(observed).toEqual([{
        runId,
        agentId: identity.agentId,
        issueId,
        seq: 1,
        eventType: "tool.execution.started",
        stream: "system",
        level: "info",
        payload: { prpEvent: progressEvent },
      }]);

      await expect(port.appendEvent(progressEvent)).resolves.toMatchObject({
        disposition: "duplicate",
      });
      expect(observed).toHaveLength(1);

      const unsubscribeThrowingListener = subscribeCompanyLiveEvents(
        identity.companyId,
        () => {
          throw new Error("simulated_live_listener_failure");
        },
      );
      try {
        await expect(port.appendEvent({
          ...progressEvent,
          sourceEventId: "safe-progress-signal:2",
          sourceSeq: 2,
        })).resolves.toMatchObject({ disposition: "committed" });
      } finally {
        unsubscribeThrowingListener();
      }
      expect(committedCallbacks).toEqual([
        "safe-progress-signal:1",
        "safe-progress-signal:2",
      ]);
      expect(observed).toHaveLength(1);

      await expect(port.appendEvent({
        ...progressEvent,
        sourceEventId: "safe-progress-signal:3",
        sourceSeq: 3,
        eventType: "item.delta",
        itemId: "streaming-message",
        payload: { kind: "agentMessage", text: "still writing" },
      })).resolves.toMatchObject({ disposition: "committed" });
      expect(observed).toHaveLength(2);
      expect(observed[1]).toMatchObject({ seq: 3, eventType: "item.delta", payload: {
        prpEvent: { eventType: "item.delta", payload: { text: "still writing" } },
      } });
      expect(committedCallbacks).toEqual([
        "safe-progress-signal:1",
        "safe-progress-signal:2",
        "safe-progress-signal:3",
      ]);
    } finally {
      unsubscribe();
    }
  });

  it("recovers a runtime question when the event commits before its callback", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const issueId = "40000000-0000-4000-8000-000000000041";
    const runId = "41000000-0000-4000-8000-000000000041";
    const sessionId = "42000000-0000-4000-8000-000000000041";
    const runnerInstanceId = "43000000-0000-4000-8000-000000000041";
    const localContractId = "44000000-0000-4000-8000-000000000041";
    const contractSha256 = "runtime-question-recovery-contract";
    await db.insert(issues).values({
      id: issueId,
      companyId: identity.companyId,
      title: "Recover a committed runtime question",
      status: "in_progress",
      assigneeAgentId: identity.agentId,
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: localContractId,
      companyId: identity.companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "phase6-v1",
        objective: "Recover a committed runtime question",
        criteria: [{ id: "objective", requirement: "Recover the question" }],
      },
      canonicalSha256: contractSha256,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      nativeSessionId: sessionId,
      runnerInstanceId,
      completionContractId: localContractId,
      completionContractSha256: contractSha256,
      contextSnapshot: { issueId },
    });

    const binding = {
      companyId: identity.companyId,
      issueId,
      runId,
      agentId: identity.agentId,
      sessionId,
      completionContractId: localContractId,
      completionContractSha256: contractSha256,
      sourceInstanceId: runnerInstanceId,
      controlPlaneSourceInstanceId: "runtime-question-recovery-control",
    };
    const questionEvent: PrpEvent = {
      schema: "paperclip.prp.event.v1",
      sourceEventId: "runtime-question-recovery:1",
      sourceSeq: 1,
      sourceInstanceId: runnerInstanceId,
      sourceKind: "runner",
      runId,
      normalizedSessionId: sessionId,
      turnId: "runtime-question-recovery-turn",
      eventType: "runtime_request.expired",
      schemaVersion: 1,
      priority: 0,
      emittedAt: "2026-08-09T03:00:00.000Z",
      payload: {
        requestId: "runtime-question-recovery-request",
        requestKind: "runtime",
        requestType: "input",
        reason: "provider_process_lost",
        replayAllowed: false,
        request: {
          schema: "paperclip.runtime_request.v2",
          requestKind: "runtime",
          requestId: "runtime-question-recovery-request",
          type: "input",
          status: "pending",
          prompt: "Choose a recovery option",
          turnId: "runtime-question-recovery-turn",
          itemId: "runtime-question-recovery-item",
          input: {
            schema: "paperclip.question_set.v1",
            title: "Choose a recovery option",
            questions: [
              {
                id: "recovery-option",
                prompt: "Which option should recovery use?",
                required: true,
                answerMode: "single_select",
                options: [
                  { id: "safe", label: "Safe recovery" },
                  { id: "fast", label: "Fast recovery" },
                ],
              },
            ],
          },
        },
      },
    };
    const port = new PaperclipControlPlanePort(db, binding, {
      onCommittedEvent: async () => {
        throw new Error("simulated_post_commit_crash");
      },
      onDuplicateEvent: async (event) => {
        await materializeRuntimeQuestionFallback({ db, binding, event });
      },
    });
    await port.openRun({
      identity: { ...identity, issueId, runId, sessionId },
      backendKind: "mock",
      sourceInstanceId: runnerInstanceId,
    });

    await expect(port.appendEvent(questionEvent)).rejects.toThrow(
      "simulated_post_commit_crash",
    );
    await expect(
      db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.issueId, issueId)),
    ).resolves.toEqual([]);

    await expect(port.appendEvent(questionEvent)).resolves.toMatchObject({
      disposition: "duplicate",
    });
    await expect(
      db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.issueId, issueId)),
    ).resolves.toEqual([
      expect.objectContaining({
        kind: "ask_user_questions",
        status: "pending",
        idempotencyKey: `runtime-input-durable:v1:${runId}:runtime-question-recovery-request`,
        sourceRunId: runId,
      }),
    ]);
  });

  it("persists a delayed final answer and replay before resolving the selected task response", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const sessionId = taskSessionId;
    const evidenceRef = `work_product:${taskWorkProductId}`;
    const taskResult = structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT);
    taskResult.completionClaim.contractRevision = "phase6-v1";
    taskResult.completionClaim.criteria[0]!.evidenceRefs = [evidenceRef];
    taskResult.evidence = [{ kind: "work_product", ref: evidenceRef }];
    taskResult.verification[0]!.artifactRef = evidenceRef;
    const event = (sourceSeq: number, eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent => ({
      schema: "paperclip.prp.event.v1",
      sourceEventId: `phase6-task:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: taskRunnerId,
      sourceKind: "runner",
      runId: taskRunId,
      normalizedSessionId: sessionId,
      turnId: "turn-phase6-paperclip-task",
      eventType,
      schemaVersion: 1,
      priority: 0,
      emittedAt: `2026-08-09T02:59:0${sourceSeq}.000Z`,
      payload,
    });
    const finalText = "The launch has two stages. Source: https://example.invalid/launch/STREAM-42";
    const finalAnswer = event(2, "item.completed", { kind: "agentMessage", channel: "final", text: finalText });
    const events = [
      event(1, "run.result.proposed", taskResult),
      finalAnswer,
      finalAnswer, // Exact replay must not create another stored answer.
      event(3, "turn.completed", {}),
    ];
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "phase6-scripted",
          version: "1",
          capabilities: { resume: false, typedEvents: true, steering: false, interruption: true, structuredResult: true },
          runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" },
        };
      },
      async openSession(input) {
        return {
          identity: () => input.identity,
          async capabilities() { return { resume: false, typedEvents: true, steering: false, interruption: true, structuredResult: true }; },
          async *events() {
            yield events[0]!;
            await new Promise((resolve) => setTimeout(resolve, 6_000));
            yield* events.slice(1);
          },
          async startTurn() { return { turnId: "turn-phase6-paperclip-task" }; },
          cancel() { throw new Error("A completion report must not interrupt the provider"); },
          async result() { return { result: taskResult, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, turnId: "turn-phase6-paperclip-task" }; },
          async snapshot() { return { backendKind: "mock", sessionId, identity: input.identity, providerSessionId: "provider-phase6-paperclip-task" }; },
          async close() {},
        };
      },
    };
    const execution = parseNativeExecutionInput({
      schema: "paperclip.native-execution-input.v4",
      executionMode: "default",
      planningContext: null,
      binding: {
        companyId: identity.companyId,
        runId: taskRunId,
        issueId: taskIssueId,
        agentId: identity.agentId,
        executionWorkspaceId: "workspace-phase6",
      },
      task: {
        identifier: "P6C-2",
        title: "Complete one native task",
        description: null,
        prompt: "# P6C-2: Complete one native task",
        workMode: "standard",
      },
      workspace: {
        cwd: process.cwd(),
        repoUrl: null,
        repoRef: null,
        branchName: null,
      },
      session: {
        normalizedSessionId: sessionId,
        driverKind: "codex_app_server",
        protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
      },
      provider: { kind: "codex", model: null, approvalPolicy: "never" },
      completionContract: {
        id: taskContractId,
        sha256: "phase6-task-contract",
        schemaVersion: "paperclip.completion-contract.v1",
        contract: { revision: "phase6-v1", objective: "Complete one native task", criteria: [{ id: "objective", requirement: "Complete the task" }] },
      },
      interactionResponses: [],
      credentialBindings: [],
      runtimeContext: nativeRuntimeContextFixture(),
    });
    let resultCommitMarkers = 0;
    const port = new PaperclipControlPlanePort(db, {
      companyId: identity.companyId,
      issueId: taskIssueId,
      runId: taskRunId,
      agentId: identity.agentId,
      sessionId: taskSessionId,
      completionContractId: taskContractId,
      completionContractSha256: "phase6-task-contract",
      sourceInstanceId: taskRunnerId,
      controlPlaneSourceInstanceId: "phase6-control-plane",
    }, {onResultCommitted:async()=>{resultCommitMarkers++;}});
    const completed = await executeNativeSession({
      input: execution,
      backend,
      controlPlane: port,
      runnerInstanceId: taskRunnerId,
      controlPlaneInstanceId: "phase6-control-plane",
    });
    expect(completed.terminal.runTerminalState).toBe("succeeded");
    const stored = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, taskRunId)).orderBy(asc(heartbeatRunEvents.seq));
    const answers = stored.filter((row) => row.eventType === "item.completed");
    expect(answers).toHaveLength(1);
    const finalAgentMessage = selectHeartbeatRunFinalAgentMessage({
      candidates: answers.flatMap((row) => {
        const candidate = readCompletedAssistantMessageCandidate({ seq: row.seq, prpEvent: row.payload?.prpEvent });
        return candidate ? [candidate] : [];
      }),
    });
    const response = resolveHeartbeatRunResponse({
      resultJson: { nativeResult: taskResult }, finalAgentMessage,
    });
    expect(resolveHeartbeatRunResponse({ resultJson: { nativeResult: taskResult } }).text).toBe(taskResult.summary);
    expect(response.text).toBe(finalText);
    expect(response.decision.chosenSource).toBe("final_agent_message");
    expect(stored.findIndex((row) => row.eventType === "run.result.accepted"))
      .toBeGreaterThan(stored.findIndex((row) => row.eventType === "item.completed"));
    // A workspace recovery owner can commit before the live heartbeat reaches
    // presentation. The file-preparation comment must not hide the real reply.
    const [workspaceNotice] = await db.insert(issueComments).values({
      companyId: identity.companyId, issueId: taskIssueId,
      authorAgentId: identity.agentId, authorType: "agent", createdByRunId: taskRunId,
      body: "## Workspace Ready",
      presentation: { kind: "system_notice", tone: "info", title: "Workspace ready", density: "compact", detailsDefaultOpen: false },
    }).returning();
    const [prepared] = await db.insert(issueComments).values({
      companyId: identity.companyId, issueId: taskIssueId,
      authorAgentId: identity.agentId, authorType: "agent", createdByRunId: taskRunId,
      body: "Prepared Continuity file for this response.",
    }).returning();
    const receipt = { semanticToolReceipts: { file: {
      operationId: "register_deliverable", result: {
        commandId: "deliverable-prepared:attachment-1", disposition: "applied",
        attachmentId: "attachment-1", entityRefs: ["attachment-1", prepared!.id],
      },
    } } };
    await db.update(heartbeatRuns).set({
      contextSnapshot: { skipIssueComment: true },
      resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify(receipt)}::jsonb`,
    }).where(eq(heartbeatRuns.id, taskRunId));
    await finalizeNativeRun({ db, runId: taskRunId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const repair = () => repairCommittedNativeChatResponse(db, {
      companyId: identity.companyId, issueId: taskIssueId, runId: taskRunId,
    });
    expect(await repair()).toBe(false);
    await db.update(heartbeatRuns).set({ contextSnapshot: { externalChatContinuation: true } })
      .where(eq(heartbeatRuns.id, taskRunId));
    expect(await repair()).toBe(false);
    await db.update(heartbeatRuns).set({ contextSnapshot: {} }).where(eq(heartbeatRuns.id, taskRunId));
    const work = nativeResponsePresentationWork(db);
    const [entry] = await work.load({ companyId: identity.companyId, runId: taskRunId });
    expect(entry?.id).toBe(taskRunId);
    expect(await work.check(entry)).toBeNull();
    expect(await repair()).toBe(false);
    expect(await db.select({ body: issueComments.body }).from(issueComments)
      .where(eq(issueComments.createdByRunId, taskRunId)).orderBy(asc(issueComments.createdAt)))
      .toEqual([{ body: workspaceNotice!.body }, { body: prepared!.body }, { body: finalText }]);
    await expect(port.completeRun({
      result: taskResult,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      turnId: "turn-phase6-paperclip-task",
      callerResultId: `phase6-scripted-runner:${taskRunId}:result`,
      callerDedupeKey: `${taskRunId}:phase6-task-contract`,
    })).resolves.toBeUndefined();
    await expect(port.completeRun({
      result: { ...structuredClone(taskResult), summary: "Conflicting changed result bytes" },
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      turnId: "turn-phase6-paperclip-task",
      callerResultId: `phase6-scripted-runner:${taskRunId}:result`,
      callerDedupeKey: `${taskRunId}:phase6-task-contract`,
    })).rejects.toThrow("structured_result_replay_conflict");
    expect(resultCommitMarkers).toBe(1);
    await Promise.all([
      finalizeNativeRun({ db, runId: taskRunId, workspaceFinalizeStatus: "succeeded" }),
      finalizeNativeRun({ db, runId: taskRunId, workspaceFinalizeStatus: "succeeded" }),
    ]);
    await expect(db.select().from(issues).where(eq(issues.id, taskIssueId))).resolves.toEqual([
      expect.objectContaining({ status: "done", statusVersion: 1 }),
    ]);
    await expect(db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, taskRunId))).resolves.toHaveLength(1);
    await expect(db.select().from(workAssessments).where(eq(workAssessments.runId, taskRunId))).resolves.toHaveLength(1);
    await expect(db.select().from(statusDecisions).where(eq(statusDecisions.issueId, taskIssueId))).resolves.toHaveLength(1);
  });

  it("fails closed when the bound company does not own the run", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const port = new PaperclipControlPlanePort(db, {
      companyId: "00000000-0000-4000-8000-000000000099",
      issueId: identity.issueId,
      runId: identity.runId,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      completionContractId: contractId,
      completionContractSha256: contractSha,
      sourceInstanceId: conformanceRunnerId,
      controlPlaneSourceInstanceId: "control-conformance",
    });
    await expect(port.openRun(CONTROL_PLANE_CONFORMANCE_OPEN)).rejects.toThrow("binding_mismatch");
  });

  it("revalidates every persisted native binding before open and completion", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const issueId = "00000000-0000-4000-8000-000000000091";
    const localContractId = "00000000-0000-4000-8000-000000000092";
    const runId = "00000000-0000-4000-8000-000000000093";
    const sessionId = "00000000-0000-4000-8000-000000000094";
    const runnerInstanceId = "00000000-0000-4000-8000-000000000095";
    const contractSha256 = "strict-native-binding-contract";
    await db.insert(issues).values({
      id: issueId,
      companyId: identity.companyId,
      title: "Strict native binding",
      status: "in_progress",
      assigneeAgentId: identity.agentId,
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: localContractId,
      companyId: identity.companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "strict-binding-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "strict-binding-v1",
        objective: "Enforce the persisted binding",
        criteria: [{ id: "objective", requirement: "Reject every mismatch" }],
      },
      canonicalSha256: contractSha256,
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      nativeSessionId: sessionId,
      runnerInstanceId,
      completionContractId: localContractId,
      completionContractSha256: contractSha256,
      contextSnapshot: { issueId },
    });
    const createPort = () => new PaperclipControlPlanePort(db, {
      companyId: identity.companyId,
      issueId,
      runId,
      agentId: identity.agentId,
      sessionId,
      completionContractId: localContractId,
      completionContractSha256: contractSha256,
      sourceInstanceId: runnerInstanceId,
      controlPlaneSourceInstanceId: "strict-binding-control",
    });
    const open = {
      identity: { ...identity, issueId, runId, sessionId },
      backendKind: "mock" as const,
      sourceInstanceId: runnerInstanceId,
    };
    const mutations = [
      { invalid: { nativeIssueId: taskIssueId }, restore: { nativeIssueId: issueId } },
      { invalid: { nativeSessionId: taskSessionId }, restore: { nativeSessionId: sessionId } },
      { invalid: { runnerInstanceId: taskRunnerId }, restore: { runnerInstanceId } },
      { invalid: { completionContractId: taskContractId }, restore: { completionContractId: localContractId } },
      { invalid: { completionContractSha256: "wrong-contract" }, restore: { completionContractSha256: contractSha256 } },
    ] satisfies Array<{
      invalid: Partial<typeof heartbeatRuns.$inferInsert>;
      restore: Partial<typeof heartbeatRuns.$inferInsert>;
    }>;
    for (const mutation of mutations) {
      // Verify service-level binding checks even for corrupted historical rows.
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local session_replication_role = replica`);
        await tx.update(heartbeatRuns).set(mutation.invalid).where(eq(heartbeatRuns.id, runId));
      });
      await expect(createPort().openRun(open)).rejects.toThrow("native_open_run_not_authorized");
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local session_replication_role = replica`);
        await tx.update(heartbeatRuns).set(mutation.restore).where(eq(heartbeatRuns.id, runId));
      });
    }

    const openedPort = createPort();
    await openedPort.openRun(open);
    await db.update(heartbeatRuns).set({ runnerInstanceId: taskRunnerId }).where(eq(heartbeatRuns.id, runId));
    await expect(openedPort.completeRun({
      result: CONTROL_PLANE_CONFORMANCE_RESULT,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: "strict-native-binding-result",
    })).rejects.toThrow("native_result_binding_mismatch");
    await db.update(heartbeatRuns).set({ runnerInstanceId }).where(eq(heartbeatRuns.id, runId));
  });

  it.each(["port", "coordinator"])("does not deadlock %s result persistence against a task mutation that updates its run", async (kind) => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: identity.companyId, agentId: identity.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: identity.issueId,
      nativeSessionId: identity.sessionId, runnerInstanceId: conformanceRunnerId,
      completionContractId: contractId, completionContractSha256: contractSha,
    });
    let resultCommitted = false;
    const port = kind === "port" ? new PaperclipControlPlanePort(db, {
      ...identity, runId, completionContractId: contractId, completionContractSha256: contractSha,
      sourceInstanceId: conformanceRunnerId, controlPlaneSourceInstanceId: "result-lock-order",
    }, {onResultCommitted:async()=>{
      const rows=await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId,runId));
      expect(rows).toHaveLength(1);resultCommitted=true;
    }}) : new NativeRunCoordinatorStore(db, {
      ...identity, runId, completionContractId: contractId, completionContractSha256: contractSha,
      normalizedSessionId: identity.sessionId, runnerSourceInstanceId: conformanceRunnerId,
      completionContractRevision: "standalone-v1", completionContractCriterionIds: ["objective"],
    });
    let completion: Promise<unknown> | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx.select().from(issues).where(eq(issues.id, identity.issueId)).for("update");
        const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`) as unknown as Array<{ pid: number }>;
        completion = port.completeRun({
          result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
          callerResultId: "result-lock-order",
        }).then(() => null, (error: unknown) => error);
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const [state] = await db.execute(sql`select exists (
            select 1 from pg_stat_activity where ${backend.pid} = any(pg_blocking_pids(pid))
          ) as waiting`) as unknown as Array<{ waiting: boolean }>;
          if (state.waiting) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
        expect(resultCommitted).toBe(false);
        await tx.execute(sql`set local lock_timeout = '1s'`);
        await tx.update(heartbeatRuns).set({ updatedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
      });
    } finally {
      expect(await completion).toBeNull();
      expect(resultCommitted).toBe(kind === "port");
    }
  });

  it.each(["port", "coordinator"])("clears a resumed session's recovery state when %s persists its result", async (kind) => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: identity.companyId, agentId: identity.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: identity.issueId,
      nativeSessionId: identity.sessionId, runnerInstanceId: conformanceRunnerId,
      completionContractId: contractId, completionContractSha256: contractSha,
    });
    await db.insert(nativeRunFinalizations).values({
      runId, companyId: identity.companyId, issueId: identity.issueId,
      phase: "observed", recoveryState: "resuming_session", recoveryRequestId: "restart-request",
    });
    const port = kind === "port" ? new PaperclipControlPlanePort(db, {
      ...identity, runId, completionContractId: contractId, completionContractSha256: contractSha,
      sourceInstanceId: conformanceRunnerId, controlPlaneSourceInstanceId: "resumed-result",
    }) : new NativeRunCoordinatorStore(db, {
      ...identity, runId, completionContractId: contractId, completionContractSha256: contractSha,
      normalizedSessionId: identity.sessionId, runnerSourceInstanceId: conformanceRunnerId,
      completionContractRevision: "standalone-v1", completionContractCriterionIds: ["objective"],
    });
    await port.completeRun({
      result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: "resumed-result",
    });
    await expect(db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId))).resolves.toEqual([
      expect.objectContaining({ phase: "workspace_finalizing", recoveryState: null, recoveryRequestId: null }),
    ]);
  });

  it("does not let native completion bypass a pending issue interaction", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const port = new PaperclipControlPlanePort(db, {
      companyId: identity.companyId,
      issueId: governanceIssueId,
      runId: governanceRunId,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      completionContractId: governanceContractId,
      completionContractSha256: "phase6-governance-contract",
      sourceInstanceId: governanceRunnerId,
      controlPlaneSourceInstanceId: "control-phase6-governance",
    });
    await port.openRun({
      identity: { ...identity, runId: governanceRunId, issueId: governanceIssueId },
      backendKind: "mock",
      sourceInstanceId: governanceRunnerId,
    });
    await port.completeRun({
      result: CONTROL_PLANE_CONFORMANCE_RESULT,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: "phase6-governance-result",
    });
    await finalizeNativeRun({ db, runId: governanceRunId, workspaceFinalizeStatus: "succeeded" });
    await expect(db.select().from(issues).where(eq(issues.id, governanceIssueId))).resolves.toEqual([
      expect.objectContaining({ status: "in_review" }),
    ]);
    await expect(db.select().from(statusDecisions).where(eq(statusDecisions.issueId, governanceIssueId))).resolves.toEqual([
      expect.objectContaining({ toStatus: "in_review", reasonCode: "governed_gate_pending" }),
    ]);
  });

  it("P6-23 materializes native review through the authorized interaction service", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const issueId = "30000000-0000-4000-8000-000000000024";
    const localContractId = "31000000-0000-4000-8000-000000000024";
    const runId = "32000000-0000-4000-8000-000000000024";
    const runnerInstanceId = "33000000-0000-4000-8000-000000000024";
    const reviewerAgentId = "34000000-0000-4000-8000-000000000024";
    await db.insert(authUsers).values({
      id: "reviewer-24", name: "Human reviewer", email: "reviewer-24@example.test",
      createdAt: new Date(), updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId: identity.companyId, principalType: "user", principalId: "reviewer-24",
      status: "active", membershipRole: "member",
    });
    await db.insert(agents).values({
      id: reviewerAgentId, companyId: identity.companyId, name: "Review lead",
      adapterType: "codex_local", status: "idle",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId: identity.companyId,
      title: "Native review interaction",
      status: "in_progress",
      assigneeAgentId: identity.agentId,
      responsibleUserId: "reviewer-24",
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: localContractId,
      companyId: identity.companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "phase6-v1", objective: "Review", criteria: [{ id: "objective", requirement: "Review" }] },
      canonicalSha256: "native-review-contract",
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      nativeSessionId: identity.sessionId,
      runnerInstanceId,
      completionContractId: localContractId,
      completionContractSha256: "native-review-contract",
      contextSnapshot: { issueId },
    });
    const port = new PaperclipControlPlanePort(db, {
      companyId: identity.companyId,
      issueId,
      runId,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      completionContractId: localContractId,
      completionContractSha256: "native-review-contract",
      sourceInstanceId: runnerInstanceId,
      controlPlaneSourceInstanceId: "native-review-control",
    });
    await port.openRun({
      identity: { ...identity, issueId, runId },
      backendKind: "mock",
      sourceInstanceId: runnerInstanceId,
    });
    const result = { ...structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT), completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: "phase6-v1" }, reportedWorkDisposition: "needs_review" as const, attentionRequests: [{ kind: "approval" as const, summary: "Approve publication", ownerClass: "human" as const }, { kind: "review" as const, summary: "Review release notes", ownerClass: "agent" as const, targetAgentId: reviewerAgentId }] };
    await expect(nativeCompletionFeedback(db, runId, { ...result, attentionRequests: [] }))
      .rejects.toThrow("needs_review requires");
    await expect(nativeCompletionFeedback(db, runId, {
      ...result, attentionRequests: [{ kind: "review", summary: "Review work", ownerClass: "agent", targetAgentId: identity.agentId }],
    })).rejects.toThrow("cannot review its own");
    await expect(nativeCompletionFeedback(db, runId, {
      ...result, attentionRequests: [{ kind: "review", summary: "Review work", ownerClass: "agent", targetAgentId: "99999999-9999-4999-8999-999999999999" }],
    })).rejects.toThrow("not available in this company");
    await expect(nativeCompletionFeedback(db, runId, {
      ...result,
      completionClaim: { ...result.completionClaim, contractRevision: "stale-first-turn" },
    })).rejects.toThrow(/contractRevision.*phase6-v1/);
    await expect(nativeCompletionFeedback(db, runId, result)).resolves.toContain("Completion report accepted");
    await port.completeRun({
      result,
      terminal: { ...CONTROL_PLANE_CONFORMANCE_TERMINAL, reportedWorkDisposition: "needs_review" },
      callerResultId: "native-review-result",
    });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded" });
    // Reconciliation must reuse the review card and its durable wake together.
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded" });
    const reviewWakes = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, reviewerAgentId));
    expect(reviewWakes).toHaveLength(1);
    const agentReview = (await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.issueId, issueId)))
      .find((entry) => entry.addresseeAgentId === reviewerAgentId)!;
    await issueThreadInteractionService(db).sweepSupersededPendingRequestConfirmations();
    expect(await db.select({ status: issueThreadInteractions.status, createdByAgentId: issueThreadInteractions.createdByAgentId })
      .from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId)))
      .toEqual([
        { status: "pending", createdByAgentId: identity.agentId },
        { status: "pending", createdByAgentId: identity.agentId },
      ]);
    expect(reviewWakes[0]).toMatchObject({
      companyId: identity.companyId, status: "queued", reason: "native_completion_review",
      payload: { issueId, nativeReviewInteractionId: agentReview.id },
    });
    await expect(getNativeReviewAssignment(db, {
      companyId: identity.companyId, issueId, agentId: reviewerAgentId,
      contextSnapshot: reviewWakes[0]!.payload,
    })).resolves.toMatchObject({ interaction: { id: agentReview.id } });
    await expect(getNativeReviewAssignment(db, {
      companyId: identity.companyId, issueId, agentId: identity.agentId,
      contextSnapshot: reviewWakes[0]!.payload,
    })).resolves.toBeNull();
    const reviewRunId = "35000000-0000-4000-8000-000000000024";
    const nativeReview = {
      nativeReviewInteractionId: agentReview.id,
      nativeReviewDecisionId: (agentReview.payload as { target: { revisionId: string } }).target.revisionId,
    };
    await db.update(agentWakeupRequests).set({ runId: reviewRunId }).where(eq(agentWakeupRequests.id, reviewWakes[0]!.id));
    const [reviewRun] = await db.insert(heartbeatRuns).values({
      id: reviewRunId, companyId: identity.companyId, agentId: reviewerAgentId,
      status: "queued", runtimeMode: "native", nativeIssueId: issueId,
      wakeupRequestId: reviewWakes[0]!.id,
      contextSnapshot: { issueId, wakeReason: "native_completion_review", ...nativeReview },
    }).returning();
    await expect(createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
      companyId: identity.companyId, runId: reviewRunId, expectedStatus: "queued", now: new Date(),
    })).resolves.toMatchObject({ outcome: "not_stale" });
    await db.insert(heartbeatRuns).values({
      id: "35000000-0000-4000-8000-000000000025", companyId: identity.companyId,
      agentId: reviewerAgentId, status: "running", runtimeMode: "native", nativeIssueId: issueId,
    });
    await db.update(issues).set({ executionRunId: "35000000-0000-4000-8000-000000000025" }).where(eq(issues.id, issueId));
    await expect(claimQueuedNativeReviewRun(db, {
      run: reviewRun!, agentNameKey: "reviewer", claimedAt: new Date(), claimValues: {},
    })).resolves.toBeNull();
    await expect(db.select({ status: heartbeatRuns.status, executionRunId: issues.executionRunId })
      .from(heartbeatRuns).innerJoin(issues, eq(issues.id, issueId)).where(eq(heartbeatRuns.id, reviewRunId)))
      .resolves.toMatchObject([{ status: "queued", executionRunId: "35000000-0000-4000-8000-000000000025" }]);
    await expect(db.select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests).where(eq(agentWakeupRequests.id, reviewWakes[0]!.id)))
      .resolves.toEqual([{ status: "queued" }]);
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId));
    await expect(claimQueuedNativeReviewRun(db, {
      run: reviewRun!, agentNameKey: "reviewer", claimedAt: new Date(), claimValues: {},
    })).resolves.toMatchObject({ id: reviewRunId, status: "running" });
    await expect(db.select({ status: agentWakeupRequests.status, executionRunId: issues.executionRunId })
      .from(agentWakeupRequests).innerJoin(issues, eq(issues.id, issueId)).where(eq(agentWakeupRequests.id, reviewWakes[0]!.id)))
      .resolves.toMatchObject([{ status: "claimed", executionRunId: reviewRunId }]);
    await expect(claimQueuedNativeReviewRun(db, {
      run: reviewRun!, agentNameKey: "reviewer", claimedAt: new Date(), claimValues: {},
    })).resolves.toBeNull();
    await expect(claimNativeReviewExecutionLock(db, {
      companyId: identity.companyId, issueId, agentId: identity.agentId, runId: reviewRunId,
      contextSnapshot: nativeReview, agentNameKey: "worker", claimedAt: new Date(),
    })).resolves.toBe(false);
    await expect(claimNativeReviewExecutionLock(db, {
      companyId: identity.companyId, issueId, agentId: reviewerAgentId, runId: reviewRunId,
      contextSnapshot: nativeReview, agentNameKey: "reviewer", claimedAt: new Date(),
    })).resolves.toBe(true);
    await expect(stageNativeRunnerWakeAttachments({
      db,
      binding: {
        companyId: identity.companyId, issueId, agentId: reviewerAgentId, runId: reviewRunId,
        workspaceRoot: "/tmp/review-handoff", executionTargetKind: "remote",
      },
    })).resolves.toMatchObject({ attachments: [] });
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId, nativeReviewInteractionId: agentReview.id } }).where(eq(heartbeatRuns.id, reviewRunId));
    await expect(stageNativeRunnerWakeAttachments({
      db,
      binding: { companyId: identity.companyId, issueId, agentId: reviewerAgentId, runId: reviewRunId, workspaceRoot: "/tmp/review-handoff", executionTargetKind: "remote" },
    })).rejects.toThrow("not_authorized");
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId, wakeReason: "native_completion_review", ...nativeReview } }).where(eq(heartbeatRuns.id, reviewRunId));
    await db.update(issueThreadInteractions).set({ status: "accepted" }).where(eq(issueThreadInteractions.id, agentReview.id));
    await expect(stageNativeRunnerWakeAttachments({
      db,
      binding: { companyId: identity.companyId, issueId, agentId: reviewerAgentId, runId: reviewRunId, workspaceRoot: "/tmp/review-handoff", executionTargetKind: "remote" },
    })).rejects.toThrow("not_authorized");
    await db.update(issueThreadInteractions).set({ status: "pending" }).where(eq(issueThreadInteractions.id, agentReview.id));
    await expect(createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
      companyId: identity.companyId, runId: reviewRunId, expectedStatus: "queued", now: new Date(),
    })).resolves.toMatchObject({ outcome: "lost_race" });
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, reviewRunId));
    const reviewBinding = {
      companyId: identity.companyId, issueId, agentId: reviewerAgentId, runId: reviewRunId,
    };
    await expect(assertCurrentWakeCommentsRead(db, reviewBinding, null)).resolves.toBeUndefined();
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId));
    await expect(assertCurrentWakeCommentsRead(db, reviewBinding, null))
      .rejects.toThrow("native_current_wake_comments_binding_changed");
    await db.update(issues).set({ executionRunId: reviewRunId }).where(eq(issues.id, issueId));
    const reviewAuthority = new PaperclipRunnerToolAuthority(db, {
      companyId: identity.companyId, issueId, agentId: reviewerAgentId, runId: reviewRunId, nativeReview,
    });
    expect(reviewAuthority.definitions().map((tool) => tool.name)).toEqual([
      "get_task_context", "get_task_history", "list_documents", "read_document", "list_document_revisions", "resolve_review",
    ]);
    await expect(reviewAuthority.execute({ tool: "get_task_context", callId: "review-read", arguments: {} }))
      .resolves.toMatchObject({ assignedReview: { id: agentReview.id }, activeTask: { assigneeAgentId: identity.agentId } });
    await expect(reviewAuthority.execute({ tool: "set_dependencies", callId: "review-mutate", arguments: {} }))
      .rejects.toThrow("may only inspect");
    await expect(nativeCompletionFeedback(db, reviewRunId, CONTROL_PLANE_CONFORMANCE_RESULT))
      .rejects.toThrow("Resolve your assigned review");
    await expect(reviewAuthority.execute({ tool: "resolve_review", callId: "review-missing-reason", arguments: { decision: "reject" } }))
      .rejects.toThrow("Explain the changes");
    await expect(reviewAuthority.execute({ tool: "resolve_review", callId: "review-other-target", arguments: { decision: "accept", issueId: taskIssueId } }))
      .rejects.toThrow("Choose accept or reject");
    await db.update(issues).set({ statusVersion: 2 }).where(eq(issues.id, issueId));
    await expect(reviewAuthority.execute({ tool: "get_task_context", callId: "review-stale", arguments: {} }))
      .rejects.toThrow("no longer available");
    await expect(issueThreadInteractionService(db).acceptInteraction(
      { id: issueId, companyId: identity.companyId, projectId: null, goalId: null }, agentReview.id, {},
      { agentId: reviewerAgentId, runId: reviewRunId },
    )).rejects.toThrow("no longer current");
    await db.update(issues).set({ statusVersion: 1 }).where(eq(issues.id, issueId));

    const reviewIssue = { id: issueId, companyId: identity.companyId, projectId: null, goalId: null, status: "in_review" as const };
    const rejectUnboundReview = async (runId?: string) => issueThreadInteractionService(db).acceptInteraction(
      reviewIssue, agentReview.id, {}, { agentId: reviewerAgentId, ...(runId ? { runId } : {}) },
    );
    await expect(rejectUnboundReview("35000000-0000-4000-8000-000000000025"))
      .rejects.toThrow("no longer current");
    await expect(db.select({ status: issueThreadInteractions.status })
      .from(issueThreadInteractions).where(eq(issueThreadInteractions.id, agentReview.id)))
      .resolves.toEqual([{ status: "pending" }]);
    await expect(rejectUnboundReview()).rejects.toThrow("valid authenticated agent run");
    await expect(db.select({ status: issueThreadInteractions.status })
      .from(issueThreadInteractions).where(eq(issueThreadInteractions.id, agentReview.id)))
      .resolves.toEqual([{ status: "pending" }]);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, reviewRunId));
    await expect(rejectUnboundReview(reviewRunId)).rejects.toThrow("no longer current");
    await expect(db.select({ status: issueThreadInteractions.status })
      .from(issueThreadInteractions).where(eq(issueThreadInteractions.id, agentReview.id)))
      .resolves.toEqual([{ status: "pending" }]);
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, reviewRunId));

    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toEqual([
      expect.objectContaining({ status: "in_review", statusVersion: 1, assigneeAgentId: identity.agentId }),
    ]);
    const [reviewInteraction] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
    expect(reviewInteraction).toMatchObject({
      kind: "request_confirmation",
      status: "pending",
      sourceRunId: runId,
      addresseeUserId: "reviewer-24",
      effectiveResolverPolicy: "human_only",
    });
    await expect(db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.issueId, issueId))).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ effectKind: "bind_reviewer", targetType: "issue_thread_interaction" })]),
    );

    await issueThreadInteractionService(db).acceptInteraction(
      { id: issueId, companyId: identity.companyId, projectId: null, goalId: null, status: "in_review" },
      reviewInteraction!.id,
      {},
      { userId: "reviewer-24" },
    );
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toEqual([
      expect.objectContaining({ status: "in_review" }),
    ]);
    const remaining = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId));
    expect(remaining).toHaveLength(2);
    const secondReview = remaining.find((entry) => entry.status === "pending")!;
    await issueThreadInteractionService(db).acceptInteraction(
      { id: issueId, companyId: identity.companyId, projectId: null, goalId: null, status: "in_review" },
      secondReview.id, {}, { agentId: reviewerAgentId, runId: reviewRunId },
    );
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toEqual([
      expect.objectContaining({ status: "done" }),
    ]);
    await expect(nativeCompletionFeedback(db, reviewRunId, CONTROL_PLANE_CONFORMANCE_RESULT))
      .resolves.toContain("recorded review decision controls task completion");
    // The real executor checks this fence after the reviewer has accepted and
    // finished. Acceptance releases the lock but keeps the worker assignee.
    await expect(db.select({ executionRunId: issues.executionRunId }).from(issues)
      .where(eq(issues.id, issueId))).resolves.toEqual([{ executionRunId: null }]);
    await expect(assertCurrentWakeCommentsRead(db, reviewBinding, null)).resolves.toBeUndefined();
    await db.update(issueThreadInteractions).set({ resolvedByRunId: null })
      .where(eq(issueThreadInteractions.id, agentReview.id));
    await expect(assertCurrentWakeCommentsRead(db, reviewBinding, null))
      .rejects.toThrow("native_current_wake_comments_binding_changed");
    await db.update(issueThreadInteractions).set({ resolvedByRunId: reviewRunId })
      .where(eq(issueThreadInteractions.id, agentReview.id));

    await expect(reviewAuthority.execute({ tool: "resolve_review", callId: "review-replay", arguments: { decision: "accept" } }))
      .resolves.toMatchObject({ interactionId: agentReview.id, status: "accepted", deduplicated: true });
    // A separate parent session must see the decision this review run recorded.
    const parentId = "36000000-0000-4000-8000-000000000024";
    const parentRunId = "37000000-0000-4000-8000-000000000024";
    await db.insert(issues).values({ id: parentId, companyId: identity.companyId,
      title: "Resume after review", status: "in_progress", assigneeAgentId: reviewerAgentId });
    await db.insert(heartbeatRuns).values({ id: parentRunId, companyId: identity.companyId,
      agentId: reviewerAgentId, nativeIssueId: parentId, status: "running", runtimeMode: "native" });
    await db.update(issues).set({ executionRunId: parentRunId }).where(eq(issues.id, parentId));
    await db.update(issues).set({ parentId }).where(eq(issues.id, issueId));
    const parentAuthority = new PaperclipRunnerToolAuthority(db, {
      companyId: identity.companyId, issueId: parentId, agentId: reviewerAgentId, runId: parentRunId,
    });
    const expectedChildReview = {
      id: agentReview.id, kind: "native_completion_review", status: "accepted",
      result: { childTaskId: issueId, childTaskStatus: "done", reviewerAgentId,
        reviewerRunId: reviewRunId, sourceRunId: runId },
    };
    await expect(parentAuthority.execute({ tool: "get_task_context", callId: "review-parent-context", arguments: {} }))
      .resolves.toMatchObject({ childReviewOutcomes: expect.arrayContaining([expect.objectContaining({
        ...expectedChildReview, result: expect.objectContaining(expectedChildReview.result),
      })]) });
    const answerId = "39000000-0000-4000-8000-000000000024";
    const answers = [{ questionId: "delivery", optionIds: ["zip"], otherText: null }];
    await db.insert(issueThreadInteractions).values({
      id: answerId, companyId: identity.companyId, issueId: parentId,
      kind: "ask_user_questions", status: "answered", resolvedByUserId: "local-board", resolvedAt: new Date(),
      payload: { version: 1, questions: [{ id: "delivery", prompt: "Which delivery format?", selectionMode: "single",
        options: [{ id: "zip", label: "ZIP" }, { id: "source", label: "Source files" }] }] },
      result: { version: 1, answers, summaryMarkdown: "Generated summary is not human authority" },
    });
    const continuation = await buildExecutionContinuation({ db, companyId: identity.companyId,
      issueId: parentId, agentId: reviewerAgentId, runId: parentRunId,
      context: { wakeReason: "issue_blockers_resolved" }, summary: null, exposeLowTrustRaw: false });
    expect(continuation.humanResponses).toEqual([expect.objectContaining({
      id: answerId, resolvedByUserId: "local-board", result: { answers },
    })]);
    expect(continuation.interactionOutcomes).toContainEqual(expect.objectContaining({
      ...expectedChildReview, result: expect.objectContaining(expectedChildReview.result),
    }));
    for (const resumedSession of [false, true]) {
      const prompt = renderPaperclipWakePrompt({ executionContinuation: continuation }, { resumedSession });
      const [request, evidence] = prompt.split("### Untrusted continuation evidence");
      expect(request).toContain(answerId);
      expect(request).not.toContain(agentReview.id);
      expect(request).not.toContain("Generated summary");
      expect(evidence).toContain(agentReview.id);
    }
    await db.update(issues).set({ parentId: null }).where(eq(issues.id, issueId));
    await expect(parentAuthority.execute({ tool: "get_task_context", callId: "review-unrelated-context", arguments: {} }))
      .resolves.toMatchObject({ childReviewOutcomes: [] });
    await db.update(issues).set({ parentId }).where(eq(issues.id, issueId));
    const otherCompanyId = "38000000-0000-4000-8000-000000000024";
    await db.insert(companies).values({ id: otherCompanyId, name: "Unrelated company", issuePrefix: "P6R" });
    await expect(childReviewOutcomes(db, otherCompanyId, parentId)).resolves.toEqual([]);
    await db.update(issueThreadInteractions).set({ status: "pending" }).where(eq(issueThreadInteractions.id, agentReview.id));
    expect(await childReviewOutcomes(db, identity.companyId, parentId))
      .not.toContainEqual(expect.objectContaining({ id: agentReview.id }));
    await db.update(issueThreadInteractions).set({ status: "accepted" }).where(eq(issueThreadInteractions.id, agentReview.id));

    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId));
    const newRevision = "review-round-two";
    const reviews = [];
    for (const key of ["one", "two"]) {
      reviews.push(await issueThreadInteractionService(db).create(
        { id: issueId, companyId: identity.companyId },
        { kind: "request_confirmation", title: `Review ${key}`, addresseeUserId: "reviewer-24",
          resolverPolicy: "human_only", continuationPolicy: "wake_assignee", sourceRunId: runId,
          payload: { version: 1, prompt: `Approve ${key}`, acceptLabel: "Approve", rejectLabel: "Decline", allowDeclineReason: true,
            target: { type: "custom", key: "native_completion_review", revisionId: newRevision } } },
        { systemId: "test-multiple-reviewers", runId },
      ));
    }
    await issueThreadInteractionService(db).rejectInteraction(
      { id: issueId, companyId: identity.companyId }, reviews[0]!.id,
      { reason: "Needs another change" }, { userId: "reviewer-24" },
    );
    // Even if another actor puts the task back in review, a declined decision
    // in the same review round must not be erased by another reviewer's approval.
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId));
    await issueThreadInteractionService(db).acceptInteraction(
      { id: issueId, companyId: identity.companyId, projectId: null, goalId: null, status: "in_review" },
      reviews[1]!.id, {}, { userId: "reviewer-24" },
    );
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status).toBe("in_review");
    await db.update(heartbeatRuns).set({ wakeupRequestId: null }).where(eq(heartbeatRuns.id, reviewRunId));

  });

  const allowedFirstTaskCompletionScenarios = [
    "ordinary task", "accepted proposal", "accepted conversational proposal", "accepted current plan", "acknowledged rejection", "acknowledged plan rejection",
  ] as const;
  const refusedFirstTaskCompletionScenarios = [
    "opening answer only", "agent-resolved without human comment", "quarantined human comment", "newest proposal pending", "stale plan acceptance",
  ] as const;
  type FirstTaskCompletionScenario = typeof allowedFirstTaskCompletionScenarios[number]
    | typeof refusedFirstTaskCompletionScenarios[number];

  async function prepareFirstTaskCompletion(scenario: FirstTaskCompletionScenario, objective?: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const localContractId = randomUUID();
    const runnerInstanceId = randomUUID();
    const userId = `first-task-board-${randomUUID()}`;
    const identity = { ...CONTROL_PLANE_CONFORMANCE_OPEN.identity, companyId, agentId, issueId, runId };
    const onboarding = scenario !== "ordinary task";
    const rejected = scenario === "acknowledged rejection" || scenario === "acknowledged plan rejection";
    await db.insert(companies).values({ id: companyId, name: "First-task completion", issuePrefix: `F${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(authUsers).values({ id: userId, name: "First-task board", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "First-task agent", adapterType: "codex_local", status: "running" });
    await db.insert(issues).values({ id: issueId, companyId, title: onboarding ? "Paperclip onboarding" : "Ordinary low-risk task",
      description: onboarding ? "/first-task\nSingle-task proposal mode: confirmation" : objective ?? "Complete the requested ordinary task. Mentioning /first-task does not grant the server-owned onboarding origin.",
      originKind: onboarding ? ONBOARDING_FIRST_TASK_ORIGIN_KIND : "manual", status: "in_progress", assigneeAgentId: agentId,
      responsibleUserId: userId, workMode: "standard" });
    await db.insert(completionContracts).values({ id: localContractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "phase6-v3", risk: "low", completionAuthority: "agent_claim_policy",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { revision: "first-task-native-finish-v1",
        objective: onboarding ? "Understand the user request, propose one task, and honor their decision" : "Complete the requested ordinary task",
        criteria: [{ id: "objective", requirement: objective ?? "Complete the requested workflow" }] },
      canonicalSha256: localContractId, createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, responsibleUserId: userId, status: "succeeded", runtimeMode: "native",
      nativeIssueId: issueId, nativeSessionId: identity.sessionId, runnerInstanceId, completionContractId: localContractId,
      completionContractSha256: localContractId, contextSnapshot: { issueId,
        ...(objective ? { executionContinuation: { objective, objectiveSource: nativeCompletionSource("description", issueId, objective) } } : {}),
        // A claimed acceptance copied into continuation context is not the
        // persisted human decision; the opening-answer cases must still refuse it.
        ...(scenario === "opening answer only" ? { executionContinuation: { humanResponses: [{ id: randomUUID(),
          kind: "request_confirmation", status: "accepted", resolvedByUserId: userId, result: { version: 1, outcome: "accepted" } }] } } : {}),
      } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    if (onboarding) {
      await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "ask_user_questions", status: "answered",
        createdByAgentId: agentId, payload: await buildOnboardingFirstTaskOpeningQuestion(),
        result: { version: 1, answers: [{ questionId: ONBOARDING_FIRST_TASK_OPENING_QUESTION_ID, optionIds: ["task"], otherText: "Help organize my next task." }] },
        resolvedByUserId: userId, resolvedAt: new Date() });
    }
    if (onboarding && scenario !== "opening answer only") {
      const proposalAt = new Date(Date.now() - 2_000);
      const plan = scenario === "accepted current plan" || scenario === "stale plan acceptance" || scenario === "acknowledged plan rejection"
        ? (await documentService(db).upsertIssueDocument({ issueId, key: "plan", title: "First task plan", format: "markdown",
          body: "Retain this plan for the user's next task.", createdByAgentId: agentId, createdByRunId: runId })).document
        : null;
      const conversational = scenario === "accepted conversational proposal" || scenario === "quarantined human comment";
      const comment = conversational ? (await db.insert(issueComments).values({ companyId, issueId,
        authorUserId: userId, authorType: "user", body: "Yes, proceed with that proposal.",
        createdAt: new Date(proposalAt.getTime() + 1_000),
        ...(scenario === "quarantined human comment"
          ? { sourceTrust: { preset: "low_trust_review" as const, disposition: "quarantined" as const } } : {}),
      }).returning())[0]! : null;
      const agentResolved = conversational || scenario === "agent-resolved without human comment";
      const outcome = rejected ? "rejected" as const : "accepted" as const;
      // Persisted agent interpretations need a real, trusted human reply. The
      // missing/quarantined variants simulate an untrusted stored result.
      await db.insert(issueThreadInteractions).values({ companyId, issueId,
        kind: plan ? "request_checkbox_confirmation" : "request_confirmation", status: outcome,
        createdByAgentId: agentId, sourceRunId: runId, createdAt: proposalAt,
        payload: plan ? { version: 1, prompt: "May I retain this plan?",
          options: [{ id: "retain-plan", label: "Retain the plan" }], defaultSelectedOptionIds: ["retain-plan"], minSelected: 1,
          target: { type: "issue_document", key: "plan", issueId, documentId: plan.id, revisionId: plan.latestRevisionId! },
        } : { version: 1, prompt: "May I create one task to organize your agenda?" },
        result: { version: 1, outcome, ...(plan && outcome === "accepted" ? { selectedOptionIds: ["retain-plan"] } : {}),
          ...(comment ? { commentId: comment.id } : {}),
          ...(outcome === "rejected" ? { reason: "Do not do this work." } : {}) },
        resolvedByUserId: agentResolved ? null : userId,
        resolvedByAgentId: agentResolved ? agentId : null, resolvedByRunId: agentResolved ? runId : null,
        resolvedAt: new Date(),
      });
      if (scenario === "newest proposal pending") {
        await db.insert(issueThreadInteractions).values({ companyId, issueId,
          kind: "request_checkbox_confirmation", status: "pending", createdByAgentId: agentId, sourceRunId: runId,
          createdAt: new Date(proposalAt.getTime() + 1_000),
          payload: { version: 1, prompt: "Accept the revised task scope?", options: [{ id: "revised", label: "Use revised scope" }],
            defaultSelectedOptionIds: ["revised"], minSelected: 1 },
        });
      }
      if (scenario === "stale plan acceptance" || scenario === "acknowledged plan rejection") {
        await documentService(db).upsertIssueDocument({ issueId, key: "plan", format: "markdown",
          baseRevisionId: plan!.latestRevisionId, body: "A revised scope that has no persisted human decision.",
          createdByAgentId: agentId, createdByRunId: runId });
      }
    }
    const port = new PaperclipControlPlanePort(db, { companyId, issueId, runId, agentId, sessionId: identity.sessionId,
      completionContractId: localContractId, completionContractSha256: localContractId,
      sourceInstanceId: runnerInstanceId, controlPlaneSourceInstanceId: "first-task-native-finish-control" });
    await port.openRun({ identity, backendKind: "mock", sourceInstanceId: runnerInstanceId });
    const result: PrpStructuredRunResult = { ...structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT),
      summary: rejected
        ? "You declined the proposal. I will stop here and have not created or performed the proposed task."
        : "The requested workflow is complete.",
      completionClaim: { contractRevision: "first-task-native-finish-v1", objectiveSatisfied: true,
        criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
      evidence: [], verification: [{ commandOrCheck: "Check the current task state", status: "passed" }], attentionRequests: [] };
    return { companyId, agentId, issueId, runId, port, result };
  }

  // Regression: the runner's successful turn fallback is not a filed task claim.
  async function unclaimedTask(options: { provider?: string; ownerAgent?: boolean; selfCreated?: boolean; routine?: boolean } = {}) {
    const f = await prepareFirstTaskCompletion("ordinary task");
    const provider = options.provider ?? "pi_rpc";
    await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider } }).where(eq(agents.id, f.agentId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const ownerAgentId = options.ownerAgent ? options.selfCreated ? f.agentId : randomUUID() : null;
    if (ownerAgentId && ownerAgentId !== f.agentId) await db.insert(agents).values({ id: ownerAgentId, companyId: f.companyId,
      name: "Delegating owner", adapterType: "paperclip_runner", status: "idle" });
    await db.update(issues).set({ createdByAgentId: ownerAgentId }).where(eq(issues.id, f.issueId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    if (options.routine) {
      const [routine] = await db.insert(routines).values({ companyId: f.companyId, title: "Daily summary",
        assigneeAgentId: f.agentId, responsibleUserId: issue!.responsibleUserId }).returning();
      const [invocation] = await db.insert(routineRuns).values({ companyId: f.companyId, routineId: routine.id,
        linkedIssueId: f.issueId, source: "schedule", status: "issue_created", responsibleUserId: issue!.responsibleUserId }).returning();
      await db.update(issues).set({ originKind: "routine_execution", originId: routine.id, originRunId: invocation.id })
        .where(eq(issues.id, f.issueId));
    }
    const startedAt = new Date(Date.now() - 10_000);
    await db.update(heartbeatRuns).set({ startedAt,
      contextSnapshot: { ...run!.contextSnapshot, executionContinuation: { version: 1, messages: [] } } }).where(eq(heartbeatRuns.id, f.runId));
    const ref = `provider:${provider}:agent-message`;
    const synthetic: PrpStructuredRunResult = { ...f.result, summary: "Next I will hire the workers and do the task.",
      completionClaim: { ...f.result.completionClaim!, criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [ref] }] },
      evidence: [{ ref }], verification: [], attentionRequests: [], artifacts: [] };
    return { ...f, synthetic, ownerAgentId, userId: issue!.responsibleUserId!, run: run!, startedAt };
  }

  async function settleUnclaimed(f: Awaited<ReturnType<typeof unclaimedTask>>, report = f.synthetic) {
    await f.port.completeRun({ result: report, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: `${f.run.runnerInstanceId}:${f.runId}:result` });
    for (let replay = 0; replay < 2; replay++) await finalizeNativeRun({ db, runId: f.runId,
      workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.id, issue!.lastStatusDecisionId!));
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    const interactions = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId));
    return { issue, decision, wakes, interactions };
  }

  async function continueUnclaimedTask(options: Parameters<typeof unclaimedTask>[0] = {}) {
    const first = await unclaimedTask(options);
    const settled = await settleUnclaimed(first);
    const wake = settled.wakes.find(row => row.payload?.continuationIdempotencyKey === "native-pi-unclaimed");
    expect(wake, "the first turn must leave exactly one durable repair").toBeDefined();
    const runId = randomUUID(), runnerInstanceId = randomUUID(), startedAt = new Date();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId: first.companyId, agentId: first.agentId,
      status: "running", runtimeMode: "native", nativeIssueId: first.issueId, nativeSessionId: first.run.nativeSessionId,
      runnerInstanceId, completionContractId: first.run.completionContractId, completionContractSha256: first.run.completionContractSha256,
      startedAt, wakeupRequestId: wake!.id, contextSnapshot: { ...wake!.payload?._paperclipWakeContext as object,
        issueId: first.issueId, nativeStatusWakeIntentId: wake!.id } }).returning();
    await db.update(agentWakeupRequests).set({ status: "completed", runId }).where(eq(agentWakeupRequests.id, wake!.id));
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, first.issueId));
    const port = new PaperclipControlPlanePort(db, { companyId: first.companyId, issueId: first.issueId, agentId: first.agentId,
      runId, sessionId: run.nativeSessionId!, completionContractId: run.completionContractId!,
      completionContractSha256: run.completionContractSha256!, sourceInstanceId: runnerInstanceId,
      controlPlaneSourceInstanceId: "unclaimed-continuation-control" });
    await port.openRun({ identity: { ...CONTROL_PLANE_CONFORMANCE_OPEN.identity, companyId: first.companyId,
      issueId: first.issueId, agentId: first.agentId, runId, sessionId: run.nativeSessionId! }, backendKind: "mock", sourceInstanceId: runnerInstanceId });
    return { ...first, run, runId, port, startedAt };
  }

  it("false-done R1: Pi provider-only task gets one compact same-agent repair and no completion notice", async () => {
    const f = await unclaimedTask();
    const parentId = randomUUID();
    await db.insert(issues).values({ id: parentId, companyId: f.companyId, title: "Parent waiting for hires",
      status: "in_progress", assigneeAgentId: f.agentId, conversationAgentId: f.agentId,
      conversationUserId: f.userId, conversationState: "active" });
    await db.insert(chatTaskHandoffs).values({ taskId: f.issueId, companyId: f.companyId, conversationId: parentId,
      agentId: f.agentId, sessionGeneration: 0 });
    await db.update(issues).set({ parentId }).where(eq(issues.id, f.issueId));
    const { issue, decision, wakes, interactions } = await settleUnclaimed(f);
    expect(issue!.status).toBe("in_progress");
    expect(decision).toMatchObject({ reasonCode: "completion_evidence_incomplete", toStatus: "in_progress" });
    expect(interactions).toEqual([]);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ agentId: f.agentId, reason: "issue_continuation_needed",
      payload: { continuationIdempotencyKey: "native-pi-unclaimed" } });
    const context = { ...wakes[0].payload!._paperclipWakeContext as Record<string, unknown>, previousRunId: f.runId };
    const executionContinuation = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId,
      agentId: f.agentId, context, previousContextRunId: f.runId, summary: null, exposeLowTrustRaw: false });
    const wakePayload = await buildPaperclipWakePayload({ db, companyId: f.companyId, agentId: f.agentId,
      contextSnapshot: { ...context, executionContinuation } });
    expect(wakePayload).toMatchObject({ nativeTaskUnclaimed: true });
    const prompt = buildNativeContinuationPrompt({ previousRunId: f.runId, issue: issue!, previousIssue: issue!, wakePayload });
    expect(prompt).toContain("without an accepted completion report");
    expect(prompt).toContain("continuing the same conversation");
    expect(prompt).toContain("Do NOT repeat commands, scripts, or other work already done");
    expect(prompt).toContain("Otherwise finish only what remains, then file your result.");
    expect(prompt!.length).toBeLessThan(600);
    const inputArgs: Parameters<typeof buildNativeExecutionInput>[0] = { companyId: f.companyId, agentId: f.agentId,
      runId: randomUUID(), issue: issue!, taskPrompt: "Original assignment which must not be repeated", provider: "pi_rpc",
      resumedSession: true, normalizedSessionId: f.run.nativeSessionId!, wakePayload,
      previousTurn: { runId: f.runId, task: issue! },
      workspace: { id: randomUUID(), cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      completionContract: { id: f.run.completionContractId!, sha256: f.run.completionContractSha256!,
        schemaVersion: "paperclip.completion-contract.v1", contract: { revision: "first-task-native-finish-v1",
          objective: "Finish the task", criteria: [{ id: "objective", requirement: "Finish the task" }] } },
      runtimeContext: nativeRuntimeContextFixture() };
    const prepared = buildNativeExecutionInput(inputArgs);
    const delivered = buildNativeModelEnvelope(prepared, { resumedSession: true });
    expect(delivered).toMatchObject({ events: prompt });
    expect(JSON.stringify(delivered)).not.toContain(inputArgs.taskPrompt);
    expect(wakes.some(wake => wake.reason === "chat_task_completed" || wake.reason === "issue_children_completed")).toBe(false);
    expect(await db.select().from(chatCompletionDeliveries).where(eq(chatCompletionDeliveries.taskId, f.issueId))).toEqual([]);
    console.info("false-done R1 proof", JSON.stringify({ issueId: f.issueId, runId: f.runId, decisionId: decision.id,
      status: issue!.status, wakeId: wakes[0].id, sessionId: f.run.nativeSessionId, delivered }));
  });

  it.each([
    { owner: "executor's lead before creating agent and primary", creator: true, lead: "idle", primary: "other", expected: "lead" },
    { owner: "executor's lead without creating agent", lead: "idle", expected: "lead" },
    { owner: "creating agent without lead, before primary", creator: true, primary: "other", expected: "creator" },
    { owner: "responsible person's primary agent", primary: "other", expected: "primary" },
    { owner: "responsible person without primary agent", expected: "person" },
    { owner: "executor created task", creator: true, selfCreated: true, expected: "person" },
    { owner: "routine responsible person", routine: true, expected: "person" },
    { owner: "routine executor's lead, not responsible person", routine: true, lead: "idle", expected: "lead" },
    { owner: "creating agent after self-reporting lead skipped", creator: true, lead: "self", expected: "creator" },
    { owner: "creating agent after paused lead skipped", creator: true, lead: "paused", expected: "creator" },
    { owner: "creating agent after terminated lead skipped", creator: true, lead: "terminated", expected: "creator" },
    { owner: "creating agent after unapproved lead skipped", creator: true, lead: "pending_approval", expected: "creator" },
    { owner: "primary after paused creating agent skipped, without lead", creator: true, creatorStatus: "paused", primary: "other", expected: "primary" },
    { owner: "person after paused creator and terminated primary skipped", creator: true, creatorStatus: "paused", primary: "other", primaryStatus: "terminated", expected: "person" },
    { owner: "primary after terminated creating agent skipped", creator: true, creatorStatus: "terminated", primary: "other", expected: "primary" },
    { owner: "primary after unapproved creating agent skipped", creator: true, creatorStatus: "pending_approval", primary: "other", expected: "primary" },
    { owner: "primary after creating agent's reporting cycle skipped", creator: true, creatorStatus: "cycle", primary: "other", expected: "primary" },
    { owner: "person after paused primary skipped", primary: "other", primaryStatus: "paused", expected: "person" },
    { owner: "person after unapproved primary skipped", primary: "other", primaryStatus: "pending_approval", expected: "person" },
    { owner: "person after primary's reporting cycle skipped", primary: "other", primaryStatus: "cycle", expected: "person" },
    { owner: "responsible person after executor primary skipped", primary: "executor", expected: "person" },
    { owner: "responsible person after foreign-company primary skipped", primary: "foreign", expected: "person" },
  ] as const)("false-done R2: second unclaimed stop requests the $owner, never a third executor repair", async (row) => {
    const { owner } = row;
    const options = row as { creator?: boolean; creatorStatus?: string; selfCreated?: boolean; routine?: boolean;
      lead?: string; primary?: string; primaryStatus?: string };
    const f = await continueUnclaimedTask({ ownerAgent: options.creator, selfCreated: options.selfCreated, routine: options.routine });
    if (f.ownerAgentId && options.creatorStatus) await db.update(agents).set(options.creatorStatus === "cycle"
      ? { reportsTo: f.ownerAgentId } : { status: options.creatorStatus }).where(eq(agents.id, f.ownerAgentId));
    const leadId = options.lead === "self" ? f.agentId : options.lead ? randomUUID() : null;
    if (leadId && leadId !== f.agentId) await db.insert(agents).values({ id: leadId, companyId: f.companyId,
      name: "Executor's lead", adapterType: "paperclip_runner", status: options.lead! });
    if (leadId) await db.update(agents).set({ reportsTo: leadId }).where(eq(agents.id, f.agentId));
    const primaryId = options.primary === "executor" ? f.agentId : options.primary ? randomUUID() : null;
    if (primaryId && primaryId !== f.agentId) {
      const companyId = options.primary === "foreign" ? randomUUID() : f.companyId;
      if (companyId !== f.companyId) await db.insert(companies).values({ id: companyId, name: "Other company", issuePrefix: `X${companyId.slice(0, 6)}` });
      await db.insert(agents).values({ id: primaryId, companyId, name: "Responsible person's primary", adapterType: "paperclip_runner",
        status: options.primaryStatus === "cycle" ? "idle" : options.primaryStatus ?? "idle",
        reportsTo: options.primaryStatus === "cycle" ? primaryId : null });
    }
    if (primaryId) await db.insert(userCompanyPreferences).values({ companyId: f.companyId, userId: f.userId,
      primaryAgentId: primaryId, primaryAgentInitialized: true });
    const expectedAgentId = row.expected === "lead" ? leadId : row.expected === "creator" ? f.ownerAgentId
      : row.expected === "primary" ? primaryId : null;
    const { issue, decision, wakes, interactions } = await settleUnclaimed(f);
    expect(issue!.status).toBe("in_review");
    expect(decision).toMatchObject({ reasonCode: "actionable_attention_pending", toStatus: "in_review" });
    expect(interactions).toHaveLength(1);
    const agentOwner = expectedAgentId !== null;
    if (options.routine) {
      expect(issue).toMatchObject({ originKind: "routine_execution", createdByAgentId: null, responsibleUserId: f.userId });
      expect((await db.select().from(routineRuns).where(eq(routineRuns.id, issue!.originRunId!)))[0])
        .toMatchObject({ linkedIssueId: f.issueId, status: "issue_created", completedAt: null });
    }
    expect(interactions[0]).toMatchObject({ kind: "request_confirmation", status: "pending",
      addresseeAgentId: expectedAgentId, addresseeUserId: agentOwner ? null : f.userId });
    expect(interactions[0].addresseeAgentId).not.toBe(f.agentId);
    expect(wakes.filter(wake => wake.status === "queued" && wake.agentId === f.agentId)).toEqual([]);
    const ownerWakes = wakes.filter(wake => wake.status === "queued");
    expect(ownerWakes).toHaveLength(agentOwner ? 1 : 0);
    if (agentOwner) expect(ownerWakes[0]).toMatchObject({ agentId: expectedAgentId, reason: "native_completion_review",
      payload: { _paperclipWakeContext: { nativeReviewInteractionId: interactions[0].id } } });
    const effects = await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.decisionId, decision.id));
    expect(effects.map(effect => effect.effectKind)).toContain("bind_reviewer");
    if (agentOwner) {
      expect(effects.map(effect => effect.effectKind)).toContain("notify_owner");
      expect(effects.find(effect => effect.effectKind === "notify_owner")!.targetId).toBe(ownerWakes[0].id);
      const [ownerRun] = await db.insert(heartbeatRuns).values({ id: randomUUID(), companyId: f.companyId,
        agentId: expectedAgentId!, status: "queued", runtimeMode: "native", nativeIssueId: f.issueId,
        wakeupRequestId: ownerWakes[0].id, contextSnapshot: ownerWakes[0].payload!._paperclipWakeContext as Record<string, unknown> }).returning();
      await db.update(agentWakeupRequests).set({ runId: ownerRun.id }).where(eq(agentWakeupRequests.id, ownerWakes[0].id));
      await expect(claimQueuedNativeReviewRun(db, { run: ownerRun, agentNameKey: "delegating-owner", claimedAt: new Date(), claimValues: {} }))
        .resolves.toMatchObject({ id: ownerRun.id, status: "running", agentId: expectedAgentId });
      console.info("false-done R2 owner started", JSON.stringify({ issueId: f.issueId, executorRunId: f.runId,
        ownerRunId: ownerRun.id, ownerAgentId: expectedAgentId, interactionId: interactions[0].id, wakeId: ownerWakes[0].id }));
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, ownerRun.id));
    }
    console.info("false-done R2 proof", JSON.stringify({ owner, executorAgentId: f.agentId, leadId,
      creatingAgentId: f.ownerAgentId, creatorStatus: options.creatorStatus ?? "idle", primaryId,
      primaryStatus: options.primaryStatus ?? "idle", expectedAgentId, issueId: f.issueId, runId: f.runId,
      decisionId: decision.id, status: issue!.status, interactionId: interactions[0].id,
      addresseeAgentId: interactions[0].addresseeAgentId, addresseeUserId: interactions[0].addresseeUserId,
      effects: effects.map(effect => ({ kind: effect.effectKind, targetId: effect.targetId })) }));
  });

  it("false-done human-only review cap commits the existing owner notification when no scoped review wake exists", async () => {
    const f = await continueUnclaimedTask({ ownerAgent: true });
    await db.update(companies).set({ interactionResolverGovernance: { request_confirmation: { cap: "human_only" } } })
      .where(eq(companies.id, f.companyId));
    const { issue, decision, wakes, interactions } = await settleUnclaimed(f);
    expect(issue!.status).toBe("in_review");
    expect(interactions).toEqual([expect.objectContaining({ kind: "request_confirmation", status: "pending",
      addresseeAgentId: f.ownerAgentId, effectiveResolverPolicy: "human_only" })]);
    expect(wakes.filter(wake => wake.reason === "native_completion_review")).toEqual([]);
    const ownerWakes = wakes.filter(wake => wake.status === "queued");
    expect(ownerWakes).toEqual([expect.objectContaining({ agentId: f.ownerAgentId, reason: "issue_status_changed",
      idempotencyKey: `native-status:${decision.id}:notify-owner`,
      payload: expect.objectContaining({ notificationReason: "server_unclaimed_task" }) })]);
    expect(ownerWakes[0].payload).not.toHaveProperty("nativeReviewDecisionId");
    expect(ownerWakes[0].payload?._paperclipWakeContext).not.toHaveProperty("nativeReviewInteractionId");
    const effects = await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.decisionId, decision.id));
    expect(effects).toContainEqual(expect.objectContaining({ effectKind: "notify_owner", targetId: ownerWakes[0].id, deliveryState: "delivered" }));
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "committed", attempt: 1, failureCode: null, nextAttemptAt: null });
    console.info("false-done missing-scoped-wake proof", JSON.stringify({ issueId: f.issueId, runId: f.runId,
      decisionId: decision.id, interactionId: interactions[0].id, effectiveResolverPolicy: interactions[0].effectiveResolverPolicy,
      ownerWakeId: ownerWakes[0].id, ownerWakeReason: ownerWakes[0].reason, effects }));
  });

  it.each([false, true])("false-done owner chain falls back to the task's creating person (primary: %s)", async (withPrimary) => {
    const f = await continueUnclaimedTask({ ownerAgent: true, selfCreated: true });
    await db.update(issues).set({ responsibleUserId: null, createdByUserId: f.userId }).where(eq(issues.id, f.issueId));
    const primaryId = withPrimary ? randomUUID() : null;
    if (primaryId) {
      await db.insert(agents).values({ id: primaryId, companyId: f.companyId, name: "Creating person's primary",
        adapterType: "paperclip_runner", status: "idle" });
      await db.insert(userCompanyPreferences).values({ companyId: f.companyId, userId: f.userId,
        primaryAgentId: primaryId, primaryAgentInitialized: true });
    }
    const { issue, interactions, wakes } = await settleUnclaimed(f);
    expect(issue!.status).toBe("in_review");
    expect(interactions).toEqual([expect.objectContaining({ addresseeAgentId: primaryId, addresseeUserId: primaryId ? null : f.userId })]);
    expect(wakes.filter(wake => wake.status === "queued")).toEqual(primaryId
      ? [expect.objectContaining({ agentId: primaryId, reason: "native_completion_review" })] : []);
    console.info("false-done creating-person fallback proof", JSON.stringify({ issueId: f.issueId, runId: f.runId,
      primaryId, interactionId: interactions[0].id, addresseeAgentId: interactions[0].addresseeAgentId,
      addresseeUserId: interactions[0].addresseeUserId }));
  });

  it.each(["no creator", "executor-created", "paused creator"] as const)("false-done missing named owner commits blocked with one board recovery and system warning, no third repair (%s)", async (creator) => {
    const f = await continueUnclaimedTask({ ownerAgent: creator !== "no creator", selfCreated: creator === "executor-created" });
    if (creator === "paused creator") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.ownerAgentId!));
    await db.update(issues).set({ responsibleUserId: null, createdByUserId: null }).where(eq(issues.id, f.issueId));
    await f.port.completeRun({ result: f.synthetic, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL });
    let decisionId: string | null = null;
    for (let replay = 0; replay < 3; replay++) {
      const finalized = await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      expect(finalized).toMatchObject({ phase: "committed", failureCode: null, nextAttemptAt: null });
      if (decisionId) expect(finalized.decisionId).toBe(decisionId);
      decisionId = finalized.decisionId;
    }
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId));
    expect(issue).toMatchObject({ status: "blocked", executionRunId: null, checkoutRunId: null,
      unblockDescriptor: { owner: "board", action: "This task stopped twice without filing its result and has no owner to confirm it. Assign an owner or reply here to continue." } });
    expect(run).toMatchObject({ status: "succeeded", nativePhase: "committed", errorCode: null,
      resultJson: { finalizationPhase: "committed", failureCode: null, nextAttemptAt: null } });
    expect(coordinator).toMatchObject({ phase: "committed", attempt: 1, leaseOwner: null, nextAttemptAt: null, failureCode: null });
    expect(coordinator!.decisionId).toBe(decisionId);
    expect(comments).toEqual([expect.objectContaining({ authorType: "system", authorAgentId: null, authorUserId: null,
      createdByRunId: null, clientRequestId: `native-unclaimed-task-owner-missing:${f.runId}`,
      presentation: { kind: "system_notice", tone: "warning", detailsDefaultOpen: false },
      body: "This task stopped twice without filing its result and has no owner to confirm it. Assign an owner or reply here to continue." })]);
    // TaskChatThread hides system-owned recovery metadata. This warning must
    // remain a visible thread notice, not a hidden recovery diagnostic.
    expect(comments[0].metadata).toBeNull();
    expect(comments[0].metadata ?? {}).not.toHaveProperty("recoveryResponsibility");
    expect(comments[0].metadata ?? {}).not.toHaveProperty("sourceRunId");
    expect(comments[0].metadata ?? {}).not.toHaveProperty("attachmentPreparation");
    expect(comments[0].metadata ?? {}).not.toHaveProperty("recovery");
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId))).toEqual([]);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(wakes).toEqual([expect.objectContaining({ status: "completed", runId: f.runId,
      payload: expect.objectContaining({ continuationIdempotencyKey: "native-pi-unclaimed" }) })]);
    const recovery = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(recovery).toEqual([expect.objectContaining({ kind: "active_run_watchdog", status: "active",
      ownerType: "board", ownerAgentId: null, ownerUserId: null, cause: "native_unclaimed_task_owner_missing",
      nextAction: "This task stopped twice without filing its result and has no owner to confirm it. Assign an owner or reply here to continue.",
      wakePolicy: null, evidence: { runId: f.runId, decisionId } })]);
    expect((await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId))))
      .toEqual([expect.objectContaining({ id: decisionId, reasonCode: "native_unclaimed_task_owner_missing", toStatus: "blocked" })]);
    expect(await db.select().from(statusDecisionEffects).where(and(eq(statusDecisionEffects.decisionId, decisionId!),
      eq(statusDecisionEffects.effectKind, "record_recovery"))))
      .toEqual([expect.objectContaining({ targetId: recovery[0].id, deliveryState: "delivered" })]);
    console.info("false-done missing-owner AFTER row", JSON.stringify({ creator, creatingAgentId: f.ownerAgentId, issueId: f.issueId, runId: f.runId,
      status: issue!.status, executionRunId: issue!.executionRunId, runStatus: run!.status,
      coordinator, comments, recovery, wakes: wakes.map(wake => ({ id: wake.id, status: wake.status, runId: wake.runId })) }));
  });

  it.each([false, true].flatMap(second => ["new queued comment", "older queued comment", "new comment before its wake"]
    .map(input => ({ second, input }))))("false-done person input wins ($input; repair already used: $second)", async ({ second, input }) => {
    const f = second ? await continueUnclaimedTask({ ownerAgent: true }) : await unclaimedTask({ ownerAgent: true });
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: f.userId, body: "Actually, do this instead.",
      createdAt: new Date(f.startedAt.getTime() + (input === "older queued comment" ? -1_000 : 1_000)) }).returning();
    const personWakes = input === "new comment before its wake" ? [] : await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", reason: "issue_execution_deferred", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: f.userId,
      payload: { issueId: f.issueId, _paperclipWakeContext: { wakeReason: "issue_commented", wakeCommentIds: [comment.id] } } }).returning();
    const { issue, wakes, interactions } = await settleUnclaimed(f);
    expect(issue!.status).toBe("in_progress");
    expect(interactions).toEqual([]);
    expect(wakes.filter(wake => wake.status !== "completed")).toEqual(personWakes);
  });

  it.each([false, true])("false-done person's Stop wins (repair already used: %s)", async (second) => {
    const f = second ? await continueUnclaimedTask({ ownerAgent: true }) : await unclaimedTask({ ownerAgent: true });
    await db.update(heartbeatRuns).set({ resultJson: { personStop: { requestedAt: new Date().toISOString() } } }).where(eq(heartbeatRuns.id, f.runId));
    const { issue, wakes, interactions } = await settleUnclaimed(f);
    expect(issue!.status).toBe("in_progress");
    expect(interactions).toEqual([]);
    expect(wakes.filter(wake => wake.status === "queued")).toEqual([]);
  });

  it.each([false, true].flatMap(second => ["Stop", "comment"].flatMap(person =>
    (second ? [false, true] : [false]).map(ownerless => ({ second, person, ownerless })))))(
    "false-done person $person between assessment and commit wins (repair already used: $second; ownerless: $ownerless)", async ({ second, person, ownerless }) => {
    const f = second ? await continueUnclaimedTask({ ownerAgent: !ownerless }) : await unclaimedTask({ ownerAgent: true });
    if (ownerless) await db.update(issues).set({ responsibleUserId: null, createdByUserId: null }).where(eq(issues.id, f.issueId));
    const trigger = `unclaimed_person_${randomUUID().replaceAll("-", "")}`;
    // PostgreSQL injects the real write after arbitration, before the actual
    // status transaction. No mocked finalizer/committer or timing sleep.
    const mutation = person === "Stop"
      ? `update heartbeat_runs set result_json = coalesce(result_json, '{}'::jsonb) ||
          jsonb_build_object('personStop', jsonb_build_object('requestedAt', current_timestamp::text)) where id = '${f.runId}';`
      : `insert into issue_comments (company_id, issue_id, author_type, author_user_id, body, created_at)
          values ('${f.companyId}', '${f.issueId}', 'user', '${f.userId}', 'A person changed the request.', now() + interval '1 second');`;
    await db.execute(sql.raw(`create function ${trigger}() returns trigger language plpgsql as $$
      begin ${mutation} return NEW; end $$`));
    await db.execute(sql.raw(`create trigger ${trigger} after update on native_run_finalizations for each row
      when (NEW.run_id = '${f.runId}' and NEW.phase = 'arbitrating' and OLD.phase <> NEW.phase) execute function ${trigger}()`));
    try {
      const { issue, wakes, interactions } = await settleUnclaimed(f);
      expect(issue!.status).toBe("in_progress");
      expect(interactions).toEqual([]);
      expect(wakes.filter(wake => wake.status === "queued")).toEqual([]);
      if (ownerless) {
        expect(await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
          eq(issueComments.authorType, "system")))).toEqual([]);
        expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
      }
    } finally {
      await db.execute(sql.raw(`drop trigger ${trigger} on native_run_finalizations`));
      await db.execute(sql.raw(`drop function ${trigger}()`));
    }
  });

  it("false-done unrelated incomplete-report repair is not a previous unclaimed stop", async () => {
    const f = await unclaimedTask();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", reason: "issue_status_changed", status: "completed", runId: f.runId,
      payload: { issueId: f.issueId, continuationIdempotencyKey: "native-completion-incomplete" } }).returning();
    await db.update(heartbeatRuns).set({ wakeupRequestId: wake.id }).where(eq(heartbeatRuns.id, f.runId));
    const { issue, wakes, interactions } = await settleUnclaimed(f);
    expect(issue!.status).toBe("in_progress");
    expect(interactions).toEqual([]);
    expect(wakes.filter(row => row.status === "queued")).toEqual([expect.objectContaining({
      reason: "issue_continuation_needed", payload: expect.objectContaining({ continuationIdempotencyKey: "native-pi-unclaimed" }),
    })]);
  });

  it.each(["honest Pi claim", "conversation", "codex synthetic"] as const)("false-done control: %s is unchanged", async (control) => {
    const f = await unclaimedTask({ provider: control === "codex synthetic" ? "codex" : "pi_rpc" });
    if (control === "conversation") await db.update(issues).set({ conversationAgentId: f.agentId,
      conversationUserId: f.userId, conversationState: "active" }).where(eq(issues.id, f.issueId));
    const { issue, wakes, interactions } = await settleUnclaimed(f, control === "honest Pi claim" ? f.result : f.synthetic);
    expect(issue!.status).toBe(control === "conversation" ? "in_progress" : "done");
    expect(interactions).toEqual([]);
    expect(wakes.filter(wake => wake.reason === "issue_continuation_needed")).toEqual([]);
  });

  it("keeps synthetic provider completion open until the requested task document is published", async () => {
    const { companyId, agentId, issueId, runId, port, result } = await prepareFirstTaskCompletion("ordinary task");
    const objective = "Use the connected page service to find recent pages and create a short Markdown briefing document on this task. Put the returned page titles and service receipt code in the document. When complete, give me the document link.";
    await db.update(issues).set({ title: "Create the service briefing", description: objective }).where(eq(issues.id, issueId));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId, executionContinuation: { objective } } }).where(eq(heartbeatRuns.id, runId));
    const synthetic: PrpStructuredRunResult = { ...result, summary: "Created briefing.md with the returned page titles and service receipt.",
      evidence: [{ ref: "provider:opencode:agent-message" }], artifacts: [] };
    await port.completeRun({ result: synthetic, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "in_progress" });
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, issueId)))
      .not.toContainEqual(expect.objectContaining({ toStatus: "done" }));
    const wakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)));
    expect(wakes).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({
      continuationIdempotencyKey: "native-completion-incomplete", continuationSummary: expect.stringContaining("write_document"),
    }) }));
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded" });
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId))))
      .toHaveLength(wakes.length);
    const followUpId = randomUUID(), runnerInstanceId = randomUUID();
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const wake = wakes.find(row => row.payload?.continuationIdempotencyKey === "native-completion-incomplete")!;
    await db.insert(heartbeatRuns).values({ id: followUpId, companyId, agentId, status: "succeeded", runtimeMode: "native",
      nativeIssueId: issueId, nativeSessionId: source!.nativeSessionId, runnerInstanceId,
      completionContractId: source!.completionContractId, completionContractSha256: source!.completionContractSha256,
      wakeupRequestId: wake.id, contextSnapshot: source!.contextSnapshot });
    await db.update(agentWakeupRequests).set({ runId: followUpId }).where(eq(agentWakeupRequests.id, wake.id));
    await db.update(issues).set({ executionRunId: followUpId }).where(eq(issues.id, issueId));
    const followUp = new PaperclipControlPlanePort(db, { companyId, issueId, agentId, runId: followUpId,
      sessionId: source!.nativeSessionId!, sourceInstanceId: runnerInstanceId,
      completionContractId: source!.completionContractId!, completionContractSha256: source!.completionContractSha256!,
      controlPlaneSourceInstanceId: "output-follow-up-control" });
    await followUp.openRun({ identity: { ...CONTROL_PLANE_CONFORMANCE_OPEN.identity, companyId, issueId, agentId, runId: followUpId },
      backendKind: "mock", sourceInstanceId: runnerInstanceId });
    await followUp.completeRun({ result: synthetic, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL });
    await finalizeNativeRun({ db, runId: followUpId, workspaceFinalizeStatus: "succeeded" });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status).toBe("in_progress");
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId))))
      .toHaveLength(wakes.length);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId)))
      .toContainEqual(expect.objectContaining({ ownerAgentId: agentId, cause: "completion_evidence_incomplete", nextAction: expect.stringContaining("write_document") }));
    expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId)))[0]!.resultJson)
      .toMatchObject({ result: { reportedWorkDisposition: "done", evidence: synthetic.evidence, artifacts: [] } });
  });

  it.each(["saved document", "registered attachment", "plain Ask"] as const)(
    "accepts native completion with %s", async (delivery) => {
    const objective = delivery === "plain Ask" ? "What is two plus two?" : "Create a Markdown briefing document on this task.";
    const { companyId, agentId, issueId, runId, port, result } = await prepareFirstTaskCompletion("ordinary task", objective);
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, runId));
    const report: PrpStructuredRunResult = { ...result, evidence: [{ ref: "provider:opencode:agent-message" }], artifacts: [] };
    if (delivery === "saved document") {
      const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
      await authority.execute({ tool: "write_document", callId: "briefing", arguments: {
        idempotencyKey: "briefing", key: "briefing", title: "Briefing", body: "Verified service titles and receipt.", baseRevisionId: null,
      } });
    } else if (delivery === "registered attachment") {
      const bytes = Buffer.from("# Briefing\nVerified service titles and receipt.\n");
      const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId,
        workspaceRoot: "/workspace/output-control", executionTargetKind: "remote", readRemoteTaskFile: async () => bytes,
        storage: createStorageService(createLocalDiskStorageProvider(outputStorageRoot)) });
      const receipt = await authority.execute({ tool: "register_deliverable", callId: "briefing", arguments: {
        idempotencyKey: "briefing", filename: "briefing.md", contentType: "text/markdown", contentRef: "briefing.md",
        byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), title: "Briefing",
      } }) as { entityRefs: string[] };
      report.artifacts = [{ kind: "file", ref: `deliverable:${receipt.entityRefs[0]}` }];
    }
    await port.completeRun({ result: report, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded" });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status).toBe("done");
  });

  it.each(["current human rejection", "model-only decline", "different objective revision", "different trigger",
    "changed description after admission", "changed description at commit"] as const)(
    "binds an explicit declined-document fallback to %s", async (scenario) => {
    const objective = "Use the connected page service to find recent pages and create a short Markdown briefing document on this task. Put the returned page titles and service receipt code in the document. When complete, give me the document link. If I decline the action, do not try again or request another connection. Instead, give me a brief explanation that you could not retrieve the data. That explanation is the complete allowed fallback; no briefing is required after a decline.";
    const source = await prepareFirstTaskCompletion("ordinary task", objective);
    const { companyId, agentId, issueId } = source;
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId, issueId, sourceRunId: source.runId,
      createdByAgentId: agentId, kind: "request_confirmation", status: "pending", requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only", continuationPolicy: "wake_assignee", payload: { version: 1, prompt: "Approve service read",
        toolAction: { version: 1, actionRequestId: randomUUID(), invocationId: randomUUID(), toolName: "pages.read",
          toolDisplayName: "Read pages", connectionId: null, applicationId: null, appDisplayName: null, risk: "read",
          previewMarkdown: "Read pages", argumentsSummaryJson: "{}", argumentsHash: "test-hash", expiresAt: "2099-01-01T00:00:00Z" } } });
    if (scenario !== "model-only decline") {
      await issueThreadInteractionService(db).rejectInteraction({ id: issueId, companyId }, interactionId,
        { reason: "Do not call the service." }, { userId: issue!.responsibleUserId! });
    }
    const contract = await ensureNativeCompletionContract({ db, companyId, issue: issue!, actorId: agentId, humanResponseId: interactionId });
    const runId = randomUUID(), runnerInstanceId = randomUUID();
    const continuedObjective = scenario === "different objective revision" ? `${objective} Still create the document even if I decline.` : objective;
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", runtimeMode: "native", nativeIssueId: issueId,
      nativeSessionId: CONTROL_PLANE_CONFORMANCE_OPEN.identity.sessionId, runnerInstanceId, completionContractId: contract.row.id,
      completionContractSha256: contract.row.canonicalSha256, contextSnapshot: { issueId, executionContinuation: {
        objective: continuedObjective, objectiveSource: nativeCompletionSource("description", issueId, continuedObjective),
        trigger: { interactionId: scenario === "different trigger" ? randomUUID() : interactionId, sourceRunId: source.runId },
      } } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const port = new PaperclipControlPlanePort(db, { companyId, issueId, agentId, runId,
      sessionId: CONTROL_PLANE_CONFORMANCE_OPEN.identity.sessionId, sourceInstanceId: runnerInstanceId,
      completionContractId: contract.row.id, completionContractSha256: contract.row.canonicalSha256,
      controlPlaneSourceInstanceId: "declined-output-control" });
    await port.openRun({ identity: { ...CONTROL_PLANE_CONFORMANCE_OPEN.identity, companyId, issueId, agentId, runId },
      backendKind: "mock", sourceInstanceId: runnerInstanceId });
    const report: PrpStructuredRunResult = { ...source.result, summary: "The service action was declined, so I could not retrieve the data.",
      evidence: [{ ref: "provider:opencode:agent-message" }], completionClaim: { ...source.result.completionClaim,
        contractRevision: contract.contract.revision, criteria: contract.contract.criteria.map(entry => ({ criterionId: entry.id, status: "satisfied", evidenceRefs: [] })) } };
    await port.completeRun({ result: report, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL });
    const changedDescription = "Create the Markdown briefing document on this task. The prior decline does not waive the required document.";
    if (scenario === "changed description after admission") {
      await db.update(issues).set({ description: changedDescription }).where(eq(issues.id, issueId));
    }
    const trigger = `decline_revision_race_${randomUUID().replaceAll("-", "")}`;
    if (scenario === "changed description at commit") {
      await db.execute(sql.raw(`create function ${trigger}() returns trigger language plpgsql as $$
        begin
          if NEW.issue_id = '${issueId}'::uuid and NEW.run_id = '${runId}'::uuid then
            update issues set description = '${changedDescription}' where id = '${issueId}'::uuid and company_id = '${companyId}'::uuid;
          end if;
          return NEW;
        end $$`));
      await db.execute(sql.raw(`create trigger ${trigger} before insert on work_assessments
        for each row execute function ${trigger}()`));
    }
    try {
      await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded" });
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status)
        .toBe(scenario === "current human rejection" ? "done" : scenario === "model-only decline" ? "in_review" : "in_progress");
    } finally {
      if (scenario === "changed description at commit") {
        await db.execute(sql.raw(`drop trigger if exists ${trigger} on work_assessments`));
        await db.execute(sql.raw(`drop function if exists ${trigger}()`));
      }
    }
  });

  it("rechecks publication removed between assessment and native done commit", async () => {
    const objective = "Create a Markdown briefing document on this task.";
    const { companyId, agentId, issueId, runId, port, result } = await prepareFirstTaskCompletion("ordinary task", objective);
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, runId));
    const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
    await authority.execute({ tool: "write_document", callId: "briefing", arguments: {
      idempotencyKey: "briefing", key: "briefing", title: "Briefing", body: "Verified service titles and receipt.", baseRevisionId: null,
    } });
    const report = { ...result, evidence: [{ ref: "provider:opencode:agent-message" }], artifacts: [] };
    await port.completeRun({ result: report, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL });
    const trigger = `publication_race_${randomUUID().replaceAll("-", "")}`;
    await db.execute(sql.raw(`create function ${trigger}() returns trigger language plpgsql as $$
      begin
        if NEW.issue_id = '${issueId}'::uuid and NEW.run_id = '${runId}'::uuid then
          delete from issue_documents where issue_id = '${issueId}'::uuid and company_id = '${companyId}'::uuid;
        end if;
        return NEW;
      end $$`));
    try {
      await db.execute(sql.raw(`create trigger ${trigger} before insert on work_assessments
        for each row execute function ${trigger}()`));
      await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status).toBe("in_progress");
      expect(await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, issueId)))
        .not.toContainEqual(expect.objectContaining({ toStatus: "done" }));
      expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId))))
        .toContainEqual(expect.objectContaining({ payload: expect.objectContaining({
          continuationIdempotencyKey: "native-completion-incomplete", continuationSummary: expect.stringContaining("write_document"),
        }) }));
    } finally {
      await db.execute(sql.raw(`drop trigger if exists ${trigger} on work_assessments`));
      await db.execute(sql.raw(`drop function if exists ${trigger}()`));
    }
  });

  it.each([false, true])("checks requested publication for an authoritative done decision with an opaque accepted ledger (%s)", async requested => {
    const objective = requested ? "Create a Markdown briefing document on this task." : "What is two plus two?";
    const { companyId, agentId, issueId, runId } = await prepareFirstTaskCompletion("ordinary task", objective);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [saved] = await db.insert(nativeRunResults).values({ companyId, issueId, runId,
      completionContractId: run!.completionContractId!, serverFingerprint: randomUUID(), schemaStatus: "accepted",
      resultJson: {}, canonicalSha256: randomUUID() }).returning();
    const [assessment] = await db.insert(workAssessments).values({ companyId, issueId, runId,
      contractId: run!.completionContractId!, resultId: saved!.id, triggerKind: "native_result", triggerActorCompanyId: companyId,
      priorIssueStatus: issue!.status, priorStatusVersion: issue!.statusVersion, policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      assessmentJson: {}, inputDigest: randomUUID() }).returning();
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "arbitrating", resultId: saved!.id });
    const commit = commitNativeStatusDecision({ db, companyId, issueId, runId, assessmentId: assessment!.id,
      priorStatus: issue!.status as "in_progress", priorStatusVersion: issue!.statusVersion, priorDecisionId: issue!.lastStatusDecisionId,
      decision: { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "done", toStatus: "done",
        reasonCode: "completion_contract_satisfied", unblockDescriptor: null, effects: [{ kind: "release_checkout" }] } });
    if (requested) await expect(commit).rejects.toThrow("native_status_race");
    else await expect(commit).resolves.toMatchObject({ issue: { status: "done" } });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status).toBe(requested ? "in_progress" : "done");
    expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, saved!.id)))[0]!.resultJson).toEqual({});
  });

  it.each(refusedFirstTaskCompletionScenarios)(
    "refuses native completion feedback without a trusted current first-task decision (%s)", async (scenario) => {
    const { issueId, runId, result } = await prepareFirstTaskCompletion(scenario);
    await expect(nativeCompletionFeedback(db, runId, result))
      .rejects.toThrow("First-task proposal requires a persisted human decision");
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status).toBe("in_progress");
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, issueId))).toEqual([]);
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId))).toEqual([]);
  });

  it.each([...allowedFirstTaskCompletionScenarios, ...refusedFirstTaskCompletionScenarios])(
    "honors the first-task human decision during native completion (%s)", async (scenario) => {
    const { issueId, runId, port, result } = await prepareFirstTaskCompletion(scenario);
    const allowed = allowedFirstTaskCompletionScenarios.some(candidate => candidate === scenario);
    if (allowed) await expect(nativeCompletionFeedback(db, runId, result)).resolves.toContain("Completion report accepted");
    // Invalid results bypass only early feedback to exercise the backstop for a
    // report already committed by a disconnected or older controller.
    await port.completeRun({ result, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, callerResultId: "first-task-native-finish-result" });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });

    const [completedIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, issueId));
    if (!allowed) {
      const expectedReason = scenario === "newest proposal pending" ? "governed_gate_pending" : "onboarding_first_task_decision_required";
      expect(completedIssue).toMatchObject({ status: "in_review" });
      expect(decisions).toContainEqual(expect.objectContaining({ toStatus: "in_review", reasonCode: expectedReason }));
      expect(decisions).not.toContainEqual(expect.objectContaining({ toStatus: "done" }));
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!.resultJson)
        .toMatchObject({ finalizationReasonCode: expectedReason });
    } else {
      expect(completedIssue).toMatchObject({ status: "done" });
      expect(decisions).toContainEqual(expect.objectContaining({ toStatus: "done", reasonCode: "completion_claim_policy_accepted" }));
    }
  });

  it("rechecks the first-task human decision atomically before native status commit", async () => {
    const { companyId, agentId, issueId, runId, port, result } = await prepareFirstTaskCompletion("accepted proposal");
    await expect(nativeCompletionFeedback(db, runId, result)).resolves.toContain("Completion report accepted");
    await port.completeRun({ result, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, callerResultId: "first-task-race-result" });
    expect(await db.select().from(workAssessments).where(eq(workAssessments.runId, runId))).toEqual([]);

    const interactionId = randomUUID();
    const trigger = `first_task_race_${randomUUID().replace(/-/g, "")}`;
    // Assessment persistence follows the policy read and precedes status commit.
    // Insert a newer proposal at that real database boundary, exactly once.
    await db.execute(sql.raw(`create function ${trigger}() returns trigger language plpgsql as $$
      begin
        if NEW.issue_id = '${issueId}'::uuid and NEW.run_id = '${runId}'::uuid then
          insert into issue_thread_interactions
            (id, company_id, issue_id, kind, status, created_by_agent_id, source_run_id, payload, created_at)
          values
            ('${interactionId}'::uuid, '${companyId}'::uuid, '${issueId}'::uuid,
             'request_confirmation', 'pending', '${agentId}'::uuid, '${runId}'::uuid,
             '{"version":1,"prompt":"Accept the revised task scope?"}'::jsonb, clock_timestamp())
          on conflict (id) do nothing;
        end if;
        return NEW;
      end $$`));
    try {
      await db.execute(sql.raw(`create trigger ${trigger} before insert on work_assessments
        for each row execute function ${trigger}()`));
      await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });

      expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId)))[0])
        .toMatchObject({ status: "pending", issueId });
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status).toBe("in_review");
      const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, issueId));
      expect(decisions).toEqual([expect.objectContaining({ toStatus: "in_review", reasonCode: "governed_gate_pending" })]);
      expect(decisions).not.toContainEqual(expect.objectContaining({ toStatus: "done" }));
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0])
        .toMatchObject({ nativePhase: "committed", resultJson: { finalizationReasonCode: "governed_gate_pending" } });
    } finally {
      await db.execute(sql.raw(`drop trigger if exists ${trigger} on work_assessments`));
      await db.execute(sql.raw(`drop function if exists ${trigger}()`));
    }
  });

  it.each(["none", "queued", "claimed", "deferred_issue_execution", "coalesced", "current_run", "current_intent"])(
    "preserves completion caveats and pending child delivery (%s)", async (delivery) => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const issueId = randomUUID();
    const localContractId = randomUUID();
    const runId = randomUUID();
    const runnerInstanceId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: identity.companyId,
      title: "DOT-29 completion caveat",
      status: "in_progress",
      assigneeAgentId: identity.agentId,
      workMode: "standard",
    });
    await db.insert(completionContracts).values({
      id: localContractId,
      companyId: identity.companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v3",
      risk: "low",
      completionAuthority: "agent_claim_policy",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "phase6-v3",
        objective: "Complete the low-risk task",
        criteria: [{ id: "objective", requirement: "Complete the requested work" }],
      },
      canonicalSha256: "dot-29-contract",
      createdByActorType: "system",
      createdByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      status: "succeeded",
      runtimeMode: "native",
      nativeIssueId: issueId,
      nativeSessionId: identity.sessionId,
      runnerInstanceId,
      completionContractId: localContractId,
      completionContractSha256: "dot-29-contract",
      contextSnapshot: { issueId },
    });
    const port = new PaperclipControlPlanePort(db, {
      companyId: identity.companyId,
      issueId,
      runId,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      completionContractId: localContractId,
      completionContractSha256: "dot-29-contract",
      sourceInstanceId: runnerInstanceId,
      controlPlaneSourceInstanceId: "dot-29-control",
    });
    await port.openRun({
      identity: { ...identity, issueId, runId },
      backendKind: "mock",
      sourceInstanceId: runnerInstanceId,
    });
    const result: PrpStructuredRunResult = {
      ...structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT),
      summary: "The requested work is complete; local Node verification could not run.",
      completionClaim: {
        contractRevision: "phase6-v3",
        objectiveSatisfied: true,
        criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }],
        remainingWork: [],
      },
      evidence: [],
      verification: [{ commandOrCheck: "Run npm test", status: "not_run" }],
      attentionRequests: [{
        kind: "environment_constraint",
        summary: "Node and npm are unavailable in this sandbox.",
      }],
    };
    await port.completeRun({
      result,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: "dot-29-result",
    });
    const pendingDelivery = ["queued", "claimed", "deferred_issue_execution"].includes(delivery);
    if (delivery !== "none") {
      const intentId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: intentId, companyId: identity.companyId, agentId: identity.agentId,
        source: "automation", triggerDetail: "system", reason: delivery === "deferred_issue_execution" ? "issue_execution_deferred" : "issue_children_completed",
        requestedByActorType: "system", requestedByActorId: delivery === "deferred_issue_execution"
          ? `native-status-wake-dispatch:${randomUUID()}` : "native-status-committer",
        status: delivery.startsWith("current_") ? "claimed" : delivery,
        runId: delivery === "current_run" ? runId : null,
        payload: { issueId, _paperclipWakeContext: { wakeReason: "issue_children_completed", nativeChildCompletionDecisionId: randomUUID() } },
      });
      if (delivery === "current_intent") await db.update(heartbeatRuns)
        .set({ contextSnapshot: { issueId, nativeStatusWakeIntentId: intentId } })
        .where(eq(heartbeatRuns.id, runId));
    }
    const expectedStatus = pendingDelivery ? "in_progress" : "done";
    const expectedReason = pendingDelivery ? "native_child_completion_pending" : "completion_claim_policy_accepted";
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });

    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toEqual([
      expect.objectContaining({ status: expectedStatus, statusVersion: 1 }),
    ]);
    await expect(db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId))).resolves.toEqual([]);
    await expect(db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, identity.companyId)))
      .resolves.not.toEqual(expect.arrayContaining([
        expect.objectContaining({ payload: expect.objectContaining({ issueId, sourceRunId: runId }) }),
      ]));
    await expect(db.select().from(statusDecisions).where(eq(statusDecisions.issueId, issueId))).resolves.toEqual([
      expect.objectContaining({ toStatus: expectedStatus, reasonCode: expectedReason }),
    ]);
    const [persistedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(persistedRun).toMatchObject({ status: "succeeded", nativePhase: "committed" });
    expect(persistedRun?.resultJson).toMatchObject({
      finalizationReasonCode: expectedReason,
      verificationCaveats: [{
        commandOrCheck: "Run npm test",
        reasonCode: "tool_unavailable",
        detail: "Node and npm are unavailable in this sandbox.",
      }],
      ignoredAttentionRequests: [expect.objectContaining({
        sourceKind: "environment_constraint",
        disposition: "verification_caveat",
      })],
    });
  });

  it("serializes a concurrent child notification with the parent's completion check", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    async function preparedRun(parentId: string | null) {
      const agentId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId: identity.companyId,
        name: parentId ? "Child worker" : "Parent lead", adapterType: "codex_local", status: "running" });
      const issueId = randomUUID();
      const runId = randomUUID();
      const localContractId = randomUUID();
      const runnerInstanceId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId: identity.companyId, parentId,
        title: parentId ? "Revised child" : "Deliver revised child result", status: "in_progress",
        assigneeAgentId: agentId, workMode: "standard" });
      await db.insert(completionContracts).values({ id: localContractId, companyId: identity.companyId,
        issueId, revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "phase6-v3",
        risk: "low", completionAuthority: "agent_claim_policy", incompleteCriteriaPolicy: "preserve_non_terminal",
        contractJson: { revision: "handoff-race-v1", objective: "Deliver the requested result",
          criteria: [{ id: "objective", requirement: "Complete the requested work" }] },
        canonicalSha256: localContractId, createdByActorType: "system", createdByActorId: "test" });
      await db.insert(heartbeatRuns).values({ id: runId, companyId: identity.companyId, agentId,
        status: "succeeded", runtimeMode: "native", nativeIssueId: issueId, nativeSessionId: identity.sessionId,
        runnerInstanceId, completionContractId: localContractId, completionContractSha256: localContractId,
        contextSnapshot: { issueId } });
      const port = new PaperclipControlPlanePort(db, { ...identity, agentId, issueId, runId,
        completionContractId: localContractId, completionContractSha256: localContractId,
        sourceInstanceId: runnerInstanceId, controlPlaneSourceInstanceId: "handoff-race" });
      await port.openRun({ identity: { ...identity, agentId, issueId, runId }, backendKind: "mock", sourceInstanceId: runnerInstanceId });
      await port.completeRun({ result: { ...structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT),
        summary: parentId ? "Revised result is ready." : "The result is delivered.",
        completionClaim: { contractRevision: "handoff-race-v1", objectiveSatisfied: true,
          criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
        evidence: [], verification: [{ commandOrCheck: "node --test", status: "passed" }], attentionRequests: [],
      }, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, callerResultId: "handoff-race-result" });
      return { issueId, runId };
    }
    const parent = await preparedRun(null);
    const child = await preparedRun(parent.issueId);
    const suffix = randomUUID().replace(/-/g, "");
    const trigger = `handoff_barrier_${suffix}`;
    const lockKey = Number.parseInt(suffix.slice(0, 7), 16);
    // A test-only database barrier pauses the real child transaction after it
    // reads the parent and immediately before it inserts the completion wake.
    await db.execute(sql.raw(`create function ${trigger}() returns trigger language plpgsql as $$
      begin
        if NEW.requested_by_actor_id = 'native-status-committer'
          and NEW.payload->>'issueId' = '${parent.issueId}' then
          perform pg_advisory_xact_lock(${lockKey}, 1);
        end if;
        return NEW;
      end $$`));
    await db.execute(sql.raw(`create trigger ${trigger} before insert on agent_wakeup_requests
      for each row execute function ${trigger}()`));
    let childCompletion: Promise<unknown> | undefined;
    let parentCompletion: Promise<unknown> | undefined;
    let parentSettled = false;
    async function waitUntil(check: () => Promise<boolean>) {
      for (let attempt = 0; attempt < 500; attempt++) {
        if (await check()) return true;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return false;
    }
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${lockKey}::integer, 1)`);
        const [controller] = await tx.execute(sql`select pg_backend_pid() as pid`) as unknown as Array<{ pid: number }>;
        childCompletion = finalizeNativeRun({ db, runId: child.runId, workspaceFinalizeStatus: "succeeded" })
          .then(() => null, (error: unknown) => error);
        let childPid: number | null = null;
        expect(await waitUntil(async () => {
          const [blocked] = await db.execute(sql`select pid from pg_stat_activity
            where ${controller.pid} = any(pg_blocking_pids(pid)) limit 1`) as unknown as Array<{ pid: number }>;
          childPid = blocked?.pid ?? null;
          return childPid !== null;
        })).toBe(true);
        parentCompletion = finalizeNativeRun({ db, runId: parent.runId, workspaceFinalizeStatus: "succeeded" })
          .then(() => { parentSettled = true; return null; }, (error: unknown) => { parentSettled = true; return error; });
        let parentWaiting = false;
        expect(await waitUntil(async () => {
          const [state] = await db.execute(sql`select exists (select 1 from pg_stat_activity
            where ${childPid}::integer = any(pg_blocking_pids(pid))) as waiting`) as unknown as Array<{ waiting: boolean }>;
          parentWaiting = state.waiting;
          return parentWaiting || parentSettled;
        })).toBe(true);
        expect(parentSettled).toBe(false);
        expect(parentWaiting).toBe(true);
      });
      expect(await childCompletion).toBeNull();
      expect(await parentCompletion).toBeNull();
      expect((await db.select().from(issues).where(eq(issues.id, child.issueId)))[0]!.status).toBe("done");
      expect((await db.select().from(issues).where(eq(issues.id, parent.issueId)))[0]!.status).toBe("in_progress");
      expect(await db.select().from(statusDecisions).where(eq(statusDecisions.issueId, parent.issueId)))
        .toEqual([expect.objectContaining({ reasonCode: "native_child_completion_pending" })]);
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, identity.companyId));
      expect(wakes.filter(wake => wake.payload?.issueId === parent.issueId)).toHaveLength(1);
    } finally {
      await Promise.all([childCompletion, parentCompletion]);
      await db.execute(sql.raw(`drop trigger ${trigger} on agent_wakeup_requests`));
      await db.execute(sql.raw(`drop function ${trigger}()`));
    }
  }, 30_000);

  it.each(["child_dependency", "child"].flatMap((relationship) =>
    ["manual", "task_watchdog", "task_watchdog_product_bug"].map((originKind) => ({ relationship, originKind })),
  ))("preserves completion wake identity across reopen ($relationship, $originKind)", async ({ relationship, originKind }) => {
    const hasDependency = relationship !== "child";
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const parentIssueId = randomUUID();
    const childIssueId = randomUUID();
    const localContractId = randomUUID();
    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId: identity.companyId,
        title: "Accepted plan parent",
        status: "in_progress",
        assigneeAgentId: identity.agentId,
        workMode: "planning",
      },
      {
        id: childIssueId,
        companyId: identity.companyId,
        parentId: parentIssueId,
        title: "Implement the accepted plan",
        originKind,
        status: "in_progress",
        assigneeAgentId: identity.agentId,
        workMode: "standard",
      },
    ]);
    if (hasDependency) await db.insert(issueRelations).values({
      companyId: identity.companyId,
      issueId: childIssueId,
      relatedIssueId: parentIssueId,
      type: "blocks",
    });
    await db.insert(completionContracts).values({
      id: localContractId,
      companyId: identity.companyId,
      issueId: childIssueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v3",
      risk: "low",
      completionAuthority: "agent_claim_policy",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {
        revision: "child-wake-v1",
        objective: "Implement the accepted plan",
        criteria: [{ id: "objective", requirement: "Implement and test" }],
      },
      canonicalSha256: "child-wake-contract",
      createdByActorType: "system",
      createdByActorId: "test",
    });
    for (const revision of [1, 2]) {
      const runId = randomUUID();
      const runnerInstanceId = randomUUID();
      if (revision === 2) {
        // The original completion wake was already consumed. Feedback reopens
        // the same child while its parent still needs the revised result.
        await db.update(agentWakeupRequests).set({ status: "completed" })
          .where(sql`${agentWakeupRequests.payload}->>'issueId' = ${parentIssueId}`);
        await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, parentIssueId));
        await db.update(issues).set({ status: "in_progress", statusVersion: 2 })
          .where(eq(issues.id, childIssueId));
      }
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: identity.companyId,
        agentId: identity.agentId,
        status: "running",
        runtimeMode: "native",
        nativeIssueId: childIssueId,
        nativeSessionId: identity.sessionId,
        runnerInstanceId,
        completionContractId: localContractId,
        completionContractSha256: "child-wake-contract",
        contextSnapshot: { issueId: childIssueId },
      });
      const port = new PaperclipControlPlanePort(db, {
        companyId: identity.companyId,
        issueId: childIssueId,
        runId,
        agentId: identity.agentId,
        sessionId: identity.sessionId,
        completionContractId: localContractId,
        completionContractSha256: "child-wake-contract",
        sourceInstanceId: runnerInstanceId,
        controlPlaneSourceInstanceId: "child-wake-control",
      });
      await port.openRun({
        identity: { ...identity, issueId: childIssueId, runId },
        backendKind: "mock",
        sourceInstanceId: runnerInstanceId,
      });
      const result: PrpStructuredRunResult = {
        ...structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT),
        summary: `Implemented revision ${revision} and passed 44/44 tests.`,
        completionClaim: {
          contractRevision: "child-wake-v1",
          objectiveSatisfied: true,
          criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }],
          remainingWork: [],
        },
        verification: [{ commandOrCheck: "node --test", status: "passed" }],
        attentionRequests: [],
      };
      await port.completeRun({
        result,
        terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
        callerResultId: "child-wake-result",
      });
      await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded" });
      const [completedChild] = await db.select().from(issues).where(eq(issues.id, childIssueId));
      expect(completedChild).toMatchObject({ status: "done", statusVersion: revision === 1 ? 1 : 3 });

      const parentWakes = await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, identity.companyId))
        .then((rows) => rows.filter((row) => row.payload?.issueId === parentIssueId));
      const wakeCount = originKind === "task_watchdog" ? 1 : revision;
      expect(parentWakes).toHaveLength(wakeCount);
      const latestWake = parentWakes.find((wake) => wake.status === "queued");
      if (originKind === "task_watchdog" && revision === 2) {
        expect(latestWake).toBeUndefined();
      } else expect(latestWake).toMatchObject({
        reason: "issue_children_completed",
        payload: {
          issueId: parentIssueId,
          completedChildIssueId: childIssueId,
          childIssueIds: [childIssueId],
          childIssueSummaries: [{
            id: childIssueId,
            title: "Implement the accepted plan",
            status: "done",
            summary: `Implemented revision ${revision} and passed 44/44 tests.`,
          }],
          childIssueSummaryTruncated: false,
          _paperclipWakeContext: {
            wakeReason: "issue_children_completed",
            childIssueSummaries: [{
              id: childIssueId,
              summary: `Implemented revision ${revision} and passed 44/44 tests.`,
            }],
          },
        },
      });
      if (latestWake) {
        const delivery = latestWake.payload?._paperclipWakeContext as Record<string, unknown>;
        expect(delivery.nativeChildCompletionDecisionId).toBe(
          originKind === "task_watchdog" ? undefined : completedChild!.lastStatusDecisionId,
        );
      }
      await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded" });
      const replayWakes = await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, identity.companyId))
        .then((rows) => rows.filter((row) => row.payload?.issueId === parentIssueId));
      expect(replayWakes).toHaveLength(wakeCount);
      expect(new Set(replayWakes.map((wake) => wake.idempotencyKey)).size).toBe(wakeCount);
    }
  });

  it("returns a rejected native completion review to the original agent with the reviewer reason", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const issueId = "30000000-0000-4000-8000-000000000027";
    await db.insert(issues).values({
      id: issueId,
      companyId: identity.companyId,
      title: "Rejected native completion review",
      status: "in_review",
      assigneeAgentId: identity.agentId,
      responsibleUserId: "reviewer-25",
      workMode: "standard",
    });
    const [interaction] = await db.insert(issueThreadInteractions).values({
      companyId: identity.companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      resolverPolicyProvenance: "explicit",
      effectiveResolverPolicySource: "requested",
      sourceRunId: taskRunId,
      addresseeUserId: "reviewer-25",
      payload: {
        version: 1,
        prompt: "Approve completion?",
        rejectRequiresReason: true,
        target: { type: "custom", key: "native_completion_review", revisionId: "decision-25" },
      },
    }).returning();

    const rejected = await issueThreadInteractionService(db).rejectInteraction(
      { id: issueId, companyId: identity.companyId, status: "in_review" },
      interaction!.id,
      { reason: "Add the missing external verification." },
      { userId: "reviewer-25" },
    );

    expect(rejected).toMatchObject({
      status: "rejected",
      result: { outcome: "rejected", reason: "Add the missing external verification." },
    });
    await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toEqual([
      expect.objectContaining({ status: "todo", assigneeAgentId: identity.agentId }),
    ]);
  });

  it("preserves the result and issue status when workspace finalization fails", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const port = new PaperclipControlPlanePort(db, {
      companyId: identity.companyId,
      issueId: workspaceFailureIssueId,
      runId: workspaceFailureRunId,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      completionContractId: workspaceFailureContractId,
      completionContractSha256: "phase6-workspace-failure-contract",
      sourceInstanceId: workspaceFailureRunnerId,
      controlPlaneSourceInstanceId: "control-phase6-workspace-failure",
    });
    await port.openRun({
      identity: { ...identity, runId: workspaceFailureRunId, issueId: workspaceFailureIssueId },
      backendKind: "mock",
      sourceInstanceId: workspaceFailureRunnerId,
    });
    await port.completeRun({
      result: CONTROL_PLANE_CONFORMANCE_RESULT,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL,
      callerResultId: "phase6-workspace-failure-result",
    });
    await finalizeNativeRun({
      db,
      runId: workspaceFailureRunId,
      workspaceFinalizeStatus: "failed",
      projectRunStatus: true,
    });
    await expect(db.select().from(issues).where(eq(issues.id, workspaceFailureIssueId))).resolves.toEqual([
      expect.objectContaining({ status: "in_progress", statusVersion: 0, lastStatusDecisionId: null }),
    ]);
    await expect(db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, workspaceFailureRunId))).resolves.toEqual([
      expect.objectContaining({ status: "succeeded", nativePhase: "retryable_failure" }),
    ]);
    await expect(db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, workspaceFailureRunId))).resolves.toHaveLength(1);
  });

  it("LIVE-01..06 rolls back status, decision, and liveness rows at every materialization failpoint", async () => {
    const identity = CONTROL_PLANE_CONFORMANCE_OPEN.identity;
    const cases: Array<{
      suffix: number;
      failpoint: "governance_materialization" | "interaction_materialization" | "continuation_materialization" | "blocker_materialization" | "recovery_materialization" | "status_projection";
      result: PrpStructuredRunResult;
      terminalState?: "succeeded" | "failed" | "cancelled";
      executionState?: Record<string, unknown>;
    }> = [
      {
        suffix: 20,
        failpoint: "interaction_materialization",
        result: { ...structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT), reportedWorkDisposition: "needs_review", attentionRequests: [{ kind: "approval", summary: "Approve publication", ownerClass: "human" }] },
      },
      {
        suffix: 21,
        failpoint: "continuation_materialization",
        result: {
          ...structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT),
          reportedWorkDisposition: "yielded",
          continuation: { kind: "same_agent", summary: "Continue after recovery", idempotencyKey: "live-continue" },
        },
      },
      {
        suffix: 22,
        failpoint: "blocker_materialization",
        result: {
          ...structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT),
          reportedWorkDisposition: "blocked",
          blocker: {
            reasonCode: "access",
            owner: { kind: "user", name: "Board operator" },
            unblockAction: "Approve access",
            scope: "task_wide",
          },
        },
      },
      {
        suffix: 23,
        failpoint: "status_projection",
        result: { ...structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT), reportedWorkDisposition: "needs_review" },
      },
      {
        suffix: 25,
        failpoint: "recovery_materialization",
        terminalState: "cancelled",
        result: structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT),
      },
      {
        suffix: 26,
        failpoint: "governance_materialization",
        executionState: { status: "pending", stage: "approval" },
        result: structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT),
      },
    ];
    for (const entry of cases) {
      const value = String(entry.suffix).padStart(12, "0");
      const issueId = `30000000-0000-4000-8000-${value}`;
      const contractId = `31000000-0000-4000-8000-${value}`;
      const runId = `32000000-0000-4000-8000-${value}`;
      const runnerInstanceId = `33000000-0000-4000-8000-${value}`;
      await db.insert(issues).values({
        id: issueId,
        companyId: identity.companyId,
        title: `Atomic liveness ${entry.failpoint}`,
        status: "in_progress",
        assigneeAgentId: identity.agentId,
        workMode: "standard",
        executionState: entry.executionState,
      });
      await db.insert(completionContracts).values({
        id: contractId,
        companyId: identity.companyId,
        issueId,
        revision: 1,
        schemaVersion: "paperclip.completion-contract.v1",
        policyVersion: "phase6-v1",
        risk: "standard",
        completionAuthority: "server_arbiter",
        incompleteCriteriaPolicy: "preserve_non_terminal",
        contractJson: { revision: "phase6-v1", objective: "Atomic liveness", criteria: [{ id: "objective", requirement: "Stay atomic" }] },
        canonicalSha256: `contract-${entry.suffix}`,
        createdByActorType: "system",
        createdByActorId: "test",
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: identity.companyId,
        agentId: identity.agentId,
        status: "running",
        runtimeMode: "native",
        nativeIssueId: issueId,
        nativeSessionId: identity.sessionId,
        runnerInstanceId,
        completionContractId: contractId,
        completionContractSha256: `contract-${entry.suffix}`,
        contextSnapshot: { issueId },
      });
      const terminal: PrpTerminalState = {
        ...CONTROL_PLANE_CONFORMANCE_TERMINAL,
        runTerminalState: entry.terminalState ?? "succeeded",
        reportedWorkDisposition: entry.result.reportedWorkDisposition,
      };
      const port = new PaperclipControlPlanePort(db, {
        companyId: identity.companyId,
        issueId,
        runId,
        agentId: identity.agentId,
        sessionId: identity.sessionId,
        completionContractId: contractId,
        completionContractSha256: `contract-${entry.suffix}`,
        sourceInstanceId: runnerInstanceId,
        controlPlaneSourceInstanceId: `atomic-control-${entry.suffix}`,
      });
      await port.openRun({
        identity: { ...identity, issueId, runId },
        backendKind: "mock",
        sourceInstanceId: runnerInstanceId,
      });
      await port.completeRun({ result: entry.result, terminal, callerResultId: `atomic-result-${entry.suffix}` });
      await expect(finalizeNativeRun({
        db,
        runId,
        workspaceFinalizeStatus: "succeeded",
        failpoint: entry.failpoint,
      })).resolves.toEqual(expect.objectContaining({ phase: "retryable_failure" }));
      await expect(db.select().from(issues).where(eq(issues.id, issueId))).resolves.toEqual([
        expect.objectContaining({ status: "in_progress", statusVersion: 0, lastStatusDecisionId: null }),
      ]);
      await expect(db.select().from(statusDecisions).where(eq(statusDecisions.issueId, issueId))).resolves.toHaveLength(0);
      await expect(db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.issueId, issueId))).resolves.toHaveLength(0);
      await expect(db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId))).resolves.toHaveLength(0);
      await expect(db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, identity.companyId))).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({ issueId }) })]),
      );
      await expect(db.select().from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, issueId))).resolves.toEqual([
        expect.objectContaining({ status: "active", cause: "side_effect_planning_failed" }),
      ]);
    }
  });
});
