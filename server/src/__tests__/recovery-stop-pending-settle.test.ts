import { randomUUID } from "node:crypto";
import { activityLog, environmentLeases, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { asc, eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { describeEmbeddedPostgres, nativeRestartFixture } from "./helpers/native-restart.js";
import { claimNativeRestartRecoveries } from "../services/native-runtime/native-restart-recovery.js";
import { recordTaskStopPending } from "../services/recovery/stop-pending.js";
import { recoveryService } from "../services/recovery/service.js";

// Keep reason: the real restart-recovery writer clears task claims without
// owning the #20807 Stop hold. Exercise that incident boundary with PostgreSQL,
// not a mocked proof or a timer: lease release is the missing positive evidence.
describeEmbeddedPostgres("Stop-pending settles independently of the claim-release owner", () => {
  const environment = nativeRestartFixture();
  const retryNote = "This task was stopped and its saved work is kept. Press Retry to run it again, or assign this agent a new task.";
  const heldNote = "This task was stopped and its saved work is kept. Assign this agent a new task to continue.";

  async function fixture(held = false, standalone = true) {
    const f = await environment.seedRun(randomUUID());
    const { companyId, agentId } = environment.current;
    const old = new Date(Date.now() - 86_400_000);
    await f.db.update(heartbeatRuns).set({ status: "failed", startedAt: old, finishedAt: old,
      errorCode: "native_session_interrupted", resultJson: { cancelledByActorType: "agent", cancelledByAgentId: agentId,
        cancellation: { source: "control_plane", expected: true, initiator: { type: "agent", id: agentId },
          reason: "Cancelled by a managing agent", recordedAt: old.toISOString() } } }).where(eq(heartbeatRuns.id, f.runId));
    await f.db.update(issues).set({ checkoutRunId: f.runId, executionLockedAt: old }).where(eq(issues.id, f.issueId));
    const [lease] = await f.db.insert(environmentLeases).values({ companyId, issueId: f.issueId, heartbeatRunId: f.runId,
      provider: "local", status: "active", cleanupStatus: null }).returning();
    if (!standalone) await f.db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", status: "escalated", ownerType: "board", cause: "uncertain_provider_action",
      fingerprint: randomUUID(), nextAction: "Review the recorded provider effect.", evidence: { importantReceipt: "retain", runId: f.runId },
      attemptCount: 3, maxAttempts: 3 });
    await f.db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update");
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)).orderBy(asc(heartbeatRuns.id)).for("update");
      await recordTaskStopPending(tx as unknown as Db, { companyId, issueId: f.issueId, runIds: [f.runId], source: "recovery.sweep_stale_issue_locks" }, []);
    });
    if (held) await f.db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "system", body: "Held predecessor",
      metadata: { version: 1, authorizationReason: `native_prior_owner_held:${f.native.normalizedSessionId}` } });
    const [action] = await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    const recovery = recoveryService(f.db, { enqueueWakeup: vi.fn() });
    const notes = () => f.db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))
      .then(rows => rows.filter(row => row.metadata?.authorizationReason === `task_stop_proved:${action.id}`));
    return { ...f, companyId, agentId, action, lease, recovery, notes };
  }

  async function release(f: Awaited<ReturnType<typeof fixture>>) {
    await f.db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" })
      .where(eq(environmentLeases.id, f.lease.id));
  }

  it("restart recovery clears the claims; lease release then one sweep resolves the saved binding and writes one plain Retry-first note", async () => {
    const f = await fixture();
    // Force the real restart owner's non-preserving branch without a provider.
    await f.db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
    const dispositions = await claimNativeRestartRecoveries({ db: f.db, controller: environment.current.successor,
      restartKind: "hard", runIds: [f.runId] });
    expect(dispositions).toContainEqual(expect.objectContaining({ kind: "blocked", runId: f.runId }));
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ checkoutRunId: null, executionRunId: null });
    expect((await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.action.id)))[0].status).toBe("escalated");
    // Task status is independent of the run Stop. Restore the open task shape
    // on which the person's Retry is available (the managing agent stopped the run).
    await f.db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issueId));
    await release(f);
    const runsBefore = await f.db.select().from(heartbeatRuns);
    expect(await f.recovery.reconcileActiveRecoveryActions({ companyId: f.companyId })).toMatchObject({ resolved: 1 });
    const [settled] = await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.action.id));
    expect(settled).toMatchObject({ status: "resolved", outcome: "restored", resolutionNote: "Stop proved under the task and bound-run locks." });
    expect(settled.nextAction).not.toContain("execution_stop_pending");
    expect(settled.evidence.stopPending).toEqual(f.action.evidence.stopPending);
    expect(await f.notes()).toHaveLength(1);
    expect((await f.notes())[0].body).toBe(retryNote);
    await f.recovery.reconcileActiveRecoveryActions({ companyId: f.companyId });
    expect(await f.notes()).toHaveLength(1);
    expect(await f.db.select().from(heartbeatRuns)).toEqual(runsBefore);
    expect(await f.db.select().from(activityLog).where(eq(activityLog.action, "issue.execution_stop_confirmed"))).toHaveLength(1);
  });

  it("claims already cleared but Stop not proved: stays escalated, no plain note", async () => {
    const f = await fixture();
    await f.db.update(issues).set({ checkoutRunId: null, executionRunId: null }).where(eq(issues.id, f.issueId));
    await f.recovery.reconcileActiveRecoveryActions({ companyId: f.companyId });
    expect((await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.action.id)))[0]).toEqual(f.action);
    expect(await f.notes()).toHaveLength(0);
  });

  it("a held conversation's settled Stop names only the new-task action, never Retry or a new message", async () => {
    const f = await fixture(true);
    await release(f);
    await f.recovery.reconcileActiveRecoveryActions({ companyId: f.companyId });
    expect(await f.notes()).toHaveLength(1);
    expect((await f.notes())[0].body).toBe(heldNote);
  });

  it("the saved old binding is proved, not a newer task claimant, and concurrent sweeps cannot duplicate the note", async () => {
    const f = await fixture();
    const [newer] = await f.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "running", nativeIssueId: f.issueId }).returning();
    await f.db.update(issues).set({ checkoutRunId: newer.id, executionRunId: newer.id }).where(eq(issues.id, f.issueId));
    await release(f);
    await Promise.all([f.recovery.reconcileActiveRecoveryActions({ companyId: f.companyId }),
      f.recovery.reconcileActiveRecoveryActions({ companyId: f.companyId })]);
    expect((await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.action.id)))[0].status).toBe("resolved");
    expect((await f.db.select().from(issues).where(eq(issues.id, f.issueId)))[0])
      .toMatchObject({ checkoutRunId: newer.id, executionRunId: newer.id });
    expect(await f.notes()).toHaveLength(1);
  });

  it("Stop proof removes only its annotation from an independent stronger obligation", async () => {
    const f = await fixture(false, false);
    await release(f);
    await f.recovery.reconcileActiveRecoveryActions({ companyId: f.companyId });
    const [after] = await f.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.action.id));
    expect(after).toMatchObject({ status: "escalated", cause: "uncertain_provider_action", ownerType: "board",
      nextAction: "Review the recorded provider effect.", attemptCount: 3, maxAttempts: 3,
      evidence: { importantReceipt: "retain", runId: f.runId } });
    expect(after.evidence).not.toHaveProperty("stopPending");
  });
});
