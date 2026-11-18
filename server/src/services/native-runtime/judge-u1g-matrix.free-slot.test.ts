import { appendFileSync } from "node:fs";
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

import { QUALIFIED_PI_RPC_PROFILE } from "../../vendor/paperclip-runner/index.js";
import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { projectPaperclipRunnerTaskConfig, resolvePaperclipRunnerNativeProviderInput } from "./provider-profile.js";
import { applyNativeMidStreamCutOpening, readExhaustedNativeMidStreamCutCandidate, isNativeProviderAccountFailure, classifyNativeMidStreamCut } from "./native-mid-stream-cut.js";
import { NATIVE_RUN_FAILED_CONTINUATION_EXHAUSTED_ACTION } from "./status-arbiter.js";
import { heartbeatService } from "../heartbeat.js";
import { createReleaseIssueExecution } from "../../modules/wake-queue/application/use-cases.js";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { deliverReconciledExecutions } from "../execution-recovery-resolution.js";
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
type CutShape = string;
const matrixErrors: Record<string, Record<string, unknown>> = {"a_billing": {"code": "pi_rpc_transport_failed", "message": "unexpected EOF while fetching billing tables"}, "a_quota": {"code": "pi_rpc_transport_failed", "message": "unexpected EOF while checking quota"}, "a_auth": {"code": "pi_rpc_transport_failed", "message": "unexpected EOF while refreshing auth token"}, "b_rate": {"code": "pi_provider_error", "message": "429 Too Many Requests: rate limit exceeded"}, "c_openai": {"code": "pi_provider_error", "message": "429 You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs\u2026"}, "d_gemini": {"code": "pi_provider_error", "message": "429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric \u2026 per minute"}, "e_overload": {"code": "pi_provider_error", "message": "529 overloaded_error"}, "f_credit": {"code": "pi_provider_error", "httpStatus": 400, "message": "Your credit balance is too low to access the Anthropic API"}, "g_401": {"code": "pi_provider_error", "httpStatus": 401, "message": "401 invalid_api_key: invalid API key"}, "g_402": {"code": "pi_provider_error", "httpStatus": 402, "message": "402 Payment Required"}, "g_403": {"code": "pi_provider_error", "httpStatus": 403, "message": "403 permission_error: access denied"}, "h_rate": {"code": "pi_provider_error", "message": "429 Too Many Requests: rate limit exceeded"}, "h_overload": {"code": "pi_provider_error", "message": "529 overloaded_error"}, "m_typed429": {"code": "pi_provider_error", "httpStatus": 429, "message": "429 You exceeded your current quota, please check your plan and billing details.", "providerFailure": {"schema": "paperclip.provider-failure.v1", "provider": "pi", "phase": "turn", "category": "quota_exhausted", "message": "Quota exhausted", "retryability": "requires_action", "httpStatus": 429}}, "m_typed529": {"code": "pi_provider_error", "httpStatus": 529, "message": "529 overloaded_error", "providerFailure": {"schema": "paperclip.provider-failure.v1", "provider": "pi", "phase": "turn", "category": "quota_exhausted", "message": "Quota exhausted", "retryability": "requires_action", "httpStatus": 529}}};
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
    if (matrixErrors[shape]) return [...(shape.startsWith("h_") ? [item(1, "agentMessage", "Step 1: snapshot the invoices table. Step 2: ")] : []), failed(shape.startsWith("h_") ? 2 : 1, matrixErrors[shape])];
    const extra: Record<string, Record<string, unknown>> = {
      auth401: {code:"pi_provider_error",httpStatus:401,message:"401 invalid_api_key: invalid API key"},
      permission403: {code:"pi_provider_error",httpStatus:403,message:"403 permission_error: access denied"},
      quota_eof: {code:"pi_provider_error",message:"unexpected EOF while checking quota"},
      auth_transport: {code:"pi_rpc_transport_failed",message:"connection reset while checking auth"},
      billing_eof: {code:"pi_rpc_transport_failed",message:"unexpected EOF while fetching billing tables"},
      rate429: {code:"pi_provider_error",httpStatus:429,message:"429 rate limit reached; try again later"},
      overload529: {code:"pi_provider_error",httpStatus:529,message:"529 overloaded"},
    };
    if(extra[shape]) return [failed(1,extra[shape])];
    if (shape === "cap_no_text") return [item(1, "reasoning", "thinking only ".repeat(400)),
      failed(2, { code: "pi_output_truncated", message: "Pi's final assistant response reached its output limit.", recoverable: false })];
    if (shape === "eof_mid_thinking") return [item(1, "reasoning", "considering the tables ".repeat(50)),
      failed(2, { code: "pi_provider_error", message: "unexpected EOF" })];
    if (shape === "provider_error_mid_answer") return [item(1, "agentMessage", "Step 1: snapshot the invoices table. Step 2: "),
      failed(2, { code: "pi_provider_error", message: "upstream connect error: stream reset" })];
    if (shape === "provider_quota") return [failed(1, { code: "pi_provider_error", message: "insufficient_quota: billing hard limit reached" })];
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
      provider: { kind: "pi_rpc", model: "openai/fixture-model", profile: QUALIFIED_PI_RPC_PROFILE },
      task: { identifier: issueId, title: issue.title, description: null, prompt: ASK, workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "pi_rpc", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
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
  async function assertOnePublishedNoteAfterSweep(issueId: string, runId: string, sweep = true) {
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
          driverKind: "pi_rpc", driverVersion: "fixture", nativeEventCount: 2, highestContiguousSourceSeq: 2, workspaceFinalizeStatus: "succeeded" } },
      sessionCodec: getAdapterSessionCodec(agent.adapterType), taskSessionForRun: null, sessionCompaction: { rotate: false, reason: null },
      configFreshnessResultMetadata: { version: 1 }, runLedgerScope: {}, currentUserRedactionOptions: { enabled: false },
      providerTraceCapture: false, onProviderTraceFinalized: () => {},
      issueContext: await createHeartbeatRunPreparation(db).getIssueExecutionContext(companyId, issueId), onLog: async () => {},
    };
    await completion.completeRun(input);
    await completion.completeRun(input); // crash/replay must not duplicate the completion note
    const readComments = async () => (await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).filter(c=>c.authorType !== "user" && !c.deletedAt);
    const before = await readComments();
    const sweeps=[];
    for (const delay of sweep ? [60_000, 60 * 60_000] : []) {
      const settled=await settleUnansweredPersonMessagesForTask(db,{companyId,issueId,now:new Date(Date.now()+delay)});
      sweeps.push({delay,settled,comments:await readComments()});
    }
    const record={kind:"publication",issueId,runId,run,task:issue,before,sweeps};
    appendFileSync(process.env.TASK_OUT+"/custom-rows.jsonl",JSON.stringify(record)+"\n");
    return record;
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
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    const promoted = await heartbeat.promoteDueScheduledRetries(new Date(Date.now() + 1_000));
    return { heartbeat, generic, promoted, wakes: await issueWakes(issueId), successors: await successorsOf(issueId, cutRunId) };
  }



  it.each(Object.keys(matrixErrors))("MATRIX %s", async shape => {
    const issueId = await task();
    const first = await cutTurn(issueId, shape);
    const afterFirst = await dispatchEverything(issueId, first.runId);
    const publicationFirst = await assertOnePublishedNoteAfterSweep(issueId, first.runId, afterFirst.successors.length === 0);
    let second = null, afterSecond = null, publicationFinal = publicationFirst;
    if (afterFirst.successors.length === 1) {
      second = await cutTurn(issueId, shape, afterFirst.successors[0].id);
      afterSecond = await dispatchEverything(issueId, first.runId);
      publicationFinal = await assertOnePublishedNoteAfterSweep(issueId, second.runId);
    }
    const row = {shape,error:matrixErrors[shape],account:isNativeProviderAccountFailure(matrixErrors[shape]),first,
      successorsFirst:afterFirst.successors,dispatchFirst:afterFirst.generic,wakesFirst:afterFirst.wakes,publicationFirst,second,successorsFinal:afterSecond?.successors ?? afterFirst.successors,publicationFinal};
    appendFileSync(process.env.TASK_OUT+"/matrix-rows.jsonl",JSON.stringify(row)+"\n");
    const accountExpected = shape.startsWith("f_") || shape.startsWith("g_");
    expect.soft(row.account).toBe(accountExpected);
    expect.soft(afterFirst.successors).toHaveLength(accountExpected ? 0 : 1);
    if (!accountExpected) expect.soft(afterFirst.successors[0]?.scheduledRetryReason === "native_mid_stream_cut").toBe(shape.startsWith("a_") || shape.startsWith("h_"));
    expect.soft(row.successorsFinal).toHaveLength(accountExpected ? 0 : 1);
    expect.soft(publicationFinal.before.filter(c => !c.body.includes("Paperclip is continuing"))).toHaveLength(1);
    for(const sweep of publicationFinal.sweeps) expect.soft(sweep.comments.filter(c => !c.body.includes("Paperclip is continuing"))).toHaveLength(1);
    if (shape.startsWith("c_") || accountExpected) expect.soft(publicationFinal.before.map(c=>c.body).join("\n")).not.toMatch(/Sending it again is safe|connection to the model dropped/);
    await afterFirst.heartbeat.drainActiveRunExecutions();
  },120000);
});
