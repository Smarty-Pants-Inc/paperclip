import { randomUUID } from "node:crypto";
import { activityLog, agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentExecutionStopBlocker, runExecutionsHaveStopped } from "../services/agent-execution-stop.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { recoveryService } from "../services/recovery/service.js";
import { claimCancellationRequest } from "../services/native-runtime/native-cancellation-request.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerIssueRecoveryWork } from "../services/recovery/work.js";
import { nativeUserStopRecoveryHeld } from "../services/native-runtime/native-user-stop-settlement.js";
import { prepareSandboxStopAndRetain } from "../services/sandbox-stop-and-retain.js";

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

  it("does not defer a second lease whose fallback lifetime is unknown", async () => {
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

  // RF3 case (h): the shared guard reports lease cleanup first, so recovery
  // must independently preserve the missing remote termination proof.
  it.each(["sweep", "stranded"] as const)("%s remote_stop_unconfirmed is an independent blocker, not just unreleased lease", async path => {
    const f = await warmFixture(path === "stranded");
    await db.update(heartbeatRuns).set({ status: "cancelled", resultJson: {} }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" })
      .where(eq(environmentLeases.id, f.lease.id));
    expect(await agentExecutionStopBlocker(db, [f.agentId])).toBe("remote_stop_unconfirmed");
    await db.update(environmentLeases).set({ status: "active", releasedAt: null, cleanupStatus: null })
      .where(eq(environmentLeases.id, f.lease.id));
    const before = await task(f.issueId);
    await inspect(f, path);
    expect(await stopActions(f.issueId)).toMatchObject([{ status: "escalated", cause: "execution_stop_pending" }]);
    expect(await task(f.issueId)).toEqual(before);
  });

  it.each(["sweep", "stranded"] as const)("%s still defers ordinary cleanup with a receipt-proven cancelled remote co-owner", async path => {
    const f = await warmFixture(path === "stranded"), checkoutRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: checkoutRunId, companyId: f.companyId, agentId: f.agentId,
      invocationSource: "on_demand", status: "cancelled", runtimeMode: "native", executionStage: "settled",
      issueId: f.issueId, nativeIssueId: f.issueId, contextSnapshot: { issueId: f.issueId },
      startedAt: new Date(Date.now() - 120_000), finishedAt: new Date(Date.now() - 60_000), resultJson: {},
      createdAt: new Date(0) });
    const [released] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
      heartbeatRunId: checkoutRunId, provider: "plugin:boat:computer", providerLeaseId: `boat-${checkoutRunId}`,
      status: "released", cleanupStatus: "success", releasedAt: new Date() }).returning();
    // The shared helper requires successful release as well as the bound receipt.
    // The other owner retains the ordinary unreleased lease receiving grace.
    await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: remoteTerminationReceipt(released!, {
      providerLeaseId: released!.providerLeaseId, state: "stopped" }) } }).where(eq(environmentLeases.id, released!.id));
    await db.update(issues).set({ checkoutRunId }).where(eq(issues.id, f.issueId));
    expect(await runExecutionsHaveStopped(db, f.companyId, [checkoutRunId])).toBe(true);
    expect(await runExecutionsHaveStopped(db, f.companyId, [f.runId])).toBe(false);
    const before = await task(f.issueId);
    await inspect(f, path);
    expect(await stopActions(f.issueId)).toEqual([]);
    expect(await task(f.issueId)).toEqual(before);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0]).toEqual(f.lease);
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

  it.each(["controller", "coordinator", "local_process", "local_cancelled_unproven", "interrupt", "pending_cancel"] as const)("does not silently skip a warm-looking lease with another blocker: %s", async blocker => {
    const f = await warmFixture();
    if (blocker === "controller") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, f.runId));
    if (blocker === "coordinator") await db.insert(nativeRunFinalizations).values({ runId: f.runId, companyId: f.companyId,
      issueId: f.issueId, phase: "observed", leaseOwner: "native-finalizer:still-owned", leaseExpiresAt: new Date(Date.now() + 60_000) });
    if (blocker === "local_process" || blocker === "local_cancelled_unproven") {
      await db.update(environmentLeases).set({ provider: "local" }).where(eq(environmentLeases.id, f.lease.id));
      await db.update(heartbeatRuns).set({ status: blocker === "local_process" ? "failed" : "cancelled",
        processPid: blocker === "local_process" ? process.pid : null, resultJson: {} }).where(eq(heartbeatRuns.id, f.runId));
    }
    if (blocker === "interrupt") await db.update(heartbeatRuns).set({ resultJson: { operatorInterrupted: true,
      interruptionSource: "issue_comment_interrupt", queuedCommentInterruptQueueId: randomUUID() } }).where(eq(heartbeatRuns.id, f.runId));
    if (blocker === "pending_cancel") await db.update(heartbeatRuns).set({ resultJson: {
      executionCancellation: { state: "requested", requestedAt: new Date().toISOString() } } }).where(eq(heartbeatRuns.id, f.runId));
    await inspect(f, "sweep");
    expect(await stopActions(f.issueId)).toMatchObject([{ cause: "execution_stop_pending", status: "escalated" }]);
  });

  // Rule of record: terminal failures and release-pending leases are not Stop requests.
  it.each(["sweep", "stranded"] as const)("%s defers failed owners with pending cleanup, without changing claims", async path => {
    for (const errorCode of ["native_provider_terminal_failed", "setup_failed"]) {
      const f = await warmFixture(path === "stranded");
      await db.update(heartbeatRuns).set({ status: "failed", errorCode, resultJson: {} }).where(eq(heartbeatRuns.id, f.runId));
      await db.update(environmentLeases).set({ status: "pending_cleanup", cleanupStatus: "failed", leasePolicy: "ephemeral" })
        .where(eq(environmentLeases.id, f.lease.id));
      const before = await task(f.issueId);
      await inspect(f, path);
      expect(await stopActions(f.issueId)).toEqual([]);
      expect(await task(f.issueId)).toEqual(before);
    }
  });

  it.each(["succeeded", "failed", "timed_out", "interrupted"] as const)("does not infer a Stop request from terminal status %s", async status => {
    const f = await warmFixture();
    await db.update(heartbeatRuns).set({ status, resultJson: { stopReason: "cancelled" } }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(environmentLeases).set({ metadata: { releaseDeferral: { reason: "release_failed", attempts: 1,
      retryAt: new Date().toISOString() } } }).where(eq(environmentLeases.id, f.lease.id));
    await inspect(f, "sweep");
    expect(await stopActions(f.issueId)).toEqual([]);
  });

  it.each((["sweep", "stranded"] as const).flatMap(path => ([
    ["release_skipped", true], ["release_failed", true],
    ["workspace_owner_active", false], ["workspace_retention_busy", false],
    ["future_release_reason", false], ["warm_session_busy", false], ["warm_session_close_failed", false],
  ] as const).map(([reason, allowed]) => [path, reason, allowed] as const)))(
    "%s release deferral %s allowed=%s", async (path, reason, allowed) => {
      const f = await warmFixture(path === "stranded");
      await db.update(environmentLeases).set({ metadata: { releaseDeferral: { reason, attempts: 1,
        retryAt: new Date().toISOString() } } }).where(eq(environmentLeases.id, f.lease.id));
      const before = await task(f.issueId);
      await inspect(f, path);
      expect(await task(f.issueId)).toEqual(before);
      const actions = await stopActions(f.issueId);
      if (allowed) expect(actions).toEqual([]);
      else expect(actions).toMatchObject([{ cause: "execution_stop_pending", status: "escalated" }]);
    });

  it.each(["release_skipped", "release_failed"] as const)("bounds allow-listed %s by expiry plus five minutes", async reason => {
    const f = await warmFixture();
    await db.update(environmentLeases).set({ expiresAt: new Date(Date.now() - 240_000),
      metadata: { releaseDeferral: { reason, attempts: 1, retryAt: new Date().toISOString() } } })
      .where(eq(environmentLeases.id, f.lease.id));
    const before = await task(f.issueId);
    await inspect(f, "sweep");
    expect(await stopActions(f.issueId)).toEqual([]);
    await db.update(environmentLeases).set({ expiresAt: new Date(Date.now() - 301_000) })
      .where(eq(environmentLeases.id, f.lease.id));
    await inspect(f, "sweep");
    expect(await stopActions(f.issueId)).toMatchObject([{ cause: "execution_stop_pending", status: "escalated" }]);
    expect(await task(f.issueId)).toEqual(before);
  });

  it("does not allow release_skipped on a lease that is no longer active", async () => {
    const f = await warmFixture();
    await db.update(environmentLeases).set({ status: "pending_cleanup",
      metadata: { releaseDeferral: { reason: "release_skipped", attempts: 1, retryAt: new Date().toISOString() } } })
      .where(eq(environmentLeases.id, f.lease.id));
    await inspect(f, "sweep");
    expect(await stopActions(f.issueId)).toMatchObject([{ cause: "execution_stop_pending", status: "escalated" }]);
    expect(await task(f.issueId)).toMatchObject({ checkoutRunId: f.runId, executionRunId: f.runId });
  });

  it("retains a recorded pause request even on a succeeded run", async () => {
    const f = await warmFixture();
    await db.update(heartbeatRuns).set({ resultJson: { pauseRequested: { requestedAt: new Date().toISOString() } } })
      .where(eq(heartbeatRuns.id, f.runId));
    await inspect(f, "sweep");
    expect(await stopActions(f.issueId)).toMatchObject([{ cause: "execution_stop_pending", status: "escalated" }]);
  });

  it.each(["sweep", "stranded"] as const)("%s bounds deferral by each lease's own expiry plus five minutes", async path => {
    const f = await warmFixture(path === "stranded");
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "setup_failed", resultJson: {} }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(environmentLeases).set({ expiresAt: new Date(Date.now() - 240_000), status: "pending_cleanup" })
      .where(eq(environmentLeases.id, f.lease.id));
    await inspect(f, path);
    expect(await stopActions(f.issueId)).toEqual([]);
    // A second, older unreleased lease cannot borrow the first one's deadline.
    await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId,
      status: "pending_cleanup", expiresAt: new Date(Date.now() - 301_000) });
    await inspect(f, path);
    expect(await stopActions(f.issueId)).toMatchObject([{ cause: "execution_stop_pending", status: "escalated" }]);
    expect(await task(f.issueId)).toMatchObject({ checkoutRunId: f.runId, executionRunId: f.runId });
  });

  it("uses acquisition plus the environment TTL, never last use or run finish, when expiry is absent", async () => {
    const f = await warmFixture();
    const [environment] = await db.insert(environments).values({ name: randomUUID(), driver: "plugin:boat:computer",
      config: { ttlMinutes: 30 } }).returning();
    await db.update(environmentLeases).set({ environmentId: environment!.id, expiresAt: null,
      acquiredAt: new Date(Date.now() - 34 * 60_000), lastUsedAt: new Date() }).where(eq(environmentLeases.id, f.lease.id));
    await inspect(f, "sweep");
    expect(await stopActions(f.issueId)).toEqual([]);
    await db.update(environmentLeases).set({ acquiredAt: new Date(Date.now() - 36 * 60_000) }).where(eq(environmentLeases.id, f.lease.id));
    await inspect(f, "sweep");
    expect(await stopActions(f.issueId)).toMatchObject([{ status: "escalated", cause: "execution_stop_pending" }]);
  });

  async function existingCard(f: Awaited<ReturnType<typeof warmFixture>>, realStop = false) {
    if (realStop) {
      await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
      await claimCancellationRequest(db, f.runId, f.companyId, randomUUID(), "board-user");
    }
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(environmentLeases).set({ expiresAt: new Date(Date.now() - 301_000) }).where(eq(environmentLeases.id, f.lease.id));
    await inspect(f, "sweep");
    expect(await stopActions(f.issueId)).toMatchObject([{ status: "escalated", cause: "execution_stop_pending" }]);
  }
  async function laterAnswer(f: Awaited<ReturnType<typeof warmFixture>>, companyId = f.companyId, issueId = f.issueId) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId, agentId: f.agentId, invocationSource: "on_demand", status: "succeeded",
      issueId, nativeIssueId: issueId, contextSnapshot: { issueId }, startedAt: new Date(), finishedAt: new Date(),
      createdAt: new Date(Date.now() + 1_000) });
    return id;
  }
  it.each([false, true])("resolves an existing card after a later same-task answer, even when old locks are gone=%s", async noLocks => {
    const f = await warmFixture();
    await existingCard(f);
    await laterAnswer(f);
    if (noLocks) await db.update(issues).set({ checkoutRunId: null, executionRunId: null }).where(eq(issues.id, f.issueId));
    await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks();
    expect(await stopActions(f.issueId)).toMatchObject([{ status: "resolved", outcome: "restored",
      resolutionNote: expect.stringContaining("succeeded") }]);
    // Resolving stale copy is NOT Stop proof and must not release the old executor.
    expect(await runExecutionsHaveStopped(db, f.companyId, [f.runId])).toBe(false);
    if (!noLocks) expect(await task(f.issueId)).toMatchObject({ checkoutRunId: f.runId, executionRunId: f.runId });
    await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks();
    expect(await stopActions(f.issueId)).toHaveLength(1);
  });
  it("the normal recovery worker discovers a card even without stale lock columns", async () => {
    const f = await warmFixture();
    await existingCard(f);
    await laterAnswer(f);
    await db.update(issues).set({ checkoutRunId: null, executionRunId: null }).where(eq(issues.id, f.issueId));
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true,
      onError: error => errors.push(error) });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
    const worker = registerIssueRecoveryWork(db, coordinator, { stranded: async () => {}, orphanBlockers: async () => {},
      recoveryActions: async () => {}, dependencies: async () => ({ enqueueFailed: 0 }),
      locks: scope => recovery.sweepStaleIssueLocks(scope), watchdogs: async () => ({ incomplete: 0 }),
      schedulingSuppressed: async () => false }, () => true);
    try {
      await worker.ready;
      await vi.waitFor(async () => expect(await stopActions(f.issueId)).toMatchObject([{ status: "resolved" }]), { timeout: 5_000 });
      expect(errors).toEqual([]);
    } finally { await worker.stop(); await coordinator.stop(); }
  });

  it("does not mistake an earlier answer or another task's answer for recovery", async () => {
    const f = await warmFixture(), other = await warmFixture();
    await existingCard(f);
    await laterAnswer(other);
    const otherIssueId = randomUUID();
    await db.insert(issues).values({ id: otherIssueId, companyId: f.companyId, title: "Another task", status: "in_review" });
    await laterAnswer(f, f.companyId, otherIssueId);
    // Authoritative task binding wins over an old context snapshot.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "on_demand",
      status: "succeeded", issueId: otherIssueId, nativeIssueId: otherIssueId, contextSnapshot: { issueId: f.issueId },
      createdAt: new Date(Date.now() + 1_000) });
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "on_demand",
      status: "succeeded", issueId: f.issueId, createdAt: new Date(0) });
    await inspect(f, "sweep");
    expect(await stopActions(f.issueId)).toMatchObject([{ status: "escalated" }]);
  });
  it("removes only a stale Stop annotation, preserves independent recovery and records answer resolution once", async () => {
    const f = await warmFixture();
    await existingCard(f);
    const [action] = await stopActions(f.issueId);
    await db.update(issueRecoveryActions).set({ cause: "independent_recovery", evidence: { ...action!.evidence,
      independentProof: "preserve", stopPending: { ...(action!.evidence.stopPending as Record<string, unknown>),
        standalone: false, previousNextAction: "Old independent instruction" } },
      nextAction: `${action!.nextAction}\n\nKeep current independent instruction` }).where(eq(issueRecoveryActions.id, action!.id));
    await laterAnswer(f);
    await inspect(f, "sweep");
    await inspect(f, "sweep");
    const [after] = await stopActions(f.issueId);
    expect(after).toMatchObject({ status: "escalated", cause: "independent_recovery",
      nextAction: "Keep current independent instruction", evidence: { independentProof: "preserve" } });
    expect(after!.evidence).not.toHaveProperty("stopPending");
    const logs = await db.select().from(activityLog).where(eq(activityLog.entityId, f.issueId));
    expect(logs.filter(log => log.action === "issue.execution_stop_pending_resolved")).toHaveLength(1);
    expect(logs.filter(log => log.action === "issue.execution_stop_confirmed")).toHaveLength(0);
  });

  it.each([false, true])("never resolves a real unproven Stop after a later success, even when old locks are gone=%s", async noLocks => {
    const f = await warmFixture();
    await existingCard(f, true);
    const before = await stopActions(f.issueId);
    await laterAnswer(f);
    if (noLocks) await db.update(issues).set({ checkoutRunId: null, executionRunId: null }).where(eq(issues.id, f.issueId));
    const beforeTask = await task(f.issueId);
    for (let tick = 0; tick < 2; tick++) {
      await inspect(f, "sweep");
      expect(await stopActions(f.issueId)).toEqual(before);
      expect(await task(f.issueId)).toEqual(beforeTask);
      expect(await runExecutionsHaveStopped(db, f.companyId, [f.runId])).toBe(false);
    }
    const logs = await db.select().from(activityLog).where(eq(activityLog.entityId, f.issueId));
    expect(logs.filter(log => log.action === "issue.execution_stop_pending_resolved")).toHaveLength(0);
    expect(logs.filter(log => log.action === "issue.execution_stop_confirmed")).toHaveLength(0);
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" })
      .where(eq(environmentLeases.id, f.lease.id));
    await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks();
    expect(await stopActions(f.issueId)).toMatchObject([{ id: before[0]!.id, status: "resolved", outcome: "restored",
      resolutionNote: "Stop proved under the task and bound-run locks." }]);
  });
  it("resolves an existing no-Stop card once the named lease is released after its binding changes", async () => {
    const f = await warmFixture();
    await existingCard(f);
    await db.update(issues).set({ checkoutRunId: null, executionRunId: null }).where(eq(issues.id, f.issueId));
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" })
      .where(eq(environmentLeases.id, f.lease.id));
    await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks();
    expect(await stopActions(f.issueId)).toMatchObject([{ status: "resolved", outcome: "restored" }]);
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

  // U owns a real, bound stop-only request, not H6's retained-idle receipt.
  async function boundedPersonStop(inFlight = true) {
    const f = await warmStopFixture("missing");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await db.update(heartbeatRuns).set({ resultJson: { ...run!.resultJson,
      nativeCancellation: { ...(run!.resultJson!.nativeCancellation as Record<string, unknown>), recordedAt: new Date().toISOString() } } })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.update(environmentLeases).set({ metadata: { ...f.lease.metadata, pluginId: randomUUID() } })
      .where(eq(environmentLeases.id, f.lease.id));
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    const requested = await prepareSandboxStopAndRetain(db, lease!);
    expect(requested).not.toBeNull();
    if (inFlight) await db.update(environmentLeases).set({ metadata: { ...requested!.metadata,
      pendingCleanupInFlight: true, pendingCleanupLeaseExpiresAtMs: Date.now() + 15 * 60_000 } })
      .where(eq(environmentLeases.id, f.lease.id));
    return f;
  }

  it.each([false, true])("U bounded person Stop requested/in-flight=%s: no card until receipt, then claims release", async inFlight => {
    const f = await boundedPersonStop(inFlight);
    const before = await task(f.issueId);
    const deadlines: number[] = [];
    await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId,
      onDeferredDeadline: at => deadlines.push(at) });
    expect(await stopActions(f.issueId)).toEqual([]);
    expect(await task(f.issueId)).toEqual(before);
    expect(await runExecutionsHaveStopped(db, f.companyId, [f.runId])).toBe(false);
    expect(deadlines.length).toBeGreaterThan(0);
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date(),
      metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease!, { providerLeaseId: lease!.providerLeaseId, state: "stopped" }) } })
      .where(eq(environmentLeases.id, f.lease.id));
    expect((await onePass(f)).cards).toEqual([]);
    expect(await task(f.issueId)).toMatchObject({ checkoutRunId: null, executionRunId: null });
    expect(await runExecutionsHaveStopped(db, f.companyId, [f.runId])).toBe(true);
    expect(await nativeUserStopRecoveryHeld(db, { companyId: f.companyId, issueId: f.issueId, runId: f.runId })).toBe(false);
  });

  it("U no receipt: a renewed cleanup claim cannot extend five minutes from the acknowledged Stop", async () => {
    const f = await boundedPersonStop();
    expect((await onePass(f)).cards).toEqual([]);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await db.update(heartbeatRuns).set({ resultJson: { ...run!.resultJson,
      nativeCancellation: { ...(run!.resultJson!.nativeCancellation as Record<string, unknown>),
        recordedAt: new Date(Date.now() - 5 * 60_000 - 1).toISOString() } } }).where(eq(heartbeatRuns.id, f.runId));
    expect((await onePass(f)).cards).toMatchObject([{ cause: "execution_stop_pending", status: "escalated" }]);
    expect(await runExecutionsHaveStopped(db, f.companyId, [f.runId])).toBe(false);
  });

  it.each(["non-person", "no-stop-request", "unacknowledged", "crash", "no-stop-intent", "expired-claim", "unknown-bound"] as const)(
    "U control %s still cards", async control => {
      const f = await boundedPersonStop();
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const result = { ...run!.resultJson };
      if (control === "non-person") result.cancelledByActorType = "agent";
      if (control === "no-stop-request") { delete result.nativeCancellation; delete result.executionCancellation;
        delete result.cancelledByActorType; delete result.cancelledByUserId; }
      if (control === "unacknowledged") result.nativeCancellation = { ...(result.nativeCancellation as Record<string, unknown>), dispatched: false };
      if (control === "unknown-bound") result.nativeCancellation = { ...(result.nativeCancellation as Record<string, unknown>), recordedAt: undefined };
      await db.update(heartbeatRuns).set({ status: control === "crash" ? "failed" : "cancelled", resultJson: result })
        .where(eq(heartbeatRuns.id, f.runId));
      if (control === "no-stop-intent" || control === "expired-claim") {
        const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
        const metadata = { ...lease!.metadata };
        if (control === "no-stop-intent") delete metadata.sandboxStopAndRetain;
        else metadata.pendingCleanupLeaseExpiresAtMs = Date.now() - 1;
        await db.update(environmentLeases).set({ metadata }).where(eq(environmentLeases.id, f.lease.id));
      }
      expect((await onePass(f)).cards).toMatchObject([{ cause: "execution_stop_pending", status: "escalated" }]);
    });

  // adopt-stopu-card2 (rf-4 F12). Live gate 4 (U e02cad41): card 56bcdc6a was written by
  // owner "recovery.sweep_stale_issue_locks" (service.ts sweepStaleIssueLocks -> recordTaskStopPending)
  // 3.7 s after a person's Stop, BEFORE the export and the receipt: the warm lease was still
  // unreleased (the stop_and_retain release follows the export), so the deferral's
  // pending_cleanup-only predicate returned false. Two writers raise this card for a person's
  // Stop: (A) that sweep and (B) the cleanup retry (heartbeat/recovery.ts ->
  // recordPersonStopCleanupPending). Both must read ONE bound. recordedAt stands in for the clock.
  const PERSON_CARD = "Stop pending: Paperclip cannot confirm that the previous execution stopped. " +
    "Messages you send are saved and will be sent once the stop is confirmed.";
  async function stopRecordedAgo(f: { runId: string }, ms: number) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await db.update(heartbeatRuns).set({ resultJson: { ...run!.resultJson,
      nativeCancellation: { ...(run!.resultJson!.nativeCancellation as Record<string, unknown>),
        recordedAt: new Date(Date.now() - ms).toISOString() } } }).where(eq(heartbeatRuns.id, f.runId));
    return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!;
  }
  const cleanupRetryWriter = async (run: typeof heartbeatRuns.$inferSelect) =>
    (await import("../services/recovery/stop-pending.js")).recordPersonStopCleanupPending(db, run);
  // The stop's phases while in flight: lease not yet released (live row), the cancel-finalize
  // export owning the finalizer, the stop_and_retain request recorded, its cleanup in flight.
  const PHASES = ["unreleased", "export-owned", "requested", "in-flight"] as const;
  async function personStopIn(phase: typeof PHASES[number]) {
    if (phase === "requested" || phase === "in-flight") return boundedPersonStop(phase === "in-flight");
    return warmStopFixture(phase === "export-owned" ? "coordinator_owned" : "missing");
  }

  it.each(PHASES)("U card LIVE (%s): the sweep at Stop + 20 s and a failed cleanup retry then raise no card", async phase => {
    const f = await personStopIn(phase);
    const before = await task(f.issueId);
    const run = await stopRecordedAgo(f, 20_000);
    expect((await onePass(f)).cards).toEqual([]);
    await cleanupRetryWriter(run);
    expect((await onePass(f)).cards).toEqual([]);
    expect(await task(f.issueId)).toEqual(before);
    expect(await runExecutionsHaveStopped(db, f.companyId, [f.runId])).toBe(false);
  });

  it.each(PHASES.flatMap(phase => (["sweep-first", "retry-first", "sweep-only", "retry-only"] as const)
    .map(order => [phase, order] as const)))("U card at the bound (%s, %s): exactly one card, with the person's true copy",
    async (phase, order) => {
      const f = await personStopIn(phase);
      const run = await stopRecordedAgo(f, 5 * 60_000 + 1_000);
      const writers = { "sweep-first": ["sweep", "retry", "sweep"], "retry-first": ["retry", "sweep", "retry"],
        "sweep-only": ["sweep", "sweep"], "retry-only": ["retry", "retry"] }[order];
      for (const writer of writers) writer === "sweep" ? await onePass(f) : await cleanupRetryWriter(run);
      const cards = await stopActions(f.issueId);
      expect(cards.map(card => [card.cause, card.status])).toEqual([["execution_stop_pending", "escalated"]]);
      expect(cards[0]!.nextAction).toBe(PERSON_CARD);
      expect((cards[0]!.evidence as Record<string, any>).stopPending).toMatchObject({ personStop: true });
      const read = await (await import("../services/issue-recovery-actions.js")).issueRecoveryActionService(db)
        .getActiveForIssue(f.companyId, f.issueId);
      expect(read?.nextAction).toBe(PERSON_CARD);
    });

  it("U card: a late receipt after the card retires it and releases the claims once", async () => {
    const f = await personStopIn("requested");
    await stopRecordedAgo(f, 5 * 60_000 + 1_000);
    expect((await onePass(f)).cards.map(card => card.status)).toEqual(["escalated"]);
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date(),
      metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease!, { providerLeaseId: lease!.providerLeaseId, state: "stopped" }) } })
      .where(eq(environmentLeases.id, f.lease.id));
    const { cards } = await onePass(f);
    expect(cards.map(card => [card.status, card.outcome])).toEqual([["resolved", "restored"]]);
    expect(await task(f.issueId)).toMatchObject({ checkoutRunId: null, executionRunId: null });
    expect((await onePass(f)).cards).toHaveLength(1);
  });

  it("U card: a receipt before the bound means no card ever, from either writer", async () => {
    const f = await personStopIn("requested");
    await stopRecordedAgo(f, 2 * 60_000);
    expect((await onePass(f)).cards).toEqual([]);
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date(),
      metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease!, { providerLeaseId: lease!.providerLeaseId, state: "stopped" }) } })
      .where(eq(environmentLeases.id, f.lease.id));
    const run = await stopRecordedAgo(f, 10 * 60_000);
    await cleanupRetryWriter(run);
    expect((await onePass(f)).cards).toEqual([]);
    await cleanupRetryWriter(run);
    expect(await stopActions(f.issueId)).toEqual([]);
  });

  it.each(["unreleased", "export-owned"] as const)("U card control (%s): a non-person stop at Stop + 20 s still gets the generic card", async phase => {
    const f = await personStopIn(phase);
    const run = await stopRecordedAgo(f, 20_000);
    await db.update(heartbeatRuns).set({ resultJson: { ...run.resultJson, cancelledByActorType: "agent" } }).where(eq(heartbeatRuns.id, f.runId));
    const { cards } = await onePass(f);
    expect(cards.map(card => card.status)).toEqual(["escalated"]);
    expect(cards[0]!.nextAction).toContain("The task stays held until Stop is proved");
    expect((cards[0]!.evidence as Record<string, any>).stopPending.personStop).toBeFalsy();
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
