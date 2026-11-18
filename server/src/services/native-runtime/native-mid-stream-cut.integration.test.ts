import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, completionContracts, createDb, heartbeatRuns, issueComments,
  issues, nativeRunFinalizations, statusDecisionEffects, statusDecisions } from "@paperclipai/db";
import type { ControlPlanePort, NativeExecutionInputV1, PrpEvent, PrpTerminalState } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT } from "../../vendor/paperclip-runner/testing.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()),
  executeNativeSession: provider.execute,
}));

import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { projectPaperclipRunnerTaskConfig, resolvePaperclipRunnerNativeProviderInput } from "./provider-profile.js";
import { applyNativeMidStreamCutOpening, classifyNativeMidStreamCut, isNativeProviderAccountFailure, readExhaustedNativeMidStreamCutCandidate } from "./native-mid-stream-cut.js";
import { NATIVE_RUN_FAILED_CONTINUATION_EXHAUSTED_ACTION } from "./status-arbiter.js";
import { heartbeatService } from "../heartbeat.js";
import { createReleaseIssueExecution } from "../../modules/wake-queue/application/use-cases.js";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { requestTaskRetry } from "../task-retry.js";
import { readThinkingCapStop, resolveRunAssigneeAdapterOverrides, thinkingCapStopCandidate } from "../thinking-cap-stop.js";
import { callbacks } from "../../__tests__/helpers/judge-completion-support.js";
import { createHeartbeatRunCompletion } from "../heartbeat/run-completion.js";
import { createHeartbeatRunPreparation } from "../heartbeat/run-preparation.js";
import { getAdapterSessionCodec } from "../heartbeat/run-state.js";
import { buildEffectiveRunSessionConfigMetadata } from "../heartbeat/workspaces.js";
import { issueService } from "../issues.js";
import * as usageReceipts from "../usage-receipts.js";
import { settleUnansweredPersonMessagesForTask, unansweredPersonMessageCondition } from "../recovery/unanswered-person-message.js";

// dl famlong-u1. Live (review-fleet-2): after a mid-stream cut the recovery
// path never ran. The status arbiter's GENERIC successor ran instead (context
// source native_status_decision, wake issue_status_changed), resuming the same
// Pi session at the same level:
//   gate 3 r1 f8938765, gate 3 r2 0641e970 (cap) -> fab92601 (cap) -> "Your
//   message wasn't answered. Sending it again is safe…"; gate 5 6490dd70 (EOF
//   mid-thinking) -> 3a301e73 resumed.
// These run the REAL scheduling path: runner terminal -> finalizeNativeRun ->
// arbiter -> status-decision committer -> the wake / retry dispatchers.
type CutShape = "cap_no_text" | "cap_mid_answer" | "eof_mid_thinking" | "provider_error_mid_answer" | "transport_mid_answer" | "other_provider_error_mid_answer" | "refusal";
const CAP_EXHAUSTED_NOTE = "The model ran out of output budget before answering. Press Retry to try once more.";
const CONNECTION_EXHAUSTED_NOTE = "The connection to the model dropped before the answer finished. Press Retry to try once more.";
const PROVIDER_EXHAUSTED_NOTE = "The model provider returned an error before the answer finished. Press Retry to try once more.";
const PARTIAL_ANSWER = "Step 1: snapshot the invoices table. Step 2: ";
const ASK = "Write the full migration plan for the billing tables, every step, nothing left out.";
const STORED = { provider: "pi_rpc", model: "paperclip/faux", piRpcThinkingLevel: "xhigh" };

describe("native mid-stream cut: one successor, through recovery", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    vi.spyOn(usageReceipts, "indexPendingUsageReceipts").mockResolvedValue(new Map());
    vi.spyOn(usageReceipts, "recoverPendingRunUsageReceipts").mockResolvedValue([]);
    temporary = await startEmbeddedPostgresTestDatabase("native-mid-stream-cut-");
    db = createDb(temporary.connectionString);
    await db.insert(authUsers).values({ id: "board-user", name: "Judge", email: "judge@example.test", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Native mid-stream cut", issuePrefix: "MSC" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Pi agent", status: "active", adapterType: "paperclip_runner", adapterConfig: STORED,
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    // Keep dispatch real but hold execution: these rows qualify scheduling/publication,
    // not a live provider. No background provider or gate access is allowed here.
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: { issueId: randomUUID() } });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board-user", status: "active", membershipRole: "member" });
  });
  afterAll(async () => { await heartbeatService(db).drainActiveRunExecutions(); await db?.$client.end(); await temporary?.cleanup(); });

  async function task() {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Billing migration", status: "in_progress", workMode: "standard",
      assigneeAgentId: agentId, createdByUserId: "board-user", responsibleUserId: "board-user" });
    await db.insert(issueComments).values({ companyId, issueId, authorUserId: "board-user", authorType: "user", body: ASK });
    return issueId;
  }

  /** The runner events of one cut turn, as the Pi driver emits them (pi-rpc-driver.ts :1705-1710). */
  function cutEvents(shape: CutShape, base: Omit<PrpEvent, "sourceEventId" | "sourceSeq" | "eventType" | "payload">): PrpEvent[] {
    const item = (seq: number, kind: "reasoning" | "agentMessage", text: string): PrpEvent => ({ ...base, sourceEventId: `item-${seq}`,
      sourceSeq: seq, eventType: "item.delta", itemId: `${base.turnId}:${kind === "reasoning" ? "pi-thinking" : "pi-message"}:1`,
      payload: { kind, text } } as PrpEvent);
    const failed = (seq: number, error: Record<string, unknown>): PrpEvent => ({ ...base, sourceEventId: "turn-terminal", sourceSeq: seq,
      eventType: "turn.failed", payload: { status: "failed", error } } as PrpEvent);
    if (shape === "cap_no_text") return [item(1, "reasoning", "thinking only ".repeat(400)),
      failed(2, { code: "pi_output_truncated", message: "Pi's final assistant response reached its output limit.", recoverable: false })];
    if (shape === "eof_mid_thinking") return [item(1, "reasoning", "considering the tables ".repeat(50)),
      failed(2, { code: "pi_provider_error", message: "unexpected EOF" })];
    if (shape === "cap_mid_answer") return [item(1, "agentMessage", PARTIAL_ANSWER),
      failed(2, { code: "pi_output_truncated", message: "Pi's final assistant response reached its output limit." })];
    if (shape === "other_provider_error_mid_answer") return [item(1, "agentMessage", PARTIAL_ANSWER),
      failed(2, { code: "pi_provider_error", message: "The provider encountered an internal error." })];
    if (shape === "provider_error_mid_answer" || shape === "transport_mid_answer") return [item(1, "agentMessage", PARTIAL_ANSWER),
      failed(2, { code: shape === "transport_mid_answer" ? "pi_rpc_transport_failed" : "pi_provider_error", message: "upstream connect error: stream reset" })];
    return [failed(1, { code: "pi_provider_error", stopCategory: "reasoning_extraction",
      message: "This request appears to violate our Terms of Service. Please see the Usage Policies." })];
  }

  /** One cut turn through the real executor and finalizer. `existingRunId` is an already-materialized successor. */
  async function cutTurn(issueId: string, shape: CutShape, existingRunId?: string) {
    const runId = existingRunId ?? randomUUID();
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [message] = await db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "user")));
    const [run] = existingRunId
      ? await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: issueId, error: null, errorCode: null,
        startedAt: new Date() }).where(eq(heartbeatRuns.id, existingRunId)).returning()
      : await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId,
        responsibleUserId: "board-user", invocationSource: "on_demand", triggerDetail: "manual",
        contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentId: message.id } }).returning();
    await db.update(issues).set({ status: "in_progress", executionRunId: runId, checkoutRunId: null }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const completionInput = buildNativeCompletionContract(issue, { revision: contract.revision });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "opencode", model: "openrouter/test-model" },
      task: { identifier: issueId, title: issue.title, description: null, prompt: ASK, workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "opencode_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1", contract: completionInput },
      interactionResponses: [], credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
    const events = cutEvents(shape, { schema: "paperclip.prp.event.v1", runId, normalizedSessionId: native.normalizedSessionId,
      turnId: native.turnId, sourceInstanceId: native.runnerInstanceId, sourceKind: "runner", schemaVersion: 1, priority: 0,
      emittedAt: new Date().toISOString() } as Omit<PrpEvent, "sourceEventId" | "sourceSeq" | "eventType" | "payload">);
    const terminal: PrpTerminalState = { schema: "paperclip.prp.terminal.v1", turnTerminalState: "failed", runTerminalState: "failed", reportedWorkDisposition: "needs_review" };
    const result = { ...CONTROL_PLANE_CONFORMANCE_RESULT, reportedWorkDisposition: "needs_review" as const,
      completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: completionInput.revision } };
    const openInput = { identity: { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId }, backendKind: "mock" as const, sourceInstanceId: native.runnerInstanceId };
    provider.execute.mockReset().mockImplementation(async (options: { controlPlane: ControlPlanePort }) => {
      await options.controlPlane.openRun(openInput);
      for (const event of events) await options.controlPlane.appendEvent(event);
      await options.controlPlane.completeRun({ result, terminal, turnId: native.turnId });
      return { result, terminal, turnId: native.turnId, normalizedSessionId: native.normalizedSessionId, providerSessionId: "fixture-provider-session", driverKind: execution.session.driverKind, driverVersion: "fixture", nativeEventCount: events.length, highestContiguousSourceSeq: events.length, usage: null };
    });
    await executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId, backend: {
      descriptor: async () => { throw new Error("Unexpected provider call"); },
      openSession: async () => { throw new Error("Unexpected provider call"); },
    } });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const [cut] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(cut.status).toBe("failed");
    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId));
    const effects = await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.decisionId, decision.id));
    return { runId, decision, effects };
  }

  /** Real completion publication, replay and the unanswered-message worker boundary. */
  async function assertOnePublishedNoteAfterSweep(issueId: string, runId: string, expectedBody = CAP_EXHAUSTED_NOTE) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const deps = callbacks(db, true);
    deps.issuesSvc.addComment.mockImplementation(issueService(db).addComment);
    const completion = createHeartbeatRunCompletion(db, deps);
    const input: Parameters<typeof completion.completeRun>[0] = {
      run, agent, issueId, issueRef: issue, signal: new AbortController().signal,
      output: { handle: { store: "local_file", logRef: "second-cut" }, outputProgressState: { pending: { bytes: 0 } },
        flushOutputProgress: async () => {}, stdoutExcerpt: "", stderrExcerpt: "" },
      session: { runtimeForAdapter: { sessionId: null, sessionDisplayId: null }, previousSessionParams: null, taskKey: issueId,
        configuredModel: "paperclip/faux", sessionConfigMetadata: await buildEffectiveRunSessionConfigMetadata({ adapterType: agent.adapterType,
          effectiveAdapterConfig: agent.adapterConfig, agentRuntimeConfig: {}, issueOverrides: null, workspaceConfig: null,
          environment: null, environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [] }) },
      readFailureReportSecrets: () => [],
      adapterResult: { exitCode: 1, signal: null, timedOut: false, sessionId: "fixture-provider-session",
        sessionParams: { sessionId: "fixture-provider-session" }, errorCode: "adapter_failed",
        errorMessage: run.error ?? "Provider turn failed", resultJson: run.resultJson ?? {},
        nativeFinalization: { schema: "paperclip.native-finalization.v1", runtimeMode: "native", runId, issueId, companyId, result: {},
          terminal: { schema: "paperclip.prp.terminal.v1", turnTerminalState: "failed", runTerminalState: "failed", reportedWorkDisposition: "needs_review" },
          turnId: null, sourceInstanceId: run.runnerInstanceId!, normalizedSessionId: run.nativeSessionId!, providerSessionId: "fixture-provider-session",
          driverKind: "opencode_server", driverVersion: "fixture", nativeEventCount: 2, highestContiguousSourceSeq: 2, workspaceFinalizeStatus: "succeeded" } },
      sessionCodec: getAdapterSessionCodec(agent.adapterType), taskSessionForRun: null, sessionCompaction: { rotate: false, reason: null },
      configFreshnessResultMetadata: { version: 1 }, runLedgerScope: {}, currentUserRedactionOptions: { enabled: false },
      providerTraceCapture: false, onProviderTraceFinalized: () => {},
      issueContext: await createHeartbeatRunPreparation(db).getIssueExecutionContext(companyId, issueId), onLog: async () => {},
    };
    await completion.completeRun(input);
    await completion.completeRun(input); // crash/replay must not duplicate the completion note
    // No grace-period escape: revisit long after both the settle and bounded-wait windows.
    for (const delay of [60_000, 60 * 60_000]) {
      expect(await settleUnansweredPersonMessagesForTask(db, { companyId, issueId, now: new Date(Date.now() + delay) }))
        .toEqual({ noticed: 0, pending: 0 });
    }
    const comments = (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
      .filter(comment => comment.authorType !== "user" && !comment.deletedAt);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ createdByRunId: runId,
      body: expectedBody });
    expect(comments[0]!.body).not.toMatch(/continuing|wasn't answered|Sending it again is safe/u);
    expect(await db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, issueId),
      unansweredPersonMessageCondition(issues.id, issues.companyId)))).toEqual([]);
    console.log("SECOND CUT PUBLICATION + SWEEP", JSON.stringify({ runId, issueId, comments, task: issue }));
  }

  const issueWakes = async (issueId: string) => (await db.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.companyId, companyId))).filter(wake => wake.payload?.issueId === issueId);
  /** The arbiter's generic successor: the committer's native_status_decision intent, and any run it started. */
  const genericWakes = async (issueId: string) => (await issueWakes(issueId)).filter(wake =>
    wake.requestedByActorId === "native-status-committer" || wake.requestedByActorId?.startsWith("native-status-wake-dispatch:")
    || (wake.payload?._paperclipWakeContext as Record<string, unknown> | undefined)?.source === "native_status_decision");
  const successorsOf = async (issueId: string, cutRunId: string) => (await db.select().from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId))))
    .filter(run => run.id !== cutRunId && run.contextSnapshot?.issueId === issueId);
  async function nativeInputLevel(runId: string) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const overrides = await resolveRunAssigneeAdapterOverrides(db, { companyId, runId, agent: agent!,
      issueContext: { assigneeAgentId: agentId, assigneeAdapterOverrides: null } });
    const input = resolvePaperclipRunnerNativeProviderInput({ backend: "pi_rpc",
      adapterConfig: projectPaperclipRunnerTaskConfig("pi_rpc", agent!.adapterConfig, overrides?.adapterConfig) });
    return input.provider === "pi_rpc" ? input.piRpcThinkingLevel : null;
  }
  async function opening(run: typeof heartbeatRuns.$inferSelect, issueId: string) {
    const context: Record<string, unknown> = { ...run.contextSnapshot };
    await applyNativeMidStreamCutOpening(db, { run, issueId, context });
    return context;
  }
  /** Every dispatcher that could start a successor runs; returns the task's successor runs after them. */
  async function dispatchEverything(issueId: string, cutRunId: string) {
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    // As in production: the finished run releases the task's execution before anything follows it.
    const unexpected = async () => { throw new Error("Unexpected recovery"); };
    const release = createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, { resolveResponsibleUserId: unexpected, getRoutineEnv: unexpected, resolveSessionBeforeForWakeup: unexpected }),
      recovery: { escalateStrandedAssignedIssue: unexpected, escalateStrandedRecoveryIssueInPlace: unexpected },
    });
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    if (task?.executionRunId) await release({ companyId, runId: task.executionRunId, now: new Date() });
    const generic = await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    const promoted = await heartbeat.promoteDueScheduledRetries(new Date(Date.now() + 1_000));
    return { heartbeat, generic, promoted, successors: await successorsOf(issueId, cutRunId) };
  }

  it("RED gate 3 r2 (0641e970 -> fab92601): a cap stop with no text has ONE successor, a new process on the SAME conversation at 'high'; the cut turn is not sent, and no generic wake; a second cap stop ends in one true note with a real Retry", async () => {
    const issueId = await task();
    const first = await cutTurn(issueId, "cap_no_text");
    expect(first.decision.reasonCode).toBe("run_failed_partial_evidence_preserved");
    // The decision's one effect is the recovery successor, not a wake request.
    expect(first.effects.filter(effect => effect.effectKind === "schedule_retry" || effect.effectKind === "enqueue_continuation"))
      .toMatchObject([{ effectKind: "schedule_retry", targetType: "heartbeat_run", payload: { cause: "native_mid_stream_cut" } }]);
    expect(await genericWakes(issueId)).toEqual([]);

    const { heartbeat, generic, promoted, successors } = await dispatchEverything(issueId, first.runId);
    expect(generic).toMatchObject({ dispatched: 0 });
    expect(successors).toHaveLength(1);
    const successor = successors[0]!;
    expect(promoted).toMatchObject({ promoted: 1, runIds: [successor.id] });
    expect(successor.id).toBe(first.effects.find(effect => effect.effectKind === "schedule_retry")!.targetId);
    expect(successor).toMatchObject({ retryOfRunId: first.runId, scheduledRetryReason: "native_mid_stream_cut",
      contextSnapshot: { issueId, source: "native_mid_stream_cut", wakeReason: "native_mid_stream_cut", previousRunId: first.runId,
        forceFreshSession: true, nativeMidStreamCut: "output_cap_no_text" } });
    expect(successor.contextSnapshot).not.toHaveProperty("nativeStatusWakeIntentId");
    expect(successor.contextSnapshot).not.toHaveProperty("statusDecisionSource");
    expect(await genericWakes(issueId)).toEqual([]);
    // A new process on the SAME conversation; the cut turn is not sent.
    // 'high' applies to exactly this run; the agent's stored level is unchanged.
    expect(await nativeInputLevel(first.runId)).toBe("xhigh");
    expect(await nativeInputLevel(successor.id)).toBe("high");
    expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0]!.adapterConfig).toEqual(STORED);
    // The new process's opening carries the ask verbatim; the cut turn is not sent.
    const opened = await opening(successor, issueId);
    expect(opened.livenessContinuationInstruction).toContain("Write the answer now; keep further thinking short.");
    expect(opened.livenessContinuationInstruction).toContain(ASK);
    await heartbeat.drainActiveRunExecutions();

    // The ONE successor stops at the cap too: nothing runs again by itself.
    const second = await cutTurn(issueId, "cap_no_text", successor.id);
    expect(second.decision).toMatchObject({ reasonCode: "native_run_failed_continuation_exhausted", toStatus: "blocked" });
    const after = await dispatchEverything(issueId, first.runId);
    expect(after.generic).toMatchObject({ dispatched: 0 });
    expect(after.successors.map(run => run.id)).toEqual([successor.id]);
    expect(await genericWakes(issueId)).toEqual([]);
    // ONE true note: no 'continuing', no 'safe to send again'.
    const stop = await readThinkingCapStop(db, { companyId, runId: successor.id });
    expect(stop).toMatchObject({ repeated: true });
    const note = thinkingCapStopCandidate(stop!).text;
    expect(note).toBe("The model ran out of output budget before answering. Press Retry to try once more.");
    expect(note).not.toMatch(/continuing|wasn't answered|Sending it again is safe/u);
    const [blocked] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(blocked).toMatchObject({ status: "blocked", unblockDescriptor: { owner: "board", action: NATIVE_RUN_FAILED_CONTINUATION_EXHAUSTED_ACTION } });
    expect(NATIVE_RUN_FAILED_CONTINUATION_EXHAUSTED_ACTION).not.toMatch(/continuing|Sending it again is safe/u);
    await assertOnePublishedNoteAfterSweep(issueId, second.runId);
    // A real Retry: accepted, and it starts one run of the task.
    const receipt = await requestTaskRetry({ db, companyId, issueId, actorId: "board-user", actorSource: "session",
      idempotencyKey: randomUUID(), observedRunId: second.runId });
    expect(receipt).toMatchObject({ accepted: true, stale: false });
    await after.heartbeat.resumeTaskRetry(companyId, receipt.requestId!);
    const retried = (await successorsOf(issueId, first.runId)).filter(run => run.contextSnapshot?.taskRetryRequestId === receipt.requestId);
    expect(retried).toHaveLength(1);
    await after.heartbeat.drainActiveRunExecutions();
  }, 180_000);

  it("(vii) provider-error -> cap exhausts the automatic budget: one published true note survives the unanswered sweep, and Retry queues one run", async () => {
    const issueId = await task();
    const first = await cutTurn(issueId, "eof_mid_thinking");
    const { heartbeat, successors } = await dispatchEverything(issueId, first.runId);
    expect(successors).toHaveLength(1);
    const second = await cutTurn(issueId, "cap_no_text", successors[0]!.id);
    expect(second.decision.reasonCode).toBe("native_run_failed_continuation_exhausted");
    const after = await dispatchEverything(issueId, first.runId);
    expect(after.successors.map(run => run.id)).toEqual([second.runId]);
    await assertOnePublishedNoteAfterSweep(issueId, second.runId);
    const receipt = await requestTaskRetry({ db, companyId, issueId, actorId: "board-user", actorSource: "session",
      idempotencyKey: randomUUID(), observedRunId: second.runId });
    expect(receipt).toMatchObject({ accepted: true, stale: false });
    await heartbeat.resumeTaskRetry(companyId, receipt.requestId!);
    const manual = (await successorsOf(issueId, first.runId)).filter(run => run.contextSnapshot?.taskRetryRequestId === receipt.requestId);
    expect(manual).toHaveLength(1);
    expect(manual[0]!.status).toBe("queued");
    await heartbeat.drainActiveRunExecutions();
  }, 180_000);

  // Real executor -> finalizer -> dispatch -> completion/replay -> sweep, for
  // every cut mix. No provider execution or additional automatic send is allowed.
  const cuts = ["cap_no_text", "cap_mid_answer", "eof_mid_thinking", "provider_error_mid_answer", "transport_mid_answer", "other_provider_error_mid_answer"] as const;
  it.each(cuts.flatMap(first => cuts.map(last => [first, last] as const)))(
    "exhausted cut %s -> %s publishes the LAST failure once, never a generic resend",
    async (firstShape, lastShape) => {
      const issueId = await task();
      const first = await cutTurn(issueId, firstShape);
      const { heartbeat, successors } = await dispatchEverything(issueId, first.runId);
      expect(successors).toHaveLength(1);
      const second = await cutTurn(issueId, lastShape, successors[0]!.id);
      expect(second.decision.reasonCode).toBe("native_run_failed_continuation_exhausted");
      const after = await dispatchEverything(issueId, first.runId);
      expect(after.successors.map(run => run.id)).toEqual([second.runId]);
      expect(await genericWakes(issueId)).toEqual([]);
      const note = lastShape.startsWith("cap_") ? CAP_EXHAUSTED_NOTE
        : lastShape === "other_provider_error_mid_answer" ? PROVIDER_EXHAUSTED_NOTE : CONNECTION_EXHAUSTED_NOTE;
      const prefix = lastShape.endsWith("mid_answer") ? `${PARTIAL_ANSWER}\n\n— ` : "";
      await assertOnePublishedNoteAfterSweep(issueId, second.runId, prefix + note);
      await heartbeat.drainActiveRunExecutions();
    }, 180_000,
  );

  // A small pure classifier guard is needed: a generic provider-error note alone
  // could hide an account rejection incorrectly admitted to the automatic cut lane.
  it.each([
    { message: "insufficient_quota: billing hard limit reached" },
    { message: "Provider quota exceeded for this model." },
    { message: "Billing hard limit reached." },
    { message: "401 Unauthorized" },
    { message: "403 Forbidden" },
    { message: "authentication_error: invalid credentials" },
    { message: "invalid_api_key" },
    { httpStatus: 401 },
    { statusCode: 403 },
    { status: 402 },
    { code: "pi_auth_required" },
    { providerCode: "pi_auth_required" },
    { code: "insufficient_quota" },
    { providerCode: "quota_exhausted" },
    { providerCode: "invalid_api_key" },
    ...["quota_exhausted", "authentication", "permission"].map(category => ({
      providerFailure: { schema: "paperclip.provider-failure.v1", provider: "pi", phase: "turn", category,
        message: "Account action required", retryability: "requires_action" },
    })),
  ])("account rejection never enters the cut lane: %j", async detail => {
    const rows = [{ seq: 1, payload: { prpEvent: { eventType: "turn.failed", payload: {
      status: "failed", error: { code: "pi_provider_error", ...detail },
    } } } }];
    expect(isNativeProviderAccountFailure({ code: "pi_provider_error", ...detail })).toBe(true);
    expect(classifyNativeMidStreamCut(rows)).toBeNull();
    expect(await readExhaustedNativeMidStreamCutCandidate(db, { companyId, runId: randomUUID() }, rows)).toBeNull();
  });

  it.each([
    { message: "unexpected EOF while fetching billing tables" },
    { message: "Account billing requires attention." },
    { message: "unexpected EOF while checking quota" },
    { message: "connection reset while checking auth" },
    { message: "unexpected EOF while reading the credit balance table" },
    { message: "unexpected EOF fetching table 401" },
    ...["pi_rpc_transport_failed", "EOF", "unexpected_eof", "transport_eof", "ECONNRESET", "EPIPE", "ERR_STREAM_PREMATURE_CLOSE"].map(code => ({
      code, httpStatus: 401, providerCode: "pi_auth_required",
      message: "insufficient_quota: billing hard limit reached; 401 Unauthorized",
      providerFailure: { schema: "paperclip.provider-failure.v1", provider: "pi", phase: "turn", category: "authentication",
        message: "Account action required", retryability: "requires_action" },
    })),
    ...[429, 529].flatMap(status => [
      { httpStatus: status, message: "insufficient_quota: billing hard limit reached" },
      { statusCode: status, providerCode: "pi_auth_required" },
      { status, message: "401 Unauthorized" },
      { message: `HTTP ${status}: insufficient_quota: billing hard limit reached` },
      { providerFailure: { schema: "paperclip.provider-failure.v1", provider: "pi", phase: "turn", category: "quota_exhausted",
        httpStatus: status, message: "Account action required", retryability: "requires_action" } },
    ]),
    ...["rate_limit", "overloaded"].map(category => ({
      message: "insufficient_quota: billing hard limit reached",
      providerFailure: { schema: "paperclip.provider-failure.v1", provider: "pi", phase: "turn", category,
        message: "Try again later", retryability: "transient" },
    })),
  ])("topics, transport and capacity are never account failures: %j", detail => {
    expect(isNativeProviderAccountFailure({ code: "pi_provider_error", ...detail })).toBe(false);
  });

  it("RED gate 5 (6490dd70 -> 3a301e73): an EOF mid-thinking has ONE successor through recovery, resuming the session, and no generic wake", async () => {
    const issueId = await task();
    const cut = await cutTurn(issueId, "eof_mid_thinking");
    expect(cut.effects.filter(effect => effect.effectKind === "schedule_retry"))
      .toMatchObject([{ targetType: "heartbeat_run", payload: { cause: "native_mid_stream_cut" } }]);
    const { heartbeat, generic, successors } = await dispatchEverything(issueId, cut.runId);
    expect(generic).toMatchObject({ dispatched: 0 });
    expect(await genericWakes(issueId)).toEqual([]);
    expect(successors).toHaveLength(1);
    const successor = successors[0]!;
    expect(successor).toMatchObject({ retryOfRunId: cut.runId, scheduledRetryReason: "native_mid_stream_cut",
      contextSnapshot: { source: "native_mid_stream_cut", wakeReason: "native_mid_stream_cut", nativeMidStreamCut: "provider_error" } });
    // It MAY resume the same live process: no forced process restart, so the stored level.
    expect(successor.contextSnapshot).not.toHaveProperty("forceFreshSession");
    expect(await nativeInputLevel(successor.id)).toBe("xhigh");
    expect((await opening(successor, issueId)).livenessContinuationInstruction).toBeUndefined();
    await heartbeat.drainActiveRunExecutions();
  }, 180_000);

  it("RED: a provider error mid-answer has ONE successor through recovery, told to continue the cut answer, and no generic wake", async () => {
    const issueId = await task();
    const cut = await cutTurn(issueId, "provider_error_mid_answer");
    const { heartbeat, generic, successors } = await dispatchEverything(issueId, cut.runId);
    expect(generic).toMatchObject({ dispatched: 0 });
    expect(await genericWakes(issueId)).toEqual([]);
    expect(successors).toHaveLength(1);
    const successor = successors[0]!;
    expect(successor).toMatchObject({ retryOfRunId: cut.runId,
      contextSnapshot: { source: "native_mid_stream_cut", wakeReason: "native_mid_stream_cut", nativeMidStreamCut: "provider_error" } });
    expect(successor.contextSnapshot).not.toHaveProperty("forceFreshSession");
    const opened = await opening(successor, issueId);
    expect(opened.livenessContinuationInstruction).toContain("the connection to the model ended mid-answer");
    await heartbeat.drainActiveRunExecutions();
  }, 180_000);

  it("RED: a provider refusal (Terms of Service, reasoning_extraction) is terminal: zero successors, no wake of any kind", async () => {
    const issueId = await task();
    const cut = await cutTurn(issueId, "refusal");
    expect(cut.decision.reasonCode).toBe("native_provider_refusal_terminal");
    expect(cut.effects.filter(effect => effect.effectKind === "schedule_retry" || effect.effectKind === "enqueue_continuation")).toEqual([]);
    const { heartbeat, generic, promoted, successors } = await dispatchEverything(issueId, cut.runId);
    expect(generic).toMatchObject({ dispatched: 0 });
    expect(promoted).toMatchObject({ promoted: 0 });
    expect(successors).toEqual([]);
    expect(await issueWakes(issueId)).toEqual([]);
    // The task is left as it was; this path creates no re-send.
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "in_progress", assigneeAgentId: agentId });
    await heartbeat.drainActiveRunExecutions();
  }, 180_000);

  it("control: a failure that is not a mid-stream cut keeps the generic continuation", async () => {
    const issueId = await task();
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toBeTruthy();
    // opencode_empty_response is covered end to end by native-failed-turn-continuation.integration.test.ts;
    // here: the classifier leaves every non-Pi-cut code alone.
    const { classifyNativeMidStreamCut } = await import("./native-mid-stream-cut.js");
    const failed = (error: Record<string, unknown>) => [{ seq: 1, payload: { prpEvent: { eventType: "turn.failed", turnId: "t",
      payload: { status: "failed", error } } } }];
    expect(classifyNativeMidStreamCut(failed({ code: "opencode_empty_response" }))).toBeNull();
    expect(classifyNativeMidStreamCut(failed({ code: "opencode_server_exited" }))).toBeNull();
    expect(classifyNativeMidStreamCut([{ seq: 1, payload: { prpEvent: { eventType: "turn.completed", turnId: "t", payload: {} } } }])).toBeNull();
    expect(classifyNativeMidStreamCut(failed({ code: "pi_provider_error", message: "unexpected EOF" }))).toBe("provider_error");
  });
});
