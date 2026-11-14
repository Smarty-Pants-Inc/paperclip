import { randomUUID } from "node:crypto";
import {
  activityLog, agents, agentWakeupRequests, authUsers, companies, companyMemberships,
  createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRunEvents, heartbeatRuns,
  issueComments, issueRecoveryActions, issues, nativeRunFinalizations, type Db,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createHeartbeatQueueTestDependencies } from "../../__tests__/helpers/heartbeat-queue.js";
import { createWakeQueue } from "../../modules/wake-queue/index.js";
import { QUEUED_MESSAGES_DELIVERED_REASON } from "../../modules/wake-queue/domain/policy.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { listUndispatchedQueuedRuns } from "../queued-run-dispatch-liveness.js";
import { recoveryService } from "../recovery/service.js";
import { environmentRuntimeService } from "../environment-runtime.js";
import { environmentService } from "../environments.js";
import { currentControllerProcessStamp } from "../controller-process-identity.js";
import { logger } from "../../middleware/logger.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { recordTaskHistoryRead } from "../queued-comment-delivery.js";
import { registerRunDispatchWork } from "./dispatch-work.js";
import { createHeartbeatRecovery, type HeartbeatRecoveryDependencies } from "./recovery.js";
import { createHeartbeatQueue, shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake } from "./queue.js";
import { mergeCoalescedContextSnapshot } from "./run-preparation.js";
import { createHeartbeatRunControl } from "./run-control.js";
import { createHeartbeatRunState } from "./run-state.js";
import { callbacks as runControlCallbacks } from "./__tests__/run-control-fixtures.js";

// Keep: durable human-input safety and failure paths (rollback, dead owner,
// capacity race, claim exception) that a provider/browser flow cannot reach cheaply.
// PostgreSQL, admission, settlement, drain, claim and dispatcher are real. Only
// provider execution is stopped at its boundary; this is not proof of an answer.
const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`G3 core progress unavailable: ${support.reason}`);
describe.skipIf(!support.supported)("G3 core saved-input progress", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const executionOwners: Array<ReturnType<typeof createHeartbeatQueueTestDependencies>> = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("g3-core-progress");
    db = createDb(database.connectionString, { maxConnections: 6 });
    // Observe every committed wake status, not merely the final snapshot. A
    // cancelled-then-recreated input must not satisfy the C35 regression.
    await db.execute(sql`create table g3_wake_status_history (wake_id uuid, status text)`);
    await db.execute(sql`create function g3_record_wake_status() returns trigger language plpgsql as $$
      begin insert into g3_wake_status_history values (new.id, new.status); return new; end $$`);
    await db.execute(sql`create trigger g3_record_wake_status after insert or update on agent_wakeup_requests
      for each row execute function g3_record_wake_status()`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  beforeEach(async () => {
    await db.transaction(async tx => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table companies, g3_wake_status_history restart identity cascade`);
    });
  });
  afterEach(async () => {
    for (const deps of executionOwners.splice(0)) {
      while (deps.activeRunExecutionPromises.size) await Promise.allSettled([...deps.activeRunExecutionPromises]);
      await Promise.allSettled([...deps.activeWakeupPromises]);
    }
    vi.restoreAllMocks();
  });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed(status: "succeeded" | "running" = "succeeded", runtimeMode = "native") {
    const userId = `g3-${randomUUID()}`;
    await db.insert(authUsers).values({ id: userId, name: "Saved input author", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    const [company] = await db.insert(companies).values({ name: "G3 recovery regression", issuePrefix: "G3", defaultResponsibleUserId: userId }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, status: "active", membershipRole: "operator" });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Saved input owner", role: "engineer", status: "idle", lifecycleState: "ready",
      adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Continue the saved instruction", status: "in_progress",
      assigneeAgentId: agent.id, responsibleUserId: userId }).returning();
    const old = new Date(Date.now() - 60 * 60_000);
    const [source] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, scopeKind: "issue",
      status, runtimeMode, ...(runtimeMode === "native" ? { nativeIssueId: issue.id } : {}), invocationSource: "assignment", responsibleUserId: userId,
      createdAt: old, updatedAt: old, startedAt: old, finishedAt: status === "succeeded" ? new Date(old.getTime() + 1_000) : null,
      contextSnapshot: { issueId: issue.id, taskId: issue.id } }).returning();
    if (runtimeMode === "native") await db.insert(nativeRunFinalizations).values({ runId: source.id, companyId: company.id, issueId: issue.id,
      phase: status === "succeeded" ? "committed" : "observed" });
    await db.update(issues).set({ executionRunId: source.id, checkoutRunId: source.id, executionAgentNameKey: agent.name, executionLockedAt: old })
      .where(eq(issues.id, issue.id));
    const deps = createHeartbeatQueueTestDependencies(db);
    const controls = runControlCallbacks(db);
    deps.getAgent.mockImplementation(controls.getAgent);
    deps.setWakeupStatus.mockImplementation(controls.setWakeupStatus);
    deps.appendRunEvent.mockImplementation(controls.appendRunEvent);
    deps.instanceSettings.getExperimental.mockResolvedValue({ enableNativeRunner: true } as Awaited<ReturnType<typeof deps.instanceSettings.getExperimental>>);
    const fault = { rollback: false, missingUser: false };
    const wakeQueue = createWakeQueue(db, {
      resolveResponsibleUserId: async () => fault.missingUser ? null : userId,
      getRoutineEnv: async () => {
        if (fault.rollback) { fault.rollback = false; throw new Error("G3 release rollback injection"); }
        return { routineId: null, env: null, responsibleUserId: null };
      },
      resolveSessionBeforeForWakeup: async () => null,
      wakeAdmissionHelpers: { filterZombieCoalesceTarget: deps.filterZombieCoalesceTarget,
        mergeCoalescedContextSnapshot, shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake },
      recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
    });
    deps.wakeQueue.createAdmissionTransactionScope.mockImplementation(wakeQueue.createAdmissionTransactionScope);
    deps.wakeQueue.admitWakeBehindIssueExecution.mockImplementation(wakeQueue.admitWakeBehindIssueExecution);
    vi.mocked(controls.wakeQueue.releaseIssueExecution).mockImplementation(wakeQueue.releaseIssueExecution);
    const control = createHeartbeatRunControl(db, controls);
    deps.releaseIssueExecutionAndPromote.mockImplementation(control.releaseIssueExecutionAndPromote);
    const queue = createHeartbeatQueue(db, deps);
    const f = { company, agent, issue, source, userId, fault, deps, controls, control, queue };
    executionOwners.push(deps);
    return f;
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  async function savedComment(f: Fixture, admit = false) {
    const [comment] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id,
      authorUserId: f.userId, body: "M2: keep this exact follow-up, without asking me to send it again.", origin: "comment" }).returning();
    const context = { issueId: f.issue.id, taskId: f.issue.id, wakeReason: "issue_commented", wakeCommentId: comment.id, wakeCommentIds: [comment.id] };
    if (admit) {
      await f.queue.enqueueWakeup(f.agent.id, { source: "automation", triggerDetail: "system", reason: "issue_commented",
        requestedByActorType: "user", requestedByActorId: f.userId, payload: { issueId: f.issue.id, mutation: "comment", commentId: comment.id },
        contextSnapshot: context });
    } else {
      await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id, source: "automation", triggerDetail: "system",
        status: "deferred_issue_execution", reason: "issue_execution_deferred", requestedByActorType: "user", requestedByActorId: f.userId,
        payload: { issueId: f.issue.id, mutation: "comment", commentId: comment.id, _paperclipWakeContext: context } });
    }
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agent.id));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "deferred_issue_execution", runId: null });
    return { comment, wake: wakes[0] };
  }
  async function readRun(id: string) { return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]; }
  async function readWake(id: string) { return (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]; }
  async function readIssue(f: Fixture) { return (await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0]; }
  async function successors(f: Fixture) { return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id))).filter(r => r.id !== f.source.id); }
  async function expectTakenOnce(f: Fixture, input: Awaited<ReturnType<typeof savedComment>>) {
    const runs = await successors(f);
    expect(runs, "exactly one successor must take the original saved comment").toHaveLength(1);
    const run = runs[0];
    expect(run).toMatchObject({ status: "running", wakeupRequestId: input.wake.id });
    expect(run.contextSnapshot?.wakeCommentIds).toContain(input.comment.id);
    expect(await readWake(input.wake.id)).toMatchObject({ status: "claimed", runId: run.id });
    await expect.poll(() => f.deps.executeRun.mock.calls).toEqual([[run.id]]);
    expect((await readIssue(f)).executionRunId).toBe(run.id);
    expect(await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issue.id), eq(issueComments.authorUserId, f.userId))))
      .toEqual([input.comment]);
    const transitions = await db.execute<{ status: string }>(sql`select status from g3_wake_status_history where wake_id = ${input.wake.id}`);
    expect(transitions.map(row => row.status)).not.toContain("cancelled");
    console.log("G3 PROGRESS", JSON.stringify({ issueId: f.issue.id, commentId: input.comment.id, wakeId: input.wake.id,
      sourceRunId: f.source.id, successorRunId: run.id, status: run.status }));
    return run;
  }
  function staleLocks() { return recoveryService(db, { enqueueWakeup: async () => { throw new Error("Unexpected new wake during lock settlement"); } }); }
  async function finish(f: Fixture) {
    await f.controls.setRunStatusFromLive(f.source.id, "succeeded", ["running"], { finishedAt: new Date() });
    if (f.source.runtimeMode === "native") await db.update(nativeRunFinalizations).set({ phase: "committed" })
      .where(eq(nativeRunFinalizations.runId, f.source.id));
  }

  it.each(["rollback", "responsible_user_unresolved"])("C35: %s preserves the wake and existing recovery starts it once", async kind => {
    const f = await seed(), input = await savedComment(f);
    if (kind === "rollback") f.fault.rollback = true;
    else f.fault.missingUser = true;
    await expect(f.control.releaseIssueExecutionAndPromote(f.source)).rejects.toThrow(
      kind === "rollback" ? "G3 release rollback injection" : /responsible user/i);
    expect(await readWake(input.wake.id)).toMatchObject({ status: "deferred_issue_execution", runId: null, finishedAt: null });
    expect((await readIssue(f)).executionRunId).toBe(f.source.id); // the lock clear rolled back too
    expect(await successors(f)).toHaveLength(0);
    f.fault.missingUser = false;
    await staleLocks().sweepStaleIssueLocks({ companyId: f.company.id, issueId: f.issue.id });
    await f.queue.resumeQueuedRuns();
    await f.queue.resumeQueuedRuns();
    await expectTakenOnce(f, input);
  });

  function ownerRecovery(f: Fixture) {
    const unexpected = async (): Promise<never> => { throw new Error("Unexpected recovery side path"); };
    const deps: HeartbeatRecoveryDependencies = {
      ...f.controls,
      enterShutdown: () => undefined,
      getRunWorkspaceSettlement: createHeartbeatRunState(db).getRunWorkspaceSettlement,
      activeRunExecutions: f.deps.activeRunExecutions,
      activeRunExecutionPromises: f.deps.activeRunExecutionPromises,
      executeRun: f.deps.executeRun,
      releaseIssueExecutionAndPromote: f.deps.releaseIssueExecutionAndPromote,
      startNextQueuedRunForAgent: f.queue.startNextQueuedRunForAgent,
      environmentRuntime: environmentRuntimeService(db), environmentsSvc: environmentService(db), runtimeEnv: {},
      instructionCopies: { recoverStopped: unexpected, recoverCaptured: unexpected },
      scheduleBoundedRetryForRun: unexpected,
      scheduleInteractionContinuationInfrastructureRetryIfEligible: async () => null,
      scheduleNativeSessionResumeDispatch: () => undefined,
      cancelHeartbeatNativeRun: unexpected, terminateHeartbeatRunProcess: unexpected,
      mergeRunStopMetadataForAgent: (_agent, _outcome, options) => options?.resultJson ?? null,
      classifyAndPersistRunLiveness: f.controls.classifyAndPersistRunLiveness,
      releaseEnvironmentLeasesForRun: async () => undefined,
      acknowledgeRemoteStop: unexpected, resumeRemoteStopComments: unexpected,
      dispatchPendingNativeStatusWakeups: unexpected, cancelRunInternal: unexpected,
    };
    return createHeartbeatRecovery(db, deps);
  }

  // The requested automatic-progress RED fails for a legacy owner with unknown
  // action outcomes (zero successors). This is the explicit recovery primitive
  // allowed by execution-semantics §8, not permission to replay unknown work.
  it("E3.01: a dead owner with unknown action outcomes settles into explicit reconciliation", async () => {
    const f = await seed("running", "legacy"), input = await savedComment(f);
    const recovery = ownerRecovery(f);
    await recovery.recoverActiveExecutions({ companyId: f.company.id, runId: f.source.id });
    await f.queue.resumeQueuedRuns();
    await f.queue.resumeQueuedRuns();
    expect(await readRun(f.source.id)).toMatchObject({ status: "failed", errorCode: "process_lost" });
    expect((await readIssue(f)).executionRunId).not.toBe(f.source.id);
    const recoveryActions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.company.id));
    expect(recoveryActions).toHaveLength(1);
    expect(recoveryActions[0]).toMatchObject({ status: "active", ownerType: "board", sourceIssueId: f.issue.id,
      cause: "legacy_execution_requires_reconciliation", evidence: { runId: f.source.id } });
    expect(recoveryActions[0].nextAction).toBeTruthy();
    expect(await successors(f)).toHaveLength(0);
    expect(await readWake(input.wake.id)).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(f.deps.executeRun).not.toHaveBeenCalled();
    console.log("G3 OWNER DISPOSITION", JSON.stringify({ sourceRunId: f.source.id, sourceStatus: (await readRun(f.source.id)).status,
      issueId: f.issue.id, executionRunId: (await readIssue(f)).executionRunId, wake: await readWake(input.wake.id), recoveryActions }));
  });

  it("E3.01 safe-bootstrap control: a settled owner with proof no provider work began releases the saved comment once", async () => {
    const f = await seed("running", "legacy"), input = await savedComment(f);
    // A retained bootstrap receipt is positive no-provider-work evidence; a
    // missing PID by itself (the preceding RED specimen) is not that evidence.
    await db.update(heartbeatRuns).set({ resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } })
      .where(eq(heartbeatRuns.id, f.source.id));
    await ownerRecovery(f).recoverActiveExecutions({ companyId: f.company.id, runId: f.source.id });
    await f.queue.resumeQueuedRuns();
    await f.queue.resumeQueuedRuns();
    expect(await readRun(f.source.id)).toMatchObject({ status: "failed", errorCode: "process_lost" });
    await expectTakenOnce(f, input);
  });

  it("E3.01 control: a healthy quiet running owner is not settled or given an extra run", async () => {
    const f = await seed("running", "legacy"), input = await savedComment(f);
    // Old updatedAt/output is not a death proof. The real current process and
    // its renewed lease own this quiet turn even without a child PID.
    const stamp = currentControllerProcessStamp();
    await db.update(heartbeatRuns).set({ controllerBootId: stamp.bootId, controllerProcess: stamp,
      controllerLeaseExpiresAt: new Date(Date.now() + 60_000), executionStage: "dispatching" }).where(eq(heartbeatRuns.id, f.source.id));
    await ownerRecovery(f).recoverActiveExecutions({ companyId: f.company.id, runId: f.source.id });
    await staleLocks().sweepStaleIssueLocks({ companyId: f.company.id, issueId: f.issue.id });
    await f.queue.resumeQueuedRuns();
    expect(await readRun(f.source.id)).toMatchObject({ status: "running", error: null });
    expect((await readIssue(f)).executionRunId).toBe(f.source.id);
    expect(await readWake(input.wake.id)).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(await successors(f)).toHaveLength(0);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  async function queuedInput(f: Fixture) {
    const input = await savedComment(f);
    await f.control.releaseIssueExecutionAndPromote(f.source, { suppressImmediateRecovery: true });
    const runs = await successors(f);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "queued", wakeupRequestId: input.wake.id });
    return { input, queued: runs[0] };
  }
  async function startDispatcher(f: Fixture, errors: Array<{ error: unknown; queue: string }>) {
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      onError: (error, queue) => { errors.push({ error, queue }); logger.error({ err: error, queue }, "G3 observed dispatch failure"); } });
    const work = registerRunDispatchWork(coordinator, {
      promoteDueScheduledRetries: async () => undefined, nextScheduledRetryAt: async () => null,
      resumeQueuedRunsAfterDrain: f.queue.resumeQueuedRunsAfterDrain,
      listUndispatchedQueuedRuns: scope => listUndispatchedQueuedRuns(db, scope),
      schedulingSuppressed: async () => false,
    }, () => true);
    try { await work.ready; } catch (error) { await coordinator.stop(); throw error; }
    return coordinator;
  }

  it("E3.04: after capacity refusal the same queued run starts when the slot is freed", async () => {
    const f = await seed(), { input, queued } = await queuedInput(f);
    const [other] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      status: "running", invocationSource: "assignment" }).returning();
    // Both the atomic claim guard and the ordinary dispatcher must refuse.
    expect(await f.queue.claimQueuedRun(queued)).toBeNull();
    expect(await f.queue.startNextQueuedRunForAgent(f.agent.id)).toEqual([]);
    expect(await readRun(queued.id)).toMatchObject({ status: "queued", startedAt: null });
    expect(f.deps.executeRun).not.toHaveBeenCalled();
    // Real lifecycle settlement emits the dispatch work signal, not a message.
    const errors: Array<{ error: unknown; queue: string }> = [];
    const coordinator = await startDispatcher(f, errors);
    try {
      await f.controls.setRunStatusFromLive(other.id, "succeeded", ["running"], { finishedAt: new Date() });
      await expect.poll(async () => (await readRun(queued.id)).status, { timeout: 15_000 }).toBe("running");
      const all = await successors(f);
      expect(all.map(r => r.id).sort()).toEqual([other.id, queued.id].sort());
      expect(await readWake(input.wake.id)).toMatchObject({ status: "claimed", runId: queued.id });
      expect((await readRun(queued.id)).contextSnapshot?.wakeCommentIds).toContain(input.comment.id);
      await expect.poll(() => f.deps.executeRun.mock.calls).toEqual([[queued.id]]);
      expect(errors).toEqual([]);
      console.log("G3 CAPACITY", JSON.stringify({ queuedRunId: queued.id, freedRunId: other.id, wakeId: input.wake.id, status: (await readRun(queued.id)).status }));
    } finally { await coordinator.stop(); }
  }, 25_000);

  it("E3.05: the dispatcher retries a claim exception on the same saved run without a new message", async () => {
    const f = await seed(), { input, queued } = await queuedInput(f);
    f.deps.budgets.getInvocationBlock.mockRejectedValueOnce(new Error("G3 transient claim dependency failure"));
    const errors: Array<{ error: unknown; queue: string }> = [];
    const coordinator = await startDispatcher(f, errors);
    try {
      await expect.poll(() => errors.length, { timeout: 5_000 }).toBe(1);
      expect(errors[0]).toMatchObject({ error: { message: "G3 transient claim dependency failure" }, queue: DELIVERY_QUEUES.queuedRunDispatch });
      expect(await readRun(queued.id)).toMatchObject({ status: "queued", startedAt: null });
      expect(f.deps.executeRun).not.toHaveBeenCalled();
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, queued.id));
      const activities = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.company.id), eq(activityLog.entityId, f.issue.id)));
      const runAtFailure = await readRun(queued.id), wakeAtFailure = await readWake(input.wake.id);
      console.log("G3 CLAIM DIAGNOSTICS", JSON.stringify({ runId: queued.id, wakeId: input.wake.id,
        runError: runAtFailure.error, runErrorCode: runAtFailure.errorCode, wakeError: wakeAtFailure.error,
        events, activities, coordinatorErrors: errors.map(({ error, queue }) => ({ message: String(error), queue })) }));
      // No explicit retry/wake call: the existing 30-second failure deadline owns recovery.
      await expect.poll(async () => (await readRun(queued.id)).status, { timeout: 45_000, interval: 250 }).toBe("running");
      await expectTakenOnce(f, input);
      expect((await successors(f))[0].id).toBe(queued.id);
    } finally { await coordinator.stop(); }
  }, 60_000);

  it("E3.09: an admitted same-agent follow-up not consumed by the running turn gets one successor", async () => {
    const f = await seed("running"), input = await savedComment(f, true);
    expect((await readRun(f.source.id)).contextSnapshot?.wakeCommentIds ?? []).not.toContain(input.comment.id);
    await f.queue.resumeQueuedRuns();
    expect(await successors(f)).toHaveLength(0);
    await finish(f);
    // Exercise missed finalizer delivery: owner settlement and the R4-a sweep,
    // not a second Send or a test-authored successor/lock clear.
    await staleLocks().sweepStaleIssueLocks({ companyId: f.company.id, issueId: f.issue.id });
    await f.queue.resumeQueuedRuns();
    await f.queue.resumeQueuedRuns();
    await expectTakenOnce(f, input);
  });

  it("E3.09 control: authoritative read and accepted-result coverage consumes M2 without a successor", async () => {
    const f = await seed("running"), input = await savedComment(f, true);
    await recordTaskHistoryRead(db, { companyId: f.company.id, agentId: f.agent.id, runId: f.source.id, comments: [input.comment] });
    await appendHeartbeatRunEvent(db, { companyId: f.company.id, agentId: f.agent.id, runId: f.source.id,
      eventType: "run.result.accepted", stream: "system", level: "info",
      payload: { prpEvent: { payload: { result: { evidence: [{ ref: `comment:${input.comment.id}` }] } } } } });
    await finish(f);
    await staleLocks().sweepStaleIssueLocks({ companyId: f.company.id, issueId: f.issue.id });
    await f.queue.resumeQueuedRuns();
    await f.queue.resumeQueuedRuns();
    expect(await successors(f)).toHaveLength(0);
    expect(await readWake(input.wake.id)).toMatchObject({ status: "cancelled", error: QUEUED_MESSAGES_DELIVERED_REASON, runId: null });
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });
});
