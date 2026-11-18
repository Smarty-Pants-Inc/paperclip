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
import { isFailedTurnContinuationRun } from "./native-failed-turn-continuation.js";
import { NATIVE_RUN_FAILED_CONTINUATION_EXHAUSTED_ACTION } from "./status-arbiter.js";
import { heartbeatService } from "../heartbeat.js";
import { startTaskDrain, stopTaskDrain } from "../task-admission.js";
import { createReleaseIssueExecution } from "../../modules/wake-queue/application/use-cases.js";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { deliverReconciledExecutions } from "../execution-recovery-resolution.js";
import { requestTaskRetry } from "../task-retry.js";
import { callbacks } from "../../__tests__/helpers/judge-completion-support.js";
import { createHeartbeatRunCompletion } from "../heartbeat/run-completion.js";
import { createHeartbeatRunPreparation } from "../heartbeat/run-preparation.js";
import { getAdapterSessionCodec } from "../heartbeat/run-state.js";
import { buildEffectiveRunSessionConfigMetadata } from "../heartbeat/workspaces.js";
import { issueService } from "../issues.js";
import * as usageReceipts from "../usage-receipts.js";
import { settleUnansweredPersonMessagesForTask, unansweredPersonMessageCondition } from "../recovery/unanswered-person-message.js";

// fam-long u1j (review-fleet-2). judge-generic-busy/free.test.ts beside this file are rf-2's c2a-form CONTROLS:
// on this tree every provider failure in them takes the mid-stream CUT lane (u1h), so they do not exercise the
// generic retry. This file is the real RED: same harness, same dispatcher sequence (dispatch ->
// deliverReconciledExecutions x2 -> promote), same +1m/+1h sweeps, with failures that still take the GENERIC
// native_run_failed retry here. Both slots: at most ONE automatic successor, the second failure is
// continuation-exhausted with ONE true final note.
// These run the REAL scheduling path: runner terminal -> finalizeNativeRun ->
// arbiter -> status-decision committer -> the wake / retry dispatchers.
type CutShape = string;
// GENERIC-LANE rows on the fam-long tree. classifyNativeMidStreamCut (native-mid-stream-cut.ts :89-93) sends only
// pi_output_truncated / pi_provider_error / pi_rpc_transport_failed to the cut lane, and
// classifyNativeProviderAccountFailure (:115) reads only the last two. A turn that failed with any other
// code and no provider text reaches the arbiter's last failed-turn branch (status-arbiter.ts :506-519):
// schedule_retry, cause native_run_failed. Each row asserts that lane on its FIRST decision, so it cannot pass vacuously.
const matrixErrors: Record<string, Record<string, unknown>> = {
  runner_process_exited: { code: "native_runner_process_exited" },
  pi_turn_idle_timeout: { code: "pi_turn_idle_timeout" },
  pi_abort_escalated: { code: "pi_abort_escalated" },
};
const SWEEP_SAFE_LINE = /no run started|wasn't answered|Sending it again is safe/i;
const ASK = "Write the full migration plan for the billing tables, every step, nothing left out.";
const STORED = { provider: "pi_rpc", model: "paperclip/faux", piRpcThinkingLevel: "xhigh" };

describe("generic native_run_failed retry: one successor, busy or free slot (fam-long u1j, rf-2)", () => {
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
    const continuationUsed = await isFailedTurnContinuationRun(db, run, issueId);
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const [cut] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(cut.status).toBe("failed");
    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId));
    const effects = await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.decisionId, decision.id));
    return { runId, decision, effects, continuationUsed, run: cut, native, turnEventsSubmitted: events };
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
    appendFileSync(process.env.EVIDENCE_OUT+"/custom-rows.jsonl",JSON.stringify(record)+"\n");
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
    const slotHolders = (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")))).length;
    const generic = await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    const promoted = await heartbeat.promoteDueScheduledRetries(new Date(Date.now() + 1_000));
    return { heartbeat, slotHolders, generic, promoted, wakes: await issueWakes(issueId), successors: await successorsOf(issueId, cutRunId) };
  }



  /**
   * rf-2 fixture race: with a FREE slot the real dispatcher also STARTS the run it queued (startNextQueuedRunForAgent,
   * heartbeat/queue.ts :5651), and his fixture then repurposed that same run (controller_lease_lost in all 7 logs).
   * The real executor cannot carry a native turn in this harness (it stops at the runtime API listener, then at the
   * runnerd provider pack), so the fixture must be the ONE owner of the successor:
   *  - FREE rows hold run START with the production task drain (task-admission.ts; queue.ts :3199-3208 keeps the wake
   *    queued and the dispatch-side checks keep it from starting). No other run holds the slot: dispatch and
   *    reconciliation see it free, the successor is queued, and nothing else ever claims it.
   *  - Then, in both slots, the fixture WAITS for every in-flight wake/execution of the real heartbeat and CLAIMS the
   *    successor with one compare-and-set on `queued`. A run something else took is not queued any more: the claim
   *    gets no row and the row fails instead of quietly reusing it.
   * Returns the run exactly as dispatch left it.
   */
  async function claimSuccessor(after: { heartbeat: ReturnType<typeof heartbeatService>; successors: Array<typeof heartbeatRuns.$inferSelect> }) {
    await after.heartbeat.drainActiveRunExecutions();
    const [asDispatched] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, after.successors[0].id));
    const taken = await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() })
      .where(and(eq(heartbeatRuns.id, asDispatched.id), eq(heartbeatRuns.status, "queued"))).returning({ id: heartbeatRuns.id });
    return { ...asDispatched, claimedByFixture: taken.length };
  }

  const SLOTS = ["BUSY", "FREE"] as const;
  const ROWS = SLOTS.flatMap(slot => Object.keys(matrixErrors).map(shape => [slot, shape] as const));
  const published = new Map<string, Awaited<ReturnType<typeof assertOnePublishedNoteAfterSweep>>>();
  it.each(ROWS)("BOUND %s %s", async (slot, shape) => {
    // BUSY: the agent's only slot is held by another task's run, as in rf-2's busy file.
    const [blocker] = slot === "BUSY" ? await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running",
      contextSnapshot: { issueId: randomUUID() } }).returning() : [null];
    if (slot === "FREE") startTaskDrain();
    let issueId: string | null = null;
    try {
      issueId = await task();
      const first = await cutTurn(issueId, shape);
      const afterFirst = await dispatchEverything(issueId, first.runId);
      const claimed = afterFirst.successors.length === 1 ? await claimSuccessor(afterFirst) : null;
      const publicationFirst = await assertOnePublishedNoteAfterSweep(issueId, first.runId, afterFirst.successors.length === 0);
      let second = null, afterSecond = null, publicationFinal = publicationFirst;
      if (claimed?.claimedByFixture === 1) {
        second = await cutTurn(issueId, shape, claimed.id);
        afterSecond = await dispatchEverything(issueId, first.runId);
        publicationFinal = await assertOnePublishedNoteAfterSweep(issueId, second.runId);
      }
      const successorsFinal = afterSecond?.successors ?? afterFirst.successors;
      const row = { slot, shape, error: matrixErrors[shape], first, successorsFirst: afterFirst.successors, claimed,
        dispatchFirst: afterFirst.generic, wakesFirst: afterFirst.wakes, publicationFirst, second, successorsFinal, publicationFinal };
      appendFileSync(process.env.EVIDENCE_OUT + "/matrix-rows.jsonl", JSON.stringify(row) + "\n");
      // Not vacuous: the first failure took the GENERIC lane (status-arbiter.ts :506-519), not the cut lane.
      expect.soft(first.decision.reasonCode).toBe("run_failed_partial_evidence_preserved");
      expect.soft(first.effects.filter(effect => effect.effectKind === "schedule_retry").map(effect => effect.payload?.cause)).toEqual(["native_run_failed"]);
      // ONE automatic successor, and it is not the cut lane's.
      expect.soft(afterFirst.successors).toHaveLength(1);
      expect.soft(afterFirst.successors[0]?.scheduledRetryReason).not.toBe("native_mid_stream_cut");
      // The dispatched successor was claimed cleanly: queued, never started by anything else.
      expect.soft(claimed?.status).toBe("queued");
      expect.soft(claimed?.startedAt ?? null).toBeNull();
      expect.soft(claimed?.errorCode ?? null).toBeNull();
      expect.soft(claimed?.claimedByFixture).toBe(1);
      expect.soft(second?.run.errorCode).not.toBe("controller_lease_lost");
      // The second failure is the used continuation: exhausted, and no second successor.
      expect.soft(second?.decision.reasonCode).toBe("native_run_failed_continuation_exhausted");
      expect.soft(second?.effects.map(effect => effect.effectKind)).not.toContain("schedule_retry");
      expect.soft(successorsFinal).toHaveLength(1);
      published.set(`${slot} ${shape}`, publicationFinal);
      await afterFirst.heartbeat.drainActiveRunExecutions();
      // The slot really was what the row says while the successor was dispatched.
      expect.soft(afterFirst.slotHolders).toBe(slot === "BUSY" ? 1 : 0);
    } finally {
      // A leaked second successor (the RED) must not be started by a later row's free slot.
      if (issueId) await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued"), eq(heartbeatRuns.issueId, issueId)));
      stopTaskDrain();
      if (blocker) await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, blocker.id));
    }
  }, 120000);

  // What the person reads after the GENERIC row above (same task, read-only): ONE true final note, also after the
  // +1m and +1h sweeps, and never a "safe to send again" line once a carrying run started. Kept apart from the
  // bound so each is judged on its own: the sweep text belongs to recovery/unanswered-person-message.ts.
  it.each(ROWS)("NOTE %s %s", (slot, shape) => {
    const publication = published.get(`${slot} ${shape}`);
    expect(publication, "the BOUND row for this task did not finish").toBeDefined();
    const finals = (comments: Array<{ body: string }>) => comments.filter(c => !c.body.includes("Paperclip is continuing"));
    expect.soft(finals(publication!.before)).toHaveLength(1);
    expect.soft(publication!.sweeps).toHaveLength(2);
    for (const sweep of publication!.sweeps) {
      expect.soft(finals(sweep.comments)).toHaveLength(1);
      expect.soft(sweep.comments.map(c => c.body).join("\n")).not.toMatch(SWEEP_SAFE_LINE);
    }
  });
});
