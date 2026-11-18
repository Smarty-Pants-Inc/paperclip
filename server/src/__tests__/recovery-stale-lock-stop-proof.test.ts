import { randomUUID } from "node:crypto";
import { agents, companies, createDb, environmentLeases, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { runExecutionsHaveStopped } from "../services/agent-execution-stop.js";
import { recoveryService } from "../services/recovery/service.js";
import { claimCancellationRequest } from "../services/native-runtime/native-cancellation-request.js";

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

  // Keep reason: N27P's healthy warm Boat chats acquired a false Stop card.
  // Drive the actual server sweep (heartbeat delegates to this service), with
  // real PostgreSQL ownership/lease rows, not a mocked Stop verdict.
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
  async function inspect(f: Awaited<ReturnType<typeof warmFixture>>, path: "sweep" | "stranded") {
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
    if (path === "sweep") expect((await recovery.sweepStaleIssueLocks()).cleared).toBe(0);
    else expect((await recovery.reconcileStrandedAssignedIssues()).escalated).toBe(0);
  }

  it.each(["sweep", "stranded"] as const)("%s leaves a succeeded warm Boat chat clean without releasing its claims", async path => {
    const f = await warmFixture(path === "stranded");
    const before = await task(f.issueId);
    expect(await runExecutionsHaveStopped(db, f.companyId, [f.runId])).toBe(false);
    for (let tick = 0; tick < 3; tick++) {
      await inspect(f, path);
      expect(await stopActions(f.issueId)).toEqual([]);
      expect(await task(f.issueId)).toEqual(before);
    }
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0]).toEqual(f.lease);
  });

  it("recognizes an earlier release's active reusable keep without requiring new warm metadata", async () => {
    const f = await warmFixture();
    await db.update(environmentLeases).set({ metadata: {} }).where(eq(environmentLeases.id, f.lease.id));
    await inspect(f, "sweep");
    expect(await stopActions(f.issueId)).toEqual([]);
    expect(await task(f.issueId)).toMatchObject({ checkoutRunId: f.runId, executionRunId: f.runId });
  });

  it.each([false, true])("checks a distinct terminal owner for independent Stop blockers (controller=%s)", async controller => {
    const f = await warmFixture(), checkoutRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: checkoutRunId, companyId: f.companyId, agentId: f.agentId,
      invocationSource: "on_demand", status: "failed", errorCode: "adapter_failed", runtimeMode: "legacy",
      startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(),
      controllerLeaseExpiresAt: controller ? new Date(Date.now() + 60_000) : null });
    await db.update(issues).set({ checkoutRunId }).where(eq(issues.id, f.issueId));
    await inspect(f, "sweep");
    expect(await task(f.issueId)).toMatchObject({ checkoutRunId, executionRunId: f.runId });
    if (controller) expect(await stopActions(f.issueId)).toMatchObject([{ cause: "execution_stop_pending", status: "escalated" }]);
    else expect(await stopActions(f.issueId)).toEqual([]);
  });

  it("does not hide a second non-reusable lease behind the warm keep", async () => {
    const f = await warmFixture();
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId,
      status: "active", leasePolicy: "ephemeral", provider: "plugin:boat:computer", providerLeaseId: "another-computer" });
    await inspect(f, "sweep");
    expect(await stopActions(f.issueId)).toMatchObject([{ cause: "execution_stop_pending", status: "escalated" }]);
  });

  it("rechecks task cancellation under the task lock rather than the sweep's earlier read", async () => {
    const f = await warmFixture();
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(), beforeStaleLockClear: async () => {
      await db.update(issues).set({ status: "cancelled", cancelledAt: new Date(), conversationAgentId: null,
        conversationUserId: null, conversationState: null }).where(eq(issues.id, f.issueId));
    } });
    expect((await recovery.sweepStaleIssueLocks()).cleared).toBe(0);
    expect(await stopActions(f.issueId)).toMatchObject([{ cause: "execution_stop_pending", status: "escalated" }]);
  });

  it("the next server sweep releases the claims only after warm expiry cleanup supplies real proof", async () => {
    const f = await warmFixture();
    await inspect(f, "sweep");
    expect(await stopActions(f.issueId)).toEqual([]);
    // Expiry alone is not Stop: the cleanup owner must actually release it.
    await db.update(environmentLeases).set({ expiresAt: new Date(0) }).where(eq(environmentLeases.id, f.lease.id));
    expect(await runExecutionsHaveStopped(db, f.companyId, [f.runId])).toBe(false);
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date() })
      .where(eq(environmentLeases.id, f.lease.id));
    expect(await runExecutionsHaveStopped(db, f.companyId, [f.runId])).toBe(true);
    expect((await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks()).cleared).toBe(1);
    expect(await task(f.issueId)).toMatchObject({ checkoutRunId: null, executionRunId: null });
    expect(await stopActions(f.issueId)).toEqual([]);
  });

  it.each(["sweep", "stranded"] as const)("%s still escalates a real Stop intent even if completion wins the status race", async path => {
    const f = await warmFixture(path === "stranded");
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    // The same durable fence used by the real correlated Board Stop path.
    await claimCancellationRequest(db, f.runId, f.companyId, randomUUID(), "board-user");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    const before = await task(f.issueId);
    await inspect(f, path);
    expect(await task(f.issueId)).toEqual(before);
    expect(await stopActions(f.issueId)).toMatchObject([{ cause: "execution_stop_pending", status: "escalated",
      ownerType: "board", evidence: { stopPending: { owner: path === "sweep" ? "recovery.sweep_stale_issue_locks" : "recovery.stranded_assigned_issue" } } }]);
  });

  it.each(["sweep", "stranded"] as const)("%s still escalates a cancelled warm owner", async path => {
    const f = await warmFixture(path === "stranded");
    await db.update(heartbeatRuns).set({ status: "cancelled", resultJson: { executionCancellation: { state: "requested" } } })
      .where(eq(heartbeatRuns.id, f.runId));
    const before = await task(f.issueId);
    await inspect(f, path);
    expect(await task(f.issueId)).toEqual(before);
    expect(await stopActions(f.issueId)).toMatchObject([{ cause: "execution_stop_pending", status: "escalated", ownerType: "board" }]);
  });

  it("does not hide task cancellation behind a succeeded warm run", async () => {
    const f = await warmFixture();
    // A conversation is open-only; task cancellation retires its identity too.
    await db.update(issues).set({ status: "cancelled", cancelledAt: new Date(), conversationAgentId: null,
      conversationUserId: null, conversationState: null }).where(eq(issues.id, f.issueId));
    await inspect(f, "sweep");
    expect(await stopActions(f.issueId)).toMatchObject([{ cause: "execution_stop_pending", status: "escalated" }]);
  });

  it.each(["sweep", "stranded"] as const)("%s preserves the existing non-terminal-owner behavior", async path => {
    const f = await warmFixture(path === "stranded");
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    const before = await task(f.issueId);
    await inspect(f, path);
    expect(await task(f.issueId)).toEqual(before);
    // The sweep skips live candidates; stranded recovery records its failed
    // Stop inspection. Neither may clear a live owner's claims.
    if (path === "sweep") expect(await stopActions(f.issueId)).toEqual([]);
    else expect(await stopActions(f.issueId)).toMatchObject([{ cause: "execution_stop_pending", status: "escalated" }]);
  });

  it.each(["cleanup", "ephemeral", "deferred", "controller", "coordinator", "interrupt", "pending_cancel", "stop_reason"] as const)("does not silently skip a warm-looking lease with another blocker: %s", async blocker => {
    const f = await warmFixture();
    if (blocker === "cleanup") await db.update(environmentLeases).set({ cleanupStatus: "failed" }).where(eq(environmentLeases.id, f.lease.id));
    if (blocker === "ephemeral") await db.update(environmentLeases).set({ leasePolicy: "ephemeral" }).where(eq(environmentLeases.id, f.lease.id));
    if (blocker === "deferred") await db.update(environmentLeases).set({ metadata: { ...f.lease.metadata,
      releaseDeferral: { reason: "save_failed", attempts: 1, retryAt: new Date().toISOString() } } }).where(eq(environmentLeases.id, f.lease.id));
    if (blocker === "controller") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, f.runId));
    if (blocker === "coordinator") await db.insert(nativeRunFinalizations).values({ runId: f.runId, companyId: f.companyId,
      issueId: f.issueId, phase: "observed", leaseOwner: "native-finalizer:still-owned", leaseExpiresAt: new Date(Date.now() + 60_000) });
    if (blocker === "interrupt") await db.update(heartbeatRuns).set({ resultJson: { operatorInterrupted: true,
      interruptionSource: "issue_comment_interrupt", queuedCommentInterruptQueueId: randomUUID() } }).where(eq(heartbeatRuns.id, f.runId));
    if (blocker === "pending_cancel") await db.update(heartbeatRuns).set({ resultJson: {
      executionCancellation: { state: "requested", requestedAt: new Date().toISOString() } } }).where(eq(heartbeatRuns.id, f.runId));
    if (blocker === "stop_reason") await db.update(heartbeatRuns).set({ resultJson: { stopReason: "cancelled" } }).where(eq(heartbeatRuns.id, f.runId));
    await inspect(f, "sweep");
    expect(await stopActions(f.issueId)).toMatchObject([{ cause: "execution_stop_pending", status: "escalated" }]);
  });

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
});
