import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentWakeupRequests, authUsers, chatCompletionDeliveries as deliveries,
  companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues } from "@paperclipai/db";
import { recoveryPostgresSupport as support, startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { createHeartbeatQueue } from "../services/heartbeat/queue.js";
import { assignedWorkSweep } from "../services/recovery/assigned-work-sweep.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { deliverReconciledExecutions, markExecutionReconciliation, validateExecutionReconciliation } from "../services/execution-recovery-resolution.js";
import { chatCompletionDeliveryService, prepareChatCompletionTurn, recordAcceptedChatHandoff } from "../services/chat-completion-delivery.js";

// catch: GAT-497 / GAT-498 (gate 2, 2026-11-20). Real PostgreSQL, status writers,
// assigned-work continuation, completion worker and durable queue admission.
// Only provider execution is held: unresolved recovery must never admit a run;
// after real reconciliation, ordinary queue dispatch must start exactly one.
(support.supported ? describe : describe.skip)("unrecoverable delegated execution does not re-arm chat delivery", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  beforeAll(async () => {
    temporary = await startRecoveryPostgres("chat-completion-execution-loop-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    await db.insert(authUsers).values({ id: "operator", name: "Operator", email: "operator@fixture.invalid",
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }, 30_000);
  afterEach(() => vi.useRealTimers());
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  async function seed(held = true) {
    const companyId = randomUUID(), agentId = randomUUID(), workerId = randomUUID(), sourceId = randomUUID();
    const sourceRunId = randomUUID(), taskRunId = randomUUID();
    const old = new Date(Date.now() - 60 * 60_000);
    await db.insert(companies).values({ id: companyId, name: "Delegated daily work", issuePrefix: `L${companyId.slice(0, 6)}` });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Lead", status: "idle", adapterType: "process" },
      { id: workerId, companyId, name: "Delegate", status: held ? "error" : "idle", adapterType: "process" },
    ]);
    const [source] = await db.insert(issues).values({ id: sourceId, companyId, title: "Parent chat", status: "in_progress",
      conversationAgentId: agentId, conversationUserId: "operator", responsibleUserId: "operator",
      conversationState: "waiting", assigneeAgentId: agentId, createdAt: old }).returning();
    const [task] = await db.insert(issues).values({ companyId, title: "Delegated daily work", parentId: sourceId, identifier: `L${companyId.slice(0, 6)}-498`,
      status: held ? "blocked" : "in_progress", assigneeAgentId: workerId, createdByAgentId: agentId,
      blockedTransitionAt: held ? new Date() : null, createdAt: old }).returning();
    await db.transaction(tx => recordAcceptedChatHandoff(tx, task, source));
    if (held) {
      await db.insert(heartbeatRuns).values([
        { id: sourceRunId, companyId, agentId, status: "failed", startedAt: old, finishedAt: old,
          contextSnapshot: { issueId: sourceId }, errorCode: "setup_failed" },
        { id: taskRunId, companyId, agentId: workerId, status: "cancelled", startedAt: old, finishedAt: old,
          contextSnapshot: { issueId: task.id }, errorCode: "execution_reconciliation_required" },
      ]);
      await db.insert(issueRecoveryActions).values([
        { companyId, sourceIssueId: sourceId, kind: "active_run_watchdog", status: "resolved", ownerType: "board",
          cause: "legacy_execution_requires_reconciliation", fingerprint: `parent:${sourceRunId}`,
          nextAction: "Paperclip cannot recover the unsaved files from the previous run.",
          evidence: { runId: sourceRunId, automaticRecovery: { replay: "blocked" }, workspaceRestoreFailure: "restore_unsafe_archive" } },
        { companyId, sourceIssueId: task.id, kind: "active_run_watchdog", status: "resolved", ownerType: "board", returnOwnerAgentId: workerId,
          cause: "legacy_execution_requires_reconciliation", fingerprint: `child:${taskRunId}`,
          nextAction: "Paperclip cannot recover the unsaved files from the previous run.",
          evidence: { runId: taskRunId, automaticRecovery: { replay: "blocked" }, workspaceRestoreFailure: "restore_unsafe_archive",
            continuationDelivery: "pending", freshContinuation: { schema: "paperclip.fresh-continuation.v1", sourceRunId: taskRunId,
              recordedAt: old.toISOString(), isolation: "fresh_isolated_workspace", trigger: "continuation_wake" } } },
      ]);
      expect(await getExecutionBlocker(db, companyId, task.id)).toMatchObject({ canRetry: false, workspaceRepairRequired: true });
      expect(await getExecutionBlocker(db, companyId, sourceId)).not.toBeNull();
    }
    const deps = createHeartbeatQueueTestDependencies(db);
    deps.getAgent.mockImplementation(id => db.select().from(agents).where(eq(agents.id, id)).then(rows => rows[0] ?? null));
    deps.instanceSettings.getExperimental.mockImplementation(() => instanceSettingsService(db).getExperimental());
    deps.issuesSvc.getDependencyReadiness.mockImplementation(issueService(db).getDependencyReadiness);
    deps.issuesSvc.listDependencyReadiness.mockImplementation(issueService(db).listDependencyReadiness);
    deps.getSchedulingSuppression.mockResolvedValue({ suppressed: true, reason: "task_drain" });
    const queue = createHeartbeatQueue(db, deps);
    const worker = chatCompletionDeliveryService(db, { wakeup: queue.trackWakeup });
    const continuation = assignedWorkSweep(db, { enqueueWakeup: queue.trackWakeup });
    const rows = () => db.select().from(deliveries).where(eq(deliveries.companyId, companyId)).orderBy(asc(deliveries.createdAt), asc(deliveries.id));
    const notes = () => db.select().from(issueComments).where(and(eq(issueComments.companyId, companyId), eq(issueComments.issueId, sourceId), eq(issueComments.authorType, "system")));
    const snapshot = async () => {
      const outbox = await rows();
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
      const taskRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, task.id));
      return { deliveries: outbox.length, wakes: wakes.filter(w => w.reason === "execution_reconciliation_required" && w.payload?.issueId === sourceId).length,
        notes: (await notes()).map(n => ({ id: n.id, body: n.body })),
        admittedRuns: taskRuns.filter(r => ![sourceRunId, taskRunId].includes(r.id)).length,
        outbox: outbox.map(d => ({ id: d.id, status: d.status, attempts: d.attempts, version: d.statusVersion, responseCommentId: d.responseCommentId })),
        wakeReceipts: wakes.map(w => ({ id: w.id, reason: w.reason, status: w.status, runId: w.runId, issueId: w.payload?.issueId })),
        activities: activities.map(a => ({ id: a.id, action: a.action, details: a.details })) };
    };
    return { companyId, agentId, workerId, sourceId, task, taskRunId, sourceRunId, worker, continuation, queue, deps, rows, notes, snapshot };
  }

  it("one refusal and one true note, then quiet for three 15-minute periods", async () => {
    const f = await seed();
    const start = Date.now() + 1_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    const checkpoints = [];
    for (let minute = 0; minute <= 45; minute++) {
      vi.setSystemTime(start + minute * 60_000);
      if (minute < 45 && minute % 15 === 0) {
        await Promise.all([f.continuation.checkIssue({ companyId: f.companyId, issueId: f.task.id }),
          f.continuation.checkIssue({ companyId: f.companyId, issueId: f.task.id })]);
      }
      await f.worker.sweepPending({ companyId: f.companyId, taskId: f.task.id });
      if (minute > 0 && minute % 15 === 0) checkpoints.push({ minute, ...await f.snapshot() });
    }
    f.continuation.flushPassLog();
    const result = await f.snapshot();
    console.log("EXECUTION_LOOP_ROW " + JSON.stringify({ fixture: { companyId: f.companyId, chatId: f.sourceId,
      taskId: f.task.id, workerId: f.workerId, taskRunId: f.taskRunId }, checkpoints, final: result }));
    expect(result.deliveries).toBeLessThanOrEqual(1);
    expect(result.wakes).toBeLessThanOrEqual(5);
    expect(result.admittedRuns).toBe(0);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0].body).toBe(`[${f.task.identifier}](/issues/${f.task.identifier}) has stopped: its agent can't continue it until the problem with its last run is sorted out. Open the task to see what's needed.`);
    expect(result.notes[0].body).not.toMatch(/finished|completed|try again shortly/i);
    expect(checkpoints.map(c => [c.deliveries, c.wakes, c.notes.length])).toEqual([
      [result.deliveries, result.wakes, 1], [result.deliveries, result.wakes, 1], [result.deliveries, result.wakes, 1],
    ]);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
    const [unchanged] = await db.select().from(issues).where(eq(issues.id, f.task.id));
    expect(unchanged).toMatchObject({ status: "blocked", statusVersion: f.task.statusVersion });
    expect(result.activities).toEqual([]);
    // Neither a process restart nor rolling-hour retry accounting re-arms it.
    vi.setSystemTime(start + 61 * 60_000);
    const restarted = assignedWorkSweep(db, { enqueueWakeup: f.queue.trackWakeup });
    const deadlines: number[] = [];
    expect(await restarted.checkIssue({ companyId: f.companyId, issueId: f.task.id,
      onDeferredDeadline: at => deadlines.push(at) })).toMatchObject({ outcome: "waiting_on_recovery", retryAt: null });
    restarted.flushPassLog();
    await f.worker.sweepPending({ companyId: f.companyId, taskId: f.task.id });
    expect(await f.snapshot()).toEqual(result);
    expect(deadlines).toEqual([]);
    console.log("EXECUTION_RESTART_ROW " + JSON.stringify({ minute: 61, deadlines, ...await f.snapshot() }));
  }, 60_000);

  it("resolved previous execution releases the block and starts exactly one automatic run after restart", async () => {
    const f = await seed();
    const start = Date.now() + 1_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    expect(await f.continuation.checkIssue({ companyId: f.companyId, issueId: f.task.id }))
      .toMatchObject({ outcome: "waiting_on_recovery", retryAt: null });
    vi.setSystemTime(start + 61 * 60_000);
    const restarted = assignedWorkSweep(db, { enqueueWakeup: f.queue.trackWakeup });
    expect(await restarted.checkIssue({ companyId: f.companyId, issueId: f.task.id }))
      .toMatchObject({ outcome: "waiting_on_recovery", retryAt: null });
    const held = await f.snapshot();
    expect(held.admittedRuns).toBe(0);
    expect(held.notes).toHaveLength(1);
    const [before] = await db.select().from(issues).where(eq(issues.id, f.task.id));
    expect(before).toMatchObject({ status: "blocked", statusVersion: f.task.statusVersion });
    const [action] = await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, f.companyId), eq(issueRecoveryActions.sourceIssueId, f.task.id)));
    const decision = { runId: f.taskRunId, providerStopped: true, actionOutcome: "mixed" as const,
      outcomeEvidence: "Inspected the previous execution and verified its recorded external action outcomes.",
      workspaceRepairEvidence: "Verified safe workspace staging; the unsafe archive will not be applied." };
    // The same validation + durable reconciliation writer used by real recovery.
    // No deleting holds, changing evidence directly or blocked -> done shortcut.
    await validateExecutionReconciliation({ db, companyId: f.companyId, issueId: f.task.id,
      agentId: f.workerId, sourceRunId: f.taskRunId, decision });
    await markExecutionReconciliation(db, action, decision, "operator");
    expect(await getExecutionBlocker(db, f.companyId, f.task.id)).toBeNull();
    const [resolved] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(resolved.evidence).toMatchObject({ executionReconciliation: { runId: f.taskRunId }, continuationDelivery: "pending" });
    expect(resolved.evidence.automaticRecovery).toBeUndefined();
    // Merely repairing the previous execution must not manufacture a status edit.
    expect((await db.select().from(issues).where(eq(issues.id, f.task.id)))[0])
      .toMatchObject({ status: "blocked", statusVersion: f.task.statusVersion });
    // No manual task edit, agent-status reset or Retry is needed.
    // The recovery delivery owner admits its exact reconciled continuation.
    // Keep dispatch held until the automatic sweep lifts the old block.
    await deliverReconciledExecutions(db, f.queue.trackWakeup);
    const checks = await Promise.all([restarted.checkIssue({ companyId: f.companyId, issueId: f.task.id }),
      restarted.checkIssue({ companyId: f.companyId, issueId: f.task.id })]);
    // startNextQueuedRunForAgent is the real dispatch path, not a manufactured run.
    f.deps.getSchedulingSuppression.mockResolvedValue({ suppressed: false, reason: null });
    await f.queue.startNextQueuedRunForAgent(f.workerId);
    await Promise.all([...f.deps.activeRunExecutionPromises]);
    const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .filter(r => r.id !== f.sourceRunId && r.id !== f.taskRunId);
    const [after] = await db.select().from(issues).where(eq(issues.id, f.task.id));
    await restarted.checkIssue({ companyId: f.companyId, issueId: f.task.id });
    await f.worker.sweepPending({ companyId: f.companyId, taskId: f.task.id });
    const result = await f.snapshot();
    console.log("EXECUTION_RESOLVED_ROW " + JSON.stringify({ companyId: f.companyId, taskId: f.task.id,
      recoveryActionId: action.id, held, recovery: resolved, checks,
      before: { status: before.status, version: before.statusVersion }, after: { status: after.status, version: after.statusVersion },
      runs: runs.map(r => ({ id: r.id, status: r.status, startedAt: r.startedAt, context: r.contextSnapshot })), final: result }));
    expect(checks.some(c => c?.outcome === "repaired")).toBe(true);
    expect(after.status).toBe("todo");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "running", agentId: f.workerId });
    expect(runs[0].startedAt).not.toBeNull();
    expect(f.deps.executeRun).toHaveBeenCalledExactlyOnceWith(runs[0].id);
    expect(result.admittedRuns).toBe(1);
    const [delivered] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(delivered.evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: runs[0].id });
    expect(result.notes).toEqual(held.notes);
    expect(result.deliveries).toBe(0);
    f.continuation.flushPassLog();
    restarted.flushPassLog();
  }, 60_000);

  it.each(["pending", "exhausted"])("a pre-upgrade %s delivery does not leave an extra failure report or wake", async status => {
    const f = await seed();
    await db.insert(deliveries).values({ companyId: f.companyId, taskId: f.task.id, statusVersion: f.task.statusVersion, status });
    for (let pass = 0; pass < 3; pass++) {
      // Construct another owner each time, as after a process restart. The note
      // gate lives in PostgreSQL, not a process-local cache or retry window.
      const owner = assignedWorkSweep(db, { enqueueWakeup: f.queue.trackWakeup });
      expect(await owner.checkIssue({ companyId: f.companyId, issueId: f.task.id })).toMatchObject({ outcome: "waiting_on_recovery", retryAt: null });
      owner.flushPassLog();
      await f.worker.sweepPending({ companyId: f.companyId, taskId: f.task.id });
    }
    const result = await f.snapshot();
    expect(result.deliveries).toBe(1);
    expect(result.wakes).toBe(0);
    expect(result.notes).toHaveLength(1);
    expect(result.outbox[0]).toMatchObject(status === "pending"
      ? { status: "delivered", responseCommentId: result.notes[0].id } : { status: "exhausted" });
    expect(result.activities).toEqual([]);
    console.log("EXECUTION_UPGRADE_ROW " + JSON.stringify({ status, ...result }));
  });

  it("does not put a stale handoff's stuck note into a reset chat", async () => {
    const f = await seed();
    await db.update(issues).set({ conversationSessionGeneration: 1 }).where(eq(issues.id, f.sourceId));
    expect(await f.continuation.checkIssue({ companyId: f.companyId, issueId: f.task.id })).toMatchObject({ outcome: "waiting_on_recovery", retryAt: null });
    f.continuation.flushPassLog();
    expect(await f.notes()).toEqual([]);
    expect(await f.rows()).toEqual([]);
  });

  it.each([false, true])("reports a completion once, including a real blocked-to-done change (previously stuck: %s)", async held => {
      const f = await seed(held);
      if (held) {
        await f.continuation.checkIssue({ companyId: f.companyId, issueId: f.task.id });
        f.continuation.flushPassLog();
        expect(await f.notes()).toHaveLength(1);
        // The actual repair owner clears the old execution hold. This is not a
        // status-only bounce performed by the automatic continuation worker.
        await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId));
        await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.workerId));
      }
      await issueService(db).update(f.task.id, { status: "done" });
      const pending = (await f.rows()).filter(d => d.status === "pending");
      expect(pending).toHaveLength(1);
      await f.worker.deliver(pending[0].id);
      const [delivery] = await db.select().from(deliveries).where(eq(deliveries.id, pending[0].id));
      expect(delivery.targetRunId).not.toBeNull();
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, delivery.targetRunId!));
      const prepared = await prepareChatCompletionTurn(db, run);
      expect(prepared.contextSnapshot?.chatCompletionUpdates).toEqual([expect.objectContaining({ id: f.task.id, status: "done" })]);
      const reply = await issueService(db).addComment(f.sourceId, `[${f.task.identifier}](/issues/${f.task.identifier}) is done.`,
        { agentId: f.agentId, runId: run.id }, { completionReply: true });
      const duplicate = await issueService(db).addComment(f.sourceId, "Duplicate", { agentId: f.agentId, runId: run.id }, { completionReply: true });
      expect(duplicate.id).toBe(reply.id);
      await f.worker.sweepPending({ companyId: f.companyId, taskId: f.task.id });
      const replies = await db.select().from(issueComments).where(eq(issueComments.createdByRunId, run.id));
      expect(replies).toHaveLength(1);
      expect((await f.rows()).find(d => d.id === pending[0].id)).toMatchObject({ status: "delivered", responseCommentId: reply.id });
      console.log("EXECUTION_HEALTHY_ROW " + JSON.stringify({ held, taskId: f.task.id, runId: run.id, replyId: reply.id, replies: replies.length }));
  }, 60_000);
});
