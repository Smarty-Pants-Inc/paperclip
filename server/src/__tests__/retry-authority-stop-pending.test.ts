import { randomUUID } from "node:crypto";
import { agentWakeupRequests, environmentLeases, heartbeatRuns, issueComments, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { asc, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { describeEmbeddedPostgres, nativeRestartFixture } from "./helpers/native-restart.js";
import { recordTaskStopPending, withTaskStopPendingInstruction } from "../services/recovery/stop-pending.js";
import { recoveryService } from "../services/recovery/service.js";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.js";
import { readRetryStopGate } from "../services/task-retry-stop-gate.js";
import { requestTaskRetry } from "../services/task-retry.js";

// Retry fold, judge bar R1 A / R10 F1 / R14 F5. A real authorized managing
// agent's Stop on a run that did work: the card offers no Retry (the task
// Retry source check canRetryStoppedRun refuses it) and the stop-pending
// note never says "Press Retry". The live-bound probe: a Stop proof is never
// taken while the saved bound run is still running.
describeEmbeddedPostgres("retry fold: managing-agent Stop and stop-pending share one Retry authority", () => {
  const environment = nativeRestartFixture();
  const retryNote = "This task was stopped and its saved work is kept. Press Retry to run it again, or assign this agent a new task.";
  const newTaskNote = "This task was stopped and its saved work is kept. Assign this agent a new task to continue.";

  async function fixture(status: "cancelled" | "failed") {
    const f = await environment.seedRun(randomUUID());
    const { companyId, agentId } = environment.current;
    const managerId = randomUUID();
    const old = new Date(Date.now() - 86_400_000);
    // The agent process ran (and is gone): not a startup cancellation that Retry may restart.
    await f.db.update(heartbeatRuns).set({ status, startedAt: old, processPid: 999999999, finishedAt: old, errorCode: "operator_interrupted",
      resultJson: { cancelledByActorType: "agent", cancelledByAgentId: managerId,
        managementStop: { schema: "paperclip.management-stop.v1", runId: f.runId, companyId, actorAgentId: managerId, targetAgentId: agentId },
        cancellation: { source: "control_plane", expected: true, initiator: { type: "agent", id: managerId },
          reason: "Cancelled by a managing agent", recordedAt: old.toISOString() },
        nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: f.runId, companyId, issueId: f.issueId,
          scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
          intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID() } } }).where(eq(heartbeatRuns.id, f.runId));
    await f.db.update(issues).set({ checkoutRunId: f.runId, executionLockedAt: old }).where(eq(issues.id, f.issueId));
    const [lease] = await f.db.insert(environmentLeases).values({ companyId, issueId: f.issueId, heartbeatRunId: f.runId,
      provider: "local", status: "active", cleanupStatus: null }).returning();
    await f.db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)).orderBy(asc(heartbeatRuns.id)).for("update");
      await recordTaskStopPending(tx as unknown as Db, { companyId, issueId: f.issueId, runIds: [f.runId], source: "recovery.sweep_stale_issue_locks" }, []);
    });
    const [action] = await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    const recovery = recoveryService(f.db, { enqueueWakeup: vi.fn() });
    const notes = () => f.db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))
      .then(rows => rows.filter(row => row.metadata?.authorizationReason === `task_stop_proved:${action!.id}`));
    const release = () => f.db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" })
      .where(eq(environmentLeases.id, lease!.id));
    const issue = async () => (await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0]!;
    return { ...f, companyId, agentId, action: action!, recovery, notes, release, issue };
  }

  it("R10 F1: an authorized managing-agent Stop (cancelled, did work) shows no Retry on the card", async () => {
    const f = await fixture("cancelled");
    await f.release();
    await f.recovery.reconcileActiveRecoveryActions({ companyId: f.companyId });
    // The stopped run released the task (its claims are cleared once the Stop is proved).
    await f.db.update(issues).set({ checkoutRunId: null, executionRunId: null, executionLockedAt: null }).where(eq(issues.id, f.issueId));
    const presentation = await taskInterruptionPresentation(f.db, await f.issue());
    expect(presentation?.canRetry ?? false).toBe(false);
    expect(presentation?.state).not.toBe("failed");
  });

  it("R1 A / R10 F1: stop-pending writes 'Press Retry' only where Retry is accepted; card = transcript = recovery detail", async () => {
    const f = await fixture("cancelled");
    await f.release();
    await f.recovery.reconcileActiveRecoveryActions({ companyId: f.companyId });
    const notes = await f.notes();
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toBe(newTaskNote);
    expect(notes[0]!.body).not.toMatch(/Press Retry/);
    const [settled] = await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.action.id));
    expect(withTaskStopPendingInstruction(settled!, settled!.nextAction)).toBe(notes[0]!.body);
  });

  it("R1 A: a managing-agent Stop on a FAILED run (Retry accepted) keeps the exact Retry-first note and card Retry", async () => {
    const f = await fixture("failed");
    await f.release();
    await f.recovery.reconcileActiveRecoveryActions({ companyId: f.companyId });
    expect((await f.notes())[0]?.body).toBe(retryNote);
  });

  it("R14 F5 live-bound probe: Stop proof is never taken while the saved bound run is still running", async () => {
    const f = await fixture("cancelled");
    await f.db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    await f.release();
    await f.recovery.reconcileActiveRecoveryActions({ companyId: f.companyId });
    const [after] = await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.action.id));
    expect(after!.status).toBe("escalated");
    expect(await f.notes()).toHaveLength(0);
  });

  it("R2 C bound: a forever-retrying unproven Stop waits visibly (card), and the clock refuses Retry at 5 min (identical re-records never refresh it)", async () => {
    const waiting = "Retry is waiting for the previous execution to stop. Your message is saved.";
    const unproven = "Paperclip could not confirm that the previous run stopped, so Retry can't continue this conversation. "
      + "To continue, assign this agent a new task.";
    const f = await fixture("cancelled");
    // The stopped run released the task; its lease never releases, so no Stop proof ever arrives.
    await f.db.update(issues).set({ checkoutRunId: null, executionRunId: null, executionLockedAt: null }).where(eq(issues.id, f.issueId));
    // The person's Retry, deferred by admission while the Stop is unproven.
    await f.db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "on_demand",
      reason: "task_retry", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId: f.issueId, taskRetry: { schema: "paperclip.task-retry.v1", sourceRunId: f.runId },
        executionWait: { reason: "execution_settling", message: waiting } } });
    const start = Date.now();
    try {
      for (let minute = 0; minute < 5; minute++) {
        vi.useFakeTimers({ toFake: ["Date"], now: start + minute * 60_000 });
        // Every pass of the never-parking sweep re-records the SAME binding and fails to prove the Stop.
        await f.db.transaction(async tx => {
          await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
          await recordTaskStopPending(tx as unknown as Db, { companyId: f.companyId, issueId: f.issueId, runIds: [f.runId],
            source: "recovery.sweep_stale_issue_locks" }, []);
        });
        await f.recovery.reconcileActiveRecoveryActions({ companyId: f.companyId });
        expect((await readRetryStopGate(f.db, { companyId: f.companyId, issueId: f.issueId, sourceRunId: f.runId }))?.state).toBe("waiting");
        const card = await taskInterruptionPresentation(f.db, await f.issue());
        expect(card).toMatchObject({ canRetry: false, retryWait: { reason: "execution_settling", message: waiting } });
      }
      vi.useFakeTimers({ toFake: ["Date"], now: start + 5 * 60_000 + 1_000 });
      expect((await readRetryStopGate(f.db, { companyId: f.companyId, issueId: f.issueId, sourceRunId: f.runId }))?.state).toBe("expired");
      const card = await taskInterruptionPresentation(f.db, await f.issue());
      expect(card).toMatchObject({ canRetry: false, retryWait: { message: unproven } });
      await expect(requestTaskRetry({ db: f.db, companyId: f.companyId, issueId: f.issueId, actorId: "board",
        actorSource: "local_implicit", observedRunId: f.runId, idempotencyKey: randomUUID() }))
        .rejects.toMatchObject({ status: 409, details: { code: "execution_stop_unproven" } });
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);
});
