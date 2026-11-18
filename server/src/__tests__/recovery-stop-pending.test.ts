import { randomUUID } from "node:crypto";
import request from "supertest";
import { agents, createDb, environmentLeases, heartbeatRuns, issueComments, issueRecoveryActions, issueThreadInteractions, issues, activityLog, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedCompanyWithBoardAccess, routeApp } from "./helpers/route-test-harness.js";
import { issueRoutes } from "../routes/issues.js";
import { recoveryService } from "../services/recovery/service.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { recordTaskStopPending } from "../services/recovery/stop-pending.js";
import { expectPersonSeesInsteadOfCard } from "./helpers/c1-no-card-surface.js";

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

  it("supersedes(C1 no-Stop card; RFL record SUPERSEDE-C1-NOSTOP-CARD-1118): gives the judge's 30-day unassigned hold a durable API-visible code, recovery owner and bounded board escalation", async () => {
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

  it("supersedes(C1 no-Stop card; RFL record SUPERSEDE-C1-NOSTOP-CARD-1118): keeps a stronger existing recovery action and its owner, while exposing Stop escalation; proof removes only this annotation", async () => {
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

  it("supersedes(C1 no-Stop card; RFL record SUPERSEDE-C1-NOSTOP-CARD-1118): does not let terminal task projection or generic recovery resolution hide an unproven Stop", async () => {
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

  it("C1 RED: a failed run with a pending lease release and no person Stop never gets a 'Stop pending' card (+30 s, +2 min, +14 min; +1 h only the true late card)", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed", runtimeMode: "native",
      issueId: f.issueId, nativeIssueId: f.issueId }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: f.runId,
      status: "active", leasePolicy: "reuse_by_environment", provider: "plugin:boat:computer", providerLeaseId: `boat-${f.runId}`,
      expiresAt: new Date(Date.now() + 300_000), metadata: { releaseDeferral: { reason: "workspace_retention_busy", attempts: 1,
        retryAt: new Date().toISOString() } } });
    for (const ms of [30_000, 2 * 60_000, 14 * 60_000]) {
      await finishedAgo(f.runId, ms);
      expect((await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks()).cleared).toBe(0);
      expect(await stopCards(f.issueId), `+${ms} ms`).toEqual([]);
    }
    await expectPersonSeesInsteadOfCard(db, f.issueId);
    // C1 (b): an hour on, still unreleased: the true late card, never 'Stop pending'.
    await finishedAgo(f.runId, 60 * 60_000);
    expect((await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks()).cleared).toBe(0);
    expect(await stopCards(f.issueId)).toMatchObject([{ cause: "execution_environment_unreleased", status: "escalated" }]);
    expect((await stopCards(f.issueId))[0]!.nextAction).not.toMatch(/stop pending/i);
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
  // ---- C1 round 3 (rf-5 13:55Z FAIL + RFL 14:00Z ruling) ----
  const LATE_TEXT = "The previous run's environment hasn't been released, so this task can't start yet.";
  async function sweep() { return (await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks()).cleared; }
  async function stopPendingLogs() { return db.select().from(activityLog).where(eq(activityLog.action, "issue.execution_stop_pending")); }
  async function writer(f: Awaited<ReturnType<typeof fixture>>) {
    await db.transaction(async tx => recordTaskStopPending(tx as unknown as Db, { companyId: f.companyId, issueId: f.issueId,
      runIds: [f.runId], source: "recovery.sweep_stale_issue_locks" }, []));
  }
  /** What a non-person cancel records (heartbeat/run-control.ts runCancellationFenceSql): no user actor. */
  function systemCancel(errorCode: string, extra: Record<string, unknown>, at = new Date().toISOString()) {
    return { errorCode, resultJson: { cancellation: { requestedAt: at, reason: errorCode },
      startupCancellation: { requestedAt: at, errorCode, beforeNativeSelection: false },
      executionCancellation: { state: "requested", requestedAt: at }, ...extra } };
  }
  const SYSTEM_CAUSES = [
    ["a system cancel", "cancelled", {}],
    ["controller_lease_lost", "controller_lease_lost", {}],
    ["server_shutdown_interrupted", "server_shutdown_interrupted", {}],
    ["duplex_channel_lost", "duplex_channel_lost", {}],
    ["a system reassignment", "issue_reassigned", { reassignmentStopRequested: true }],
    // routes/issues.ts board Done: issue_terminalized with the board user's attribution.
    ["board Done", "issue_terminalized", { terminalizationStopConfirmed: true, cancelledByActorType: "user", cancelledByUserId: "board-user" }],
    // routes/agents.ts POST /heartbeat-runs/:runId/cancel by a managing agent.
    ["a managing agent's cancel", "operator_interrupted", { cancelledByActorType: "agent", cancelledByAgentId: "manager-agent" }],
  ] as const;

  it.each(SYSTEM_CAUSES)("C1 F1: %s is not a person's Stop: no 'Stop pending' card at +61 s; at +16 min only the true late card", async (_label, errorCode, extra) => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ ...systemCancel(errorCode, extra), issueId: f.issueId,
      contextSnapshot: { issueId: f.issueId } }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ assigneeAgentId: f.agentId }).where(eq(issues.id, f.issueId));
    const before = await task(f.issueId);
    await finishedAgo(f.runId, 61_000);
    expect(await sweep()).toBe(0);
    expect(await stopCards(f.issueId)).toEqual([]);
    expect(await stopPendingLogs()).toEqual([]);
    expect(await task(f.issueId)).toEqual(before);
    await expectPersonSeesInsteadOfCard(db, f.issueId);
    await finishedAgo(f.runId, 16 * 60_000);
    expect(await sweep()).toBe(0);
    const cards = await stopCards(f.issueId);
    expect(cards).toMatchObject([{ cause: "execution_environment_unreleased", status: "escalated", ownerType: "board" }]);
    expect(cards[0]!.nextAction.startsWith(LATE_TEXT)).toBe(true);
    expect(cards[0]!.nextAction).not.toMatch(/stop pending|execution_stop_pending/i);
    expect(await stopPendingLogs()).toEqual([]);
    expect(await task(f.issueId)).toEqual(before);
  });

  it("C1 F1 KEEP: a person's Interrupt (the Interrupt route's user actor) still raises 'Stop pending' after 60 s", async () => {
    const f = await fixture({ operatorInterrupted: true, interruptionSource: "issue_comment_interrupt", interruptedByActorType: "user",
      interruptedByActorId: "board-user", cancelledByActorType: "user", cancelledByUserId: "board-user" });
    await db.update(heartbeatRuns).set({ errorCode: "operator_interrupted" }).where(eq(heartbeatRuns.id, f.runId));
    await finishedAgo(f.runId, 61_000);
    expect(await sweep()).toBe(0);
    expect(await stopCards(f.issueId)).toMatchObject([{ cause: "execution_stop_pending", status: "escalated" }]);
  });

  it.each([0, 30, 59])("C1 F2: an unfinished person Stop requested %s s ago gets no card from the writer", async seconds => {
    const at = new Date(Date.now() - seconds * 1000).toISOString();
    const f = await fixture({ ...PERSON_STOP, executionCancellation: { state: "requested", requestedAt: at } });
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    const before = await task(f.issueId);
    await writer(f);
    expect(await stopCards(f.issueId)).toEqual([]);
    expect(await task(f.issueId)).toEqual(before);
  });

  it("C1 F2 KEEP: an unfinished person Stop requested 61 s ago and still unconfirmed raises 'Stop pending'", async () => {
    const at = new Date(Date.now() - 61_000).toISOString();
    const f = await fixture({ ...PERSON_STOP, executionCancellation: { state: "requested", requestedAt: at } });
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    await writer(f);
    expect(await stopCards(f.issueId)).toMatchObject([{ cause: "execution_stop_pending", status: "escalated",
      evidence: { stopPending: { code: "execution_stop_pending", runIds: [f.runId] } } }]);
  });

  // ---- C1 round 4 (RFL FAIL on round 3; rf-5 rows (a)-(c)) ----
  // 'Delivered' is the unanswered-message sweep's rule (answeredPersonMessageSql)
  // for the person message the stopped run carried; a successor carries it too.
  const RETIRED_DELIVERED = "The person's message on this task was answered; no further hold is shown. This is not Stop proof. Execution claims are unchanged.";
  async function successor(f: Awaited<ReturnType<typeof fixture>>, delivers: "nothing" | "answer" | "card") {
    const messageId = randomUUID(), runId = randomUUID();
    await db.insert(issueComments).values({ id: messageId, companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: "board-user", body: "Please send me the final report.", createdAt: new Date(Date.now() - 120_000) });
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, wakeCommentId: messageId } })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      invocationSource: "on_demand", issueId: f.issueId, contextSnapshot: { issueId: f.issueId, wakeCommentId: messageId },
      resultJson: {}, createdAt: new Date(Date.now() + 1_000), startedAt: new Date(Date.now() - 19_300), finishedAt: new Date(Date.now() - 5_000) });
    if (delivers === "answer") await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent",
      authorAgentId: f.agentId, createdByRunId: runId, body: "Here is the final report." });
    if (delivers === "card") await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "ask_user_questions", status: "pending", sourceRunId: runId, createdByAgentId: f.agentId,
      title: "Which format do you want for the report?", payload: { questions: [] } as never });
    return { messageId, runId };
  }
  async function personStopCard() {
    const f = await fixture(PERSON_STOP);
    await finishedAgo(f.runId, 61_000);
    expect(await sweep()).toBe(0);
    const [card] = await stopCards(f.issueId);
    expect(card).toMatchObject({ cause: "execution_stop_pending", status: "escalated" });
    return { ...f, card: card! };
  }

  it("C1 r4 (a): a succeeded successor with an EMPTY result and ZERO comments delivered nothing; the person Stop card stays", async () => {
    const f = await personStopCard();
    await successor(f, "nothing");
    const before = await task(f.issueId);
    for (let tick = 0; tick < 2; tick++) expect(await sweep()).toBe(0);
    expect(await stopCards(f.issueId)).toMatchObject([{ id: f.card.id, cause: "execution_stop_pending", status: "escalated" }]);
    expect(await task(f.issueId)).toEqual(before);
  });
  it("C1 r4 (a): with nobody's Stop, an EMPTY succeeded successor does not suppress the true late card", async () => {
    const f = await unreleasedFailedRun();
    await finishedAgo(f.runId, 16 * 60_000);
    await successor(f, "nothing");
    expect(await sweep()).toBe(0);
    expect(await stopCards(f.issueId)).toMatchObject([{ cause: "execution_environment_unreleased", status: "escalated" }]);
  });
  it("C1 r4 (b): the successor posted the final answer; the existing card retires on the next recheck", async () => {
    const f = await personStopCard();
    await successor(f, "answer");
    const before = await task(f.issueId);
    expect(await sweep()).toBe(0);
    expect(await stopCards(f.issueId)).toMatchObject([{ id: f.card.id, status: "resolved", outcome: "restored",
      resolutionNote: RETIRED_DELIVERED }]);
    expect(await task(f.issueId)).toEqual(before);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.execution_stop_pending_resolved")))
      .toMatchObject([{ details: { reason: "person_message_delivered" } }]);
    expect(await sweep()).toBe(0);
    expect(await stopCards(f.issueId)).toHaveLength(1);
  });
  it("C1 r4 (c): a successor that only opened a card asking the person delivered by the sweep's rule; the Stop card retires, the person sees the agent's question", async () => {
    const f = await personStopCard();
    await successor(f, "card");
    expect(await sweep()).toBe(0);
    expect(await stopCards(f.issueId)).toMatchObject([{ id: f.card.id, status: "resolved", resolutionNote: RETIRED_DELIVERED }]);
    expect(await db.select({ title: issueThreadInteractions.title, status: issueThreadInteractions.status })
      .from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, f.issueId)))
      .toEqual([{ title: "Which format do you want for the report?", status: "pending" }]);
  });
  it("C1 r4 fix 2: a card written in the receipt race (receipt landed after the caller's check) retires on the next sweep, even with the claims gone", async () => {
    const f = await fixture(PERSON_STOP);
    await finishedAgo(f.runId, 61_000);
    // The receipt lands between the caller's Stop check and the card write.
    await db.update(heartbeatRuns).set({ resultJson: { ...PERSON_STOP, executionCancellation: { state: "acknowledged" } } })
      .where(eq(heartbeatRuns.id, f.runId));
    await writer(f);
    const [card] = await stopCards(f.issueId);
    expect(card).toMatchObject({ cause: "execution_stop_pending", status: "escalated" });
    await db.update(issues).set({ checkoutRunId: null, executionRunId: null, executionLockedAt: null }).where(eq(issues.id, f.issueId));
    expect(await sweep()).toBe(0);
    expect(await stopCards(f.issueId)).toMatchObject([{ id: card!.id, status: "resolved", outcome: "restored",
      resolutionNote: "Stop proved under the task and bound-run locks." }]);
  });
  it("C1 r4 fix 3: the true late card closes once its condition is gone: Force release, then a new run's checkout", async () => {
    const f = await unreleasedFailedRun();
    await finishedAgo(f.runId, 16 * 60_000);
    expect(await sweep()).toBe(0);
    const [card] = await stopCards(f.issueId);
    expect(card).toMatchObject({ cause: "execution_environment_unreleased", status: "escalated" });
    const app = routeApp(db, f.actor, issueRoutes);
    await request(app).post(`/api/issues/${f.issueId}/admin/force-release`).send({}).expect(200);
    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: f.companyId, agentId: f.agentId, status: "queued",
      invocationSource: "on_demand", issueId: f.issueId, contextSnapshot: { issueId: f.issueId } });
    await db.update(issues).set({ checkoutRunId: nextRunId, executionRunId: nextRunId, executionLockedAt: new Date() })
      .where(eq(issues.id, f.issueId));
    await sweep();
    expect(await stopCards(f.issueId)).toMatchObject([{ id: card!.id, status: "resolved",
      resolutionNote: expect.stringContaining("Force release") }]);
    expect((await request(app).get(`/api/issues/${f.issueId}`).expect(200)).body.activeRecoveryAction ?? null).toBeNull();
  });

  it("C1 guard 2 (live shape): a person Stop answered by a successor 41.7 s later gets no card after the answer", async () => {
    const f = await fixture(PERSON_STOP);
    await finishedAgo(f.runId, 61_000);
    // C1 r4: the successor DELIVERED (posted its answer), not merely succeeded.
    await successor(f, "answer");
    const before = await task(f.issueId);
    for (let tick = 0; tick < 2; tick++) expect(await sweep()).toBe(0);
    expect(await stopCards(f.issueId)).toEqual([]);
    expect(await stopPendingLogs()).toEqual([]);
    expect(await task(f.issueId)).toEqual(before);
  });

  it("C1 guard 2: a person Stop whose stop receipt lands 41.7 s after the request never cards, at +61 s or later", async () => {
    const f = await fixture(PERSON_STOP);
    await finishedAgo(f.runId, 41_700);
    expect(await sweep()).toBe(0);
    await db.update(heartbeatRuns).set({ resultJson: { ...PERSON_STOP, executionCancellation: { state: "acknowledged" } } })
      .where(eq(heartbeatRuns.id, f.runId));
    await finishedAgo(f.runId, 61_000);
    expect(await sweep()).toBe(1);
    expect(await stopCards(f.issueId)).toEqual([]);
    expect(await stopPendingLogs()).toEqual([]);
    expect(await task(f.issueId)).toMatchObject({ checkoutRunId: null, executionRunId: null });
  });

  async function unreleasedFailedRun() {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed", runtimeMode: "native",
      issueId: f.issueId, nativeIssueId: f.issueId }).where(eq(heartbeatRuns.id, f.runId));
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: f.runId,
      status: "active", leasePolicy: "reuse_by_environment", provider: "plugin:boat:computer", providerLeaseId: `boat-${f.runId}`,
      expiresAt: new Date(Date.now() + 300_000), metadata: { releaseDeferral: { reason: "workspace_retention_busy", attempts: 1,
        retryAt: new Date().toISOString() } } }).returning();
    return { ...f, lease: lease! };
  }

  it("C1 (b): a run nobody stopped, finished 15+ min ago and still unreleased, surfaces ONE true card whose next step (Force release) works", async () => {
    const f = await unreleasedFailedRun();
    const before = await task(f.issueId);
    await finishedAgo(f.runId, 16 * 60_000);
    for (let tick = 0; tick < 2; tick++) expect(await sweep()).toBe(0);
    const cards = await stopCards(f.issueId);
    expect(cards).toMatchObject([{ cause: "execution_environment_unreleased", status: "escalated", ownerType: "board",
      evidence: { stopPending: { code: "execution_environment_unreleased", runIds: [f.runId] } } }]);
    expect(cards[0]!.nextAction).toBe(`${LATE_TEXT} A board member can release the task with Force release (paperclipai issue force-release <task>), then start it again.`);
    expect(cards[0]!.nextAction).not.toMatch(/stop pending|execution_stop_pending/i);
    expect(await stopPendingLogs()).toEqual([]);
    expect(await task(f.issueId)).toEqual(before);
    const app = routeApp(db, f.actor, issueRoutes);
    const shown = (await request(app).get(`/api/issues/${f.issueId}`).expect(200)).body.activeRecoveryAction;
    expect(shown).toMatchObject({ id: cards[0]!.id, cause: "execution_environment_unreleased" });
    expect(shown.nextAction.startsWith(LATE_TEXT)).toBe(true);
    // The offered next step: the board's Force release (routes/issues.ts POST /issues/:id/admin/force-release).
    await request(app).post(`/api/issues/${f.issueId}/admin/force-release`).send({}).expect(200);
    expect(await task(f.issueId)).toMatchObject({ checkoutRunId: null, executionRunId: null, executionLockedAt: null });
  });

  it("C1 (b) transient: a run released within 15 min never cards", async () => {
    const f = await unreleasedFailedRun();
    for (const ms of [61_000, 5 * 60_000, 14 * 60_000]) {
      await finishedAgo(f.runId, ms);
      expect(await sweep()).toBe(0);
      expect(await stopCards(f.issueId), `+${ms} ms`).toEqual([]);
    }
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success", metadata: {} })
      .where(eq(environmentLeases.id, f.lease.id));
    await finishedAgo(f.runId, 16 * 60_000);
    await sweep();
    expect(await stopCards(f.issueId)).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.execution_environment_unreleased"))).toEqual([]);
  });
});
