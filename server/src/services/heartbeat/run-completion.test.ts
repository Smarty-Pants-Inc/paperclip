import { promises as fs } from "node:fs";
import { PassThrough } from "node:stream";
import pino from "pino";
import { createDurableRunLogStore } from "../run-log-store.js";
import { createServer } from "node:http";
import { registerLocalRuntimeApiServer } from "../../runtime-api.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executePaperclipNativeSession, closeIdleWarmNativeSessionsForRestart, nativeSessionFailureSourceCode } from "../native-runtime/native-session-executor.js";
import { createHeartbeatRunOutput } from "./run-output.js";
import { createHeartbeatRunControl } from "./run-control.js";
import { callbacks as controlCallbacks } from "./__tests__/run-control-fixtures.js";
import { objectLogFixture } from "./__tests__/object-log-fixture.js";
import { createNativeUsageDelivery } from "../native-runtime/native-usage-delivery.js";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { createNativeRunLogCoverageVerifier, formatNativeRunLogEvent } from "../native-runtime/native-run-log-export.js";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, authUsers, agentWakeupRequests, approvals, issueApprovals, budgetReservations, caseHandoffs, cases, companies, completionContracts, costEvents, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, heartbeatRunEvents, issueComments, issueQuestionResponseDeliveries, issueRecoveryActions, issues, issueThreadInteractions, nativeRunFinalizations } from "@paperclipai/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import * as usageReceipts from "../usage-receipts.js";
import { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import { UnresolvedWorkspaceBaseRefError } from "../workspace-runtime.js";
import { LegacyControllerLeaseLostError } from "../legacy-controller-lease.js";
import { requestedRunCancellation } from "../run-cancellation.js";
import { ProjectAccessDeniedError } from "../project-access-denial.js";
import { RemoteWorkspaceOperationError, RemoteWorkspaceOperationTimeoutError, RemoteWorkspacePreparationTimeoutError, RemoteWorkspaceRestoreError } from "../remote-workspace-transport.js";
import { EnvironmentRunError, environmentRunOrchestrator } from "../environment-run-orchestrator.js";
import { ReusableSandboxResumeError } from "../reusable-sandbox-resume-error.js";
import { PluginWorkerUnavailableError } from "../plugin-worker-unavailable-error.js";
import { ReviewedChatBindingDeniedError, ReviewedChatBindingNotReadyError } from "../reviewed-chat-binding-diagnostics.js";
import { environmentTaskErrorCodeData, JsonRpcCallError, PluginEnvironmentTaskError, PluginWorkspaceOperationError, workspaceOperationErrorData } from "@paperclipai/plugin-sdk";
import { RUNNER_REVISION_MISMATCH_RETRY } from "../runner-revision-mismatch.js";
import { STORAGE_CREDENTIALS_REJECTED_HELD_MESSAGE, STORAGE_UNAVAILABLE_CODE, STORAGE_UNAVAILABLE_EXHAUSTED_MESSAGE, STORAGE_UNAVAILABLE_HELD_MESSAGE, STORAGE_UNAVAILABLE_MESSAGE, STORAGE_UNAVAILABLE_RETRY } from "../../storage/storage-unavailable.js";
import { withS3FailureDiagnostics } from "../../storage/s3-failure.js";
import { workspaceProviderCallFailure } from "../workspace-provider-failure.js";
import { logger } from "../../middleware/logger.js";
import { unprocessable } from "../../errors.js";
import { ACCOUNTING_CONTENTION_MESSAGE, AccountingContentionError } from "../accounting-transaction.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "./run-lifecycle.js";
import { createHeartbeatRunPreparation, ConfigurationIncompleteFailure, classifyManagedProjectAuthFailure } from "./run-preparation.js";
import { createHeartbeatRunState, getAdapterSessionCodec } from "./run-state.js";
import { buildEffectiveRunSessionConfigMetadata } from "./workspaces.js";
import { createHeartbeatRunCompletion, type CompleteHeartbeatRunInput, type FailHeartbeatRunInput, type HeartbeatRunCompletionDependencies } from "./run-completion.js";
import { createHeartbeatAgentStatus } from "./agent-status.js";
import { prepareNativeHeartbeatRun } from "../native-runtime/prepare-native-run.js";
import { buildNativeCompletionContract } from "../native-runtime/completion-contracts.js";
import { readPendingNativeRunStop } from "../native-runtime/native-cancellation-request.js";
import { reserveRunBudget } from "../budget-reservations.js";
import { hasAcknowledgedNativeReassignmentStopIntent } from "../acknowledged-native-stop.js";
import { questionResponseDeliveryService } from "../question-response-delivery.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { heartbeatService } from "../heartbeat.js";
import { createReleaseIssueExecution } from "../../modules/wake-queue/application/use-cases.js";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { claimFirstTurnQueuedInput } from "../native-runtime/first-turn-queued-input.js";
import { settleUnansweredPersonMessage } from "../recovery/unanswered-person-message.js";
import { NativeRunCoordinatorStore } from "../native-runtime/native-run-coordinator-store.js";
import { finalizeNativeRun, NativeFinalizationDeferredError, recoverCommittedNativeChatResponse } from "../native-runtime/native-run-finalizer.js";
import { nativeResponsePresentationWork } from "../native-runtime/native-response-presentation-work.js";
import { issueService } from "../issues.js";

vi.mock("../live-events.js", () => ({ publishLiveEvent: vi.fn() }));

const diagnosticNativeFixture = vi.hoisted(() => ({
  enabled: false,
  retireWarm: false,
  beforeWarmClose: undefined as (() => Promise<void>) | undefined,
  backendOptions: undefined as Parameters<typeof import("../../vendor/paperclip-runner/index.js").createNativeSessionBackend>[1],
}));
vi.mock("../native-runtime/native-codex-runner.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../native-runtime/native-codex-runner.js")>();
  return {
    ...actual,
    resolvePaperclipRunnerBinary: () => diagnosticNativeFixture.enabled ? process.execPath : actual.resolvePaperclipRunnerBinary(),
    resolvePaperclipRunnerBinaryAsync: async () => diagnosticNativeFixture.enabled ? process.execPath : actual.resolvePaperclipRunnerBinaryAsync(),
  };
});
vi.mock("../../vendor/paperclip-runner/index.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>();
  return { ...actual,
    createNativeSessionBackend: (...args: Parameters<typeof actual.createNativeSessionBackend>) => {
      if (!diagnosticNativeFixture.enabled) return actual.createNativeSessionBackend(...args);
      diagnosticNativeFixture.backendOptions = args[1];
      return { descriptor: () => ({ kind: "test" }) };
    },
    executeNativeSession: async (options: Parameters<typeof actual.executeNativeSession>[0]) => {
      if (!diagnosticNativeFixture.enabled) return actual.executeNativeSession(options);
      const transport = diagnosticNativeFixture.backendOptions!.codexTransportFactory!();
      const session = { close: async ({ reason }: { reason: string }) => { await transport.close(reason); } };
      await options.onSession?.(session as never);
      await diagnosticNativeFixture.beforeWarmClose?.();
      if (diagnosticNativeFixture.retireWarm) await closeIdleWarmNativeSessionsForRestart();
      return { result: { summary: "accepted result" }, terminal: { runTerminalState: "succeeded" }, turnId: "test-turn",
        normalizedSessionId: options.input.session.normalizedSessionId, providerSessionId: "synthetic-provider",
        driverKind: "test", driverVersion: "1", nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    },
  };
});


type Dependencies = HeartbeatRunCompletionDependencies;
function callbacks(db: Db, realPresentation = false) {
  const state = createHeartbeatRunState(db);
  const lifecycleDeps = {
    ...state, ...createHeartbeatRunPreparation(db),
    issuesSvc: { addComment: vi.fn(), listReviewAttention: vi.fn() },
    recovery: { escalateStrandedAssignedIssue: vi.fn() },
    companySkills: { completeTestRunForIssue: vi.fn() },
    budgets: { getInvocationBlock: vi.fn(async () => null) },
    treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
    enqueueWakeup: vi.fn(),
    getCurrentUserRedactionOptions: vi.fn<HeartbeatLifecycleDependencies["getCurrentUserRedactionOptions"]>(async () => ({ enabled: false })),
    getAgentInvokability: vi.fn<HeartbeatLifecycleDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
    emitTerminalAgentTaskRun: vi.fn(), budgetHooks: {},
  } satisfies HeartbeatLifecycleDependencies;
  const lifecycle = createHeartbeatLifecycle(db, lifecycleDeps);
  return {
    ...state, ...lifecycle,
    setRunStatusIfRunning: vi.fn(lifecycle.setRunStatusIfRunning),
    setWakeupStatus: vi.fn(lifecycle.setWakeupStatus),
    upsertTaskSession: vi.fn(state.upsertTaskSession),
    clearTaskSessions: vi.fn(state.clearTaskSessions),
    classifyAndPersistRunLiveness: vi.fn<Dependencies["classifyAndPersistRunLiveness"]>(async run => run),
    completeSkillTestRunForHeartbeatOutcome: vi.fn<Dependencies["completeSkillTestRunForHeartbeatOutcome"]>(async () => null),
    refreshContinuationSummaryForRun: vi.fn<Dependencies["refreshContinuationSummaryForRun"]>(async () => null),
    findRunIssueComment: vi.fn<Dependencies["findRunIssueComment"]>(realPresentation ? lifecycle.findRunIssueComment : async () => null),
    findLatestCompletedFinalAgentMessage: vi.fn<Dependencies["findLatestCompletedFinalAgentMessage"]>(realPresentation ? lifecycle.findLatestCompletedFinalAgentMessage : async () => null),
    finalizeIssueCommentPolicy: vi.fn<Dependencies["finalizeIssueCommentPolicy"]>(async () => ({ outcome: "not_applicable", queuedRun: null })),
    handleIssueReviewPathDisposition: vi.fn<Dependencies["handleIssueReviewPathDisposition"]>(async () => undefined),
    handleRunLivenessContinuation: vi.fn<Dependencies["handleRunLivenessContinuation"]>(),
    handleSuccessfulRunHandoff: vi.fn<Dependencies["handleSuccessfulRunHandoff"]>(),
    updateRuntimeState: vi.fn<Dependencies["updateRuntimeState"]>(),
    scheduleBoundedRetryForRun: vi.fn<Dependencies["scheduleBoundedRetryForRun"]>(),
    scheduleInteractionContinuationInfrastructureRetryIfEligible: vi.fn<Dependencies["scheduleInteractionContinuationInfrastructureRetryIfEligible"]>(async () => null),
    timerClaimWasFirstHeartbeat: vi.fn<Dependencies["timerClaimWasFirstHeartbeat"]>(() => undefined),
    releaseIssueExecutionAndPromote: vi.fn<Dependencies["releaseIssueExecutionAndPromote"]>(async () => undefined),
    finalizeAgentStatus: vi.fn<Dependencies["finalizeAgentStatus"]>(async () => undefined),
    enqueueWakeup: vi.fn<Dependencies["enqueueWakeup"]>(),
    issuesSvc: { addComment: vi.fn<Dependencies["issuesSvc"]["addComment"]>() },
    recovery: { reconcileLegacyContinuation: vi.fn<Dependencies["recovery"]["reconcileLegacyContinuation"]>(), reconcileResolvedDependencyWakeBackstop: vi.fn<Dependencies["recovery"]["reconcileResolvedDependencyWakeBackstop"]>() },
    getCurrentUserRedactionOptions: lifecycleDeps.getCurrentUserRedactionOptions,
    budgetHooks: {},
    runLogStore: { finalize: vi.fn<Dependencies["runLogStore"]["finalize"]>(async () => ({ bytes: 123, sha256: "log-hash", compressed: true })) },
    traceStore: { finalize: vi.fn<Dependencies["traceStore"]["finalize"]>() },
    processRunCancellationSettlements: new Map<string, { settled: Promise<void>; failed: boolean }>(),
    failedProcessRunCancellations: new Map<string, { settled: Promise<void>; failed: boolean }>(),
  } satisfies Dependencies;
}

it("constructs completion handlers without querying or starting work", () => {
  const access = vi.fn(() => { throw new Error("Unexpected database access"); });
  const db = new Proxy({}, { get: access }) as Db;
  const deps = callbacks(db);
  createHeartbeatRunCompletion(db, deps);
  expect(access).not.toHaveBeenCalled();
  for (const callback of Object.values(deps)) if (vi.isMockFunction(callback)) expect(callback).not.toHaveBeenCalled();
});

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported && !process.env.PAPERCLIP_TEST_DATABASE_URL)("heartbeat run completion boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    // Keep the accounting transaction real without reading provider receipt files.
    vi.spyOn(usageReceipts, "indexPendingUsageReceipts").mockResolvedValue(new Map());
    vi.spyOn(usageReceipts, "recoverPendingRunUsageReceipts").mockResolvedValue([]);
    const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
    if (external) db = createDb(external);
    else {
      database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-completion");
      db = createDb(database.connectionString);
    }
    await db.execute(sql`set client_min_messages = warning`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); vi.restoreAllMocks(); });
  beforeEach(async () => { await db.execute(sql`truncate table companies restart identity cascade`); });

  async function fixture(patch: Partial<typeof heartbeatRuns.$inferInsert> = {}, issuePrefix = "CMP", realPresentation = false) {
    const [company] = await db.insert(companies).values({ name: "Completion", issuePrefix }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Completing agent", adapterType: "process" }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id, source: "on_demand", status: "claimed" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, wakeupRequestId: wake.id, status: "running", runtimeMode: "legacy", ...patch }).returning();
    const deps = callbacks(db, realPresentation);
    const controller = new AbortController();
    const input: CompleteHeartbeatRunInput = {
      run, agent, issueId: null, issueRef: null, signal: controller.signal,
      output: { handle: { store: "local_file", logRef: "test-log" }, outputProgressState: { pending: { bytes: 7 } }, flushOutputProgress: vi.fn(async () => {}), stdoutExcerpt: "answer", stderrExcerpt: "diagnostic" },
      session: { runtimeForAdapter: { sessionId: null, sessionDisplayId: null }, previousSessionParams: null, taskKey: "completion-task", configuredModel: "test-model",
        sessionConfigMetadata: await buildEffectiveRunSessionConfigMetadata({ adapterType: agent.adapterType, effectiveAdapterConfig: {}, agentRuntimeConfig: {}, issueOverrides: null, workspaceConfig: null, environment: null, environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [] }),
      },
      readFailureReportSecrets: () => [],
      adapterResult: { exitCode: 0, signal: null, timedOut: false, sessionId: "provider-session", sessionParams: { sessionId: "provider-session" }, usage: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 8 }, usageBasis: "per_run", costUsd: 0.01, provider: "test", model: "test-model", resultJson: { finalResponse: "Completed the work." } },
      sessionCodec: getAdapterSessionCodec(agent.adapterType), taskSessionForRun: null, sessionCompaction: { rotate: false, reason: null }, configFreshnessResultMetadata: { version: 1 }, runLedgerScope: {}, currentUserRedactionOptions: { enabled: false }, providerTraceCapture: true, onProviderTraceFinalized: vi.fn(), issueContext: null, onLog: vi.fn(async () => {}),
    };
    const completion = createHeartbeatRunCompletion(db, deps);
    const failure = (err: unknown): FailHeartbeatRunInput => ({ ...input, runId: run.id, err, identityRedactor: createAgentIdentityRedactor("private-identity-material"), requiredWorkspaceRestoreEvidence: { workspaceRestoreFailure: { reason: "missing_base" } }, legacyAdapterEntered: true, goalCheckpointSession: { current: null }, previousSessionDisplayId: "previous-session", taskSession: null });
    const setup = (outerErr: unknown, providerDispatchStarted = false) => ({ run, runId: run.id, outerErr, signal: controller.signal, providerDispatchStarted, identityRedactor: createAgentIdentityRedactor(), readFailureReportSecrets: () => [] });
    return { run, agent, wake, deps, controller, input, completion, failure, setup };
  }
  const read = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]!);

  // DREA-31: real release/queue, first-turn seal, completion publisher and B' notice.
  // Only the provider is deterministic: its answer depends on the actual turn text.
  async function commentContinuationFixture(personMessage = true) {
    const f = await fixture({ status: "failed", errorCode: "adapter_failed", finishedAt: new Date(), responsibleUserId: "local-board",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Recall the follow-up",
      assigneeAgentId: f.agent.id, status: "in_progress", executionRunId: f.run.id }).returning();
    await db.insert(issueComments).values({ companyId: f.run.companyId, issueId: issue.id,
      authorType: "agent", authorAgentId: f.agent.id, body: "Turn one: ORANGE.", createdAt: new Date(Date.now() - 60_000) });
    const [message] = personMessage ? await db.insert(issueComments).values({ companyId: f.run.companyId, issueId: issue.id,
      authorType: "user", authorUserId: "local-board", body: "Forget ORANGE. What is my new recall word? COBALT." }).returning() : [];
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: issue.id,
      ...(message ? { wakeReason: "issue_commented", wakeCommentId: message.id } : { wakeReason: "issue_assigned" }) } })
      .where(eq(heartbeatRuns.id, f.run.id));
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, {
      resolveResponsibleUserId: async () => "local-board", getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
    }), recovery: { escalateStrandedAssignedIssue: async () => {}, escalateStrandedRecoveryIssueInPlace: async () => {} } });
    async function start() {
      const result = await release({ companyId: f.run.companyId, runId: f.run.id, now: new Date() });
      expect(result.outcome.kind).toBe("queued_recovery");
      const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.run.id));
      const [running] = await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: issue.id })
        .where(eq(heartbeatRuns.id, successor.id)).returning();
      f.input.run = running;
      f.input.issueId = issue.id;
      f.input.issueRef = issue;
      f.deps.issuesSvc.addComment.mockImplementation(async (issueId, body) => {
        const [comment] = await db.insert(issueComments).values({ companyId: f.run.companyId, issueId, body,
          authorType: "agent", authorAgentId: f.agent.id, createdByRunId: running.id }).returning();
        return { ...comment, authorType: "agent" as const };
      });
      return running;
    }
    async function finish(text: string) {
      f.input.adapterResult.resultJson = { finalResponseDisposition: "final", finalResponse: text };
      await f.completion.completeRun(f.input);
      return db.select().from(issueComments).where(and(eq(issueComments.issueId, issue.id), eq(issueComments.authorType, "agent")));
    }
    return { ...f, issue, message, start, finish };
  }

  it("carry-comment (a): failed comment wake carries COBALT into the continuation's first turn and answer", async () => {
    const f = await commentContinuationFixture();
    const run = await f.start();
    expect(run.contextSnapshot).toMatchObject({ wakeCommentId: f.message!.id, wakeCommentIds: [f.message!.id] });
    const input = await claimFirstTurnQueuedInput(db, { companyId: run.companyId, issueId: f.issue.id, runId: run.id, agentId: run.agentId });
    expect(input).toContain("COBALT");
    expect((await read(run.id)).contextSnapshot?.firstTurnQueuedInput).toMatchObject({ runId: run.id, commentIds: [f.message!.id] });
    const replies = await f.finish(input?.includes("COBALT") ? "Your new recall word is COBALT." : "Turn one: ORANGE.");
    expect(replies.find(reply => reply.createdByRunId === run.id)?.body).toBe("Your new recall word is COBALT.");
  });

  it("carry-comment (b): comment continuation publishes its result even when the parent replied", async () => {
    const f = await commentContinuationFixture();
    // A parent reply does not authorize suppressing this continuation's result.
    await db.insert(issueComments).values({ companyId: f.run.companyId, issueId: f.issue.id, authorType: "agent",
      authorAgentId: f.agent.id, createdByRunId: f.run.id, body: "Parent interim note." });
    const run = await f.start();
    await claimFirstTurnQueuedInput(db, { companyId: run.companyId, issueId: f.issue.id, runId: run.id, agentId: run.agentId });
    const replies = await f.finish("The continuation result is published.");
    expect(replies.find(reply => reply.createdByRunId === run.id)?.body).toBe("The continuation result is published.");
  });

  it("carry-comment (c): ordinary work continuation still publishes its result", async () => {
    const f = await commentContinuationFixture(false);
    const run = await f.start();
    const replies = await f.finish("Finished my own assigned work.");
    expect(replies.find(reply => reply.createdByRunId === run.id)?.body).toBe("Finished my own assigned work.");
  });

  it.each([false, true])("carry-comment (d): B' notice remains only while the message is unanswered (answered=%s)", async answered => {
    const f = await commentContinuationFixture();
    const scope = { companyId: f.run.companyId, issueId: f.issue.id, now: new Date(Date.now() + 60 * 60_000) };
    const first = await settleUnansweredPersonMessage(db, scope);
    expect(first.kind).toBe("noticed");
    if (answered) {
      await f.start();
      await f.finish("Your new recall word is COBALT.");
    }
    const outcome = await settleUnansweredPersonMessage(db, scope);
    expect(outcome.kind).toBe(answered ? "answered" : "noticed_before");
    const notes = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issue.id), eq(issueComments.authorType, "system")));
    expect(notes.filter(note => !note.deletedAt && String(note.metadata?.authorizationReason).startsWith("unanswered_message:"))).toHaveLength(answered ? 0 : 1);
  });

  it("replays saved user intent through normal Retry after a first-attempt retained runner failure", async () => {
    for (const mode of ["unattached", "archive_failed", "provider_started", "system_wake", "stopped", "stopped_failed", "promoted"] as const) {
      const f = await fixture({ runtimeMode: mode === "promoted" ? "legacy" : "native" }, `CMP${randomUUID().slice(0, 6)}`);
      const failureMessage = mode === "archive_failed"
        ? "runner_continuity_break_archive_failed: exit=1 timedOut=false mv: cannot remove 'runner': Directory not empty"
        : "runner_remote_process_identity_unavailable";
      const retryExpected = mode === "unattached" || mode === "archive_failed" || mode === "promoted";
      const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Continue saved work",
        assigneeAgentId: f.agent.id, status: "in_progress" }).returning();
      const [comment] = await db.insert(issueComments).values({ companyId: f.run.companyId, issueId: issue.id,
        authorType: "user", authorUserId: "local-board", body: "Please finish the saved change." }).returning();
      await db.update(agentWakeupRequests).set({ runId: f.run.id, reason: "issue_reopened_via_comment",
        requestedByActorType: mode === "system_wake" ? "system" : "user", requestedByActorId: "local-board",
        payload: { issueId: issue.id, commentId: comment.id } }).where(eq(agentWakeupRequests.id, f.wake.id));
      const [run] = await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issue.id, responsibleUserId: "local-board",
        contextSnapshot: { issueId: issue.id, wakeReason: "issue_reopened_via_comment", wakeCommentId: comment.id } })
        .where(eq(heartbeatRuns.id, f.run.id)).returning();
      await db.insert(nativeRunFinalizations).values({ companyId: run.companyId, issueId: issue.id, runId: run.id,
        phase: "terminal_failure", failureCode: nativeSessionFailureSourceCode(new Error(failureMessage)) });
      if (mode === "provider_started") await appendHeartbeatRunEvent(db, { companyId: run.companyId, runId: run.id,
        agentId: run.agentId, eventType: "turn.started", stream: "system", level: "info", message: "Provider started" });
      if (mode === "stopped_failed") await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(),
        error: failureMessage, errorCode: nativeSessionFailureSourceCode(new Error(failureMessage)) }).where(eq(heartbeatRuns.id, run.id));
      if (mode === "stopped" || mode === "stopped_failed") f.controller.abort();
      const observedRun = mode === "promoted" ? { ...run, runtimeMode: f.run.runtimeMode } : run;
      await f.completion.failRun({ ...f.failure(new Error(failureMessage)), run: observedRun,
        issueId: issue.id, requiredWorkspaceRestoreEvidence: {}, legacyAdapterEntered: false });
      const requests = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, run.companyId),
        eq(agentWakeupRequests.reason, "task_retry")));
      expect.soft(requests, mode).toHaveLength(retryExpected ? 1 : 0);
      if (retryExpected && requests[0]) expect(requests[0]).toMatchObject({ status: "deferred_issue_execution",
        requestedByActorType: "user", requestedByActorId: "local-board", payload: { taskRetry: { sourceRunId: run.id } } });
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it.each(["ordinary", "stalled append", "object admission"] as const)("finishes accepted output before ordinary lease teardown without writing to a retired recorder (%s)", async mode => {
    const stalledAppend = mode === "stalled append", stalledAdmission = mode === "object admission";
    const f = await fixture({ runtimeMode: "native",
      resultJson: { durable: "accepted result" } });
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "diagnostic-completion-")));
    onTestFinished(() => rm(workspace, { recursive: true, force: true }));
    let holdUploads = false, uploadEntered = false, finalizeEntered = false;
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>(resolve => { releaseUpload = resolve; });
    const store = stalledAppend ? createDurableRunLogStore({ basePath: join(workspace, "run-logs") }) : objectLogFixture(async input => {
      if (stalledAdmission && holdUploads && input.objectKey.includes("/objects/")) {
        uploadEntered = true;
        await uploadGate;
      }
    });
    let latestOutputSeq = 0, admittedBytes = 0;
    const diagnosticAdmissions: Array<{ chunk: string; admitted?: boolean; error?: string }> = [];
    if (store.enqueue) {
      const originalEnqueue = store.enqueue.bind(store);
      vi.spyOn(store, "enqueue").mockImplementation(async (handle, event) => {
        latestOutputSeq = event.seq ?? latestOutputSeq;
        const observation = event.chunk.includes("runnerd diagnostic") ? { chunk: event.chunk } as typeof diagnosticAdmissions[number] : undefined;
        if (observation) diagnosticAdmissions.push(observation);
        let receipt;
        try { receipt = await originalEnqueue(handle, event); if (observation) observation.admitted = true; }
        catch (error) { if (observation) observation.error = error instanceof Error ? error.message : String(error); throw error; }
        if (holdUploads) admittedBytes += Buffer.byteLength(JSON.stringify({ ts: event.ts,
          attemptId: handle.attemptId, stream: event.stream, chunk: event.chunk, seq: event.seq }) + "\n");
        return receipt;
      });
    }
    const originalFinalize = store.finalize.bind(store);
    vi.spyOn(store, "finalize").mockImplementation((...args) => {
      finalizeEntered = true;
      return originalFinalize(...args);
    });
    const readLog = async () => {
      let content = "", offset = 0;
      do {
        const page = await store.read(output.handle!, { offset, limitBytes: 4 * 1024 * 1024 });
        content += page.content;
        if (page.nextOffset === undefined) break;
        offset = page.nextOffset;
      } while (true);
      return { content };
    };
    let releaseAppend!: () => void, observeAppend!: () => void;
    const appendGate = new Promise<void>(resolve => { releaseAppend = resolve; });
    const appendStarted = new Promise<void>(resolve => { observeAppend = resolve; });
    const originalAppend = fs.appendFile.bind(fs);
    const append = vi.spyOn(fs, "appendFile").mockImplementation(async (...args) => {
      if (stalledAppend && String(args[1]).includes("runnerd diagnostic")) { observeAppend(); await appendGate; }
      return originalAppend(...args);
    });
    const warning = vi.spyOn(console, "warn");
    onTestFinished(() => { releaseAppend(); append.mockRestore(); warning.mockRestore(); });
    const output = createHeartbeatRunOutput(db, { run: f.run, runId: f.run.id, issueId: null, runLogStore: store,
      identityRedactor: { chunk: (_stream, chunk) => chunk, redact: value => value }, secretKeys: new Set(),
      appendRunEvent: f.deps.appendRunEvent, getCurrentUserRedactionOptions: async () => ({ enabled: false }) });
    const handlers = await output.begin(f.run);
    await handlers.onLog("stdout", "accepted output for this exact run\n");
    const { execution, issue } = await admitNativeExecution(f);
    await db.update(issues).set({ assigneeAgentId: f.run.agentId, executionRunId: f.run.id, status: "in_progress" }).where(eq(issues.id, issue.id));
    vi.stubEnv("PAPERCLIP_HOME", join(workspace, "synthetic-controller-home"));
    onTestFinished(() => { vi.unstubAllEnvs(); });
    execution.workspace.cwd = workspace;
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, f.run.id));
    Object.assign(execution.session, { lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60000 } });
    await db.insert(nativeRunFinalizations).values({ runId: f.run.id, companyId: f.run.companyId, issueId: issue.id, phase: "observed" });
    const api = createServer((_req, response) => { response.writeHead(404).end(); });
    registerLocalRuntimeApiServer(api);
    await new Promise<void>((resolve, reject) => { api.once("error", reject); api.listen(0, "127.0.0.1", resolve); });
    onTestFinished(() => new Promise<void>(resolve => api.close(() => resolve())));
    diagnosticNativeFixture.enabled = true;
    diagnosticNativeFixture.retireWarm = stalledAppend || stalledAdmission;
    if (stalledAdmission) diagnosticNativeFixture.beforeWarmClose = async () => {
      await store.flush!(output.handle!);
      holdUploads = true;
      const target = 8 * 1024 * 1024 - 1;
      while (admittedBytes < target) {
        const overhead = Buffer.byteLength(JSON.stringify({ ts: new Date().toISOString(),
          attemptId: output.handle!.attemptId, stream: "stdout", chunk: "", seq: latestOutputSeq + 1 }) + "\n");
        const chunk = "x".repeat(Math.min(64 * 1024, target - admittedBytes - overhead));
        await handlers.onLog("stdout", chunk);
      }
      expect(admittedBytes).toBe(target);
      expect(uploadEntered).toBe(true);
    };
    let completed = false;
    const diagnosticWrites: Promise<void>[] = [];
    const finishing = (async () => {
      const event: PrpEvent = { schema: "paperclip.prp.event.v1", schemaVersion: 1,
        sourceInstanceId: randomUUID(), sourceEventId: randomUUID(), sourceSeq: 1, sourceKind: "runner",
        runId: f.run.id, normalizedSessionId: execution.session.normalizedSessionId,
        eventType: "item.delta", priority: 2, emittedAt: new Date().toISOString(), payload: { text: "canonical accepted output 再開" } };
      const persisted = await appendHeartbeatRunEvent(db, { companyId: f.run.companyId, runId: f.run.id,
        agentId: f.run.agentId, eventType: event.eventType, payload: { prpEvent: event },
        nativeSource: { sourceInstanceId: event.sourceInstanceId, sourceEventId: event.sourceEventId,
          sourceSeq: event.sourceSeq, protocolSchemaVersion: 1, canonicalPayload: event as unknown as Record<string, unknown> } });
      if (!stalledAppend) await handlers.onPersistedNativeLog!(persisted.row.seq, formatNativeRunLogEvent(event));
      const adapter = await executePaperclipNativeSession({ db, execution: execution as never,
        runnerInstanceId: "synthetic-controller", useRunnerd: true, onLog: (stream, chunk) => {
          const write = handlers.onLog(stream, chunk);
          if (chunk.includes("runnerd diagnostic")) diagnosticWrites.push(write);
          return write;
        },
        runnerEnvironment: { HOME: workspace, CODEX_HOME: join(workspace, "synthetic-codex-home") } });
      await db.update(heartbeatRuns).set({ status: "succeeded", nativePhase: "committed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
      Object.assign(f.run, await read(f.run.id));
      f.agent.adapterType = "paperclip_runner";
      f.input.sessionCodec = getAdapterSessionCodec(f.agent.adapterType);
      f.input.adapterResult = adapter;
      const completionDeps: Dependencies = { ...f.deps, runLogStore: store };
      f.input.output = output;
      f.input.onLog = handlers.onLog;
      await createHeartbeatRunCompletion(db, completionDeps).completeRun(f.input);
      completed = true;
      return { persisted, event };
    })();
    void finishing.catch(() => undefined);
    try {
      if (stalledAdmission) {
        await vi.waitFor(() => expect(finalizeEntered).toBe(true), { timeout: 10_000 });
        expect(diagnosticWrites.length).toBeGreaterThan(0);
        releaseUpload();
      }
      if (stalledAppend) {
        await appendStarted;
        await vi.waitFor(() => expect(completed).toBe(true), { timeout: 10_000 });
      }
      const { persisted, event } = await finishing;
      const before = await readLog();
      expect(before.content).toContain("accepted output for this exact run");
      const settled = await read(f.run.id);
      expect(settled).toMatchObject({ companyId: f.run.companyId, status: "succeeded", resultJson: { durable: "accepted result" } });
      expect(settled).toMatchObject({ costAccountingPending: true, costAccountedAt: null, usageJson: { accountingReceiptReady: false } });
      expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), expect.any(Object));
      if (stalledAppend) {
        expect(settled).toMatchObject({ logBytes: null, logSha256: null });
        expect(warning).toHaveBeenCalledWith(expect.stringContaining("final log size and hash are unknown"));
      } else {
        const chunks = before.content.trimEnd().split("\n").map(line => JSON.parse(line).chunk);
        expect(chunks).toContain(formatNativeRunLogEvent(event));
        expect(settled).toMatchObject({ logBytes: Buffer.byteLength(before.content),
          logSha256: createHash("sha256").update(before.content).digest("hex") });
      }
      const deps = controlCallbacks(db);
      deps.options.closeWarmNativeSessionsForRun.mockImplementation(async ({ runId }) => {
        expect(runId).toBe(f.run.id);
        await closeIdleWarmNativeSessionsForRestart();
        return { closed: 1, busy: 0, failed: 0 };
      });
      await createHeartbeatRunControl(db, deps).releaseEnvironmentLeasesForRun({ runId: f.run.id, companyId: f.run.companyId,
        agentId: f.run.agentId, status: "succeeded", providerResourceDisposition: "destroy" });
      expect(deps.options.closeWarmNativeSessionsForRun).toHaveBeenCalledOnce();
      const after = await readLog();
      expect(after.content).toBe(before.content);
      if (!stalledAppend) {
        const coverage = createNativeRunLogCoverageVerifier(db, f.run.companyId, f.run.id, { redactChunks: chunk => [chunk] });
        await coverage.write(Buffer.from(after.content));
        expect(await coverage.finish()).toBe(persisted.row.seq);
      }
      if (stalledAdmission) {
        await Promise.allSettled(diagnosticWrites);
        expect(diagnosticAdmissions.length).toBeGreaterThan(0);
        const storedChunks = before.content.trimEnd().split("\n").map(line => JSON.parse(line).chunk);
        for (const admission of diagnosticAdmissions) {
          expect(admission).toMatchObject({ admitted: true });
          expect(admission.error).toBeUndefined();
          expect(storedChunks).toContain(admission.chunk);
        }
      }
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.run.id));
      expect(events.filter(event => (event.payload as { reason?: string } | null)?.reason === "object_log_persistence_failed")).toEqual([]);
    } finally {
      releaseAppend();
      releaseUpload();
      await Promise.allSettled(diagnosticWrites);
      await finishing;
      if (stalledAppend) expect(await read(f.run.id)).toMatchObject({ logBytes: null, logSha256: null });
      await closeIdleWarmNativeSessionsForRestart();
      diagnosticNativeFixture.enabled = false;
      diagnosticNativeFixture.retireWarm = false;
      diagnosticNativeFixture.beforeWarmClose = undefined;
    }
  });

  async function admitNativeExecution(f: Awaited<ReturnType<typeof fixture>>) {
    await db.update(agents).set({ adapterType: "paperclip_runner" }).where(eq(agents.id, f.agent.id));
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Interrupted native task" }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue.id, issueId: issue.id,
      contextSnapshot: { issueId: issue.id } }).where(eq(heartbeatRuns.id, f.run.id));
    Object.assign(f.run, await read(f.run.id));
    const native = await prepareNativeHeartbeatRun({ db, run: f.run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issue.id));
    const binding = { companyId: f.run.companyId, runId: f.run.id, issueId: issue.id, agentId: f.agent.id, executionWorkspaceId: f.run.id };
    const execution = { schema: "paperclip.native-execution-input.v1", binding,
      provider: { kind: "codex", model: "test-model" },
      task: { identifier: issue.id, title: issue.title, description: null, prompt: "Complete the task.", workMode: "standard" },
      workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue, { revision: contract.revision }) },
      interactionResponses: [], credentialBindings: [] };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, f.run.id));
    return { issue, native, binding, execution };
  }

  it.each(["completeRun", "failRun"] as const)("settles the outgoing agent after a case handoff in %s", async operation => {
    const f = await fixture();
    await db.update(agents).set({ status: "running", lifecycleState: "ready" }).where(eq(agents.id, f.agent.id));
    const [recipient] = await db.insert(agents).values({ companyId: f.agent.companyId, name: "Next phase", adapterType: "process" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: f.agent.companyId, title: "Case task", status: "in_progress", assigneeAgentId: f.agent.id }).returning();
    const [record] = await db.insert(cases).values({ companyId: f.agent.companyId, caseNumber: 1, identifier: "CASE-1", caseType: "work", title: issue.title, workIssueId: issue.id, handoffVersion: 1 }).returning();
    await db.insert(caseHandoffs).values({ companyId: f.agent.companyId, caseId: record.id, issueId: issue.id, version: 1,
      fromAgentId: f.agent.id, toAgentId: recipient.id, phase: "verification", instructions: "Verify the saved work",
      actorType: "agent", actorId: f.agent.id, sourceRunId: f.run.id, wakeupRequestId: randomUUID(), idempotencyKey: "next-phase", inputFingerprint: "next-phase", state: "awaiting_release" });
    f.input.issueId = issue.id;
    f.input.issueRef = issue;
    f.deps.finalizeAgentStatus.mockImplementation(createHeartbeatAgentStatus(db).finalizeAgentStatus);

    if (operation === "completeRun") await f.completion.completeRun(f.input);
    else await f.completion.failRun(f.failure(new Error("Provider exited after the accepted handoff")));

    const [settledAgent] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
    expect(settledAgent).toMatchObject({ status: operation === "completeRun" ? "idle" : "error", lastHeartbeatAt: expect.any(Date) });
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledOnce();
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), { suppressImmediateRecovery: true });
    expect(f.deps.handleSuccessfulRunHandoff).not.toHaveBeenCalled();
    expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0]?.status).toBe("in_progress");
  });

  it("persists usage, accounting, final logs, presentation and the next task session", async () => {
    const f = await fixture();
    await f.completion.completeRun(f.input);
    expect(await read(f.run.id)).toMatchObject({ status: "succeeded", sessionIdAfter: "provider-session", logBytes: 123, logSha256: "log-hash", logCompressed: true, stdoutExcerpt: "answer", costAccountingPending: false, costAccountedAt: expect.any(Date), usageJson: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 8, usageSource: "per_run", configFreshness: { version: 1 } }, resultJson: { presentationDecision: { commentAction: "none" } } });
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id))).toHaveLength(1);
    expect((await f.deps.getTaskSession(f.agent.companyId, f.agent.id, f.agent.adapterType, "completion-task"))?.sessionDisplayId).toBe("provider-session");
    expect(f.input.output.outputProgressState.pending?.bytes).toBe(123);
    expect(f.input.onProviderTraceFinalized).toHaveBeenCalledOnce();
    expect(f.deps.setWakeupStatus).toHaveBeenCalledWith(f.wake.id, "completed", expect.any(Object));
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledOnce();
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledWith(f.agent.id, "succeeded", null, expect.any(Object));
  });

  // A chat turn can finish while its task keeps waiting: a resubmitted hire
  // approval, an execution stage or a dependency blocker holds the status.
  // The accepted final answer must still reach the conversation. Only a card
  // the run itself left pending in the thread presents the turn instead.
  it.each([
    { hold: "pending approval", reasonCode: "governed_response_waiting", replies: true },
    { hold: "approval sent back for revision", reasonCode: "governed_response_waiting", replies: true },
    { hold: "execution stage", reasonCode: "governed_response_waiting", replies: true },
    { hold: "dependency blocker", reasonCode: "durable_dependency_blocker_bound", replies: true },
    { hold: "finished turn", reasonCode: "conversation_turn_finished", replies: true },
    { hold: "own question card", reasonCode: "governed_response_waiting", replies: false },
    { hold: "execution stage and own question card", reasonCode: "governed_response_waiting", replies: false },
    // A card the board addressed to someone else holds the task, but this run
    // did not create it, so it cannot be the turn's response.
    { hold: "someone else's confirmation card", reasonCode: "governed_response_waiting", replies: true },
    { hold: "earlier turn's question card", reasonCode: "governed_response_waiting", replies: true },
  ] as const)("posts a waiting conversation turn's accepted answer: $hold", async ({ hold, reasonCode, replies }) => {
    const f = await fixture({ runtimeMode: "native" }, `CNV${randomUUID().slice(0, 6)}`);
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Chat with CEO",
      status: "in_progress", assigneeAgentId: f.agent.id, responsibleUserId: "local-board",
      conversationAgentId: f.agent.id, conversationUserId: "local-board", conversationState: "active",
      ...(hold.startsWith("execution stage") ? { executionState: { status: "pending" } } : {}),
    }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue.id, responsibleUserId: "local-board",
      contextSnapshot: { issueId: issue.id, conversationSessionGeneration: 0 } }).where(eq(heartbeatRuns.id, f.run.id));
    if (hold.includes("approval")) {
      const [approval] = await db.insert(approvals).values({ companyId: f.run.companyId, type: "hire_agent",
        status: hold === "pending approval" ? "pending" : "revision_requested", payload: { name: "Researcher" } }).returning();
      await db.insert(issueApprovals).values({ companyId: f.run.companyId, issueId: issue.id, approvalId: approval.id });
    }
    if (hold.endsWith("own question card")) {
      await issueThreadInteractionService(db).create(issue, { kind: "ask_user_questions", sourceRunId: f.run.id,
        continuationPolicy: "wake_assignee", payload: { version: 1, questions: [{ id: "model", prompt: "Which model?",
          selectionMode: "single", required: true, options: [{ id: "flash", label: "Flash" }] }] } },
        { agentId: f.agent.id, runId: f.run.id });
    }
    if (hold === "someone else's confirmation card") {
      // Saved as the board's create route saves it: no source run.
      await db.insert(issueThreadInteractions).values({ companyId: f.run.companyId, issueId: issue.id,
        kind: "request_confirmation", status: "pending", continuationPolicy: "none", title: "Riley's website proposal",
        requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only", resolverPolicyProvenance: "explicit",
        addresseeUserId: "riley", createdByUserId: "local-board",
        payload: { version: 1, prompt: "Riley: approve creating the website implementation task?" } });
    }
    if (hold === "earlier turn's question card") {
      const [earlier] = await db.insert(heartbeatRuns).values({ companyId: f.run.companyId, agentId: f.agent.id,
        status: "succeeded", runtimeMode: "native", responsibleUserId: "local-board" }).returning();
      await issueThreadInteractionService(db).create(issue, { kind: "request_confirmation", sourceRunId: earlier.id,
        resolverPolicy: "human_only", continuationPolicy: "wake_assignee",
        payload: { version: 1, prompt: "Create the website implementation task?" } },
        { agentId: f.agent.id, runId: earlier.id });
    }
    const answer = "Resubmitted the hire with the cheaper model. [Review the pending approval](/CNV/approvals/a1).";
    f.input.issueId = issue.id;
    f.input.issueRef = issue;
    f.input.issueContext = await createHeartbeatRunPreparation(db).getIssueExecutionContext(f.run.companyId, issue.id);
    // The finalizer's saved shape, unchanged from the previous release.
    f.input.adapterResult.resultJson = {
      nativeResult: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded",
        summary: "Waiting for the approval decision.",
        continuation: { kind: "response_wake", summary: "Wait for the decision.", idempotencyKey: "hire-wait" } },
      finalizationPhase: "committed", finalizationReasonCode: reasonCode,
    };
    f.deps.findLatestCompletedFinalAgentMessage.mockResolvedValue({ seq: 1, text: answer, sourceEventId: "final-event", channel: "final",
      reasonCode: "latest_non_empty_completed_final_agent_message" });
    f.deps.issuesSvc.addComment.mockImplementation(async (issueId, body) => {
      const [comment] = await db.insert(issueComments).values({ companyId: f.run.companyId, issueId,
        authorAgentId: f.agent.id, authorType: "agent", createdByRunId: f.run.id, body }).returning();
      return { ...comment, authorType: "agent" as const };
    });

    await f.completion.completeRun(f.input);

    const posted = (await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id)))
      .filter(comment => comment.createdByRunId === f.run.id);
    expect(posted.map(comment => comment.body)).toEqual(replies ? [answer] : []);
    expect((await read(f.run.id)).resultJson).toMatchObject({ presentationDecision: replies
      ? { chosenSource: "final_agent_message", commentAction: "create", commentId: posted[0]?.id }
      : { chosenSource: "none", commentAction: "none" } });
    // The posted answer (or the run's own card) is the turn's response: the
    // conversation waits for the person.
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0].conversationState).toBe("waiting");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  // dl-n5-cont (Paul NOTE 5; gate 1 run 00e31d20): a chat turn that streamed
  // items 0001-0262 and then FAILED at the output cap posted nothing. A failed
  // run's streamed prefix is its reply: posted once, before any continuation.
  it.each([true, false])("dl-n5-cont posts a failed chat turn's streamed prefix once (streamed answer: %s)", async (streamed) => {
    const f = await fixture({ runtimeMode: "native" }, `CUT${randomUUID().slice(0, 5)}`);
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Chat with CEO",
      status: "in_progress", assigneeAgentId: f.agent.id, responsibleUserId: "local-board",
      conversationAgentId: f.agent.id, conversationUserId: "local-board", conversationState: "active" }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue.id, responsibleUserId: "local-board",
      contextSnapshot: { issueId: issue.id, conversationSessionGeneration: 0 } }).where(eq(heartbeatRuns.id, f.run.id));
    f.input.issueId = issue.id;
    f.input.issueRef = issue;
    f.input.issueContext = await createHeartbeatRunPreparation(db).getIssueExecutionContext(f.run.companyId, issue.id);
    f.input.adapterResult = { ...f.input.adapterResult, exitCode: 1, errorCode: "pi_output_truncated",
      errorMessage: "Pi's final assistant response reached its output limit.", resultJson: {} };
    const item = (n: number) => `Item ${String(n).padStart(4, "0")}: ${"body text of this numbered item; ".repeat(7)}\n`;
    const prefix = Array.from({ length: 262 }, (_, i) => item(i + 1)).join("");
    const turnId = "turn-1", itemId = "turn-1:pi-message:2:block:0";
    const rows = [
      ...(streamed ? [{ seq: 1, payload: { prpEvent: { eventType: "item.delta", itemId, turnId, payload: { kind: "agentMessage", text: prefix } } } }] : []),
      { seq: 2, payload: { prpEvent: { eventType: "turn.failed", turnId, payload: { error: { code: "pi_output_truncated" } } } } },
    ];
    const { readFailedTurnStreamedAnswer } = await import("../heartbeat-run-summary.js");
    f.deps.findLatestCompletedFinalAgentMessage.mockResolvedValue(readFailedTurnStreamedAnswer(rows)?.candidate ?? null);
    f.deps.issuesSvc.addComment.mockImplementation(async (issueId, body) => {
      const [comment] = await db.insert(issueComments).values({ companyId: f.run.companyId, issueId,
        authorAgentId: f.agent.id, authorType: "agent", createdByRunId: f.run.id, body }).returning();
      return { ...comment, authorType: "agent" as const };
    });

    await f.completion.completeRun(f.input);

    const posted = (await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id)))
      .filter(comment => comment.createdByRunId === f.run.id);
    expect((await read(f.run.id)).status).toBe("failed");
    if (!streamed) {
      // Nothing streamed: no reply here; the unanswered-message notice stays the true note.
      expect(posted).toHaveLength(0);
      return;
    }
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body.startsWith(prefix)).toBe(true);
    expect(posted[0]!.body.slice(prefix.length)).toMatch(/output limit/u);
    expect(posted[0]!.body).not.toMatch(/wasn't answered|Sending it again is safe/u);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  // H5: exercise stored pi_rpc events -> real candidate selection -> successful
  // completion -> real comment service -> PostgreSQL read-back (not mock bodies).
  const h5Answer = "0123456789abcdef\n".repeat(Math.ceil(300 * 1024 / 17)).slice(0, 300 * 1024);
  it.each([
    { storage: "intact", name: "300 KiB intact", answer: h5Answer },
    { storage: "rebuilt", name: "300 KiB rebuilt", answer: h5Answer },
    { storage: "projected", name: "300 KiB projector preview", answer: h5Answer },
    { storage: "intact", name: "under limit unchanged", answer: "  A complete short answer.\n\n" },
    { storage: "intact", name: "exactly at limit", answer: "x".repeat(250 * 1024) },
    { storage: "intact", name: "multi-byte boundary", answer: "😀漢é".repeat(40_000) },
    { storage: "rebuilt", name: "code fence spanning boundary", answer: `\`\`\`ts\n${h5Answer}\n\`\`\`\n`, fence: "```", opening: "```ts" },
    { storage: "intact", name: "tilde fence spanning boundary", answer: `~~~~js\n${h5Answer}\n~~~~\n`, fence: "~~~~", opening: "~~~~js" },
  ])("H5 completed final $name posts whole in ordered parts", async ({ storage, answer, name, fence, opening }) => {
    const f = await fixture({ runtimeMode: "native" }, `H5${randomUUID().slice(0, 5)}`, true);
    await db.insert(authUsers).values({ id: "local-board", name: "Board", email: "h5-board@example.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Chat with CEO",
      status: "in_progress", assigneeAgentId: f.agent.id, responsibleUserId: "local-board",
      conversationAgentId: f.agent.id, conversationUserId: "local-board", conversationState: "active" }).returning();
    await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc" } }).where(eq(agents.id, f.agent.id));
    await db.update(heartbeatRuns).set({ nativeIssueId: issue.id, responsibleUserId: "local-board",
      contextSnapshot: { issueId: issue.id, conversationSessionGeneration: 0 } }).where(eq(heartbeatRuns.id, f.run.id));
    f.input.issueId = issue.id;
    f.input.issueRef = issue;
    f.input.issueContext = await createHeartbeatRunPreparation(db).getIssueExecutionContext(f.run.companyId, issue.id);
    f.input.adapterResult.resultJson = { nativeResult: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Short summary must not replace the answer." } };
    f.deps.issuesSvc.addComment.mockImplementation(issueService(db).addComment);
    const turnId = `runner:${f.run.id}:turn-1`, itemId = `${turnId}:pi-message:2:block:0`;
    const base = { companyId: f.run.companyId, runId: f.run.id, agentId: f.agent.id, stream: "system", level: "info", message: "e" };
    const events: (typeof heartbeatRunEvents.$inferInsert)[] = [];
    let seq = 1;
    for (let offset = 0; offset < answer.length;) {
      let end = Math.min(answer.length, offset + 4_001);
      if (end < answer.length && /[\uD800-\uDBFF]/u.test(answer[end - 1]!)) end--;
      events.push({ ...base, seq: seq++, eventType: "item.delta",
        payload: { prpEvent: { eventType: "item.delta", itemId, turnId, payload: { kind: "agentMessage", channel: "progress", text: answer.slice(offset, end) } } } });
      offset = end;
    }
    events.push({ ...base, seq: seq++, eventType: "item.completed", payload: { prpEvent: { eventType: "item.completed", itemId, turnId,
      payload: storage === "intact" ? { kind: "agentMessage", channel: "final", text: answer }
        : storage === "projected" ? { kind: "agentMessage", channel: "final", text: `This answer is longer than one message (308 KB). The full text is kept; ask me to show any part.\n\nExcerpt (the start of the answer, not the whole answer):\n\n${answer.slice(0, 16 * 1024)}`,
          fullText: { path: "/runner-private/spill.txt", sha256: createHash("sha256").update(answer).digest("hex"), bytes: Buffer.byteLength(answer) } }
        : { truncated: true, byteSize: Buffer.byteLength(answer) } } } });
    events.push({ ...base, seq: seq++, eventType: "turn.completed", payload: { prpEvent: { eventType: "turn.completed", turnId, payload: {} } } });
    await db.insert(heartbeatRunEvents).values(events);
    await db.update(heartbeatRuns).set({ nextEventSeq: seq }).where(eq(heartbeatRuns.id, f.run.id));
    await f.completion.completeRun(f.input);
    const posted = await db.select().from(issueComments).where(and(eq(issueComments.issueId, issue.id), eq(issueComments.createdByRunId, f.run.id)))
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id));
    if (process.env.H5_EVIDENCE_DIR) {
      const evidenceDir = join(process.env.H5_EVIDENCE_DIR, name.replaceAll(" ", "-"));
      await fs.mkdir(evidenceDir, { recursive: true });
      for (const [i, comment] of posted.entries()) await fs.writeFile(join(evidenceDir, `part-${i + 1}.txt`), comment.body);
    }
    expect((await read(f.run.id)).status).toBe("succeeded");
    expect(f.input.onLog).not.toHaveBeenCalledWith("stderr", expect.stringContaining("Failed to resolve run presentation"));
    const multiple = Buffer.byteLength(answer) > 250 * 1024;
    if (multiple) expect(posted.length).toBeGreaterThan(1);
    else expect(posted).toHaveLength(1);
    const payloads = posted.map((comment, i) => {
      expect(comment.body.startsWith(`part ${i + 1} of ${posted.length}\n`)).toBe(multiple);
      expect(Buffer.byteLength(comment.body)).toBeLessThanOrEqual(250 * 1024);
      expect(comment.body).not.toContain("The full text is kept");
      expect(Buffer.from(comment.body).toString("utf8")).toBe(comment.body);
      let payload = comment.body.replace(/^part \d+ of \d+\n/u, "");
      if (fence) {
        // Each code part renders independently. Discard only the known
        // synthetic fence wrappers to recover the byte-identical source.
        expect(payload.startsWith(`${opening}\n`)).toBe(true);
        expect(payload.trimEnd().endsWith(fence)).toBe(true);
        if (i > 0) payload = payload.slice(opening!.length + 1);
        if (i < posted.length - 1) payload = payload.slice(0, -(fence.length + 1));
      }
      return payload;
    });
    if (process.env.H5_EVIDENCE_DIR) {
      const evidenceDir = join(process.env.H5_EVIDENCE_DIR, name.replaceAll(" ", "-"));
      await fs.mkdir(evidenceDir, { recursive: true });
      await fs.writeFile(join(evidenceDir, "stored-answer.txt"), answer);
      await fs.writeFile(join(evidenceDir, "receipt.json"), JSON.stringify({ storage, name, status: (await read(f.run.id)).status,
        answerBytes: Buffer.byteLength(answer), answerSha256: createHash("sha256").update(answer).digest("hex"),
        comments: posted.map(comment => ({ id: comment.id, bytes: Buffer.byteLength(comment.body), createdAt: comment.createdAt,
          sha256: createHash("sha256").update(comment.body).digest("hex") })),
        reconstructedSha256: createHash("sha256").update(payloads.join("")).digest("hex") }, null, 2));
    }
    const storedDeltas = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.run.id), eq(heartbeatRunEvents.eventType, "item.delta"))).orderBy(asc(heartbeatRunEvents.seq));
    const storedAnswer = storedDeltas.map(row => (row.payload as { prpEvent: { payload: { text: string } } }).prpEvent.payload.text).join("");
    expect(Buffer.from(payloads.join("")).equals(Buffer.from(storedAnswer))).toBe(true);
    // A replay of the same final must reuse the durable receipt, not any part.
    await issueService(db).addComment(issue.id, storedAnswer, { agentId: f.agent.id, runId: f.run.id }, { completionReply: true });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).toHaveLength(posted.length);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  // dl-n5-cont3 F1 + F4 (judge rf-2): at 300 KiB the person saw a 16 KB
  // excerpt while the continuation quoted the end of the FULL prefix. The
  // "whole once" check now reads the POSTED comments back from the DB: the
  // first reply holds the whole prefix, the quoted ending is that reply's
  // ending, and the replies together hold every item exactly once, in order.
  it("dl-n5-cont3 F1/F4 RED: a 300 KiB cut answer is posted whole; the posted comments hold the answer once, in order", async () => {
    const f = await fixture({ runtimeMode: "native" }, `CUT${randomUUID().slice(0, 5)}`);
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Chat with CEO",
      status: "in_progress", assigneeAgentId: f.agent.id, responsibleUserId: "local-board",
      conversationAgentId: f.agent.id, conversationUserId: "local-board", conversationState: "active" }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue.id, responsibleUserId: "local-board",
      contextSnapshot: { issueId: issue.id, conversationSessionGeneration: 0 } }).where(eq(heartbeatRuns.id, f.run.id));
    f.input.issueId = issue.id;
    f.input.issueRef = issue;
    f.input.issueContext = await createHeartbeatRunPreparation(db).getIssueExecutionContext(f.run.companyId, issue.id);
    f.input.adapterResult = { ...f.input.adapterResult, exitCode: 1, errorCode: "pi_output_truncated",
      errorMessage: "Pi's final assistant response reached its output limit.", resultJson: {} };
    const item = (n: number) => `Item ${String(n).padStart(4, "0")}: ${"body text of this numbered item; ".repeat(7)}\n`;
    const whole = Array.from({ length: 1_500 }, (_, i) => item(i + 1)).join("");
    const streamed = 1_300;
    const prefix = Array.from({ length: streamed }, (_, i) => item(i + 1)).join("");
    expect(Buffer.byteLength(prefix)).toBeGreaterThan(300 * 1024);
    const turnId = "turn-1", itemId = "turn-1:pi-message:2:block:0";
    const rows: { seq: number; payload: unknown }[] = [];
    let seq = 1;
    for (let offset = 0; offset < prefix.length; offset += 4_001) rows.push({ seq: seq++, payload: { prpEvent: { eventType: "item.delta",
      itemId, turnId, payload: { kind: "agentMessage", channel: "progress", text: prefix.slice(offset, offset + 4_001) } } } });
    rows.push({ seq: seq++, payload: { prpEvent: { eventType: "turn.failed", turnId, payload: { error: { code: "pi_output_truncated" } } } } });
    const { readFailedTurnStreamedAnswer, cutAnswerContinuationInstruction } = await import("../heartbeat-run-summary.js");
    const cut = readFailedTurnStreamedAnswer(rows)!;
    f.deps.findLatestCompletedFinalAgentMessage.mockResolvedValue(cut.candidate);
    f.deps.issuesSvc.addComment.mockImplementation(async (issueId, body) => {
      const [comment] = await db.insert(issueComments).values({ companyId: f.run.companyId, issueId,
        authorAgentId: f.agent.id, authorType: "agent", createdByRunId: f.run.id, body }).returning();
      return { ...comment, authorType: "agent" as const };
    });

    await f.completion.completeRun(f.input);

    const postedByRun = (await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id)))
      .filter(comment => comment.createdByRunId === f.run.id);
    expect(postedByRun).toHaveLength(1);
    const NOTE = /\n+— The answer stopped here because it hit the model's output limit\. Paperclip is continuing it from exactly this point in the next reply\.$/u;
    expect(postedByRun[0]!.body).toMatch(NOTE);
    const shown = postedByRun[0]!.body.replace(NOTE, "\n");
    expect(shown).toBe(prefix);
    // The continuation is told an ending the person really saw.
    const instruction = cutAnswerContinuationInstruction({ text: cut.text, cause: cut.cause, posted: true });
    const quoted = /<<<END OF POSTED TEXT\n([\s\S]*)\nEND OF POSTED TEXT>>>/u.exec(instruction)![1]!;
    expect(shown.endsWith(quoted)).toBe(true);
    // A continuation that follows it posts the rest from the next words after that ending.
    await db.insert(issueComments).values({ companyId: f.run.companyId, issueId: issue.id, authorAgentId: f.agent.id,
      authorType: "agent", body: whole.slice(whole.indexOf(quoted) + quoted.length), createdAt: new Date(Date.now() + 60_000) });
    const replies = (await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id))).filter(comment => comment.authorAgentId === f.agent.id);
    const answer = replies.map(comment => comment.body.replace(NOTE, "\n")).join("");
    expect(answer).toBe(whole);
    for (const n of [1, 700, streamed, streamed + 1, 1_500]) expect(answer.split(item(n)).length - 1).toBe(1);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  // dl-n5-cont4 (judge rf-2 'JUDGE real DB completion D-completed-first', 3x5):
  // a failed turn whose FIRST answer item completed and whose SECOND item only
  // streamed. The real lifecycle selection (no mock) returned the completed item
  // first, so item B was lost, and the recovery opening then said none of the
  // answer was shown. The run's events are real DB rows; the posted comments
  // are read back from the DB.
  // dl-n5-cont5: `message`/`block` place the item at '<turn>:pi-message:N:block:M'
  // (default: message index+1, block 0); `kind` is its agent-message spelling.
  type AnswerItem = { text: string; completed: boolean; message?: number; block?: number; kind?: "agentMessage" | "assistant_message" };
  async function failedTurnRealCompletion(items: AnswerItem[], terminal: "turn.failed" | "turn.completed" = "turn.failed", realAddComment = false) {
    const f = await fixture({ runtimeMode: "native" }, `CF${randomUUID().slice(0, 5)}`, true);
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Chat with CEO",
      status: "in_progress", assigneeAgentId: f.agent.id, responsibleUserId: "local-board",
      conversationAgentId: f.agent.id, conversationUserId: "local-board", conversationState: "active" }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue.id, responsibleUserId: "local-board",
      contextSnapshot: { issueId: issue.id, conversationSessionGeneration: 0 } }).where(eq(heartbeatRuns.id, f.run.id));
    f.input.issueId = issue.id;
    f.input.issueRef = issue;
    f.input.issueContext = await createHeartbeatRunPreparation(db).getIssueExecutionContext(f.run.companyId, issue.id);
    f.input.adapterResult = terminal === "turn.failed"
      ? { ...f.input.adapterResult, exitCode: 1, errorCode: "pi_output_truncated",
        errorMessage: "Pi's final assistant response reached its output limit.", resultJson: {} }
      : { ...f.input.adapterResult, resultJson: {} };
    const turnId = `runner-1:${f.run.id}:turn-1`;
    const base = { companyId: f.run.companyId, runId: f.run.id, agentId: f.agent.id, stream: "system", level: "info", message: "e" };
    const events: (typeof heartbeatRunEvents.$inferInsert)[] = [];
    let seq = 1 + Number((await db.select({ max: sql<number>`coalesce(max(${heartbeatRunEvents.seq}), 0)` }).from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, f.run.id)))[0]!.max);
    items.forEach((item, index) => {
      const itemId = `${turnId}:pi-message:${item.message ?? index + 1}:block:${item.block ?? 0}`;
      const kind = item.kind ?? "agentMessage";
      for (let offset = 0; offset < item.text.length; offset += 1_009) events.push({ ...base, seq: seq++, eventType: "item.delta",
        payload: { prpEvent: { eventType: "item.delta", itemId, turnId,
          payload: { kind, channel: "final", text: item.text.slice(offset, offset + 1_009) } } } });
      if (item.completed) events.push({ ...base, seq: seq++, eventType: "item.completed",
        payload: { prpEvent: { eventType: "item.completed", itemId, turnId,
          payload: { kind, channel: "final", text: item.text } } } });
    });
    events.push({ ...base, seq: seq++, eventType: terminal, payload: { prpEvent: { eventType: terminal, turnId,
      payload: terminal === "turn.failed" ? { error: { code: "pi_output_truncated" } } : {} } } });
    await db.insert(heartbeatRunEvents).values(events);
    await db.update(heartbeatRuns).set({ nextEventSeq: seq }).where(eq(heartbeatRuns.id, f.run.id));
    f.deps.issuesSvc.addComment.mockImplementation(async (issueId, body) => {
      const [comment] = await db.insert(issueComments).values({ companyId: f.run.companyId, issueId,
        authorAgentId: f.agent.id, authorType: "agent", createdByRunId: f.run.id, body }).returning();
      return { ...comment, authorType: "agent" as const };
    });
    // H5 round 2: through the REAL addComment (its multipart path), not a direct insert.
    if (realAddComment) f.deps.issuesSvc.addComment.mockImplementation(issueService(db).addComment);
    await f.completion.completeRun(f.input);
    const posted = (await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))
      .orderBy(asc(issueComments.createdAt), asc(issueComments.id))).filter(comment => comment.createdByRunId === f.run.id);
    return { f, issue, posted };
  }
  const CUT_NOTE = /\n+— The answer stopped here because it hit the model's output limit\. Paperclip is continuing it from exactly this point in the next reply\.$/u;
  const answerItem = (label: string, bytes: number) => {
    const line = (n: number) => `${label} line ${String(n).padStart(4, "0")}: ${"text of this answer item; ".repeat(3)}\n`;
    let text = "";
    for (let n = 1; Buffer.byteLength(text) < bytes; n++) text += line(n);
    return text;
  };
  const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
  async function recoveryOpening(runId: string, companyId: string) {
    const { readSourceRunCutAnswer } = await import("../fresh-continuation-fallback.js");
    const { cutAnswerContinuationInstruction } = await import("../heartbeat-run-summary.js");
    const cut = await readSourceRunCutAnswer(db, { id: runId, companyId });
    if (!cut || "thinkingOnlyCapStop" in cut) throw new Error("expected a cut answer");
    return { cut, opening: cutAnswerContinuationInstruction(cut) };
  }

  // H5 round 2 (review-fleet-2 F1/F2/F3): a multipart answer is ONE logical
  // response. Everything below posts through the REAL addComment into real
  // Postgres and reads back through the real lifecycle findRunIssueComment and
  // the real resolver; no comment row is inserted directly.
  async function chatRunForReply() {
    const f = await fixture({ runtimeMode: "native" }, `WP${randomUUID().slice(0, 5)}`, true);
    await db.insert(authUsers).values({ id: "local-board", name: "Board", email: "wp-board@example.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Chat with CEO",
      status: "in_progress", assigneeAgentId: f.agent.id, responsibleUserId: "local-board",
      conversationAgentId: f.agent.id, conversationUserId: "local-board", conversationState: "active" }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue.id, responsibleUserId: "local-board",
      contextSnapshot: { issueId: issue.id, conversationSessionGeneration: 0 } }).where(eq(heartbeatRuns.id, f.run.id));
    const post = (body: string, completionReply = true) =>
      issueService(db).addComment(issue.id, body, { agentId: f.agent.id, runId: f.run.id }, { completionReply });
    // The task-run REPLY: findRunIssueComment (descending) -> the resolver.
    const reply = async () => {
      const comment = await f.deps.findRunIssueComment(f.run.id, f.run.companyId, issue.id, {});
      const { resolveHeartbeatRunResponse } = await import("../heartbeat-run-summary.js");
      return { comment, resolved: resolveHeartbeatRunResponse({ resultJson: {}, existingComment: comment }) };
    };
    const rows = () => db.select().from(issueComments).where(and(eq(issueComments.issueId, issue.id),
      eq(issueComments.createdByRunId, f.run.id))).orderBy(asc(issueComments.createdAt), asc(issueComments.id));
    return { f, issue, post, reply, rows };
  }
  const probeAnswer = (bytes: number) => {
    let text = "";
    for (let n = 1; Buffer.byteLength(text) < bytes; n++) text += `Line ${String(n).padStart(6, "0")} of the long answer — détails ✓\n`;
    return text;
  };
  const sameBytes = (a: string | null | undefined, b: string) => Buffer.from(a ?? "").equals(Buffer.from(b));

  it.each([
    { name: "300 KiB", answer: probeAnswer(300 * 1024) },
    { name: "1 MiB", answer: probeAnswer(1024 * 1024) },
    { name: "code fence spanning a part boundary", answer: `Intro\n\n\`\`\`ts\n${probeAnswer(300 * 1024)}\`\`\`\n\nAfter the fence.\n` },
  ])("PROBE task-run reply must be whole: $name via the real addComment", async ({ answer }) => {
    const { post, reply, rows } = await chatRunForReply();
    const receipt = await post(answer);
    const posted = await rows();
    expect(posted.length).toBeGreaterThan(1);
    // F1 first: the task-run reply is the WHOLE answer, not its last part.
    const { comment, resolved } = await reply();
    expect(Buffer.byteLength(resolved.text ?? "")).toBe(Buffer.byteLength(answer));
    expect(sameBytes(resolved.text, answer)).toBe(true);
    // addComment: first part keeps the single-comment shape; ordered receipt of ALL parts.
    expect(receipt.id).toBe(posted[0]!.id);
    expect(receipt.answerPartCommentIds).toEqual(posted.map(row => row.id));
    for (const [i, row] of posted.entries()) {
      expect(row.body.startsWith(`part ${i + 1} of ${posted.length}\n`)).toBe(true);
      expect(row.metadata?.answerPart).toMatchObject({ index: i + 1, count: posted.length, answerId: posted[0]!.metadata!.answerPart!.answerId });
    }
    expect(comment!.id).toBe(posted[0]!.id);
    expect(comment!.answerPartCommentIds).toEqual(posted.map(row => row.id));
    expect(sameBytes(comment!.body, answer)).toBe(true);
    expect(resolved.decision.commentAction).toBe("reuse");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it.each(["case", "numbers", "unknown label", "wrapper"])(
    "rf-2 (c): a damaged %s never makes the last physical part the reply", async (damage) => {
      const answer = `\`\`\`ts\n${probeAnswer(300 * 1024)}\`\`\`\ntail\n`;
      const { post, reply, rows } = await chatRunForReply();
      await post(answer);
      const posted = await rows();
      const first = posted[0]!;
      const part = first.metadata!.answerPart!;
      const body = damage === "case" ? first.body.replace(/^part /u, "pArt ")
        : damage === "numbers" ? first.body.replace(/^part \d+ of \d+/u, "part 999 of 1000")
        : damage === "unknown label" ? `edited label\n${first.body.slice(part.label.length)}`
        : `${first.body.slice(0, -part.suffix.length)}damaged closing wrapper`;
      await db.update(issueComments).set({ body }).where(eq(issueComments.id, first.id));
      const { comment, resolved } = await reply();
      const expected = damage === "case" || damage === "numbers" ? answer
        : (await rows()).map(row => row.body).join("");
      expect(sameBytes(resolved.text, expected)).toBe(true);
      expect(comment!.id).toBe(first.id);
      expect(comment!.answerPartCommentIds).toEqual(posted.map(row => row.id));
      expect(resolved.text).not.toBe(posted.at(-1)!.body);
    }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it.each(["missing", "duplicate", "soft-deleted", "invalid index"])(
    "rf-2: a %s answer part resolves to C1, never one physical part", async (damage) => {
      const { post, reply, rows } = await chatRunForReply();
      await post(probeAnswer(300 * 1024));
      const posted = await rows();
      expect(posted).toHaveLength(2);
      const first = posted[0]!;
      if (damage === "missing") {
        await db.delete(issueComments).where(eq(issueComments.id, first.id));
      } else if (damage === "soft-deleted") {
        await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, first.id));
      } else {
        const metadata = first.metadata!;
        await db.update(issueComments).set({ metadata: { ...metadata,
          answerPart: { ...metadata.answerPart!, index: damage === "duplicate" ? 2 : 0 },
        } }).where(eq(issueComments.id, first.id));
      }
      const { comment, resolved } = await reply();
      const { TRUNCATED_FINAL_UNDELIVERABLE_TEXT } = await import("../heartbeat-run-summary.js");
      expect(comment!.body).toBe(TRUNCATED_FINAL_UNDELIVERABLE_TEXT);
      expect(resolved.text).toBe(TRUNCATED_FINAL_UNDELIVERABLE_TEXT);
      expect(comment).not.toHaveProperty("answerPartCommentIds");
      expect(resolved.text).not.toBe(posted[1]!.body);
    }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  );

  it("F3: with the recorded wrappers, a fence spanning a boundary strips back to the source, byte-equal", async () => {
    const answer = `\`\`\`ts\n${probeAnswer(300 * 1024)}\`\`\`\ntail\n`;
    const { post, rows } = await chatRunForReply();
    await post(answer);
    const posted = await rows();
    expect(posted.length).toBeGreaterThan(1);
    // Each part renders on its own: a closing fence is added to part 1 and a reopening to part 2.
    expect(posted[0]!.metadata!.answerPart!.suffix).toBe("\n```");
    expect(posted[1]!.metadata!.answerPart!.prefix).toBe("```ts\n");
    const stripped = posted.map(row => {
      const part = row.metadata!.answerPart!;
      expect(row.body.startsWith(`${part.label}${part.prefix}`) && row.body.endsWith(part.suffix)).toBe(true);
      return row.body.slice(part.label.length + part.prefix.length, row.body.length - part.suffix.length);
    }).join("");
    expect(sameBytes(stripped, answer)).toBe(true);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("control: a single comment under the limit is unchanged everywhere", async () => {
    const { post, reply, rows } = await chatRunForReply();
    const answer = "  A complete short answer.\n\n";
    const receipt = await post(answer);
    const posted = await rows();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toBe(answer);
    expect(posted[0]!.metadata?.answerPart).toBeUndefined();
    expect(receipt.answerPartCommentIds).toBeUndefined();
    const { comment, resolved } = await reply();
    expect({ id: comment!.id, body: comment!.body }).toEqual({ id: posted[0]!.id, body: answer });
    expect(comment).not.toHaveProperty("answerPartCommentIds");
    expect(resolved.text).toBe(answer);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("control: a run with no answer is unchanged", async () => {
    const { reply } = await chatRunForReply();
    const { comment, resolved } = await reply();
    expect(comment).toBeNull();
    expect(resolved.text).toBeNull();
    expect(resolved.decision.reasonCodes).toContain("no_user_facing_response");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("control: an older single-comment answer then a newer multipart one: the reply is the newer one, whole", async () => {
    const { post, reply, rows } = await chatRunForReply();
    await post("An older, short reply.\n", false);
    const answer = probeAnswer(300 * 1024);
    await post(answer);
    const posted = await rows();
    expect(posted[0]!.body).toBe("An older, short reply.\n");
    const { comment, resolved } = await reply();
    expect(sameBytes(resolved.text, answer)).toBe(true);
    expect(comment!.id).toBe(posted[1]!.id);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("F2 RED: a failed 300 KiB prefix posted in parts is recognised as posted; the opening quotes its really posted ending", async () => {
    const A = answerItem("A", 300 * 1024);
    const { f, posted } = await failedTurnRealCompletion([{ text: A, completed: false }], "turn.failed", true);
    expect(posted.length).toBeGreaterThan(1);
    expect(posted[0]!.body.startsWith(`part 1 of ${posted.length}\n`)).toBe(true);
    // F2 first: the continuation must know the prefix WAS posted.
    const { cut, opening } = await recoveryOpening(f.run.id, f.run.companyId);
    expect(cut.posted).toBe(true);
    const shownWhole = posted.map(row => {
      const part = row.metadata!.answerPart!;
      return row.body.slice(part.label.length + part.prefix.length, row.body.length - part.suffix.length);
    }).join("");
    expect(shownWhole).toMatch(CUT_NOTE);
    expect(sameBytes(shownWhole.replace(CUT_NOTE, "\n"), A)).toBe(true);
    expect(cut).not.toHaveProperty("partial");
    expect(opening).not.toMatch(/none of it was shown|starting the answer again/u);
    expect(opening).toContain("was posted to the person");
    const quoted = /<<<END OF POSTED TEXT\n([\s\S]*)\nEND OF POSTED TEXT>>>/u.exec(opening)![1]!;
    expect(quoted.length).toBeGreaterThan(100);
    // The quoted ending is really posted: it is the end of the LAST part's content.
    expect(A.endsWith(quoted)).toBe(true);
    expect(posted[posted.length - 1]!.body).toContain(quoted);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("dl-n5-cont4 RED (JUDGE real DB completion D-completed-first): A completed + B streamed, the turn failed: A then B posted whole, each once; the opening quotes the real posted ending", async () => {
    const A = answerItem("A", 2 * 1024), B = answerItem("B", 20 * 1024);
    // dl-n5-cont5 (RFL ruling 17:47Z): A and B are text blocks of the LAST message.
    const { f, posted } = await failedTurnRealCompletion([{ text: A, completed: true, message: 2, block: 0 },
      { text: B, completed: false, message: 2, block: 1 }]);
    expect((await read(f.run.id)).status).toBe("failed");
    const bodies = posted.map(comment => comment.body);
    const all = bodies.join("");
    expect(occurrences(all, A)).toBe(1);
    expect(occurrences(all, B)).toBe(1);
    expect(all.indexOf(A)).toBeLessThan(all.indexOf(B));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!).toMatch(CUT_NOTE);
    const shown = bodies[0]!.replace(CUT_NOTE, "\n");
    expect(shown).toBe(`${A}\n${B}`);
    const { cut, opening } = await recoveryOpening(f.run.id, f.run.companyId);
    expect(cut.posted).toBe(true);
    expect(opening).not.toMatch(/none of it was shown|starting the answer again/u);
    expect(opening).toContain("was posted to the person");
    const quoted = /<<<END OF POSTED TEXT\n([\s\S]*)\nEND OF POSTED TEXT>>>/u.exec(opening)![1]!;
    expect(quoted.length).toBeGreaterThan(100);
    expect(shown.endsWith(quoted)).toBe(true);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("dl-n5-cont4 (2): when only item A was really posted, the opening says A was shown, quotes A's posted ending, never 'none of it was shown'", async () => {
    const A = answerItem("A", 2 * 1024), B = answerItem("B", 20 * 1024);
    const { f, issue, posted } = await failedTurnRealCompletion([{ text: A, completed: true, message: 2, block: 0 },
      { text: B, completed: false, message: 2, block: 1 }]);
    // What an older server (073f4a4f) really posted for this turn: item A alone.
    await db.delete(issueComments).where(eq(issueComments.issueId, issue.id));
    await db.insert(issueComments).values({ companyId: f.run.companyId, issueId: issue.id, authorAgentId: f.agent.id,
      authorType: "agent", createdByRunId: f.run.id, body: A });
    expect(posted.length).toBeGreaterThan(0);
    const { cut, opening } = await recoveryOpening(f.run.id, f.run.companyId);
    expect(cut.posted).toBe(true);
    expect(cut.text).toBe(A);
    expect(opening).toContain("Only the first part of what you had written was posted to the person");
    expect(opening).not.toMatch(/none of it was shown|starting the answer again/u);
    const quoted = /<<<END OF POSTED TEXT\n([\s\S]*)\nEND OF POSTED TEXT>>>/u.exec(opening)![1]!;
    expect(A.endsWith(quoted)).toBe(true);
    expect(B).not.toContain(quoted);
    // Nothing of this run posted: the opening truthfully says none was shown.
    await db.delete(issueComments).where(eq(issueComments.issueId, issue.id));
    const none = await recoveryOpening(f.run.id, f.run.companyId);
    expect(none.cut.posted).toBe(false);
    expect(none.opening).toMatch(/none of it was shown/u);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("dl-n5-cont4 control: a successful turn with completed items posts the latest completed item, unchanged", async () => {
    const A = answerItem("A", 2 * 1024), B = answerItem("B", 3 * 1024);
    const { f, posted } = await failedTurnRealCompletion([{ text: A, completed: true }, { text: B, completed: true }], "turn.completed");
    expect((await read(f.run.id)).status).toBe("succeeded");
    expect(posted.map(comment => comment.body)).toEqual([B]);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("dl-n5-cont4 control: a streamed-only failed turn is cont3's F1 path, unchanged", async () => {
    const B = answerItem("B", 20 * 1024);
    const { posted } = await failedTurnRealCompletion([{ text: B, completed: false }]);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toMatch(CUT_NOTE);
    expect(posted[0]!.body.replace(CUT_NOTE, "\n")).toBe(B);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("dl-n5-cont4 control: two completed items plus a third streamed: all three posted, in order, each once", async () => {
    const A = answerItem("A", 2 * 1024), A2 = answerItem("A2", 4 * 1024), C = answerItem("C", 12 * 1024);
    const { f, posted } = await failedTurnRealCompletion([{ text: A, completed: true, message: 2, block: 0 },
      { text: A2, completed: true, message: 2, block: 1 }, { text: C, completed: false, message: 2, block: 2 }]);
    expect(posted).toHaveLength(1);
    const shown = posted[0]!.body.replace(CUT_NOTE, "\n");
    expect(shown).toBe(`${A}\n${A2}\n${C}`);
    for (const piece of [A, A2, C]) expect(occurrences(shown, piece)).toBe(1);
    const { cut, opening } = await recoveryOpening(f.run.id, f.run.companyId);
    expect(cut.posted).toBe(true);
    const quoted = /<<<END OF POSTED TEXT\n([\s\S]*)\nEND OF POSTED TEXT>>>/u.exec(opening)![1]!;
    expect(shown.endsWith(quoted)).toBe(true);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  // dl-n5-cont5 (rf-2 cont4 verdict; RFL ruling 17:47Z): THE ANSWER is every
  // text block of the LAST assistant message, in block order, completed or
  // streamed, posted whole once, on the completed AND the failed path.
  const lastBlock = "Short closing block of the same final message, 53 B.\n";
  it("dl-n5-cont5 (i) RED: last message with 2 completed text blocks, turn COMPLETED: both blocks posted, in order", async () => {
    const A = answerItem("A", 2_072);
    const { f, posted } = await failedTurnRealCompletion([{ text: A, completed: true, message: 2, block: 0 },
      { text: lastBlock, completed: true, message: 2, block: 1 }], "turn.completed");
    expect((await read(f.run.id)).status).toBe("succeeded");
    expect(posted.map(comment => comment.body)).toEqual([`${A}\n${lastBlock}`]);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it.each([false, true])("dl-n5-cont5 (ii) RED: the same, turn FAILED: both blocks posted, the cut tail (streamed tail: %s), ONE true note", async (tail) => {
    const A = answerItem("A", 2_072), C = answerItem("C", 6 * 1024);
    const { f, posted } = await failedTurnRealCompletion([{ text: A, completed: true, message: 2, block: 0 },
      { text: lastBlock, completed: true, message: 2, block: 1 }, ...(tail ? [{ text: C, completed: false, message: 2, block: 2 }] : [])]);
    expect((await read(f.run.id)).status).toBe("failed");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toMatch(CUT_NOTE);
    expect(occurrences(posted[0]!.body, "— The answer stopped here")).toBe(1);
    expect(posted[0]!.body.replace(CUT_NOTE, "\n")).toBe(tail ? `${A}\n${lastBlock}\n${C}` : `${A}\n${lastBlock}`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it.each([true, false])("dl-n5-cont5 (iii) RED: 2 items in DIFFERENT messages (last completed: %s), turn failed: only the last message is posted, with ONE note; the earlier one stays in the transcript", async (lastCompleted) => {
    const commentary = answerItem("Commentary", 2_072), B = answerItem("B", 3 * 1024);
    const { f, posted } = await failedTurnRealCompletion([{ text: commentary, completed: true, message: 1, block: 0 },
      { text: B, completed: lastCompleted, message: 3, block: 0 }]);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toMatch(CUT_NOTE);
    expect(posted[0]!.body.replace(CUT_NOTE, "\n")).toBe(B);
    expect(occurrences(posted[0]!.body, commentary)).toBe(0);
    const transcript = (await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.run.id),
      eq(heartbeatRunEvents.eventType, "item.completed")))).map(row => (row.payload as { prpEvent: { payload: { text: string } } }).prpEvent.payload.text);
    expect(transcript).toContain(commentary);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("dl-n5-cont5 (iv) RED: a streamed 'assistant_message' item is rebuilt and posted", async () => {
    const B = answerItem("B", 8 * 1024);
    const { posted } = await failedTurnRealCompletion([{ text: B, completed: false, kind: "assistant_message" }]);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toMatch(CUT_NOTE);
    expect(posted[0]!.body.replace(CUT_NOTE, "\n")).toBe(B);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it.each(["one block", "two blocks"] as const)("dl-n5-cont5 (v) RED: a posted ending that differs only by a trailing newline is recognised as shown (%s)", async (shape) => {
    const A = answerItem("A", 2 * 1024), B = answerItem("B", 6 * 1024);
    const items = shape === "one block" ? [{ text: B, completed: false }]
      : [{ text: A, completed: true, message: 2, block: 0 }, { text: B, completed: false, message: 2, block: 1 }];
    const { f, issue } = await failedTurnRealCompletion(items);
    const answer = shape === "one block" ? B : `${A}\n${B}`;
    // What was really posted: the answer whose trailing newline was dropped.
    await db.delete(issueComments).where(eq(issueComments.issueId, issue.id));
    await db.insert(issueComments).values({ companyId: f.run.companyId, issueId: issue.id, authorAgentId: f.agent.id,
      authorType: "agent", createdByRunId: f.run.id, body: answer.trimEnd() });
    const { cut, opening } = await recoveryOpening(f.run.id, f.run.companyId);
    expect(cut.posted).toBe(true);
    expect(cut.partial).toBeUndefined();
    expect(cut.text).toBe(answer);
    expect(opening).not.toMatch(/none of it was shown|starting the answer again|Only the first part/u);
    expect(opening).toContain("was posted to the person as your reply, exactly as written");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  // Gate 3, run f5c33c68 (stack-lane/): the native result was accepted at
  // precommit (seq 234, yielded/response_wake), the live finalizer found the
  // finalization lease busy (server log 09:10:51.013), the commit worker then
  // committed conversation_turn_finished (09:10:51.112), and only after that
  // did the live path resolve its presentation (seq 250, 09:10:51.185) from
  // the precommit fields it had read. The final reply (seq 228) must still be
  // published once, from the committed state; the run's own open question card
  // (SMA-627) still owns its turn.
  async function leaseBusyConversationTurn(shape: "gate3" | "own open card" | "SMA-627" | "lease free") {
    const f = await fixture({ runtimeMode: "native" }, `LB${randomUUID().slice(0, 6)}`, true);
    const userId = `gate3-${randomUUID()}`, sessionId = randomUUID(), runnerId = randomUUID(), turnId = "pi-turn-4d6e60de";
    await db.insert(authUsers).values({ id: userId, name: "Conversation owner", email: `${userId}@example.test`,
      createdAt: new Date("2020-01-01T00:00:00Z"), updatedAt: new Date("2020-01-01T00:00:00Z") });
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Chat with TEST PS1-S2p-fg-2",
      status: "in_progress", assigneeAgentId: f.agent.id, responsibleUserId: userId, executionRunId: f.run.id,
      conversationAgentId: f.agent.id, conversationUserId: userId, conversationState: "active", conversationSessionGeneration: 0 }).returning();
    const [contract] = await db.insert(completionContracts).values({ companyId: f.run.companyId, issueId: issue.id, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { revision: "2", objective: "Answer the person", criteria: [] },
      canonicalSha256: "gate3-conversation-contract", createdByActorType: "system", createdByActorId: "test" }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue.id, nativeSessionId: sessionId, runnerInstanceId: runnerId,
      completionContractId: contract.id, completionContractSha256: contract.canonicalSha256, responsibleUserId: userId,
      contextSnapshot: { issueId: issue.id, source: "execution.reconciled", wakeReason: "issue_recovery_action_restored",
        conversationSessionGeneration: 0 } }).where(eq(heartbeatRuns.id, f.run.id));
    if (shape === "own open card" || shape === "SMA-627") await db.insert(issueThreadInteractions).values({ companyId: f.run.companyId, issueId: issue.id,
      kind: "ask_user_questions", status: "pending", sourceRunId: f.run.id, createdByAgentId: f.agent.id,
      payload: { version: 1, questions: [{ id: "continue", prompt: "Repeat the 3 facts when I continue?",
        selectionMode: "single", required: true, options: [{ id: "yes", label: "Yes: repeat the 3 facts" }] }] } });
    // seq 228: the final agentMessage.
    const answer = "The foreground sleep completed. The question key was rejected as already used. I'm parked and waiting for you.";
    // SMA-627 (7b5cc899) parked on its own pending card with no agentMessage.
    if (shape !== "SMA-627") await appendHeartbeatRunEvent(db, { companyId: f.run.companyId, runId: f.run.id, agentId: f.agent.id, eventType: "item.completed",
      payload: { prpEvent: { runId: f.run.id, normalizedSessionId: sessionId, turnId, schema: "paperclip.prp.event.v1",
        itemId: `${turnId}:pi-message:3:block:0`, sourceEventId: "gate3-final-228",
        payload: { kind: "agentMessage", channel: "final", text: answer } } } });
    // seq 234/236: run.result.accepted + run.terminal, precommit.
    const result = { schema: "paperclip.run_result.v1" as const, reportedWorkDisposition: "yielded" as const,
      summary: "TEST PS1-S2p-fg-2 result: I sent both calls together in one response, but only one of them succeeded.",
      continuation: { kind: "response_wake" as const, idempotencyKey: "PS1-S2p-fg-2-park-response-wake",
        summary: "Parked waiting for the person's answer or next message; on wake, repeat the three seeded facts immediately without tools." },
      completionClaim: { contractRevision: "2", objectiveSatisfied: true, criteria: [], remainingWork: [] },
      evidence: [], verification: [], attentionRequests: [], artifacts: [] };
    const terminal = { schema: "paperclip.prp.terminal.v1" as const, runTerminalState: "succeeded" as const,
      turnTerminalState: "completed" as const, reportedWorkDisposition: "yielded" as const };
    await new NativeRunCoordinatorStore(db, { companyId: f.run.companyId, issueId: issue.id, runId: f.run.id, agentId: f.agent.id,
      normalizedSessionId: sessionId, runnerSourceInstanceId: runnerId, completionContractId: contract.id,
      completionContractSha256: contract.canonicalSha256, completionContractRevision: "2", completionContractCriterionIds: [] })
      .completeRun({ result, terminal, turnId });
    const finalization = () => db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id)).then(rows => rows[0]!);
    expect((await finalization()).phase).not.toBe("committed");
    if (shape !== "lease free") {
      // 09:10:51.013: native_finalization_lease_busy; the live finalizer defers.
      await db.update(nativeRunFinalizations).set({ leaseOwner: "native-finalizer:commit-worker",
        leaseExpiresAt: new Date(Date.now() + 5 * 60_000) }).where(eq(nativeRunFinalizations.runId, f.run.id));
      await expect(finalizeNativeRun({ db, runId: f.run.id, workspaceFinalizeStatus: "succeeded" }))
        .rejects.toBeInstanceOf(NativeFinalizationDeferredError);
    } else {
      await finalizeNativeRun({ db, runId: f.run.id, workspaceFinalizeStatus: "succeeded", projectRunStatus: false });
    }
    f.input.issueId = issue.id;
    f.input.issueRef = issue;
    f.input.issueContext = await createHeartbeatRunPreparation(db).getIssueExecutionContext(f.run.companyId, issue.id);
    f.input.adapterResult.resultJson = { stopReason: "completed", nativeResult: result, nativeTerminal: terminal };
    f.input.adapterResult.nativeFinalization = { schema: "paperclip.native-finalization.v1", runtimeMode: "native", runId: f.run.id,
      companyId: f.run.companyId, issueId: issue.id, result, terminal, turnId, sourceInstanceId: runnerId, normalizedSessionId: sessionId,
      providerSessionId: "provider-session", driverKind: "pi_rpc", driverVersion: "phase6-v1", nativeEventCount: 1,
      highestContiguousSourceSeq: 1, workspaceFinalizeStatus: "succeeded" };
    // 09:10:51.112: the lease holder (the result-commit worker) commits after
    // the live terminal write and before the live presentation.
    if (shape !== "lease free") f.deps.classifyAndPersistRunLiveness.mockImplementationOnce(async run => {
      await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, f.run.id));
      await finalizeNativeRun({ db, runId: f.run.id, workspaceFinalizeStatus: "succeeded", projectRunStatus: true,
        onlyWhenDue: true, skipNativeResponsePresentation: true, skipNativeReviewResponse: true });
      return run;
    });
    f.deps.issuesSvc.addComment.mockImplementation(async (issueId, body) => {
      const [comment] = await db.insert(issueComments).values({ companyId: f.run.companyId, issueId, body,
        authorType: "agent", authorAgentId: f.agent.id, createdByRunId: f.run.id }).returning();
      return { ...comment, authorType: "agent" as const };
    });
    await f.completion.completeRun(f.input);
    expect((await finalization()).phase).toBe("committed");
    // The presentation worker, woken by the commit, resolves from committed state.
    const scope = { companyId: f.run.companyId, issueId: issue.id };
    const publish = async () => {
      const work = nativeResponsePresentationWork(db), entries = await work.load(scope);
      for (const entry of entries) await work.check(entry);
      await recoverCommittedNativeChatResponse(db, { ...scope, runId: f.run.id });
      return entries.map(entry => entry.id);
    };
    const posted = () => db.select().from(issueComments).where(and(eq(issueComments.issueId, issue.id), eq(issueComments.createdByRunId, f.run.id)));
    return { f, issue, answer, publish, posted };
  }

  it("publishes a lease-busy conversation turn's final reply once from its committed state (gate 3 f5c33c68)", async () => {
    const { f, answer, publish, posted } = await leaseBusyConversationTurn("gate3");
    const run = await read(f.run.id);
    expect(run.status).toBe("succeeded");
    expect(run.resultJson).toMatchObject({ finalizationPhase: "committed", finalizationReasonCode: "conversation_turn_finished" });
    // seq 250: the live path resolved from precommit fields, as on gate 3.
    expect(run.resultJson?.presentationDecision).toMatchObject({ chosenSource: "none", commentAction: "none", commentId: null,
      reasonCodes: expect.arrayContaining(["interaction_owns_conversation_response"]) });
    // The pending publication is a presentation-worker candidate.
    expect(await publish()).toEqual([f.run.id]);
    expect((await posted()).map(comment => comment.body)).toEqual([answer]);
    expect((await read(f.run.id)).resultJson?.presentationDecision).toMatchObject({
      chosenSource: "final_agent_message", commentAction: "create", commentId: (await posted())[0]?.id });
    expect(await publish()).toEqual([]);
    await f.completion.completeRun(f.input).catch(() => undefined);
    expect(await posted()).toHaveLength(1);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it.each(["own open card", "SMA-627"] as const)("keeps a run's own open question card's park under a busy finalization lease: %s", async shape => {
    const { f, publish, posted } = await leaseBusyConversationTurn(shape);
    await publish();
    expect(await posted()).toEqual([]);
    expect((await read(f.run.id)).resultJson?.presentationDecision).toMatchObject({ chosenSource: "none", commentAction: "none" });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("publishes a committed conversation turn's final reply once when the lease is free", async () => {
    const { f, answer, publish, posted } = await leaseBusyConversationTurn("lease free");
    expect((await posted()).map(comment => comment.body)).toEqual([answer]);
    await publish();
    expect(await posted()).toHaveLength(1);
    expect((await read(f.run.id)).resultJson?.presentationDecision).toMatchObject({ chosenSource: "final_agent_message", commentAction: "create" });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("settles the accepted native exact rate-card price without replacing it with zero", async () => {
    const f = await fixture({ runtimeMode: "native" });
    const runnerInstanceId = randomUUID();
    const delivery = await createNativeUsageDelivery(db, { companyId: f.run.companyId, runId: f.run.id, runnerInstanceId,
      provider: { kind: "codex", model: "gpt-6.1-sol" }, billing: { provider: "openai", biller: "openai", billingType: "metered_api" } });
    const event = (sourceSeq: number, eventType: string, payload: Record<string, unknown>): PrpEvent => ({
      sourceKind: "runner", sourceInstanceId: runnerInstanceId, runId: f.run.id, sourceSeq, sourceEventId: `rate-card-${sourceSeq}`,
      turnId: "price-turn", eventType, emittedAt: new Date().toISOString(), payload,
    } as PrpEvent);
    await delivery.capture(event(1, "usage.reported", { runDeltaBasis: "run", runDeltaAvailable: true,
      runDelta: { inputTokens: 1000, outputTokens: 100000, providerCostUsd: 0 } }));
    await delivery.capture(event(2, "turn.completed", {}));
    const accepted = await usageReceipts.readAcceptedRunUsageCheckpoint(db, { companyId: f.run.companyId, runId: f.run.id });
    expect(accepted?.costStatus).toBe("estimated");
    const exact = accepted!.costUsdExact;
    f.input.adapterResult = { exitCode: 0, signal: null, timedOut: false, ...accepted, usageComplete: accepted!.complete };
    await f.completion.completeRun(f.input);
    const saved = await read(f.run.id);
    expect(saved).toMatchObject({ status: "succeeded", costAccountingPending: false, costAccountedAt: expect.any(Date),
      usageJson: { costUsdExact: exact, costStatus: "estimated" } });
    const ledger = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].costCents).toBe(100.2);
  });

  it("retains newer accepted native usage when completion consumed an older receipt", async () => {
    const f = await fixture({ runtimeMode: "native", usageJson: { sessionRotated: true, configFreshness: { version: 0 } } });
    const runnerInstanceId = randomUUID();
    const delivery = await createNativeUsageDelivery(db, { companyId: f.run.companyId, runId: f.run.id, runnerInstanceId,
      provider: { kind: "codex", model: "test-model" }, billing: { provider: "openai", biller: "openai", billingType: "metered_api" } });
    const event = (sourceSeq: number, eventType: string, inputTokens = 100): PrpEvent => ({
      sourceInstanceId: runnerInstanceId, runId: f.run.id, sourceSeq, sourceEventId: `racing-${sourceSeq}`, turnId: "turn-1",
      emittedAt: new Date().toISOString(), eventType, payload: eventType === "usage.reported"
        ? { runDeltaBasis: "run", runDeltaAvailable: true, runDelta: { inputTokens, outputTokens: 10, providerCostUsd: inputTokens / 1000 } } : {},
    } as PrpEvent);
    await delivery.capture(event(1, "usage.reported"));
    await delivery.capture(event(2, "turn.completed"));
    const acceptedA = await usageReceipts.readAcceptedRunUsageCheckpoint(db, { companyId: f.run.companyId, runId: f.run.id });
    await delivery.capture(event(3, "usage.reported", 120));
    f.input.adapterResult = { exitCode: 0, signal: null, timedOut: false, ...acceptedA, usageComplete: acceptedA!.complete };
    await f.completion.completeRun(f.input);
    expect(await read(f.run.id)).toMatchObject({ status: "succeeded", costAccountingPending: true, costAccountedAt: null,
      usageJson: { inputTokens: 120, costUsd: 0.12, accountingReceiptSequence: 3, accountingReceiptReady: false, sessionRotated: false, configFreshness: { version: 1 } } });
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id))).toHaveLength(0);
    await delivery.capture(event(4, "turn.completed", 120));
    expect(await (await import("../run-cost-accounting.js")).accountRunCost(db, f.run.id)).toBe(true);
    const ledger = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].costCents).toBe(12);
  });

  it.each([
    { timedOut: true, expected: "timed_out", errorCode: "timeout" },
    { signal: "SIGTERM", expected: "failed", errorCode: "adapter_failed" },
    { errorMessage: "provider quota", errorCode: "provider_quota", expected: "failed" },
  ])("keeps adapter outcome classification ($expected, $errorCode)", async ({ expected, ...result }) => {
    const f = await fixture();
    Object.assign(f.input.adapterResult, result);
    await f.completion.completeRun(f.input);
    expect(await read(f.run.id)).toMatchObject({ status: expected, errorCode: result.errorCode });
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledWith(f.agent.id, expected, expect.any(String), expect.objectContaining({ keepIdleOnFailure: result.errorCode === "provider_quota" }));
  });

  it.each(["completeRun", "failRun"] as const)("waits for an owned Stop before %s can write a competing outcome", async operation => {
    const f = await fixture();
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    f.deps.processRunCancellationSettlements.set(f.run.id, { settled, failed: false });
    const completion = operation === "completeRun" ? f.completion.completeRun(f.input) : f.completion.failRun(f.failure(new Error("late adapter error")));
    await Promise.resolve();
    expect(f.deps.setRunStatusIfRunning).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    f.controller.abort();
    settle();
    await completion;
    expect((await read(f.run.id)).status).toBe("cancelled");
    if (operation === "completeRun") {
      expect((await read(f.run.id)).sessionIdAfter).toBe("provider-session");
      expect(f.deps.finalizeAgentStatus).toHaveBeenCalledWith(f.agent.id, "cancelled", expect.any(String), expect.any(Object));
    } else expect(f.deps.finalizeAgentStatus).not.toHaveBeenCalled();
  });

  it.each(["completeRun", "failRun"] as const)("finalizes the run log in %s only after a reattach's deferred log recovery settles", async operation => {
    const f = await fixture();
    let finishRecovery!: () => void;
    const recovery = new Promise<void>(resolve => { finishRecovery = resolve; });
    let recovered = false;
    const output = { ...f.input.output, settleDeferredLogRecovery: () => recovery.then(() => { recovered = true; }) };
    const finalizedAfterRecovery: boolean[] = [];
    f.deps.runLogStore.finalize.mockImplementation(async () => {
      finalizedAfterRecovery.push(recovered);
      return { bytes: 123, sha256: "log-hash", compressed: true };
    });
    const completion = operation === "completeRun" ? f.completion.completeRun({ ...f.input, output })
      : f.completion.failRun({ ...f.failure(new Error("reattach preparation failed")), output });
    await new Promise(resolve => setTimeout(resolve, 50));
    const finalizedEarly = f.deps.runLogStore.finalize.mock.calls.length;
    finishRecovery();
    await completion;
    expect(finalizedEarly).toBe(0);
    expect(finalizedAfterRecovery).toEqual([true]);
  });

  it("attributes an adapter stop caused by a lost controller lease", async () => {
    const f = await fixture();
    Object.assign(f.input.adapterResult, { exitCode: null, errorCode: "cancelled", errorMessage: "Grok execution was cancelled" });
    f.controller.abort(new LegacyControllerLeaseLostError("renewal_deadline"));
    await f.completion.completeRun(f.input);
    expect(await read(f.run.id)).toMatchObject({ status: "cancelled", resultJson: { cancellation: {
      source: "controller_lease", expected: false, initiator: { type: "system" }, reason: "Legacy controller lease lost (renewal_deadline)" } } });
  });

  it("attributes a lost controller lease when the adapter throws the abort reason", async () => {
    const f = await fixture();
    f.controller.abort(new LegacyControllerLeaseLostError("renewal_rejected"));
    await f.completion.failRun(f.failure(f.controller.signal.reason));
    expect(await read(f.run.id)).toMatchObject({ status: "cancelled", resultJson: {
      workspaceRestoreFailure: { reason: "missing_base" },
      cancellation: { source: "controller_lease", expected: false, reason: "Legacy controller lease lost (renewal_rejected)" } } });
  });

  it("records the watchdog timings with a lease loss that stops the adapter", async () => {
    const f = await fixture();
    Object.assign(f.input.adapterResult, { exitCode: null, errorCode: "cancelled", errorMessage: "Grok execution was cancelled" });
    f.controller.abort(new LegacyControllerLeaseLostError("renewal_deadline",
      { sinceRenewalMs: 61_000, renewalPendingMs: 58_000, deadlineLateMs: 2, renewalCount: 41 }));
    await f.completion.completeRun(f.input);
    expect((await read(f.run.id)).resultJson).toMatchObject({ controllerLeaseLoss: {
      cause: "renewal_deadline", sinceRenewalMs: 61_000, renewalPendingMs: 58_000, deadlineLateMs: 2, renewalCount: 41 } });
  });

  it("records the lease-loss cause and timings when setup fails on the abort reason", async () => {
    const f = await fixture();
    f.controller.abort(new LegacyControllerLeaseLostError("renewal_deadline",
      { sinceRenewalMs: 60_004, renewalPendingMs: null, deadlineLateMs: 55_000, renewalCount: 3 }));
    await f.completion.failRunSetup(f.setup(f.controller.signal.reason));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "controller_lease_lost", resultJson: {
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      controllerLeaseLoss: { cause: "renewal_deadline", sinceRenewalMs: 60_004, renewalPendingMs: null,
        deadlineLateMs: 55_000, renewalCount: 3 } } });
  });

  it("keeps a stop requested before the lease loss when the adapter throws", async () => {
    const f = await fixture();
    const requested = requestedRunCancellation({ cancelledByActorType: "user", cancelledByUserId: "operator-1" }, "Stopped from the board");
    await db.update(heartbeatRuns).set({ resultJson: { cancellation: requested } }).where(eq(heartbeatRuns.id, f.run.id));
    f.controller.abort(new LegacyControllerLeaseLostError("renewal_error"));
    await f.completion.failRun(f.failure(f.controller.signal.reason));
    expect(await read(f.run.id)).toMatchObject({ status: "cancelled", resultJson: { cancellation: {
      source: "operator", expected: true, initiator: { type: "user", id: "operator-1" }, reason: "Stopped from the board" } } });
  });

  it("does not publish or overwrite a conflicting terminal transition that wins the compare-and-set", async () => {
    const f = await fixture();
    const write = f.deps.setRunStatusIfRunning.getMockImplementation()!;
    f.deps.setRunStatusIfRunning.mockImplementationOnce(async (...args) => {
      await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled", resultJson: { winner: "Stop" } }).where(eq(heartbeatRuns.id, f.run.id));
      return write(...args);
    });
    await f.completion.completeRun(f.input);
    expect(await read(f.run.id)).toMatchObject({ status: "cancelled", resultJson: { winner: "Stop" }, sessionIdAfter: null });
    expect(f.deps.setWakeupStatus).not.toHaveBeenCalled();
    expect(f.deps.updateRuntimeState).not.toHaveBeenCalled();
    expect(f.deps.releaseIssueExecutionAndPromote).not.toHaveBeenCalled();
    expect(f.deps.finalizeAgentStatus).not.toHaveBeenCalled();
  });

  it("retains native completion metadata when reconciliation already committed the same terminal status", async () => {
    const finishedAt = new Date("2026-10-09T12:00:00Z");
    const f = await fixture({ runtimeMode: "native", status: "succeeded", finishedAt, resultJson: { durable: "accepted" }, usageJson: { durableReceipt: "native" } });
    await db.update(agents).set({ adapterType: "paperclip_runner" }).where(eq(agents.id, f.agent.id));
    f.agent.adapterType = "paperclip_runner";
    f.input.sessionCodec = getAdapterSessionCodec(f.agent.adapterType);
    const nativeSessionId = randomUUID(), providerSessionId = randomUUID();
    f.input.adapterResult.sessionId = nativeSessionId;
    delete f.input.adapterResult.sessionParams;
    f.input.adapterResult.sessionDisplayId = providerSessionId;
    f.input.adapterResult.nativeFinalization = { schema: "paperclip.native-finalization.v1", runtimeMode: "native", runId: f.run.id, companyId: f.run.companyId, issueId: "unused", result: {}, terminal: { schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "done" }, turnId: null, sourceInstanceId: "test", normalizedSessionId: nativeSessionId, providerSessionId, driverKind: "test", driverVersion: "1", nativeEventCount: 1, highestContiguousSourceSeq: 1, workspaceFinalizeStatus: "succeeded" };
    await f.completion.completeRun(f.input);
    expect(await read(f.run.id)).toMatchObject({ status: "succeeded", finishedAt, sessionIdAfter: providerSessionId, resultJson: { durable: "accepted" }, usageJson: { durableReceipt: "native", inputTokens: 20 } });
    expect(f.deps.updateRuntimeState).toHaveBeenCalledOnce();
  });

  // smarty-dev#21005: the native finalizer commits `succeeded` before the live
  // completion tail runs. If that tail then throws, failRun loses the
  // compare-and-set and used to return without settling the agent, which the
  // native projection never settles either: the agent read `running`.
  it("settles the agent when the live completion fails after the native finalizer committed success", async () => {
    const f = await fixture({ runtimeMode: "native", status: "succeeded", finishedAt: new Date(),
      nativePhase: "committed", resultJson: { finalizationPhase: "committed" } });
    await db.update(agents).set({ adapterType: "paperclip_runner", status: "running", lifecycleState: "ready" })
      .where(eq(agents.id, f.agent.id));
    f.run.runtimeMode = "native";
    await f.completion.failRun(f.failure(new Error("completion tail failed after the native commit")));
    expect(await read(f.run.id)).toMatchObject({ status: "succeeded" });
    const [settled] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
    expect(settled).toMatchObject({ status: "idle", errorReason: null, lastHeartbeatAt: expect.any(Date) });
  });

  it("settles the agent when the live completion loses to the native finalizer's committed success", async () => {
    const f = await fixture({ runtimeMode: "native", status: "succeeded", finishedAt: new Date(),
      nativePhase: "committed", resultJson: { finalizationPhase: "committed" } });
    await db.update(agents).set({ adapterType: "paperclip_runner", status: "running", lifecycleState: "ready" })
      .where(eq(agents.id, f.agent.id));
    f.run.runtimeMode = "native";
    await f.completion.completeRun(f.input);
    expect(await read(f.run.id)).toMatchObject({ status: "succeeded" });
    const [settled] = await db.select().from(agents).where(eq(agents.id, f.agent.id));
    expect(settled).toMatchObject({ status: "idle", errorReason: null, lastHeartbeatAt: expect.any(Date) });
    expect(f.deps.finalizeAgentStatus).not.toHaveBeenCalled();
  });

  it("keeps the committed native finalization record when the stored result is larger than the read projection", async () => {
    const decisionId = randomUUID();
    const diagnostics = randomBytes(120_000).toString("base64");
    const f = await fixture({ runtimeMode: "native", resultJson: { finalizationPhase: "committed",
      finalizationReasonCode: "conversation_turn_finished", decisionId, diagnostics } });
    await db.update(agents).set({ adapterType: "paperclip_runner" }).where(eq(agents.id, f.agent.id));
    f.agent.adapterType = "paperclip_runner";
    f.input.sessionCodec = getAdapterSessionCodec(f.agent.adapterType);
    const nativeSessionId = randomUUID(), providerSessionId = randomUUID();
    f.input.adapterResult.sessionId = nativeSessionId;
    delete f.input.adapterResult.sessionParams;
    f.input.adapterResult.sessionDisplayId = providerSessionId;
    f.input.adapterResult.nativeFinalization = { schema: "paperclip.native-finalization.v1", runtimeMode: "native", runId: f.run.id, companyId: f.run.companyId, issueId: "unused", result: {}, terminal: { schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "yielded" }, turnId: null, sourceInstanceId: "test", normalizedSessionId: nativeSessionId, providerSessionId, driverKind: "test", driverVersion: "1", nativeEventCount: 1, highestContiguousSourceSeq: 1, workspaceFinalizeStatus: "succeeded" };
    expect((await f.deps.getRun(f.run.id))?.resultJson).toMatchObject({ truncated: true });
    await f.completion.completeRun(f.input);
    const completed = await read(f.run.id);
    expect(completed.status).toBe("succeeded");
    expect(completed.resultJson).toMatchObject({ finalizationReasonCode: "conversation_turn_finished", decisionId, diagnostics });
    expect(completed.resultJson).not.toHaveProperty("truncated");
  });

  it("reports trace completion before a later write throws and reads output after log finalization", async () => {
    const f = await fixture();
    let excerpt = "before finalize";
    Object.defineProperty(f.input.output, "stdoutExcerpt", { get: () => excerpt });
    f.deps.runLogStore.finalize.mockImplementationOnce(async () => { excerpt = "last provider output"; return { bytes: 99, compressed: false }; });
    const writeError = new Error("write failed");
    f.deps.setRunStatusIfRunning.mockRejectedValueOnce(writeError);
    await expect(f.completion.completeRun(f.input)).rejects.toBe(writeError);
    expect(f.input.onProviderTraceFinalized).toHaveBeenCalledOnce();
    expect(f.deps.setRunStatusIfRunning).toHaveBeenCalledWith(f.run.id, "succeeded", expect.objectContaining({ stdoutExcerpt: "last provider output", logBytes: 99 }), expect.any(Object));
  });

  it("keeps a failed trace finalization eligible for the executor's cleanup retry", async () => {
    const f = await fixture();
    f.deps.traceStore.finalize.mockRejectedValueOnce(new Error("trace store unavailable"));
    await f.completion.completeRun(f.input);
    expect((await read(f.run.id)).status).toBe("succeeded");
    expect(f.input.onProviderTraceFinalized).not.toHaveBeenCalled();
  });

  it.each([
    { runtimeMode: "native" as const, conversation: true, createsFinal: true },
    { runtimeMode: "native" as const, conversation: false, createsFinal: false },
    { runtimeMode: "legacy" as const, conversation: true, createsFinal: false },
  ])("scopes final-response precedence to native standing conversations: %j", async ({ runtimeMode, conversation, createsFinal }) => {
    const f = await fixture({ runtimeMode });
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Conversation reply",
      ...(conversation ? { assigneeAgentId: f.agent.id, conversationAgentId: f.agent.id,
        conversationUserId: "board-person", conversationState: "active" } : {}),
    }).returning();
    const [earlier] = await db.insert(issueComments).values({ companyId: f.run.companyId, issueId: issue.id,
      authorAgentId: f.agent.id, createdByRunId: f.run.id, body: "Checking the request.",
    }).returning();
    f.input.issueId = issue.id;
    f.input.issueRef = issue;
    f.input.issueContext = await createHeartbeatRunPreparation(db).getIssueExecutionContext(f.run.companyId, issue.id);
    f.input.adapterResult.resultJson = { nativeResult: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "The complete answer" } };
    f.deps.findRunIssueComment.mockResolvedValue(earlier);
    f.deps.issuesSvc.addComment.mockImplementation(async (issueId, body) => {
      const [comment] = await db.insert(issueComments).values({ companyId: f.run.companyId, issueId,
        authorAgentId: f.agent.id, authorType: "agent", createdByRunId: f.run.id, body }).returning();
      return { ...comment, authorType: "agent" as const };
    });
    await f.completion.completeRun(f.input);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id));
    expect(comments.some(comment => comment.id === earlier.id && comment.body === earlier.body)).toBe(true);
    expect(comments.filter(comment => comment.body === "The complete answer")).toHaveLength(createsFinal ? 1 : 0);
    expect((await read(f.run.id)).resultJson).toMatchObject({ presentationDecision: {
      chosenSource: createsFinal ? "semantic_result_summary" : "existing_issue_comment",
      commentAction: createsFinal ? "create" : "reuse",
    } });
  });

  it("keeps completion and session persistence moving after a response comment fails", async () => {
    const f = await fixture();
    f.input.adapterResult.resultJson = { finalResponseDisposition: "final", finalResponse: "Completed the work." };
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Report the result" }).returning();
    f.input.issueId = issue.id;
    f.input.issueRef = issue;
    f.input.issueContext = await createHeartbeatRunPreparation(db).getIssueExecutionContext(f.run.companyId, issue.id);
    f.deps.issuesSvc.addComment.mockRejectedValueOnce(new Error("comment unavailable"));
    await f.completion.completeRun(f.input);
    expect(f.deps.issuesSvc.addComment).toHaveBeenCalledOnce();
    expect(f.input.onLog).toHaveBeenCalledWith("stderr", expect.stringContaining("comment unavailable"));
    expect((await read(f.run.id)).status).toBe("succeeded");
    expect(f.deps.upsertTaskSession).toHaveBeenCalledOnce();
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledOnce();
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledOnce();
  });

  it("clears only the completed task session when the adapter requests a reset", async () => {
    const f = await fixture();
    f.input.adapterResult.clearSession = true;
    await f.completion.completeRun(f.input);
    expect(f.deps.clearTaskSessions).toHaveBeenCalledWith(f.run.companyId, f.agent.id, { taskKey: "completion-task", adapterType: "process", expectedRunId: f.run.id });
    expect(f.deps.upsertTaskSession).not.toHaveBeenCalled();
  });

  it("redacts execution failures, retains restore evidence and resumes the latest checkpoint", async () => {
    const f = await fixture();
    const failure = f.failure(new Error("private-identity-material crashed"));
    failure.goalCheckpointSession.current = { params: { sessionId: "checkpoint" }, displayId: "checkpoint" };
    await f.completion.failRun(failure);
    const run = await read(f.run.id);
    expect(run).toMatchObject({ status: "failed", errorCode: "adapter_failed", logBytes: 123, resultJson: { workspaceRestoreFailure: { reason: "missing_base" } } });
    expect(run.error).not.toContain("private-identity-material");
    expect((await f.deps.getTaskSession(f.agent.companyId, f.agent.id, f.agent.adapterType, "completion-task"))?.sessionDisplayId).toBe("checkpoint");
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledOnce();
  });

  it.each(["execution", "setup"] as const)("retains a provider startup cause at the outer %s settlement boundary", async phase => {
    const f = await fixture();
    const providerFailure = { schema: "paperclip.provider-failure.v1", provider: "anthropic", phase: "startup",
      category: "rate_limit", message: "This request would exceed your account's rate limit.", httpStatus: 429, retryability: "unknown" };
    const error = Object.assign(new Error("PRP command session.open failed"), {
      runnerCommandResult: { result: { code: "command_execution_failed", providerFailure } },
    });
    f.deps.runLogStore.finalize.mockRejectedValueOnce(new Error("secondary log cleanup failure"));
    if (phase === "setup") await f.completion.failRunSetup(f.setup(error));
    else await f.completion.failRun(f.failure(error));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", error: "PRP command session.open failed",
      resultJson: { providerFailure } });
  });

  it.each(["run", "setup", "restore"] as const)("waits a minute and suppresses rapid recovery when %s fails because storage is unavailable (storage chaos ST1)", async phase => {
    const f = await fixture();
    const outage = await withS3FailureDiagnostics("put_object", async () => {
      throw Object.assign(new Error("Injected storage outage"), { name: "ServiceUnavailable",
        $fault: "server", $metadata: { httpStatusCode: 503, attempts: 3 } });
    }).catch(error => error as Error);
    f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "scheduled", run: { id: "wait" } } as never);
    if (phase === "restore") await f.completion.failRunSetup(f.setup(new RemoteWorkspaceRestoreError("snapshot_download", true, outage)));
    else if (phase === "setup") await f.completion.failRunSetup(f.setup(outage));
    else await f.completion.failRun(f.failure(outage));
    const failed = await read(f.run.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: STORAGE_UNAVAILABLE_CODE, error: STORAGE_UNAVAILABLE_MESSAGE });
    expect(failed.error).not.toContain("Injected storage outage");
    expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent, STORAGE_UNAVAILABLE_RETRY);
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }),
      expect.objectContaining({ suppressImmediateRecovery: true }));
    expect(f.deps.scheduleInteractionContinuationInfrastructureRetryIfEligible).not.toHaveBeenCalled();
  });

  it.each(["run", "setup"] as const)("ends the task's automatic recovery once its storage wait is exhausted (%s)", async phase => {
    const f = await fixture();
    const outage = await withS3FailureDiagnostics("put_object", async () => {
      throw Object.assign(new Error("Injected storage outage"), { name: "ServiceUnavailable", $metadata: { httpStatusCode: 503 } });
    }).catch(error => error as Error);
    f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "retry_exhausted", attempt: 11, maxAttempts: 10 } as never);
    if (phase === "setup") await f.completion.failRunSetup(f.setup(outage));
    else await f.completion.failRun(f.failure(outage));
    expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent, STORAGE_UNAVAILABLE_RETRY);
    expect(f.deps.scheduleInteractionContinuationInfrastructureRetryIfEligible).not.toHaveBeenCalled();
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }),
      expect.objectContaining({ suppressImmediateRecovery: true }));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: STORAGE_UNAVAILABLE_CODE,
      error: STORAGE_UNAVAILABLE_EXHAUSTED_MESSAGE });
  });

  // Staging incident shape: a server restart reattached a remote native runner whose turn was
  // still in flight. A storage outage then failed the reattachment, restart
  // recovery kept the workspace under a no-replay hold, and the run reported
  // "Paperclip will retry automatically when storage is back" with no storage
  // wait scheduled. The task sat blocked for 15 hours behind a false promise.
  it.each([
    ["an outage", "ServiceUnavailable", 503, STORAGE_UNAVAILABLE_HELD_MESSAGE],
    ["rejected credentials", "ExpiredToken", 403, STORAGE_CREDENTIALS_REJECTED_HELD_MESSAGE],
  ] as const)("never promises a storage retry when native recovery holds the run after %s", async (_label, name, status, expected) => {
    const f = await fixture({ runtimeMode: "native" });
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Daily staging review",
      assigneeAgentId: f.agent.id, status: "in_progress" }).returning();
    await db.update(agentWakeupRequests).set({ runId: f.run.id, reason: "issue_monitor_due", requestedByActorType: "system" })
      .where(eq(agentWakeupRequests.id, f.wake.id));
    const [run] = await db.update(heartbeatRuns).set({ nativeIssueId: issue.id,
      contextSnapshot: { issueId: issue.id, wakeReason: "issue_monitor_due", wakeSource: "automation" } })
      .where(eq(heartbeatRuns.id, f.run.id)).returning();
    await appendHeartbeatRunEvent(db, { companyId: run.companyId, runId: run.id, agentId: run.agentId,
      eventType: "turn.started", stream: "system", level: "info", message: "Provider turn started" });
    // Restart recovery's workspace preservation already settled the coordinator.
    await db.insert(nativeRunFinalizations).values({ companyId: run.companyId, issueId: issue.id, runId: run.id,
      phase: "terminal_failure", attempt: 1, controllerGeneration: 3, recoveryState: "blocked",
      failureCode: "native_continuation_requires_reconciliation" });
    const outage = await withS3FailureDiagnostics("put_object", async () => {
      throw Object.assign(new Error("Injected storage outage"), { name, $metadata: { httpStatusCode: status, attempts: 3 } });
    }).catch(error => error as Error);
    await f.completion.failRun({ ...f.failure(outage), run, issueId: issue.id, requiredWorkspaceRestoreEvidence: {}, legacyAdapterEntered: false });
    const failed = await read(run.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: "native_continuation_requires_reconciliation", error: expected });
    expect(failed.error).not.toMatch(/retry automatically/i);
    expect(failed.error).toContain("Retry");
    // No storage wait is created for a run native recovery owns: it could only be refused.
    expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
    const events = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "error")));
    expect(events.map(event => event.message)).toEqual([expected]);
  });

  it.each([
    ["run", "not scheduled"], ["setup", "not scheduled"], ["run", "scheduling failed"], ["setup", "scheduling failed"],
  ] as const)("withdraws the storage retry promise when no storage wait could be scheduled (%s, %s)", async (phase, mode) => {
    const f = await fixture();
    const outage = await withS3FailureDiagnostics("put_object", async () => {
      throw Object.assign(new Error("Injected storage outage"), { name: "ServiceUnavailable", $metadata: { httpStatusCode: 503 } });
    }).catch(error => error as Error);
    if (mode === "not scheduled") f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "not_scheduled",
      reason: "Scheduled retry suppressed because the agent is not invokable", errorCode: "agent_not_invokable", issueId: null } as never);
    else f.deps.scheduleBoundedRetryForRun.mockRejectedValueOnce(new Error("retry write failed"));
    if (phase === "setup") await f.completion.failRunSetup(f.setup(outage));
    else await f.completion.failRun(f.failure(outage));
    expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent, STORAGE_UNAVAILABLE_RETRY);
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: STORAGE_UNAVAILABLE_CODE,
      error: STORAGE_UNAVAILABLE_HELD_MESSAGE });
    const events = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.run.id),
      eq(heartbeatRunEvents.eventType, "error")));
    expect(events.map(event => event.message)).toEqual([STORAGE_UNAVAILABLE_HELD_MESSAGE]);
  });

  it.each(["execution", "setup"] as const)("names the nested cause of a generic %s failure and keeps SQL text off the board", async phase => {
    const f = await fixture();
    const logged = vi.spyOn(logger, "error");
    onTestFinished(() => logged.mockRestore());
    const driver = Object.assign(new Error("could not serialize access due to concurrent update"), { code: "40001" });
    const query = new Error('Failed query: update "heartbeat_runs" set "usage_json" = $1 where "id" = $2\nparams: {"apiKey":"sk-live-secret"},run-1',
      { cause: new Error("transaction aborted", { cause: driver }) });
    const error = new Error(`Usage write failed: ${query.message}`, { cause: query });
    if (phase === "setup") await f.completion.failRunSetup(f.setup(error));
    else await f.completion.failRun(f.failure(error));
    const run = await read(f.run.id);
    expect(run).toMatchObject({ status: "failed", errorCode: phase === "setup" ? "setup_failed" : "adapter_failed",
      error: "Usage write failed: Database query failed (40001)", resultJson: { failureCause: "40001" } });
    expect(JSON.stringify(run.resultJson)).not.toMatch(/heartbeat_runs|sk-live-secret|params/);
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ runId: f.run.id, failureCause: "40001" }), expect.any(String));
  });

  it("bounds the failure cause to a closed-shape token and falls back to the error class", async () => {
    const f = await fixture();
    class QueryTimeoutError extends Error { override name = "QueryTimeoutError"; }
    const unsafe = Object.assign(new QueryTimeoutError("timed out"), { code: `${"X".repeat(81)}` },
      { cause: { code: "select * from users" } });
    await f.completion.failRun(f.failure(unsafe));
    expect((await read(f.run.id)).resultJson).toMatchObject({ failureCause: "QueryTimeoutError" });
  });

  it("names why an adapter result failed without a code", async () => {
    const f = await fixture();
    await f.completion.completeRun({ ...f.input, adapterResult: { ...f.input.adapterResult, exitCode: 137, signal: null, errorMessage: null } });
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "adapter_failed", error: "Adapter failed",
      resultJson: { stopReason: "adapter_failed", failureCause: "exit_code_137" } });
  });

  it("keeps SQL text out of a cancelled adapter result's error", async () => {
    const f = await fixture();
    await f.completion.completeRun({ ...f.input, adapterResult: { ...f.input.adapterResult, exitCode: 1,
      errorMessage: 'Failed query: select "secret_value" from x where id = $1\nparams: sk-secret', resultJson: { status: "cancelled" } } });
    const run = await read(f.run.id);
    expect(run.status).toBe("cancelled");
    expect(run.error).toBe("Database query failed");
  });

  it("records no failure cause when the failure already has a named code", async () => {
    const f = await fixture();
    await f.completion.completeRun({ ...f.input, adapterResult: { ...f.input.adapterResult, exitCode: 1, errorCode: "provider_quota", errorMessage: "quota" } });
    const run = await read(f.run.id);
    expect(run.errorCode).toBe("provider_quota");
    expect(run.resultJson).not.toHaveProperty("failureCause");
  });

  it("keeps an ordinary adapter failure on the normal recovery path", async () => {
    const f = await fixture();
    await f.completion.failRun(f.failure(new Error("adapter crashed")));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "adapter_failed" });
    expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }),
      expect.objectContaining({ suppressImmediateRecovery: false }));
  });

  it("still records failure and releases issue ownership when log finalization and progress flushing fail", async () => {
    const f = await fixture();
    f.deps.runLogStore.finalize.mockRejectedValueOnce(new Error("log unavailable"));
    f.input.output.flushOutputProgress = vi.fn(async () => { throw new Error("progress unavailable"); });
    await f.completion.failRun(f.failure(new Error("adapter failed")));
    expect((await read(f.run.id)).status).toBe("failed");
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledOnce();
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledOnce();
  });

  it("keeps durable result-less native failure authoritative and suppresses generic replacement recovery", async () => {
    const f = await fixture({ runtimeMode: "native", status: "failed", errorCode: "native_result_missing" });
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Native recovery" }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue.id }).where(eq(heartbeatRuns.id, f.run.id));
    await db.insert(nativeRunFinalizations).values({ runId: f.run.id, companyId: f.run.companyId, issueId: issue.id, phase: "terminal_failure", failureCode: "native_result_missing" });
    await f.completion.failRun(f.failure(new Error("transport ended")));
    expect((await read(f.run.id)).errorCode).toBe("native_result_missing");
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), { suppressImmediateRecovery: true });
  });

  describe("a same-run exact-checkpoint resume refused before its provider claim", () => {
    const originalMessage = "PRP command turn.start failed: ACPX turn start failed closed: classification=session_resume_required";
    const refusal = "Plugin Runner retained session is not authorized";
    async function resumeClaim(recoveryHistory: Array<Record<string, unknown>>, attempt = 1) {
      const f = await fixture({ runtimeMode: "native" });
      const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Native resume" }).returning();
      await db.update(heartbeatRuns).set({ nativeIssueId: issue.id }).where(eq(heartbeatRuns.id, f.run.id));
      const leaseOwner = `runner:resume:${randomUUID()}`;
      await db.insert(nativeRunFinalizations).values({ runId: f.run.id, companyId: f.run.companyId, issueId: issue.id,
        phase: "observed", attempt, leaseOwner, leaseExpiresAt: new Date(Date.now() + 20 * 60_000), recoveryHistory });
      return { f, issue, leaseOwner, attempt };
    }
    const interruption = { at: "2099-01-01T00:00:00.000Z", disposition: "retryable_failure", reason: "native_session_interrupted",
      providerAttempt: 1, stderrTail: originalMessage, providerSessionEstablished: true, checkpointExists: true };

    it("reports the interrupted first attempt in the terminal error, result and coordinator detail", async () => {
      const { f, leaseOwner, attempt } = await resumeClaim([interruption]);
      await f.completion.failRun(f.failure(new Error(refusal)));
      const expected = `native_session_interrupted: ${originalMessage}; exact checkpoint resume refused: ${refusal}`;
      const failed = await read(f.run.id);
      expect(failed).toMatchObject({ status: "failed", errorCode: "adapter_failed", error: expected });
      expect(failed.resultJson).toMatchObject({ nativeExactResumeRefusal: {
        originalFailureCode: "native_session_interrupted", originalMessage, interruptedAttempt: 1, refusal } });
      const [errorEvent] = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.run.id),
        eq(heartbeatRunEvents.eventType, "error")));
      expect(errorEvent?.message).toBe(expected);

      // The dispatcher then releases its unstarted claim; the coordinator keeps
      // the same named cause and its unchanged eligibility fields.
      const { settleUnstartedNativeSessionResume } = await import("../native-runtime/native-failed-run-owner-release.js");
      await expect(settleUnstartedNativeSessionResume(db, { runId: f.run.id, leaseOwner, attempt })).resolves.toBe(true);
      const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id));
      expect(coordinator).toMatchObject({ phase: "terminal_failure", failureCode: "adapter_failed",
        failureDetail: { message: expected, originalFailureCode: "adapter_failed" } });
    });

    it("masks usernames in both texts before their length budgets cut them", async () => {
      // Each username crosses a cut: 1,500 characters for the original message
      // and 480 for the refusal. A cut before masking would keep "casp".
      const userName = "casperhost";
      const original = `${"x".repeat(1_495)} ${userName} could not resume`;
      const longRefusal = `${"r".repeat(475)} ${userName} retained session is not authorized`;
      const { f } = await resumeClaim([{ ...interruption, stderrTail: original }]);
      f.deps.getCurrentUserRedactionOptions.mockResolvedValue({ enabled: true, userNames: [userName], homeDirs: [] });
      await f.completion.failRun(f.failure(new Error(longRefusal)));
      const failed = await read(f.run.id);
      const recorded = (failed.resultJson as { nativeExactResumeRefusal: Record<string, string> }).nativeExactResumeRefusal;
      expect(failed.error).toHaveLength(2_000);
      expect(failed.error!.startsWith("native_session_interrupted: xxx")).toBe(true);
      expect(failed.error!.endsWith(`; exact checkpoint resume refused: ${"r".repeat(475)} c***`)).toBe(true);
      expect(recorded.originalMessage).toBe(`${"x".repeat(1_495)} c***`);
      expect(recorded.refusal).toBe(`${"r".repeat(475)} c********* retained session is not authorized`);
      for (const text of [failed.error!, recorded.originalMessage, recorded.refusal]) expect(text).not.toContain("casp");
    });

    it("saves the failure when an emoji crosses each cut", async () => {
      const emoji = "\u{1F642}";
      const { f } = await resumeClaim([{ ...interruption, stderrTail: `${"x".repeat(1_499)}${emoji} could not resume` }]);
      await f.completion.failRun(f.failure(new Error(`${"r".repeat(479)}${emoji} retained session is not authorized`)));
      const failed = await read(f.run.id);
      expect(failed.status).toBe("failed");
      const recorded = (failed.resultJson as { nativeExactResumeRefusal: Record<string, string> }).nativeExactResumeRefusal;
      expect(recorded.originalMessage).toBe("x".repeat(1_499));
      expect(failed.error!.endsWith(`; exact checkpoint resume refused: ${"r".repeat(479)}`)).toBe(true);
    });

    it.each([
      ["has no prior interruption", [], 0],
      ["follows a bootstrap retry", [{ ...interruption, checkpointExists: false, providerSessionEstablished: false }], 1],
      ["already claimed a later provider attempt", [interruption], 2],
    ])("keeps the thrown error unchanged when the run %s", async (_name, history, attempt) => {
      const { f } = await resumeClaim(history, attempt);
      await f.completion.failRun(f.failure(new Error(refusal)));
      const failed = await read(f.run.id);
      expect(failed).toMatchObject({ status: "failed", errorCode: "adapter_failed", error: refusal });
      expect(failed.resultJson).not.toHaveProperty("nativeExactResumeRefusal");
    });
  });

  it.each([
    "native_controller_recovery_missing_evidence:snapshot_binding",
    "native_controller_recovery_unsupported:metadata_format", "runner_remote_state_unavailable",
    "native_runner_refresh_required", "native_runner_launch_profile_mismatch", "runner_harness_state_mismatch: backup_without_reusable_lease",
    "runner_harness_state_mismatch: resumed_unavailable",
    "runner_harness_state_mismatch: backup_without_reusable_lease",
    "native_controller_recovery_missing_evidence:retained_sandbox_binding",
  ])("RFL F5 keeps the agent idle after an execute-path D10 refusal (%s)", async code => {
    const f = await fixture({ runtimeMode: "native" }, `RF${randomUUID().slice(0, 6)}`);
    await f.completion.failRun(f.failure(Object.assign(new Error("Opaque refusal"), { code })));
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledWith(f.run.agentId, "failed", expect.any(String),
      expect.objectContaining({ keepIdleOnFailure: true }));
  });

  it.each([
    "native_controller_recovery_missing_evidence:snapshot_binding",
    "native_controller_recovery_unsupported:metadata_format", "runner_remote_state_unavailable", "native_runner_refresh_required",
    "runner_harness_state_mismatch: backup_without_reusable_lease",
    "runner_harness_state_mismatch: resumed_unavailable",
    "runner_harness_state_mismatch: backup_without_reusable_lease",
    "native_controller_recovery_missing_evidence:retained_sandbox_binding",
  ])("persists structured fresh-thread refusal through ordinary completion recovery (%s)", async code => {
    // follow-Paperclip Cut B R7: typed refusals keep diagnostics but use ordinary completion and recovery owners.
    for (const phase of ["execute", "setup"]) {
      const f = await fixture({ runtimeMode: "native" }, `FR${randomUUID().slice(0, 6)}`);
      const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Structured refusal", assigneeAgentId: f.run.agentId }).returning();
      await db.update(heartbeatRuns).set({ nativeIssueId: issue.id, issueId: issue.id }).where(eq(heartbeatRuns.id, f.run.id));
      f.run.nativeIssueId = issue.id;
      f.run.issueId = issue.id;
      await db.insert(nativeRunFinalizations).values({ companyId: f.run.companyId, issueId: issue.id,
        runId: f.run.id, phase: "observed", attempt: 0 });
      const error = Object.assign(new Error("Opaque Runner/controller refusal; not provider prose"), { code, waitForTurn: true });
      if (phase === "execute") await f.completion.failRun(f.failure(error));
      else await f.completion.failRunSetup(f.setup(error));
      expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: code,
        resultJson: { nativeFreshContinuationRefusal: { code, waitForTurn: true } } });
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id)))[0])
        .toMatchObject({ phase: "observed", failureCode: null, nextAttemptAt: null, leaseOwner: null, resultId: null });
      expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
      expect(f.deps.scheduleInteractionContinuationInfrastructureRetryIfEligible).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: f.run.id, errorCode: code }), expect.objectContaining({ id: f.agent.id }));
      expect(f.deps.finalizeIssueCommentPolicy).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: f.run.id, errorCode: code }), expect.objectContaining({ id: f.agent.id }));
      expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: f.run.id }),
        expect.objectContaining({ suppressImmediateRecovery: false }));
    }
  });

  it.each(["provider_active_turn", "provider_live_descendants", "provider_active_goal", "provider_config_changed",
    "provider_contract_changed_same_run", "provider_launch_profile_mismatch", "provider_pending_tool_calls",
    "provider_reconciliation_required", "provider_session_closed", undefined, "future_unknown",
    "runner_harness_state_mismatch: resumed_unavailable",
    "runner_harness_state_mismatch: backup_without_reusable_lease",
    "native_controller_recovery_missing_evidence:retained_sandbox_binding"])(
    "persists the precise prepare code through the server completion boundary (%s)", async refusalCode => {
    // follow-Paperclip Cut B R7: precise prepare facts no longer suppress ordinary comment finalization or recovery.
    for (const phase of ["execute", "setup"]) {
      const f = await fixture({ runtimeMode: "native" }, `WC${randomUUID().slice(0, 6)}`);
      const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Wire refusal", assigneeAgentId: f.run.agentId }).returning();
      await db.update(heartbeatRuns).set({ nativeIssueId: issue.id, issueId: issue.id }).where(eq(heartbeatRuns.id, f.run.id));
      f.run.nativeIssueId = issue.id;
      f.run.issueId = issue.id;
      await db.insert(nativeRunFinalizations).values({ companyId: f.run.companyId, issueId: issue.id,
        runId: f.run.id, phase: "observed", attempt: 0 });
      const error = Object.assign(new Error("opaque transport"), { runnerCommandResult: {
        commandType: "run.prepare", status: "failed", result: { code: "command_execution_failed", refusalCode,
          message: "Pi run.prepare launch does not match the runner-owned qualified profile" } } });
      if (phase === "execute") await f.completion.failRun(f.failure(error));
      else await f.completion.failRunSetup(f.setup(error));
      const code = refusalCode === "runner_harness_state_mismatch: backup_without_reusable_lease"
        || refusalCode === "runner_harness_state_mismatch: resumed_unavailable"
        || refusalCode === "native_controller_recovery_missing_evidence:retained_sandbox_binding" ? refusalCode
        : refusalCode === "provider_launch_profile_mismatch" ? "native_runner_launch_profile_mismatch" : "native_runner_refresh_required";
      expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: code,
        resultJson: { nativeFreshContinuationRefusal: { code,
          prepareRefusalCode: !refusalCode || refusalCode === "future_unknown" ? "provider_prepare_refused" : refusalCode } } });
      expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
      expect(f.deps.scheduleInteractionContinuationInfrastructureRetryIfEligible).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: f.run.id, errorCode: code }), expect.objectContaining({ id: f.agent.id }));
      expect(f.deps.finalizeIssueCommentPolicy).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: f.run.id, errorCode: code }), expect.objectContaining({ id: f.agent.id }));
      expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: f.run.id }),
        expect.objectContaining({ suppressImmediateRecovery: false }));
    }
  });

  it("persists a project denial without provider work or an automatic retry", async () => {
    const f = await fixture();
    const projectId = randomUUID();
    await f.completion.failRunSetup(f.setup(new ProjectAccessDeniedError(projectId)));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "project_access_denied",
      resultJson: { projectAccessDenied: { projectId }, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
    expect(f.deps.enqueueWakeup).not.toHaveBeenCalled();
    expect(f.deps.scheduleInteractionContinuationInfrastructureRetryIfEligible).not.toHaveBeenCalled();
    expect(f.deps.finalizeIssueCommentPolicy).not.toHaveBeenCalled();
  });

  it("records a setup configuration gap without inventing provider work or applying comment policy", async () => {
    const f = await fixture();
    await f.completion.failRunSetup(f.setup(new ConfigurationIncompleteFailure("missing credential", { configurationIncomplete: { reason: "missing_binding" } })));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "configuration_incomplete", resultJson: { configurationIncomplete: { reason: "missing_binding" }, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    expect(f.deps.finalizeIssueCommentPolicy).not.toHaveBeenCalled();
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledOnce();
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledOnce();
  });

  it.each(["current", "stale_snapshot", "stale_profile", "prior_attempt_only", "concurrent_ack", "handoff_ack"] as const)("retains an existing native Stop and receipt debt when recovery configuration fails (%s)", async mode => {
    const f = await fixture({ runtimeMode: "native", costAccountingPending: true,
      usageJson: { accountingReceiptReady: false, accountingReceiptSequence: 0 } });
    const { issue, native, binding, execution } = await admitNativeExecution(f);
    const intentAuditId = randomUUID();
    await db.insert(activityLog).values({ id: intentAuditId, companyId: f.run.companyId, actorType: "user", actorId: "test-board",
      action: "native.cancellation_intent_recorded", entityType: "heartbeat_run", entityId: f.run.id, runId: f.run.id, agentId: f.agent.id });
    const nativeCancellation = { schema: "paperclip.native-cancellation.v1", ...binding, scope: "run", reasonCode: "cancellation_run_only",
      intentId: `native-cancellation:${randomUUID()}`, intentAuditId, dispatchState: "pending", dispatched: false, effects: ["release_run_resources"] };
    await db.insert(nativeRunFinalizations).values({ runId: f.run.id, companyId: f.run.companyId, issueId: issue.id, phase: "observed", attempt: 1 });
    await reserveRunBudget(db, f.run.companyId, f.run.id, null);
    await db.update(budgetReservations).set({ providerStartedAt: new Date() }).where(eq(budgetReservations.runId, f.run.id));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution,
      ...(mode === "prior_attempt_only" ? {} : { sessionCheckpoint: { identity: { ...binding, sessionId: native.normalizedSessionId }, providerSessionId: "existing-provider-session", activeTurnId: native.turnId } }) },
      resultJson: { oldNonControlField: "replace this stale projection", nativeCancellation, startupCancellation: { requestedAt: new Date().toISOString(), beforeNativeSelection: false },
        ...(mode === "handoff_ack" ? { reassignmentStopRequested: true } : {}),
        executionCancellation: { state: "requested", requestedAt: new Date().toISOString() } } }).where(eq(heartbeatRuns.id, f.run.id));
    Object.assign(f.run, await read(f.run.id));
    expect(await readPendingNativeRunStop(db, f.run)).toBe(true);
    const setup = f.setup(new ConfigurationIncompleteFailure("The AI account changed while suspended.", {
      configurationIncomplete: { reason: "ai_connection_changed" } }));
    if (mode === "stale_snapshot") setup.run = { ...setup.run, resultJson: {} };
    if (mode === "stale_profile" || mode === "prior_attempt_only") setup.run = { ...setup.run, runnerProfileJson: {} };
    let expectedCancellation: Record<string, unknown> = nativeCancellation;
    const acknowledged = mode === "concurrent_ack" || mode === "handoff_ack";
    if (acknowledged) {
      const acknowledgementAuditId = randomUUID();
      await db.insert(activityLog).values({ id: acknowledgementAuditId, companyId: f.run.companyId, actorType: "system", actorId: "native-session-cancellation",
        action: "native.cancellation_dispatch_acknowledged", entityType: "heartbeat_run", entityId: f.run.id, runId: f.run.id, agentId: f.agent.id });
      expectedCancellation = { ...nativeCancellation, dispatchState: "acknowledged", dispatched: true, acknowledgementAuditId };
      let enter!: () => void, release!: () => void, blockerPid = 0;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const released = new Promise<void>(resolve => { release = resolve; });
      const writer = db.transaction(async tx => {
        const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        blockerPid = backend.pid;
        const [current] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)).for("update");
        enter(); await released;
        const [committed] = await tx.update(heartbeatRuns).set({ resultJson: { ...current.resultJson, nativeCancellation: expectedCancellation } })
          .where(eq(heartbeatRuns.id, f.run.id)).returning();
        expect(hasAcknowledgedNativeReassignmentStopIntent(committed)).toBe(mode === "handoff_ack");
      });
      await entered;
      const failure = f.completion.failRunSetup(setup);
      try {
        await vi.waitFor(async () => {
          const waiting = await db.execute(sql`select pid from pg_stat_activity
            where ${blockerPid} = any(pg_blocking_pids(pid)) and wait_event_type = 'Lock'`);
          expect(waiting.length).toBeGreaterThan(0);
        }, { timeout: 5_000 });
      } finally { release(); await writer; await failure; }
    } else await f.completion.failRunSetup(setup);
    const failed = await read(f.run.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: "configuration_incomplete" });
    expect.soft(failed.resultJson?.nativeCancellation).toEqual(expectedCancellation);
    expect.soft(await readPendingNativeRunStop(db, failed)).toBe(!acknowledged);
    expect.soft(hasAcknowledgedNativeReassignmentStopIntent(failed)).toBe(mode === "handoff_ack");
    expect(failed.resultJson).not.toHaveProperty("oldNonControlField");
    expect.soft((failed.resultJson?.executionRecovery as Record<string, unknown> | undefined)?.providerWorkStarted).not.toBe(false);
    expect.soft(await (await import("../run-cost-accounting.js")).accountRunCost(db, f.run.id)).toBe(false);
    expect.soft(await read(f.run.id)).toMatchObject({ costAccountingPending: true, costAccountedAt: null,
      usageJson: { accountingReceiptReady: false, accountingReceiptSequence: 0 } });
    const [hold] = await db.select().from(budgetReservations).where(eq(budgetReservations.runId, f.run.id));
    expect.soft(hold).toMatchObject({ state: "held", settledAt: null });
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id))).toHaveLength(0);
  }, 30_000);

  it.each([
    { runtimeMode: "native", providerDispatchStarted: false },
    { runtimeMode: "legacy", providerDispatchStarted: false },
    { runtimeMode: "native", providerDispatchStarted: true },
    { runtimeMode: "legacy", providerDispatchStarted: true },
  ] as const)("settles only a genuinely pre-provider setup failure ($runtimeMode, dispatched=$providerDispatchStarted)", async ({ runtimeMode, providerDispatchStarted }) => {
    const f = await fixture({ runtimeMode, costAccountingPending: true,
      usageJson: { accountingReceiptReady: false, accountingReceiptSequence: 0 } });
    await reserveRunBudget(db, f.run.companyId, f.run.id, null);
    if (providerDispatchStarted) await db.update(budgetReservations).set({ providerStartedAt: new Date() }).where(eq(budgetReservations.runId, f.run.id));
    await f.completion.failRunSetup(f.setup(new ConfigurationIncompleteFailure("missing credential", {
      configurationIncomplete: { reason: "missing_binding" } }), providerDispatchStarted));
    expect(await (await import("../run-cost-accounting.js")).accountRunCost(db, f.run.id)).toBe(!providerDispatchStarted);
    expect(await read(f.run.id)).toMatchObject({ costAccountingPending: providerDispatchStarted,
      costAccountedAt: providerDispatchStarted ? null : expect.any(Date) });
    const [hold] = await db.select().from(budgetReservations).where(eq(budgetReservations.runId, f.run.id));
    expect(hold.state).toBe(providerDispatchStarted ? "held" : "released");
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id))).toHaveLength(0);
  });

  it.each(["run", "company", "issue", "task_scope"] as const)("does not preserve a foreign or task-scoped cancellation projection (%s)", async mismatch => {
    const f = await fixture({ runtimeMode: "native" });
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Scoped metadata" }).returning();
    const nativeCancellation = { schema: "paperclip.native-cancellation.v1", scope: mismatch === "task_scope" ? "issue" : "run",
      reasonCode: "cancellation_run_only", runId: mismatch === "run" ? randomUUID() : f.run.id,
      companyId: mismatch === "company" ? randomUUID() : f.run.companyId, issueId: mismatch === "issue" ? randomUUID() : issue.id,
      dispatchState: "pending", dispatched: false };
    await db.update(heartbeatRuns).set({ nativeIssueId: issue.id, resultJson: { nativeCancellation, oldNonControlField: true } })
      .where(eq(heartbeatRuns.id, f.run.id));
    const resultJson = { configurationIncomplete: { reason: "missing_binding" } };
    await f.deps.setRunStatusIfRunning(f.run.id, "failed", { errorCode: "configuration_incomplete", resultJson });
    expect((await read(f.run.id)).resultJson).toEqual(resultJson);
  });

  it("keeps ordinary adapter pre-provider receipts outside setup-history checks", async () => {
    const f = await fixture({ runtimeMode: "native", costAccountingPending: true,
      runnerProfileJson: { nativeExecutionInput: { schema: "paperclip.native-execution-input.v1" } } });
    await reserveRunBudget(db, f.run.companyId, f.run.id, null);
    await f.completion.completeRun({ ...f.input, adapterResult: { exitCode: 1, signal: null, timedOut: false,
      errorCode: "provider_not_started", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    expect(await read(f.run.id)).toMatchObject({ status: "failed", costAccountingPending: false,
      costAccountedAt: expect.any(Date), resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    const [hold] = await db.select().from(budgetReservations).where(eq(budgetReservations.runId, f.run.id));
    expect(hold.state).toBe("released");
  });

  it.each(["stale", "loaded", "foreign_coordinator"] as const)("settles fresh input admitted by this attempt when no provider work started (%s)", async mode => {
    const f = await fixture({ runtimeMode: "native", costAccountingPending: true,
      usageJson: { accountingReceiptReady: false, accountingReceiptSequence: 0 } });
    const setup = { ...f.setup(new ConfigurationIncompleteFailure("fresh preparation failed", {
      configurationIncomplete: { reason: "missing_binding" } })), run: { ...f.run } };
    const { issue } = await admitNativeExecution(f);
    await db.insert(nativeRunFinalizations).values({ runId: f.run.id, companyId: f.run.companyId,
      issueId: issue.id, phase: "observed" });
    if (mode === "foreign_coordinator") {
      const [otherIssue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Other task" }).returning();
      const [otherRun] = await db.insert(heartbeatRuns).values({ companyId: f.run.companyId, agentId: f.agent.id,
        nativeIssueId: otherIssue.id, status: "running", runtimeMode: "native" }).returning();
      await db.insert(nativeRunFinalizations).values({ runId: otherRun.id, companyId: otherRun.companyId,
        issueId: otherIssue.id, phase: "observed", attempt: 1 });
    }
    await reserveRunBudget(db, f.run.companyId, f.run.id, null);
    if (mode !== "stale") setup.run = await read(f.run.id);
    await f.completion.failRunSetup(setup);
    expect.soft(await read(f.run.id)).toMatchObject({ status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    expect.soft(await (await import("../run-cost-accounting.js")).accountRunCost(db, f.run.id)).toBe(true);
    expect.soft(await read(f.run.id)).toMatchObject({ costAccountingPending: false, costAccountedAt: expect.any(Date) });
    const [hold] = await db.select().from(budgetReservations).where(eq(budgetReservations.runId, f.run.id));
    expect.soft(hold).toMatchObject({ state: "released", providerStartedAt: expect.any(Date) });
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id))).toHaveLength(0);
  });

  it("retains receipt debt when a first execution claim commits during setup failure", async () => {
    const f = await fixture({ runtimeMode: "native", costAccountingPending: true,
      usageJson: { accountingReceiptReady: false, accountingReceiptSequence: 0 } });
    const setup = f.setup(new ConfigurationIncompleteFailure("preparation failed", {
      configurationIncomplete: { reason: "missing_binding" } }));
    const { issue } = await admitNativeExecution(f);
    await db.insert(nativeRunFinalizations).values({ runId: f.run.id, companyId: f.run.companyId,
      issueId: issue.id, phase: "observed" });
    await reserveRunBudget(db, f.run.companyId, f.run.id, null);
    let enter!: () => void, release!: () => void, blockerPid = 0;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const claimant = db.transaction(async tx => {
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      blockerPid = backend.pid;
      await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id)).for("update");
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)).for("update");
      enter(); await released;
      await tx.update(nativeRunFinalizations).set({ attempt: 1 }).where(eq(nativeRunFinalizations.runId, f.run.id));
      await tx.update(heartbeatRuns).set({ nativePhase: "observed", updatedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    });
    await entered;
    const failure = f.completion.failRunSetup(setup);
    try {
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select pid from pg_stat_activity
          where ${blockerPid} = any(pg_blocking_pids(pid)) and wait_event_type = 'Lock'`);
        expect(waiting.length).toBeGreaterThan(0);
      }, { timeout: 5_000 });
    } finally { release(); await claimant; await failure; }
    const failed = await read(f.run.id);
    expect.soft((failed.resultJson?.executionRecovery as Record<string, unknown> | undefined)?.providerWorkStarted).not.toBe(false);
    expect.soft(await (await import("../run-cost-accounting.js")).accountRunCost(db, f.run.id)).toBe(false);
    expect.soft(await read(f.run.id)).toMatchObject({ status: "failed", costAccountingPending: true, costAccountedAt: null });
    const [hold] = await db.select().from(budgetReservations).where(eq(budgetReservations.runId, f.run.id));
    expect(hold.state).toBe("held");
  }, 30_000);

  it("lets a completed Stop advance its budget delivery metadata", async () => {
    const f = await fixture({ runtimeMode: "native" });
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Budget Stop delivery" }).returning();
    const intentAuditId = randomUUID(), acknowledgementAuditId = randomUUID();
    await db.insert(activityLog).values([
      { id: intentAuditId, companyId: f.run.companyId, actorType: "system", actorId: "native-session-cancellation",
        action: "native.cancellation_intent_recorded", entityType: "heartbeat_run", entityId: f.run.id, runId: f.run.id, agentId: f.agent.id },
      { id: acknowledgementAuditId, companyId: f.run.companyId, actorType: "system", actorId: "native-session-cancellation",
        action: "native.cancellation_dispatch_acknowledged", entityType: "heartbeat_run", entityId: f.run.id, runId: f.run.id, agentId: f.agent.id },
    ]);
    const nativeCancellation = { schema: "paperclip.native-cancellation.v1", companyId: f.run.companyId, runId: f.run.id, issueId: issue.id,
      scope: "run", reasonCode: "cancellation_run_only", intentAuditId, acknowledgementAuditId, dispatched: true, dispatchState: "acknowledged" };
    const startupCancellation = { requestedAt: new Date().toISOString(), beforeNativeSelection: false,
      budgetEnforcement: { companyId: f.run.companyId, scopeType: "agent", scopeId: f.agent.id, policyId: randomUUID(), version: 1 } };
    await db.update(heartbeatRuns).set({ nativeIssueId: issue.id, resultJson: { nativeCancellation, startupCancellation } })
      .where(eq(heartbeatRuns.id, f.run.id));
    const deliveredAt = new Date().toISOString();
    const outcome = await f.deps.setRunStatusFromLive(f.run.id, "cancelled", ["running"], {
      finishedAt: new Date(), resultJson: { nativeCancellation, startupCancellation: {
        ...startupCancellation, budgetEnforcement: { ...startupCancellation.budgetEnforcement, deliveredAt } } },
    });
    expect(outcome.updated).toBe(true);
    expect(await read(f.run.id)).toMatchObject({ status: "cancelled", resultJson: {
      nativeCancellation, startupCancellation: { budgetEnforcement: { deliveredAt } } } });
  });

  it("retains the default branch needed to repair an unresolved workspace base ref", async () => {
    const f = await fixture();
    const error = new UnresolvedWorkspaceBaseRefError({
      requestedRef: "main", recoveryIdentityRef: "origin/main", attemptedRefs: ["origin/main"], defaultBranch: "master",
    });
    await f.completion.failRunSetup(f.setup(error));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "configuration_incomplete", resultJson: {
      configurationIncomplete: { reason: "workspace_base_ref_unresolved", requestedRef: "main", defaultBranch: "master", attemptedRefs: ["origin/main"], fingerprint: "workspace_base_ref:origin/main" },
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    } });
  });

  it.each(["fresh", "started", "untrusted", "retained"] as const)("routes a %s workspace preparation timeout through bootstrap recovery", async scenario => {
    const f = await fixture({ runtimeMode: scenario === "retained" ? "native" : "legacy" });
    const cause = new RemoteWorkspaceOperationTimeoutError("prepare", 300_000);
    const error = scenario === "untrusted" ? new Error(cause.message) : new RemoteWorkspacePreparationTimeoutError(cause);
    f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "not_scheduled", reason: "Fixture scheduler boundary", issueId: null });
    await f.completion.failRunSetup(f.setup(error, scenario === "started"));
    const failed = await read(f.run.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: scenario === "fresh" ? "remote_workspace_prepare_timeout" : "setup_failed" });
    if (scenario === "fresh") {
      expect(failed.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
      expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent);
    } else expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
  });

  it.each(["fresh", "started", "untrusted", "retained"] as const)("routes a %s preserved sandbox resume failure through bounded bootstrap recovery", async scenario => {
    const f = await fixture({ runtimeMode: scenario === "retained" ? "native" : "legacy" });
    const providerError = Object.assign(new Error("Sandbox abc is not in a valid state: stopping /home/daytona/secret"), { statusCode: 400 });
    const resume = new ReusableSandboxResumeError({ provider: "daytona", providerLeaseId: "lease-1", cause: providerError });
    // The orchestrator wraps the runtime error, exactly as staging recorded it.
    const wrapped = new EnvironmentRunError("lease_acquire_failed",
      `Failed to acquire lease for environment "Paperclip Sandbox" (sandbox): ${resume.message}`, { cause: resume });
    const error = scenario === "untrusted" ? new Error(wrapped.message) : wrapped;
    f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "not_scheduled", reason: "Fixture scheduler boundary", issueId: null });
    await f.completion.failRunSetup(f.setup(error, scenario === "started"));
    const failed = await read(f.run.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: scenario === "fresh" ? "reusable_sandbox_resume_failed" : "setup_failed" });
    // The closed-label cause is recorded; provider text never is.
    expect(failed.error).toContain("cause=provider_error status=400");
    expect(failed.error).not.toContain("/home/daytona");
    if (scenario === "fresh") {
      expect(failed.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
      expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent);
    } else expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
  });

  it.each(["fresh", "started", "untrusted", "retained"] as const)("routes a %s stopped plugin worker refusal through bounded bootstrap recovery", async scenario => {
    const f = await fixture({ runtimeMode: scenario === "retained" ? "native" : "legacy" });
    const refusal = new PluginWorkerUnavailableError({ pluginId: "plugin-1", workerStatus: "stopped",
      message: 'Cannot call "environmentExecute" — worker for "plugin-1" is stopped' });
    const error = scenario === "untrusted" ? new Error(refusal.message)
      : new EnvironmentRunError("workspace_realization_failed", refusal.message, { cause: refusal });
    f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "not_scheduled", reason: "Fixture scheduler boundary", issueId: null });
    await f.completion.failRunSetup(f.setup(error, scenario === "started"));
    const failed = await read(f.run.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: scenario === "fresh" ? "plugin_worker_unavailable" : "setup_failed" });
    if (scenario === "fresh") {
      expect(failed.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
      expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent);
    } else expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
  });

  // Daytona returned HTTP 502 on sandbox create and cleanup of the
  // provisional allocation could not be confirmed. The orchestrator wraps the
  // worker refusal exactly as staging recorded it.
  const daytonaCreate502 = (withEnvelope = true) => new JsonRpcCallError({ code: -32000,
    message: "Daytona sandbox creation failed (HTTP 502); cleanup could not be confirmed for paperclip-create-05f81d77",
    data: withEnvelope ? { schema: "paperclip/environment-creation-cleanup/v1", providerDiagnostic: { httpStatus: 502 },
      cleanup: { providerLeaseId: "paperclip-create-05f81d77", companyId: "company", environmentId: "environment",
        attemptId: "05f81d77", accountFingerprint: "a".repeat(64), labels: {} } } : undefined });
  const acquireThroughOrchestrator = async (refusal: unknown) => {
    const orchestrator = environmentRunOrchestrator(db, { environmentRuntime: {
      acquireRunLease: async () => { throw refusal; },
    } as never });
    return orchestrator.acquireLease({ companyId: randomUUID(), environment: { id: randomUUID(), name: "Paperclip Sandbox", driver: "sandbox" } as never,
      issueId: null, agentId: randomUUID(), heartbeatRunId: randomUUID(), persistedExecutionWorkspace: null,
      executionWorkspaceSettings: null, adapterType: null }).then(() => { throw new Error("expected a refusal"); }, (error: unknown) => error);
  };

  it.each(["fresh", "started", "message_only", "permanent", "retained"] as const)("routes a %s sandbox provider lease refusal through bounded bootstrap recovery", async scenario => {
    const f = await fixture({ runtimeMode: scenario === "retained" ? "native" : "legacy" });
    const refusal = scenario === "message_only" ? daytonaCreate502(false)
      : scenario === "permanent" ? new JsonRpcCallError({ code: -32000, message: "Daytona sandbox creation failed (HTTP 400)",
        data: { schema: "paperclip/environment-acquire-error/v1", providerDiagnostic: { httpStatus: 400 } } })
      : daytonaCreate502();
    const error = await acquireThroughOrchestrator(refusal);
    f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "not_scheduled", reason: "Fixture scheduler boundary", issueId: null });
    await f.completion.failRunSetup(f.setup(error, scenario === "started"));
    const failed = await read(f.run.id);
    const retried = scenario === "fresh";
    expect(failed).toMatchObject({ status: "failed", errorCode: retried ? "environment_provider_unavailable" : "setup_failed" });
    // The staging message is kept verbatim for diagnostics.
    expect(failed.error).toContain("Daytona sandbox creation failed");
    if (retried) {
      expect(failed.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        providerFailure: { provider: "sandbox", phase: "startup", category: "overloaded", httpStatus: 502, retryability: "transient" } });
      expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent);
    } else expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
  });

  // Staging run f41857b6: the Daytona create was still pending at the
  // acquisition deadline, so the worker returned the cleanup envelope with a
  // create-phase diagnostic and no provider status.
  const daytonaLeaseTimeout = (elapsedMs: number) => new JsonRpcCallError({ code: -32000,
    message: "Daytona lease acquisition timed out; allocation cleanup is pending",
    data: { schema: "paperclip/environment-creation-cleanup/v1",
      cleanup: { providerLeaseId: "paperclip-create-05f81d77", companyId: "company", environmentId: "environment",
        runId: "f41857b6", attemptId: "05f81d77", accountFingerprint: "a".repeat(64),
        labels: { "paperclip-provider": "daytona", "paperclip-create-attempt": "05f81d77" } },
      acquisitionDiagnostic: { phase: "create", elapsedMs, budgetMs: 300_000, providerState: "creating" } } });

  it.each(["fresh", "started", "early_failure"] as const)("routes a %s sandbox create that timed out through bounded bootstrap recovery", async scenario => {
    const f = await fixture();
    const error = await acquireThroughOrchestrator(daytonaLeaseTimeout(scenario === "early_failure" ? 100 : 300_004));
    f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "not_scheduled", reason: "Fixture scheduler boundary", issueId: null });
    await f.completion.failRunSetup(f.setup(error, scenario === "started"));
    const failed = await read(f.run.id);
    const retried = scenario === "fresh";
    expect(failed).toMatchObject({ status: "failed", errorCode: retried ? "environment_provider_unavailable" : "setup_failed" });
    expect(failed.error).toContain("Daytona lease acquisition timed out");
    if (retried) {
      expect(failed.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        providerFailure: { provider: "sandbox", phase: "startup", category: "timeout", retryability: "transient" } });
      expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent);
    } else expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
  });

  it.each(["fresh", "started", "untrusted", "denied", "retained", "session", "runner"] as const)("bounds only an owned pre-dispatch chat binding wait: %s", async scenario => {
    const f = await fixture({ runtimeMode: scenario === "retained" ? "native" : "legacy",
      ...(scenario === "session" ? { nativeSessionId: randomUUID() } : {}),
      ...(scenario === "runner" ? { runnerInstanceId: randomUUID() } : {}) });
    const error = scenario === "untrusted" ? new Error("reviewed_chat_execution_binding_not_ready")
      : scenario === "denied" ? new ReviewedChatBindingDeniedError("principal_denied")
      : new ReviewedChatBindingNotReadyError();
    f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "scheduled" } as never);
    await f.completion.failRunSetup(f.setup(error, scenario === "started"));
    const failed = await read(f.run.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: scenario === "fresh" ? "reviewed_chat_execution_binding_not_ready" : "setup_failed" });
    if (scenario === "fresh") {
      expect(failed.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
      expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent);
    } else expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
  });

  it("keeps an answered chat interaction on its own bounded continuation retry", async () => {
    const f = await fixture({ contextSnapshot: { source: "issue.interaction.respond", externalChatContinuation: true,
      interactionId: "interaction-1", interactionStatus: "answered", interactionKind: "ask_user_questions",
      mutation: "interaction", wakeReason: "issue_commented" } });
    await f.completion.failRunSetup(f.setup(new ReviewedChatBindingNotReadyError()));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "reviewed_chat_execution_binding_not_ready" });
    expect(f.deps.scheduleInteractionContinuationInfrastructureRetryIfEligible)
      .toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent);
    expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
  });

  it.each([false, true])("selects the answer retry from the real delivery producer and heartbeat queue (legacy context=%s)", async legacy => {
    const f = await fixture();
    await db.update(agents).set({ adapterType: "paperclip_runner", status: "idle",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.agent.id));
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Answer delivery retry",
      status: "in_progress", assigneeAgentId: f.agent.id, responsibleUserId: "local-board" }).returning();
    const [questionRun] = await db.insert(heartbeatRuns).values({ companyId: f.run.companyId, agentId: f.agent.id,
      issueId: issue.id, nativeIssueId: issue.id, runtimeMode: "native", status: "succeeded", finishedAt: new Date(),
      contextSnapshot: { issueId: issue.id, source: "chat:telegram" } }).returning();
    const interactions = issueThreadInteractionService(db);
    const interaction = await interactions.create(issue, { kind: "ask_user_questions", sourceRunId: questionRun.id,
      continuationPolicy: "wake_assignee", payload: { version: 1, questions: [{ id: "choice", prompt: "Choose",
        selectionMode: "single", required: true, options: [{ id: "yes", label: "Yes" }] }] } },
      { agentId: f.agent.id, runId: questionRun.id });
    await interactions.answerQuestions(issue, interaction.id, { answers: [{ questionId: "choice", optionIds: ["yes"] }] },
      { userId: "local-board" });
    const heartbeat = heartbeatService(db);
    const answerHeartbeat = legacy ? { ...heartbeat, wakeup: (...[agentId, options]: Parameters<typeof heartbeat.wakeup>) => {
      const contextSnapshot = { ...options?.contextSnapshot };
      delete contextSnapshot.mutation;
      return heartbeat.wakeup(agentId, { ...options, contextSnapshot });
    } } : heartbeat;
    await questionResponseDeliveryService(db, { heartbeat: answerHeartbeat }).deliver(interaction.id);
    const [delivery] = await db.select().from(issueQuestionResponseDeliveries)
      .where(eq(issueQuestionResponseDeliveries.interactionId, interaction.id));
    expect(delivery).toMatchObject({ status: "fallback_queued", deliveryMode: "wake_fallback" });
    expect(delivery.targetRunId).toBeTruthy();
    const [admitted] = await db.update(heartbeatRuns).set({ status: "running", executionStage: "preparing", startedAt: new Date() })
      .where(eq(heartbeatRuns.id, delivery.targetRunId!)).returning();
    f.deps.scheduleInteractionContinuationInfrastructureRetryIfEligible.mockImplementation(async run => {
      await heartbeat.scheduleBoundedRetry(run.id, { now: new Date(), random: () => 0,
        retryReason: "interaction_continuation_infra_retry", wakeReason: "interaction_continuation_infra_retry", maxAttempts: 2 });
      return null;
    });
    f.deps.scheduleBoundedRetryForRun.mockResolvedValue({ outcome: "not_scheduled",
      reason: "Wrong retry owner fixture", issueId: issue.id });
    await f.completion.failRunSetup({ ...f.setup(new ReviewedChatBindingNotReadyError()), run: admitted, runId: admitted.id });
    expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
    expect(f.deps.scheduleInteractionContinuationInfrastructureRetryIfEligible)
      .toHaveBeenCalledWith(expect.objectContaining({ id: admitted.id }), expect.anything());
    const children = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, admitted.id));
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ scheduledRetryReason: "interaction_continuation_infra_retry",
      contextSnapshot: { interactionId: interaction.id, interactionStatus: "answered", mutation: "interaction" } });
    expect((await db.select().from(issueQuestionResponseDeliveries)
      .where(eq(issueQuestionResponseDeliveries.id, delivery.id)))[0]).toEqual(delivery);
  }, 30_000);

  const runnerMismatch = () => new JsonRpcCallError({ code: -32002, message: "The installed Runner does not match the expected revision",
    data: environmentTaskErrorCodeData(new PluginEnvironmentTaskError("runner_revision_mismatch")) });

  it.each(["fresh", "wrapped", "started", "untrusted", "retained"] as const)("waits for the Runner update after a %s Runner mismatch", async scenario => {
    const f = await fixture({ runtimeMode: scenario === "retained" ? "native" : "legacy" });
    const refusal = runnerMismatch();
    const error = scenario === "untrusted" ? new Error(refusal.message)
      : scenario === "wrapped" ? new Error("Plugin Runner task failed", { cause: refusal })
      : classifyManagedProjectAuthFailure(refusal, f.agent.id);
    f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "not_scheduled", reason: "Fixture scheduler boundary", issueId: null });
    await f.completion.failRunSetup(f.setup(error, scenario === "started"));
    const failed = await read(f.run.id);
    const retried = scenario === "fresh" || scenario === "wrapped";
    expect(failed).toMatchObject({ status: "failed", errorCode: retried ? "runner_revision_mismatch" : "setup_failed" });
    expect(failed.resultJson).not.toHaveProperty("configurationIncomplete");
    if (retried) {
      expect(failed.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
      expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent, RUNNER_REVISION_MISMATCH_RETRY);
    } else expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
  });

  it("waits for the Runner update on an answered interaction instead of its two-attempt continuation retry", async () => {
    const f = await fixture({ contextSnapshot: { interactionId: "interaction-1", interactionStatus: "answered", interactionKind: "ask_user_questions",
      mutation: "interaction", wakeReason: "issue_commented" } });
    f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "not_scheduled", reason: "Fixture scheduler boundary", issueId: null });
    await f.completion.failRunSetup(f.setup(runnerMismatch()));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "runner_revision_mismatch" });
    expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent, RUNNER_REVISION_MISMATCH_RETRY);
    expect(f.deps.scheduleInteractionContinuationInfrastructureRetryIfEligible).not.toHaveBeenCalled();
  });

  it("serializes only allowlisted cause diagnostics through Pino", async () => {
    const destination = new PassThrough();
    let serialized = "";
    destination.on("data", chunk => { serialized += chunk.toString(); });
    const captured = pino(destination);
    const logged = vi.spyOn(logger, "error").mockImplementation((...args: Parameters<typeof logger.error>) => { captured.error(...args); return logger; });
    const secrets = ["sk-live-SECRET123456789", "pa55w0rd-SECRET", "lowercase-secret-token", "sk-secret-code", "secret-syscall"];
    try {
      const causes = [
        Object.assign(new Error(`Authorization: Bearer ${secrets[0]}`), { code: "ECONNRESET", syscall: "connect", errno: 7 }),
        Object.assign(new Error(`could not reach https://user:${secrets[1]}@ingress.example/x`), { code: "ECONNREFUSED", syscall: "write", errno: 8 }),
        Object.assign(new Error(secrets[2]), { code: "ETIMEDOUT", syscall: "read", errno: 9 }),
        Object.assign(new Error("runner_ingress_upgrade_rejected"), { code: secrets[3], syscall: secrets[4], errno: 10 }),
        Object.assign(new Error("runner_ingress_unavailable"), { code: "ETIMEDOUT", syscall: "connect", errno: 1.5 }),
      ];
      for (const cause of causes) {
        const f = await fixture({}, `LOG${randomUUID().slice(0, 6)}`);
        await f.completion.failRun(f.failure(new Error("wrapped failure", { cause })));
      }
      // failureCause is the existing classified code (error.code / class name, bounded),
      // already persisted as resultJson.failureCause; this test covers the new causeSummary
      // and every other field, so it is the one field excluded here (RFL 11:33Z).
      const withoutFailureCause = serialized.trim().split("\n").filter(Boolean)
        .map(line => { const { failureCause: _ignored, ...rest } = JSON.parse(line) as Record<string, unknown>; return JSON.stringify(rest); }).join("\n");
      expect(withoutFailureCause).not.toMatch(/Authorization|Bearer|SECRET|pa55w0rd|lowercase-secret-token|sk-secret-code|secret-syscall/);
      const lines = serialized.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { causeSummary?: Record<string, unknown> });
      expect(lines).toHaveLength(5);
      expect(lines).toEqual(expect.arrayContaining([expect.objectContaining({ causeSummary: expect.objectContaining({ code: "other", syscall: "other" }) })]));
      expect(lines).toEqual(expect.arrayContaining([expect.objectContaining({ causeSummary: expect.objectContaining({ errno: null }) })]));
    } finally { logged.mockRestore(); captured.flush(); destination.destroy(); }
  });

  it("saves a bounded cause and keeps the retryable generic code when accounting retries are exhausted", async () => {
    const f = await fixture();
    const logged = vi.spyOn(logger, "error");
    onTestFinished(() => logged.mockRestore());
    const driverError = Object.assign(new Error("could not serialize access due to concurrent update"),
      { name: "PostgresError", code: "40001" });
    const queryError = new Error("Failed query: select \"id\" from \"heartbeat_runs\" where \"id\" = $1 for update\nparams: secret-run-id",
      { cause: driverError });
    await f.completion.failRun(f.failure(new AccountingContentionError(queryError, 4)));
    const failed = await read(f.run.id);
    // adapter_failed keeps chat and recovery retry paths that key on it.
    expect(failed).toMatchObject({ status: "failed", errorCode: "adapter_failed", error: ACCOUNTING_CONTENTION_MESSAGE,
      resultJson: { failureCause: "40001" } });
    expect(JSON.stringify(failed)).not.toMatch(/heartbeat_runs|secret-run-id|Failed query/);
    const failureLog = logged.mock.calls.find(call => call[1] === "heartbeat execution failed");
    expect(failureLog?.[0]).toMatchObject({ runId: f.run.id, errorCode: "adapter_failed", failureCause: "40001" });
  });

  describe("a native run that fails before provider work", () => {
    const contention = () => new AccountingContentionError(Object.assign(new Error("deadlock detected"),
      { name: "PostgresError", code: "40P01" }), 4);
    const nativeFixture = async () => {
      const f = await fixture({ runtimeMode: "native" }, `NPD${randomUUID().slice(0, 6)}`);
      f.deps.scheduleBoundedRetryForRun.mockResolvedValue({ outcome: "scheduled", run: f.run } as never);
      return { ...f, preDispatch: (err: unknown, nativeDispatchMayHaveStarted?: boolean) =>
        ({ ...f.failure(err), legacyAdapterEntered: false, nativeDispatchMayHaveStarted }) };
    };

    it("records that no provider work started and re-queues itself in the uncharged preparation lane", async () => {
      const f = await nativeFixture();
      await f.completion.failRun(f.preDispatch(contention(), false));
      const failed = await read(f.run.id);
      expect(failed).toMatchObject({ status: "failed", errorCode: "adapter_failed",
        resultJson: { failureCause: "40P01", nativePreDispatchFailure: { version: 1, providerWorkStarted: false } } });
      expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent,
        { retryReason: "interrupted_preparation" });
      expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }),
        expect.objectContaining({ suppressImmediateRecovery: true }));
    });

    it("re-queues a setup failure on a transient database fault", async () => {
      const f = await nativeFixture();
      await f.completion.failRunSetup({ ...f.setup(Object.assign(new Error("could not serialize access"),
        { name: "PostgresError", code: "40001" })), nativeDispatchMayHaveStarted: false });
      expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "setup_failed",
        resultJson: { failureCause: "40001", nativePreDispatchFailure: { version: 1, providerWorkStarted: false } } });
      expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent,
        { retryReason: "interrupted_preparation" });
    });

    it("records and settles an unclaimed native coordinator after a Boat HTTP429 before setup", async () => {
      const f = await nativeFixture();
      const { issue } = await admitNativeExecution(f);
      await db.insert(nativeRunFinalizations).values({ companyId: f.run.companyId, issueId: issue.id, runId: f.run.id, phase: "observed" });
      const cause = Object.assign(new Error("Boat HTTP429 before SETUP"), { providerFailure: {
        schema: "paperclip.provider-failure.v1", provider: "boat", phase: "startup", category: "rate_limit",
        message: "Boat refused allocation", httpStatus: 429, retryability: "transient" } });
      await f.completion.failRunSetup({ ...f.setup(cause), nativeDispatchMayHaveStarted: false });
      expect(await read(f.run.id)).toMatchObject({ status: "failed", resultJson: {
        nativePreDispatchFailure: { version: 1, providerWorkStarted: false } } });
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id)))[0])
        .toMatchObject({ phase: "terminal_failure", failureCode: "native_pre_dispatch_failure", attempt: 0, leaseOwner: null, controllerBootId: null });
    });

    it("keeps the hold once the run's history shows a native process start", async () => {
      const f = await nativeFixture();
      await appendHeartbeatRunEvent(db, { companyId: f.run.companyId, runId: f.run.id, agentId: f.run.agentId,
        eventType: "native.process_start_requested", stream: "system", level: "info", message: "Native execution requested",
        payload: { providerAttempt: 1 } });
      await f.completion.failRun(f.preDispatch(contention(), false));
      const failed = await read(f.run.id);
      expect(failed.resultJson).not.toHaveProperty("nativePreDispatchFailure");
      expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
    });

    it.each([
      ["a dispatch that may have started", true],
      ["a caller that does not report dispatch", undefined],
    ] as const)("keeps the hold for %s", async (_label, mayHaveStarted) => {
      const f = await nativeFixture();
      await f.completion.failRun(f.preDispatch(contention(), mayHaveStarted));
      expect((await read(f.run.id)).resultJson).not.toHaveProperty("nativePreDispatchFailure");
      expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
    });

    it("keeps the hold when a native coordinator was claimed", async () => {
      const f = await nativeFixture();
      const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Claimed native run" }).returning();
      await db.update(heartbeatRuns).set({ nativeIssueId: issue.id }).where(eq(heartbeatRuns.id, f.run.id));
      await db.insert(nativeRunFinalizations).values({ runId: f.run.id, companyId: f.run.companyId, issueId: issue.id, phase: "observed", attempt: 1, leaseOwner: "executor-lease" });
      await f.completion.failRun(f.preDispatch(contention(), false));
      expect((await read(f.run.id)).resultJson).not.toHaveProperty("nativePreDispatchFailure");
      expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
    });

    it("re-queues when runtime selection created the coordinator but no executor claimed it", async () => {
      const f = await nativeFixture();
      const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Unclaimed native run" }).returning();
      await db.update(heartbeatRuns).set({ nativeIssueId: issue.id }).where(eq(heartbeatRuns.id, f.run.id));
      await db.insert(nativeRunFinalizations).values({ runId: f.run.id, companyId: f.run.companyId, issueId: issue.id, phase: "observed" });
      await f.completion.failRun(f.preDispatch(contention(), false));
      expect((await read(f.run.id)).resultJson).toMatchObject({ nativePreDispatchFailure: { version: 1, providerWorkStarted: false } });
      expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledOnce();
      // The unclaimed coordinator is closed so it cannot hold the successor as pending cleanup.
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id)))[0])
        .toMatchObject({ phase: "terminal_failure", failureCode: "native_pre_dispatch_failure" });
    });

    it.each([
      ["a recorded process", { processPid: 4242 }],
      ["a provider session", { sessionIdAfter: "provider-session" }],
    ] as const)("keeps the hold when the run carries %s", async (_label, patch) => {
      const f = await nativeFixture();
      await db.update(heartbeatRuns).set(patch).where(eq(heartbeatRuns.id, f.run.id));
      await f.completion.failRun(f.preDispatch(contention(), false));
      expect((await read(f.run.id)).resultJson).not.toHaveProperty("nativePreDispatchFailure");
      expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
    });

    it("re-queues a follow-up whose process identity was inherited from its warm predecessor", async () => {
      const f = await nativeFixture();
      await db.update(heartbeatRuns).set({ processPid: 4242, runnerProfileJson: { inheritedProcessIdentityRunId: randomUUID() } })
        .where(eq(heartbeatRuns.id, f.run.id));
      await f.completion.failRun(f.preDispatch(contention(), false));
      expect((await read(f.run.id)).resultJson).toMatchObject({ nativePreDispatchFailure: { version: 1, providerWorkStarted: false } });
      expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledOnce();
    });

    it("records the proof but does not re-queue a failure that is not a transient database fault", async () => {
      const f = await nativeFixture();
      await f.completion.failRun(f.preDispatch(new Error("adapter crashed"), false));
      expect((await read(f.run.id)).resultJson).toMatchObject({ nativePreDispatchFailure: { version: 1, providerWorkStarted: false } });
      expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
    });
  });

  it("records a workspace provider's reason on the run and in the setup failure log without retrying", async () => {
    const f = await fixture();
    const logged = vi.spyOn(logger, "error");
    onTestFinished(() => logged.mockRestore());
    const rejection = new JsonRpcCallError({ code: -32002, message: "Invalid runtime computer connection",
      data: workspaceOperationErrorData(new PluginWorkspaceOperationError("runtime_connection_invalid")) });
    await f.completion.failRunSetup(f.setup(workspaceProviderCallFailure(rejection)));
    const failed = await read(f.run.id);
    expect(failed).toMatchObject({ status: "failed", errorCode: "setup_failed",
      error: "The selected runtime's saved connection is invalid; reprovision the runtime before retrying",
      resultJson: { workspaceProviderFailure: { kind: "provider", reason: "runtime_connection_invalid", retryable: false } } });
    expect(JSON.stringify(failed)).not.toContain("Invalid runtime computer connection");
    expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
    const setupLog = logged.mock.calls.find(call => call[1] === "heartbeat execution setup failed");
    expect(setupLog?.[0]).toMatchObject({ runId: f.run.id, errorCode: "setup_failed",
      workspaceProviderFailure: { kind: "provider", reason: "runtime_connection_invalid", retryable: false } });
  });

  it("logs the driver cause code of a wrapped setup query failure without its text", async () => {
    const f = await fixture();
    const logged = vi.spyOn(logger, "error");
    onTestFinished(() => logged.mockRestore());
    const driverError = Object.assign(new Error("write CONNECTION_CLOSED 127.0.0.1:5432"), { code: "CONNECTION_CLOSED" });
    await f.completion.failRunSetup(f.setup(new Error("Failed query: select 1", { cause: driverError })));
    const setupLog = logged.mock.calls.find(call => call[1] === "heartbeat execution setup failed");
    expect(setupLog?.[0]).toMatchObject({ runId: f.run.id, errorCode: "setup_failed", causeCode: "CONNECTION_CLOSED" });
    expect(JSON.stringify(setupLog?.[0])).not.toContain("127.0.0.1:5432");
  });

  it("retries a workspace operation the stopped provider worker never received", async () => {
    const f = await fixture();
    const refusal = new PluginWorkerUnavailableError({ pluginId: "plugin-1", workerStatus: "stopped",
      message: 'Cannot call "workspaceOperation" — worker for "plugin-1" is stopped' });
    f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "not_scheduled", reason: "Fixture scheduler boundary", issueId: null });
    await f.completion.failRunSetup(f.setup(workspaceProviderCallFailure(refusal)));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "plugin_worker_unavailable",
      error: "Workspace storage provider is not running; retry the same workspace",
      resultJson: { workspaceProviderFailure: { kind: "worker_unavailable", reason: null, retryable: true } } });
    expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent);
  });

  it("keeps a found project authentication conflict a configuration gap that blocks for the board", async () => {
    const f = await fixture();
    const conflict = unprocessable("This agent's managed AI connection conflicts with project authentication settings in .claude/settings.json.",
      { code: "ai_connection_incompatible" });
    await f.completion.failRunSetup(f.setup(classifyManagedProjectAuthFailure(conflict, f.agent.id)));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "configuration_incomplete",
      resultJson: { configurationIncomplete: { reason: "ai_connection_incompatible", actionUrl: `/agents/${f.agent.id}/runtime` } } });
    expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
  });

  it.each([
    ["an unavailable Runner identity", new Error("Runner identity unavailable")],
    ["an unreachable execution host", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })],
    ["another 422", unprocessable("Select a saved AI account", { code: "ai_connection_busy" })],
  ])("does not report %s as a project authentication conflict", async (_name, error) => {
    const f = await fixture();
    const classified = classifyManagedProjectAuthFailure(error, f.agent.id);
    expect(classified).toBe(error);
    await f.completion.failRunSetup(f.setup(classified));
    const failed = await read(f.run.id);
    expect(failed.errorCode).not.toBe("configuration_incomplete");
    expect(failed.resultJson).not.toHaveProperty("configurationIncomplete");
  });

  it("routes a lease acquisition refused by a stopped provider worker through bounded bootstrap recovery", async () => {
    const f = await fixture();
    const refusal = new PluginWorkerUnavailableError({ pluginId: "plugin-1", workerStatus: null,
      message: 'Sandbox provider "daytona" is installed via plugin "paperclip.daytona-sandbox-provider", but its worker is not running.' });
    const wrapped = new EnvironmentRunError("lease_acquire_failed",
      `Failed to acquire lease for environment "Paperclip Sandbox" (sandbox): ${refusal.message}`, { cause: refusal });
    f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "not_scheduled", reason: "Fixture scheduler boundary", issueId: null });
    await f.completion.failRunSetup(f.setup(wrapped));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "plugin_worker_unavailable",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent);
  });

  it.each(["retried", "exhausted", "refused", "started", "in progress"] as const)("names a %s saved workspace restore failure and leaves recovery", async scenario => {
    const f = await fixture();
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Parent task", status: scenario === "in progress" ? "in_progress" : "blocked",
      assigneeAgentId: f.agent.id }).returning();
    await db.update(heartbeatRuns).set({ issueId: issue.id, contextSnapshot: { issueId: issue.id } }).where(eq(heartbeatRuns.id, f.run.id));
    const sandboxCause = scenario === "refused"
      ? "remote_workspace_operation_failed: operation=restore exit=1; remote_workspace_restore_failed: stage=inspect_root reason=occupied_root"
      : "remote_workspace_operation_failed: operation=restore exit=1; remote_workspace_restore_failed: stage=extract code=EIO exit=1";
    const error = new RemoteWorkspaceRestoreError("sandbox_restore", scenario !== "refused", new RemoteWorkspaceOperationError(sandboxCause));
    if (scenario === "retried") f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "scheduled" } as never);
    else f.deps.scheduleBoundedRetryForRun.mockResolvedValueOnce({ outcome: "retry_exhausted", attempt: 3, maxAttempts: 2 } as never);
    await f.completion.failRunSetup(f.setup(error, scenario === "started"));
    const failed = await read(f.run.id);
    // The run names the restore step and the sandbox step instead of a bare exit status.
    expect(failed.error).toBe(`remote_workspace_restore_failed: step=sandbox_restore; ${sandboxCause}`);
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issue.id));
    if (scenario === "started") {
      expect(failed.errorCode).toBe("setup_failed");
      expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
      // Started work keeps its existing reconciliation path.
      expect(actions.filter(action => action.cause === "remote_workspace_restore_failed")).toHaveLength(0);
      return;
    }
    expect(failed).toMatchObject({ status: "failed", errorCode: "remote_workspace_restore_failed" });
    expect(failed.resultJson).toMatchObject({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      remoteWorkspaceRestore: { step: "sandbox_restore", retryable: scenario !== "refused" } });
    if (scenario === "refused") expect(f.deps.scheduleBoundedRetryForRun).not.toHaveBeenCalled();
    else expect(f.deps.scheduleBoundedRetryForRun).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), f.agent);
    // Stranded-work recovery owns scanned statuses; a retry owns the next step.
    if (scenario === "retried" || scenario === "in progress") { expect(actions).toHaveLength(0); return; }
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: "active", ownerType: "board", cause: "remote_workspace_restore_failed",
      kind: "stranded_assigned_issue", returnOwnerAgentId: f.agent.id });
    expect(actions[0]!.evidence).toMatchObject({ runId: f.run.id, restoreFailure: failed.error });
    expect(actions[0]!.nextAction).toContain("The saved version was kept");
  });

  it("keeps an active recovery action that another writer created for the task", async () => {
    const f = await fixture();
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Parent task", status: "blocked",
      assigneeAgentId: f.agent.id }).returning();
    await db.update(heartbeatRuns).set({ issueId: issue.id, contextSnapshot: { issueId: issue.id } }).where(eq(heartbeatRuns.id, f.run.id));
    const [existing] = await db.insert(issueRecoveryActions).values({ companyId: f.run.companyId, sourceIssueId: issue.id,
      kind: "active_run_watchdog", status: "active", ownerType: "board", cause: "other_failure", fingerprint: "other",
      evidence: { runId: "other-run" }, nextAction: "Handle the other failure.", attemptCount: 1 }).returning();
    const error = new RemoteWorkspaceRestoreError("sandbox_restore", false, new RemoteWorkspaceOperationError(
      "remote_workspace_operation_failed: operation=restore exit=1; remote_workspace_restore_failed: stage=inspect_root reason=occupied_root"));
    await f.completion.failRunSetup(f.setup(error));
    expect((await read(f.run.id)).errorCode).toBe("remote_workspace_restore_failed");
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issue.id));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ id: existing.id, cause: "other_failure", fingerprint: "other", nextAction: "Handle the other failure.",
      attemptCount: 1, evidence: { runId: "other-run" } });
  });

  it("records a lease lost before dispatch as a retryable host stop, not an opaque setup failure", async () => {
    const f = await fixture();
    f.controller.abort(new LegacyControllerLeaseLostError("renewal_rejected"));
    await f.completion.failRunSetup(f.setup(f.controller.signal.reason));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "controller_lease_lost", resultJson: {
      cancellation: { source: "controller_lease", expected: false, reason: "Legacy controller lease lost (renewal_rejected)" },
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledOnce();
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledWith(f.agent.id, "failed", expect.any(String), expect.objectContaining({ keepIdleOnFailure: true }));
  });

  it("attributes a lease loss even when a setup step throws its own abort error", async () => {
    const f = await fixture();
    f.controller.abort(new LegacyControllerLeaseLostError("renewal_deadline"));
    await f.completion.failRunSetup(f.setup(new Error("environment acquisition aborted")));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "controller_lease_lost",
      resultJson: { cancellation: { source: "controller_lease", reason: "Legacy controller lease lost (renewal_deadline)" } } });
  });

  it("does not make a lease loss retryable once provider work has started", async () => {
    const f = await fixture();
    f.controller.abort(new LegacyControllerLeaseLostError("renewal_error"));
    await f.completion.failRunSetup(f.setup(new Error("usage capture write failed"), true));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "setup_failed",
      resultJson: { cancellation: { source: "controller_lease", reason: "Legacy controller lease lost (renewal_error)" } } });
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledWith(f.agent.id, "failed", expect.any(String), expect.objectContaining({ keepIdleOnFailure: false }));
  });

  it("leaves a winning terminal outcome and agent state untouched after a late setup error", async () => {
    const f = await fixture({ status: "succeeded", resultJson: { winner: "completion" } });
    await f.completion.failRunSetup(f.setup(new Error("late setup error")));
    expect(await read(f.run.id)).toMatchObject({ status: "succeeded", resultJson: { winner: "completion" } });
    expect(f.deps.setWakeupStatus).not.toHaveBeenCalled();
    expect(f.deps.releaseIssueExecutionAndPromote).not.toHaveBeenCalled();
    expect(f.deps.finalizeAgentStatus).not.toHaveBeenCalled();
  });
});
