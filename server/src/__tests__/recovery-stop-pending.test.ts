import { randomUUID } from "node:crypto";
import request from "supertest";
import { agents, createDb, environmentLeases, heartbeatRuns, issueRecoveryActions, issues, activityLog, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedCompanyWithBoardAccess, routeApp } from "./helpers/route-test-harness.js";
import { issueRoutes } from "../routes/issues.js";
import { recoveryService } from "../services/recovery/service.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";

// Keep reason: #20807 RFL F2's real PostgreSQL reproduction found a stable,
// silent Stop hold on a 30-day unassigned task. Data safety requires retaining
// the claim, but the ordinary issue API must expose who now owns the decision.
describe("unproven task Stop is visibly escalated, never released by age", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-stop-pending-");
    db = createDb(database.connectionString, { maxConnections: 4 });
    db.$client.options.onnotice = () => {};
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  // C1: a card needs a recorded person Stop; the board Stop button records its user.
  const PERSON_STOP = { cancelledByActorType: "user", cancelledByUserId: "board-user" };
  async function fixture(resultJson: Record<string, unknown> = {}) {
    const { companyId, actor } = await seedCompanyWithBoardAccess(db, "Stop hold");
    const agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const old = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    await db.insert(agents).values({ id: agentId, companyId, name: "Old owner", adapterType: "http",
      status: "active", lifecycleState: "ready", lifecycleHolds: [], lifecycleRequiredPluginIds: [] });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "cancelled",
      runtimeMode: "legacy", executionStage: "dispatching", startedAt: old, finishedAt: old,
      runnerProfileJson: { adapterDispatch: { adapterType: "http" } }, resultJson });
    // No context.issueId and no assignee/lifecycle operation: the task's actual
    // binding, not a best-effort run-context join, must carry this state.
    await db.insert(issues).values({ id: issueId, companyId, title: "Thirty-day Stop without proof", status: "in_progress",
      checkoutRunId: runId, executionRunId: runId, executionLockedAt: old });
    return { companyId, agentId, issueId, runId, actor };
  }
  async function task(id: string) { return (await db.select().from(issues).where(eq(issues.id, id)))[0]!; }
  async function acknowledge(runId: string) {
    await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "acknowledged" } } })
      .where(eq(heartbeatRuns.id, runId));
  }

  it("supersedes(C1 no-Stop card): gives the judge's 30-day unassigned hold a durable API-visible code, recovery owner and bounded board escalation", async () => {
    const f = await fixture(PERSON_STOP);
    const before = await task(f.issueId);
    const runBefore = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0];
    const enqueueWakeup = vi.fn();
    for (let pass = 0; pass < 3; pass++) {
      // Recreate the service to prove that a process-local counter is not the owner.
      const recovery = recoveryService(db, { enqueueWakeup });
      await recovery.reconcileStrandedAssignedIssues();
      expect((await recovery.sweepStaleIssueLocks()).cleared).toBe(0);
      expect(await task(f.issueId)).toEqual(before);
    }
    const app = routeApp(db, f.actor, issueRoutes);
    const response = await request(app).get(`/api/issues/${f.issueId}`).expect(200);
    expect(response.body.activeRecoveryAction).toMatchObject({
      cause: "execution_stop_pending", status: "escalated", ownerType: "board", attemptCount: 1, maxAttempts: 1,
      evidence: { stopPending: { code: "execution_stop_pending", owner: "recovery.sweep_stale_issue_locks",
        runIds: [f.runId], escalation: "board", automaticAttemptsExhausted: true } },
    });
    expect(response.body.activeRecoveryAction.nextAction).toMatch(/cannot confirm.*stopped/i);
    const id = response.body.activeRecoveryAction.id;
    expect((await request(app).get(`/api/issues/${f.issueId}`).expect(200)).body.activeRecoveryAction.id).toBe(id);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.execution_stop_pending"))).toHaveLength(1);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(runBefore);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    await acknowledge(f.runId);
    expect((await recoveryService(db, { enqueueWakeup }).sweepStaleIssueLocks()).cleared).toBe(1);
    expect(await task(f.issueId)).toMatchObject({ checkoutRunId: null, executionRunId: null });
    expect((await request(app).get(`/api/issues/${f.issueId}`).expect(200)).body.activeRecoveryAction).toBeNull();
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)))[0])
      .toMatchObject({ status: "resolved", outcome: "restored" });
  });

  it("supersedes(C1 no-Stop card): keeps a stronger existing recovery action and its owner, while exposing Stop escalation; proof removes only this annotation", async () => {
    const f = await fixture(PERSON_STOP);
    const [prior] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "uncertain_provider_action", fingerprint: "existing-action",
      ownerType: "board", status: "escalated", nextAction: "Review the recorded provider effect.",
      evidence: { runId: f.runId, importantReceipt: "retain" }, attemptCount: 3, maxAttempts: 3 }).returning();
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
    expect((await recovery.sweepStaleIssueLocks()).cleared).toBe(0);
    const app = routeApp(db, f.actor, issueRoutes);
    const held = (await request(app).get(`/api/issues/${f.issueId}`).expect(200)).body.activeRecoveryAction;
    expect(held).toMatchObject({ id: prior.id, cause: prior.cause, status: prior.status, ownerType: prior.ownerType,
      attemptCount: 3, maxAttempts: 3, evidence: { importantReceipt: "retain", stopPending: { code: "execution_stop_pending", escalation: "board" } } });
    expect(held.nextAction).toContain(prior.nextAction);
    expect(held.nextAction).toContain("execution_stop_pending");
    await acknowledge(f.runId);
    expect((await recovery.sweepStaleIssueLocks()).cleared).toBe(1);
    const [after] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, prior.id));
    expect(after).toMatchObject({ cause: prior.cause, status: prior.status, ownerType: prior.ownerType,
      attemptCount: 3, maxAttempts: 3, nextAction: prior.nextAction, evidence: prior.evidence });
  });

  it("supersedes(C1 no-Stop card): does not let terminal task projection or generic recovery resolution hide an unproven Stop", async () => {
    const f = await fixture(PERSON_STOP);
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
    expect((await recovery.sweepStaleIssueLocks()).cleared).toBe(0);
    const [held] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await recovery.reconcileActiveRecoveryActions();
    expect(await issueRecoveryActionService(db).resolveActiveForIssue({ companyId: f.companyId, sourceIssueId: f.issueId,
      actionId: held.id, status: "resolved", outcome: "restored", resolutionNote: "Task is closed, but Stop is unproven." })).toBeNull();
    const app = routeApp(db, f.actor, issueRoutes);
    expect((await request(app).get(`/api/issues/${f.issueId}`).expect(200)).body.activeRecoveryAction)
      .toMatchObject({ id: held.id, cause: "execution_stop_pending", status: "escalated" });
    expect(await task(f.issueId)).toMatchObject({ status: "cancelled", checkoutRunId: f.runId, executionRunId: f.runId });
  });

  it("never annotates a new claim using a stale sweep candidate", async () => {
    const f = await fixture(), newerRun = randomUUID();
    await db.insert(heartbeatRuns).values({ id: newerRun, companyId: f.companyId, agentId: f.agentId,
      status: "running", invocationSource: "manual", startedAt: new Date() });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(), beforeStaleLockClear: async () => {
      await db.update(issues).set({ checkoutRunId: newerRun, executionRunId: newerRun }).where(eq(issues.id, f.issueId));
    } });
    expect((await recovery.sweepStaleIssueLocks()).cleared).toBe(0);
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(await task(f.issueId)).toMatchObject({ checkoutRunId: newerRun, executionRunId: newerRun });
  });
  // Keep reason: C1. 103 "Stop pending" cards in 7 days, 102 on tasks nobody
  // stopped: failed runs with a pending lease release. Drive the real sweep.
  async function finishedAgo(runId: string, ms: number) {
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - ms) }).where(eq(heartbeatRuns.id, runId));
  }
  async function stopCards(issueId: string) {
    return db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
  }

  it("C1 RED: a failed run with a pending lease release and no person Stop never gets a card (+30 s, +2 min, +1 h)", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed", runtimeMode: "native",
      issueId: f.issueId, nativeIssueId: f.issueId }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: f.runId,
      status: "active", leasePolicy: "reuse_by_environment", provider: "plugin:boat:computer", providerLeaseId: `boat-${f.runId}`,
      expiresAt: new Date(Date.now() + 300_000), metadata: { releaseDeferral: { reason: "workspace_retention_busy", attempts: 1,
        retryAt: new Date().toISOString() } } });
    for (const ms of [30_000, 2 * 60_000, 60 * 60_000]) {
      await finishedAgo(f.runId, ms);
      expect((await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks()).cleared).toBe(0);
      expect(await stopCards(f.issueId), `+${ms} ms`).toEqual([]);
    }
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.execution_stop_pending"))).toEqual([]);
    expect(await task(f.issueId)).toMatchObject({ checkoutRunId: f.runId, executionRunId: f.runId });
  });

  it("C1 RED+CONTROL: a person's Stop gets no card for 60 s, then exactly one; its stop receipt closes it", async () => {
    const f = await fixture(PERSON_STOP);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
    await finishedAgo(f.runId, 20_000);
    expect((await recovery.sweepStaleIssueLocks()).cleared).toBe(0);
    expect(await stopCards(f.issueId)).toEqual([]);
    // CONTROL: the true case still works. 61 s on, still no receipt: one card, not one per tick.
    await finishedAgo(f.runId, 61_000);
    for (let tick = 0; tick < 2; tick++) expect((await recovery.sweepStaleIssueLocks()).cleared).toBe(0);
    const cards = await stopCards(f.issueId);
    expect(cards).toMatchObject([{ cause: "execution_stop_pending", status: "escalated",
      evidence: { stopPending: { runIds: [f.runId] } } }]);
    // CONTROL: the stop receipt lands; the card closes and the claims release.
    await acknowledge(f.runId);
    expect((await recovery.sweepStaleIssueLocks()).cleared).toBe(1);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, cards[0]!.id)))[0])
      .toMatchObject({ status: "resolved", outcome: "restored" });
  });

  it("C1 CONTROL: a receipt that lands inside the 60 s window means no card ever opens", async () => {
    const f = await fixture(PERSON_STOP);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
    await finishedAgo(f.runId, 20_000);
    expect((await recovery.sweepStaleIssueLocks()).cleared).toBe(0);
    await acknowledge(f.runId);
    await finishedAgo(f.runId, 61_000);
    expect((await recovery.sweepStaleIssueLocks()).cleared).toBe(1);
    expect(await stopCards(f.issueId)).toEqual([]);
  });
});
