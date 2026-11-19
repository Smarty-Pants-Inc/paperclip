import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, completionContracts, createDb, environmentLeases, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, statusDecisionEffects, statusDecisions } from "@paperclipai/db";
import type { ControlPlanePort, NativeExecutionInputV1, PrpEvent, PrpTerminalState } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT } from "../../vendor/paperclip-runner/testing.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
const sentry = vi.hoisted(() => ({ captureRunFailure: vi.fn() }));
vi.mock("../../sentry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sentry.js")>()), captureRunFailure: sentry.captureRunFailure,
}));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()), executeNativeSession: provider.execute,
}));
import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { acceptedResponseDigestMatches, finalizeNativeRun, selectAcceptedFinalAgentMessage } from "./native-run-finalizer.js";
import { readPersistedNativeProviderFailure } from "./native-provider-failure-evidence.js";
import { NATIVE_PROVIDER_OVERLOADED_MESSAGE } from "./native-provider-failure.js";
import { QUALIFIED_PI_RPC_PROFILE } from "../../vendor/paperclip-runner/index.js";
import capturedPiOverload from "./__fixtures__/captured-pi-provider-overload.json" with { type: "json" };
import { heartbeatService } from "../heartbeat.js";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../../modules/wake-queue/application/use-cases.js";
import { buildExecutionContinuation } from "../execution-continuation.js";
import { waitForPendingRunFailureReports } from "../run-failure-report.js";
import { projectTaskInterruption, taskInterruptionPresentation } from "../task-interruption-presentation.js";

describe("durable native provider capacity retry", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID();
  const providerDisplayMessage = "Distinctive upstream explanation for the task display only.";
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SENTRY_RUN_FAILURES", "unexpected");
    temporary = await startEmbeddedPostgresTestDatabase("native-capacity-retry-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Capacity regression", issuePrefix: "CAP" });
    await db.insert(authUsers).values({ id: "capacity-owner", name: "Capacity owner", email: "capacity-owner@example.invalid", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "capacity-owner", status: "active", membershipRole: "operator" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Capacity worker", status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "test-model" } },
      { id: otherAgentId, companyId, name: "New owner", status: "active", adapterType: "paperclip_runner" },
    ]);
  });
  afterAll(async () => { vi.unstubAllEnvs(); await temporary?.cleanup(); });

  async function acceptCapacityFailure(runId: string, issueId: string, mutateOwner = false, kind: "codex" | "pi_rpc" = "codex") {
    const capacityMessage = kind === "pi_rpc" ? "The model is at capacity." : NATIVE_PROVIDER_OVERLOADED_MESSAGE;
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [run] = await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: issueId, error: null, errorCode: null }).where(eq(heartbeatRuns.id, runId)).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const contractInput = buildNativeCompletionContract(issue, { revision: contract.revision });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1", binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: kind === "pi_rpc" ? { kind, model: "anthropic/test-model", profile: QUALIFIED_PI_RPC_PROFILE } : { kind, model: "test-model" },
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Continue the task using its history.", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: kind === "pi_rpc" ? "pi_rpc" : "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1", contract: contractInput },
      interactionResponses: [], credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
    const providerFailure = { schema: "paperclip.provider-failure.v1", provider: kind === "pi_rpc" ? "pi_rpc" : "openai", phase: "turn",
      category: "overloaded", message: kind === "pi_rpc" ? capacityMessage : providerDisplayMessage, retryability: "transient" };
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1", runId, normalizedSessionId: native.normalizedSessionId, turnId: native.turnId,
      sourceInstanceId: native.runnerInstanceId, sourceEventId: "overload", sourceSeq: 1, sourceKind: "runner", eventType: "turn.failed", schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(),
      payload: { status: "failed", error: kind === "pi_rpc"
        ? { code: "pi_provider_error", message: JSON.stringify(capturedPiOverload) }
        : { codexErrorInfo: "serverOverloaded", message: NATIVE_PROVIDER_OVERLOADED_MESSAGE, providerFailure } },
    };
    const terminal: PrpTerminalState = { schema: "paperclip.prp.terminal.v1", turnTerminalState: "failed", runTerminalState: "failed", reportedWorkDisposition: "needs_review" };
    const result = { ...CONTROL_PLANE_CONFORMANCE_RESULT, reportedWorkDisposition: "needs_review" as const,
      summary: "I started investigating the task.", completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: contractInput.revision } };
    provider.execute.mockReset().mockImplementation(async (options: { controlPlane: ControlPlanePort }) => {
      await options.controlPlane.openRun({ identity: { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId }, backendKind: "mock", sourceInstanceId: native.runnerInstanceId });
      await options.controlPlane.appendEvent(event);
      await options.controlPlane.completeRun({ result, terminal, turnId: native.turnId });
      return { result, terminal, turnId: native.turnId, normalizedSessionId: native.normalizedSessionId, providerSessionId: "fixture-session", driverKind: execution.session.driverKind, driverVersion: "fixture", nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    });
    const unexpected = async () => { throw new Error("Unexpected provider call"); };
    const adapter = await executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId, backend: { descriptor: unexpected, openSession: unexpected } });
    expect(adapter).toMatchObject({ errorCode: "native_provider_overloaded", errorMessage: capacityMessage });
    const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(persisted.errorCode).toBeNull(); // Restart before adapter metadata is saved.
    expect(await readPersistedNativeProviderFailure(db, persisted, native.turnId, terminal)).toMatchObject({ errorCode: "native_provider_overloaded" });
    expect(await readPersistedNativeProviderFailure(db, { ...persisted, runnerProfileJson: null }, native.turnId, terminal)).toBeNull();
    expect(await readPersistedNativeProviderFailure(db, persisted, "different-turn", terminal)).toBeNull();
    if (mutateOwner) await db.update(issues).set({ assigneeAgentId: otherAgentId, executionRunId: null }).where(eq(issues.id, issueId));
    for (let replay = 0; replay < 2; replay++) await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    expect(provider.execute).toHaveBeenCalledTimes(1);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]).toMatchObject({ status: "failed", error: capacityMessage, errorCode: "native_provider_overloaded" });
    const [recoveredRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(recoveredRun.resultJson).toMatchObject({ providerFailure,
      nativeProviderFailure: { provider: kind, category: "server_overloaded" } });
    expect(projectTaskInterruption(issue, { run: recoveredRun, paused: false, approval: false }))
      .toMatchObject({ providerFailure });
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId))).toHaveLength(1);
    return recoveredRun;
  }

  it.each(["codex", "pi_rpc"] as const)("%s retries after one and two minutes across restart/replay, then stops", async kind => {
    const issueId = randomUUID(), originalRunId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Capacity task", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "capacity-owner" });
    await db.insert(heartbeatRuns).values({ id: originalRunId, companyId, agentId, responsibleUserId: "capacity-owner", contextSnapshot: { issueId, wakeCommentId: "original-message" } });
    let runId: string = originalRunId;
    const unexpected = vi.fn(async () => { throw new Error("Unexpected recovery"); });
    const release = createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, { resolveResponsibleUserId: unexpected, getRoutineEnv: unexpected, resolveSessionBeforeForWakeup: unexpected }),
      recovery: { escalateStrandedAssignedIssue: unexpected, escalateStrandedRecoveryIssueInPlace: unexpected },
    });
    for (let failure = 0; failure <= 2; failure++) {
      const before = Date.now();
      sentry.captureRunFailure.mockClear();
      await acceptCapacityFailure(runId, issueId, false, kind);
      await waitForPendingRunFailureReports();
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, runId)));
      if (failure === 2) {
        expect(successors).toHaveLength(0);
        // Exhaustion ends automatic recovery, so Sentry receives the failure.
        expect(sentry.captureRunFailure).toHaveBeenCalledOnce();
        expect(sentry.captureRunFailure.mock.calls[0]![0]).toMatchObject({ runId, runStatus: "failed" });
        expect(JSON.stringify(sentry.captureRunFailure.mock.calls)).not.toContain(providerDisplayMessage);
        expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "blocked", unblockDescriptor: { action: expect.stringContaining("Automatic retries exhausted") } });
        break;
      }
      expect(successors).toHaveLength(1);
      const retry = successors[0];
      expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: failure + 1, scheduledRetryReason: "native_provider_overloaded", error: NATIVE_PROVIDER_OVERLOADED_MESSAGE,
        contextSnapshot: { issueId, forceFreshSession: true, executionRetryAccounting: { version: 1, failureRetries: failure + 1, maxTurnContinuations: 0 } } });
      const [retryIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
      // Exercise the actual thread read, including its predecessor explanation join.
      expect(await taskInterruptionPresentation(db, retryIssue))
        .toMatchObject({ state: "retry_scheduled", providerFailure: { category: "overloaded",
          message: kind === "pi_rpc" ? "The model is at capacity." : providerDisplayMessage } });
      expect(retry.contextSnapshot).not.toHaveProperty("wakeCommentId");
      // The scheduled retry owns recovery; this failure stays out of Sentry.
      expect(sentry.captureRunFailure).not.toHaveBeenCalled();
      expect(retry.scheduledRetryAt!.getTime() - before).toBeGreaterThanOrEqual(60_000 * 2 ** failure);
      expect(retry.scheduledRetryAt!.getTime() - Date.now()).toBeLessThanOrEqual(60_000 * 2 ** failure);
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, retry.id));
      expect(wakes).toHaveLength(1);
      const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId));
      expect(await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.decisionId, decision.id))).toMatchObject([{ effectKind: "schedule_retry", targetType: "heartbeat_run", targetId: retry.id }]);
      expect((await release({ companyId, runId, now: new Date() })).outcome.kind).toBe("released");
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
      const schedulerAfterRestart = heartbeatService(db, { runtimeEnv: {} });
      expect(await schedulerAfterRestart.promoteDueScheduledRetries(new Date())).toMatchObject({ promoted: 0 });
      expect(await schedulerAfterRestart.promoteDueScheduledRetries(retry.scheduledRetryAt!)).toMatchObject({ promoted: 1, runIds: [retry.id] });
      runId = retry.id;
    }
    expect(unexpected).not.toHaveBeenCalled();
  });

  it("answers the saved person message once when the Pi capacity retry succeeds", async () => {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Ordinary message", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: "capacity-owner", conversationAgentId: agentId,
      conversationUserId: "capacity-owner", conversationState: "active" });
    const [message] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: "capacity-owner", body: "What is six times seven?" }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, responsibleUserId: "capacity-owner", contextSnapshot: { issueId, wakeCommentId: message.id, conversationSessionGeneration: 0 } });
    await acceptCapacityFailure(runId, issueId, false, "pi_rpc");
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    const unexpectedRecovery = async () => { throw new Error("Unexpected recovery"); };
    const release = createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, { resolveResponsibleUserId: unexpectedRecovery, getRoutineEnv: unexpectedRecovery, resolveSessionBeforeForWakeup: unexpectedRecovery }),
      recovery: { escalateStrandedAssignedIssue: unexpectedRecovery, escalateStrandedRecoveryIssueInPlace: unexpectedRecovery },
    });
    expect((await release({ companyId, runId, now: new Date() })).outcome.kind).toBe("released");
    expect(await heartbeatService(db, { runtimeEnv: {} }).promoteDueScheduledRetries(retry.scheduledRetryAt!)).toMatchObject({ promoted: 1, runIds: [retry.id] });
    const [issue] = await db.update(issues).set({ executionRunId: retry.id }).where(eq(issues.id, issueId)).returning();
    const [run] = await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: issueId, error: null, errorCode: null }).where(eq(heartbeatRuns.id, retry.id)).returning();
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const contractInput = buildNativeCompletionContract(issue, { revision: contract.revision });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1", binding: { companyId, runId: run.id, issueId, agentId, executionWorkspaceId: run.id },
      provider: { kind: "pi_rpc", model: "anthropic/test-model", profile: QUALIFIED_PI_RPC_PROFILE },
      task: { identifier: issueId, title: issue.title, description: null, prompt: message.body, workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "pi_rpc", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1", contract: contractInput },
      interactionResponses: [], credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, run.id));
    await db.insert(nativeRunFinalizations).values({ runId: run.id, companyId, issueId, phase: "observed" });
    const result = { ...CONTROL_PLANE_CONFORMANCE_RESULT, summary: "42", completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: contractInput.revision } };
    const terminal: PrpTerminalState = { schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "done" };
    provider.execute.mockReset().mockImplementation(async (options: { controlPlane: ControlPlanePort }) => {
      await options.controlPlane.openRun({ identity: { companyId, issueId, runId: run.id, agentId, sessionId: native.normalizedSessionId }, backendKind: "mock", sourceInstanceId: native.runnerInstanceId });
      await options.controlPlane.appendEvent({ schema: "paperclip.prp.event.v1", runId: run.id, normalizedSessionId: native.normalizedSessionId, turnId: native.turnId,
        sourceInstanceId: native.runnerInstanceId, sourceEventId: "answer", sourceSeq: 1, sourceKind: "runner", eventType: "item.completed", itemId: "answer", schemaVersion: 1, priority: 0,
        emittedAt: new Date().toISOString(), payload: { kind: "agentMessage", channel: "final", text: "42" } });
      // Real native execution journals the control-plane source as well as runner items.
      // Presentation re-derives the accepted result digest from that authenticated binding.
      await options.controlPlane.appendEvent({ schema: "paperclip.prp.event.v1", runId: run.id, normalizedSessionId: native.normalizedSessionId, turnId: native.turnId,
        sourceInstanceId: `${native.runnerInstanceId}:control`, sourceEventId: "result", sourceSeq: 1, sourceKind: "control_plane", eventType: "run.result.proposed", schemaVersion: 1, priority: 0,
        emittedAt: new Date().toISOString(), payload: result });
      await options.controlPlane.completeRun({ result, terminal, turnId: native.turnId });
      return { result, terminal, turnId: native.turnId, normalizedSessionId: native.normalizedSessionId, providerSessionId: "retry-session", driverKind: "pi_rpc", driverVersion: "fixture", nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    });
    const unexpected = async () => { throw new Error("Unexpected provider call"); };
    const adapter = await executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId, backend: { descriptor: unexpected, openSession: unexpected } });
    expect(adapter.exitCode).toBe(0);
    for (let replay = 0; replay < 2; replay++) await finalizeNativeRun({ db, runId: run.id, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    expect(provider.execute).toHaveBeenCalledTimes(1);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toMatchObject({ status: "succeeded", errorCode: null });
    const [savedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const [accepted] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, run.id));
    expect(await acceptedResponseDigestMatches(db, savedRun, accepted)).toBe(true);
    expect(await selectAcceptedFinalAgentMessage(db, { companyId, runId: run.id, agentId, nativeSessionId: native.normalizedSessionId,
      turnId: native.turnId, conversation: true, currentConversation: true })).toMatchObject({ text: "42" });
    const replies = await db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorAgentId, agentId)));
    expect(replies.map(reply => reply.body)).toEqual(["42"]);
    console.log("PI_CAPACITY_ANSWER_EVIDENCE", JSON.stringify({ failedRunId: runId, retryRunId: run.id,
      status: savedRun.status, replies: replies.map(reply => ({ id: reply.id, body: reply.body })) }));
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run.id))).toHaveLength(0);
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.runId, run.id))).toHaveLength(1);
  });

  it("uses failed-run history without lending a resumed task's consumed continuation receipt", async () => {
    const issueId = randomUUID(), runId = randomUUID(), olderRunId = randomUUID(), commentId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Resumed capacity task", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "capacity-owner" });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorUserId: "capacity-owner", authorType: "user", body: "Continue the investigation." });
    const consumedContext = { issueId, wakeCommentId: commentId, wakeCommentIds: [commentId],
      explicitUserContinuation: { previousRunId: olderRunId, commentId },
      previousRunId: olderRunId, resumeIntent: "continue", paperclipTurnContext: "Previously delivered context" };
    await db.insert(heartbeatRuns).values([
      { id: olderRunId, companyId, agentId, status: "failed", contextSnapshot: { issueId } },
      { id: runId, companyId, agentId, responsibleUserId: "capacity-owner", contextSnapshot: consumedContext },
    ]);
    await acceptCapacityFailure(runId, issueId);
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(retry.contextSnapshot).not.toHaveProperty("explicitUserContinuation");
    expect(retry.contextSnapshot).not.toHaveProperty("wakeCommentId");
    expect(retry.contextSnapshot).not.toHaveProperty("resumeIntent");
    expect(retry.contextSnapshot).not.toHaveProperty("paperclipTurnContext");
    const continuation = await buildExecutionContinuation({ db, companyId, issueId, agentId,
      runId: retry.id, context: retry.contextSnapshot!, summary: null, exposeLowTrustRaw: false });
    expect(continuation).toMatchObject({ trigger: { sourceRunId: runId }, objective: "Continue the investigation.",
      messages: [expect.objectContaining({ id: commentId, body: "Continue the investigation." })] });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].contextSnapshot)
      .toEqual(consumedContext);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, retry.id));
  });

  it("does not claim a capacity retry before predecessor cleanup settles", async () => {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Cleanup capacity task", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "capacity-owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, responsibleUserId: "capacity-owner", contextSnapshot: { issueId } });
    await acceptCapacityFailure(runId, issueId);
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, issueId));
    const scheduler = heartbeatService(db, { runtimeEnv: {} });
    expect(await scheduler.promoteDueScheduledRetries(retry.scheduledRetryAt!)).toMatchObject({ promoted: 1 });
    await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId, provider: "local", status: "pending_cleanup", cleanupStatus: "failed" });
    await scheduler.resumeQueuedRuns();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry.id)))[0].status).toBe("queued");
    expect(provider.execute).toHaveBeenCalledTimes(1);
    // Do not leave a runnable fixture behind for the next case.
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, retry.id));
  });

  it("does not retry or change the task after reassignment", async () => {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Reassigned capacity task", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "capacity-owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, responsibleUserId: "capacity-owner", contextSnapshot: { issueId } });
    sentry.captureRunFailure.mockClear();
    await acceptCapacityFailure(runId, issueId, true);
    await waitForPendingRunFailureReports();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toHaveLength(0);
    // No retry owns this failure, so it remains reportable.
    expect(sentry.captureRunFailure).toHaveBeenCalledOnce();
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "in_progress", assigneeAgentId: otherAgentId });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).filter(wake => wake.payload?.issueId === issueId)).toHaveLength(0);
  });
});
