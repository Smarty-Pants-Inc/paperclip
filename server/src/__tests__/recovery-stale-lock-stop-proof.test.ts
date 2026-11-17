import { randomUUID } from "node:crypto";
import { agents, companies, createDb, environmentLeases, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentExecutionStopBlocker, runExecutionsHaveStopped } from "../services/agent-execution-stop.js";
import { recoveryService } from "../services/recovery/service.js";
import { nativeUserStopRecoveryHeld } from "../services/native-runtime/native-user-stop-settlement.js";

// Keep reason: #20807 RFL F1's independent PostgreSQL reproduction caught a
// data-safety failure: the ordinary sweep released a still-executing owner's
// claims immediately after guarded stranded-assignment recovery retained them.
describe("stale-lock sweep requires execution Stop proof", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-stale-lock-stop-");
    db = createDb(database.connectionString, { maxConnections: 4 });
    db.$client.options.onnotice = () => {};
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Independent ownership check", issuePrefix: `J${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Stopping owner", adapterType: "http",
      status: "paused", pauseReason: "budget", lifecycleState: "pausing", lifecycleHolds: ["budget"],
      lifecycleRequiredPluginIds: [], lifecycleOperation: { id: randomUUID(), attempts: 1, hostComplete: false, completedPluginIds: [] } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "cancelled",
      runtimeMode: "legacy", executionStage: "dispatching", startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(),
      contextSnapshot: { issueId }, runnerProfileJson: { adapterDispatch: { adapterType: "http" } }, resultJson: {},
      controllerLeaseExpiresAt: new Date(Date.now() + 600_000), processPid: process.pid });
    await db.insert(issues).values({ id: issueId, companyId, title: "Unconfirmed stopped task", status: "in_progress",
      assigneeAgentId: agentId, checkoutRunId: runId, executionRunId: runId, executionLockedAt: new Date() });
    return { companyId, agentId, issueId, runId };
  }
  async function task(id: string) { return (await db.select().from(issues).where(eq(issues.id, id)))[0]!; }
  async function acknowledgeStop(runId: string) {
    await db.update(heartbeatRuns).set({ processPid: null, controllerLeaseExpiresAt: null,
      resultJson: { executionCancellation: { state: "acknowledged" } } }).where(eq(heartbeatRuns.id, runId));
  }

  it("retains both claims after guarded recovery when cancellation has no Stop proof and the PID is live", async () => {
    const f = await fixture();
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
    const before = await task(f.issueId);
    expect(await runExecutionsHaveStopped(db, f.companyId, [f.runId])).toBe(false);
    expect((await recovery.reconcileStrandedAssignedIssues()).escalated).toBe(0);
    expect(await task(f.issueId)).toEqual(before);
    const swept = await recovery.sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId });
    expect(await runExecutionsHaveStopped(db, f.companyId, [f.runId])).toBe(false);
    expect(await task(f.issueId)).toMatchObject({ checkoutRunId: f.runId, executionRunId: f.runId });
    expect(swept).toEqual({ cleared: 0, issueIds: [], terminalizedRunIds: [] });
  });

  it("clears both claims once durable cancellation acknowledgement and released execution establish Stop", async () => {
    const f = await fixture();
    await acknowledgeStop(f.runId);
    expect(await runExecutionsHaveStopped(db, f.companyId, [f.runId])).toBe(true);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
    expect(await recovery.sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId }))
      .toEqual({ cleared: 1, issueIds: [f.issueId], terminalizedRunIds: [] });
    expect(await task(f.issueId)).toMatchObject({ status: "in_progress", checkoutRunId: null, executionRunId: null, executionLockedAt: null });
  });

  it("rechecks Stop proof in the clear transaction rather than trusting the candidate read", async () => {
    const f = await fixture();
    await acknowledgeStop(f.runId);
    const before = await task(f.issueId);
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(), beforeStaleLockClear: async () => {
      await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.runId));
    } });
    expect((await recovery.sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId })).cleared).toBe(0);
    expect(await task(f.issueId)).toEqual(before);
  });

  it("requires Stop proof for both distinct bound owners", async () => {
    const f = await fixture(), executionRunId = randomUUID();
    await acknowledgeStop(f.runId);
    await db.insert(heartbeatRuns).values({ id: executionRunId, companyId: f.companyId, agentId: f.agentId,
      invocationSource: "on_demand", status: "cancelled", runtimeMode: "legacy", executionStage: "dispatching",
      startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(), processPid: process.pid, contextSnapshot: { issueId: f.issueId } });
    await db.update(issues).set({ executionRunId }).where(eq(issues.id, f.issueId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
    expect((await recovery.sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId })).cleared).toBe(0);
    expect(await task(f.issueId)).toMatchObject({ checkoutRunId: f.runId, executionRunId });
    await acknowledgeStop(executionRunId);
    expect((await recovery.sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId })).cleared).toBe(1);
    expect(await task(f.issueId)).toMatchObject({ checkoutRunId: null, executionRunId: null });
  });
  // h6s port: the fork warm-box fixture and Stop-card reader these cases use (from 951a02259; absent on this line).
  async function warmFixture(stranded = false) {
    const f = await fixture();
    await db.update(agents).set({ adapterType: "paperclip_runner", status: stranded ? "paused" : "active",
      lifecycleState: stranded ? "pausing" : "ready", lifecycleHolds: stranded ? ["budget"] : [],
      pauseReason: stranded ? "budget" : null }).where(eq(agents.id, f.agentId));
    await db.update(heartbeatRuns).set({ status: "succeeded", runtimeMode: "native", executionStage: "settled",
      issueId: f.issueId, nativeIssueId: f.issueId, processPid: null, controllerLeaseExpiresAt: null,
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } }, resultJson: { stopReason: "completed" } })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ title: "Healthy warm Boat chat", status: stranded ? "in_progress" : "in_review",
      conversationAgentId: f.agentId, conversationUserId: "board-user", conversationState: stranded ? "active" : "waiting" })
      .where(eq(issues.id, f.issueId));
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
      heartbeatRunId: f.runId, status: "active", leasePolicy: "reuse_by_environment",
      provider: "plugin:boat:computer", providerLeaseId: `boat-${f.runId}`, expiresAt: new Date(Date.now() + 300_000),
      metadata: { driver: "plugin", pluginKey: "boat", driverKey: "computer", agentId: f.agentId,
        runnerTaskLease: true, runnerTaskDispatched: true, runnerTaskExecutionStopped: false,
        runnerTaskLifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 } } }).returning();
    return { ...f, lease: lease! };
  }
  async function stopActions(issueId: string) {
    return db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
  }
  // Keep reason: adopt-h6-src (S1 card d1bc0612, written 1 ms after the cancel).
  // A person's Stop on a keep_running warm box hands the box off warm and never
  // writes a termination receipt. One sweep pass inside that no-receipt window
  // must accept the executor's settled-turn proof, and only that proof.
  async function warmStopFixture(proof: "settled" | "missing" | "generation_mismatch" | "coordinator_owned" | "unacknowledged") {
    const f = await warmFixture();
    const sessionId = randomUUID(), bootId = "boot-1", generation = 3;
    const nativeCancellation = { schema: "paperclip.native-cancellation.v1", runId: f.runId, companyId: f.companyId,
      issueId: f.issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged",
      dispatched: proof !== "unacknowledged", intentAuditId: "intent-1", acknowledgementAuditId: "ack-1" };
    const receipt = { schema: "paperclip.native-retained-idle-checkpoint.v1", companyId: f.companyId, issueId: f.issueId,
      runId: f.runId, sessionId, bootId, generation: proof === "generation_mismatch" ? generation + 1 : generation };
    await db.update(heartbeatRuns).set({ status: "cancelled", nativeSessionId: sessionId,
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "board-user",
        executionCancellation: { state: "acknowledged" }, nativeCancellation },
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" },
        ...(proof === "missing" ? {} : { nativeRetainedIdleCheckpoint: receipt }) } }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issueId));
    await db.insert(nativeRunFinalizations).values({ runId: f.runId, companyId: f.companyId, issueId: f.issueId,
      phase: proof === "coordinator_owned" ? "observed" : "terminal_failure", failureCode: "native_retry_cancelled",
      controllerBootId: bootId, controllerGeneration: generation,
      ...(proof === "coordinator_owned" ? { leaseOwner: "executor", leaseExpiresAt: new Date(Date.now() + 60_000) } : {}) });
    return f;
  }
  async function onePass(f: { companyId: string; issueId: string; runId: string }) {
    // Deterministic race: one direct sweep pass, no termination receipt yet.
    await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId });
    return { cards: await stopActions(f.issueId),
      held: await nativeUserStopRecoveryHeld(db, { companyId: f.companyId, issueId: f.issueId, runId: f.runId }) };
  }

  it("a proved warm-turn handoff Stop with no termination receipt raises no card and holds no owner", async () => {
    const f = await warmStopFixture("settled");
    const { cards, held } = await onePass(f);
    // Base: an escalated execution_stop_pending card that holds the warm owner
    // (native refusal owner_recovery_action_pending, so a FRESH thread).
    expect(cards.map(card => card.cause)).toEqual([]);
    expect(held).toBe(false);
    expect(await runExecutionsHaveStopped(db, f.companyId, [f.runId])).toBe(true);
    // The warm box stays as it was: no release, no termination.
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0]).toEqual(f.lease);
    // Whole-agent lifecycle Stop is not broadened by the task-scoped proof.
    expect(await agentExecutionStopBlocker(db, [f.agentId])).toBe("environment_lease_unreleased");
  });

  it.each(["missing", "generation_mismatch", "coordinator_owned", "unacknowledged"] as const)(
    "settled-turn proof %s keeps the Stop-pending card", async proof => {
      const f = await warmStopFixture(proof);
      expect(await runExecutionsHaveStopped(db, f.companyId, [f.runId])).toBe(false);
      const { cards, held } = await onePass(f);
      expect(cards).toMatchObject([{ status: "escalated", cause: "execution_stop_pending" }]);
      expect(held).toBe(true);
    });

  it("a stop_and_retain Stop with no receipt yet keeps the card even with a settled-turn receipt", async () => {
    const f = await warmStopFixture("settled");
    await db.update(environmentLeases).set({ metadata: { ...f.lease.metadata, sandboxStopAndRetain: { requestedAt: new Date().toISOString() } } })
      .where(eq(environmentLeases.id, f.lease.id));
    expect(await runExecutionsHaveStopped(db, f.companyId, [f.runId])).toBe(false);
    const { cards, held } = await onePass(f);
    expect(cards).toMatchObject([{ status: "escalated", cause: "execution_stop_pending" }]);
    expect(held).toBe(true);
  });
});
