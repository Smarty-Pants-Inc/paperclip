import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createScheduledRetryCancellationRecovery } from "../services/heartbeat/scheduled-retry-cancellation.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { notifyScheduledRetryCancellation } from "../services/scheduled-retry-cancellation-notifications.js";
import { requestedRunCancellation } from "../services/run-cancellation.js";
import { idleWorkSnapshot, startTaskDrain, stopTaskDrain } from "../services/task-admission.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import express from "express";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  agentWakeupRequests,
  agentRuntimeState,
  agentTaskSessions,
  authUsers,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  createDb,
  applyPendingMigrations,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issueTreeHolds,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { runningProcesses, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";

const externalTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_RETRY_CANCELLATION_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres scheduled retry route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue scheduled retry routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      await applyPendingMigrations(externalTestDatabaseUrl);
      db = createDb(externalTestDatabaseUrl);
    }
    else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-scheduled-retry-routes-");
      db = createDb(tempDb.connectionString);
    }
  }, 20_000);

  afterEach(async () => {
    await db.delete(environmentLeases);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(principalPermissionGrants);
    await db.delete(agentApiKeys);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  function boardActor(companyId: string, source: "session" | "local_implicit" = "session"): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source,
    };
  }

  function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId: randomUUID(),
      keyScope: { kind: "standard" },
      source: "agent_jwt",
    };
  }

  async function seedIssueWithRetry(input: {
    agentStatus?: "active" | "paused";
    retryStatus?: "scheduled_retry" | "queued" | "running";
    issueStatus?: "in_progress" | "todo" | "done" | "cancelled";
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const retryRunId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date("2026-05-06T18:00:00.000Z");
    const scheduledRetryAt = new Date("2026-05-06T19:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board-user",
      status: "active", membershipRole: "admin" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: input.agentStatus ?? "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "transient upstream error",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "bounded_transient_heartbeat_retry",
      payload: {
        issueId,
        retryOfRunId: sourceRunId,
        scheduledRetryAt: scheduledRetryAt.toISOString(),
      },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: retryRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: input.retryStatus ?? "scheduled_retry",
      wakeupRequestId,
      retryOfRunId: sourceRunId,
      scheduledRetryAt,
      scheduledRetryAttempt: 2,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: {
        issueId,
        wakeReason: "bounded_transient_heartbeat_retry",
        retryOfRunId: sourceRunId,
        scheduledRetryAt: scheduledRetryAt.toISOString(),
        scheduledRetryAttempt: 2,
        retryReason: "transient_failure",
      },
      updatedAt: now,
      createdAt: now,
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: retryRunId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retryable issue",
      status: input.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      executionRunId: retryRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId, sourceRunId, retryRunId, scheduledRetryAt };
  }

  describe("scheduled retry cancellation worker", () => {
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    async function runRow(id: string) {
      return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]);
    }
    function intent(reason = "Interrupted operator stop") {
      return { cancellation: requestedRunCancellation({}, reason), startupCancellation: { requestedAt: new Date().toISOString() } };
    }
    async function writeIntent(f: { companyId: string; retryRunId: string }, owner = db) {
      await owner.transaction(async tx => {
        await notifyScheduledRetryCancellation(tx, { companyId: f.companyId, runId: f.retryRunId });
        await tx.update(heartbeatRuns).set({ resultJson: intent() }).where(eq(heartbeatRuns.id, f.retryRunId));
      });
    }
    async function waitCancelled(id: string) {
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(100);
        expect((await runRow(id))?.status).toBe("cancelled");
      }, { timeout: 5000 });
    }
    function clock() { vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true }); }

    it("stays quiet with retries lacking cancellation and retained completed history", async () => {
      const f = await seedIssueWithRetry({ agentStatus: "paused" });
      const historical = await seedIssueWithRetry({ agentStatus: "paused" });
      await db.update(heartbeatRuns).set({ status: "cancelled", resultJson: intent() }).where(eq(heartbeatRuns.id, historical.retryRunId));
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      try {
        await heartbeatService(db, { runtimeEnv: {} }).registerScheduledRetryCancellationWork(coordinator, () => true).ready;
        await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        expect(coordinator.nextWakeAt()).toBeNull();
        const reads = vi.spyOn(db, "select");
        await vi.advanceTimersByTimeAsync(180_000);
        expect(reads).not.toHaveBeenCalled();
        reads.mockRestore();
        expect((await runRow(f.retryRunId)).status).toBe("scheduled_retry");
      } finally { await coordinator.stop(); }
    });

    it("recovers a real cancellation's failed final write from its committed signal and retry", async () => {
      const f = await seedIssueWithRetry({ agentStatus: "paused" });
      const unrelated = await seedIssueWithRetry({ agentStatus: "paused" });
      const service = heartbeatService(db, { runtimeEnv: {} });
      const errors: unknown[] = [];
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      try {
        await service.registerScheduledRetryCancellationWork(coordinator, () => true).ready;
        expect(coordinator.nextWakeAt()).toBeNull();
        await db.execute(sql`ALTER TABLE heartbeat_runs ADD CONSTRAINT reject_worker_cancellation CHECK (status <> 'cancelled') NOT VALID`);
        try {
          await expect(service.cancelRun(f.retryRunId, "Human cancelled retry", { expectedStatus: "scheduled_retry" })).rejects.toThrow();
          await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(errors.length).toBeGreaterThan(0); });
          expect((await runRow(f.retryRunId)).resultJson?.cancellation).toMatchObject({ reason: "Human cancelled retry" });
        } finally { await db.execute(sql`ALTER TABLE heartbeat_runs DROP CONSTRAINT reject_worker_cancellation`); }
        await vi.advanceTimersByTimeAsync(31_000);
        await waitCancelled(f.retryRunId);
        await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        expect((await runRow(f.retryRunId)).error).toBe("Human cancelled retry");
        expect((await runRow(unrelated.retryRunId)).status).toBe("scheduled_retry");
        expect(await db.select().from(issues).where(eq(issues.id, f.issueId)))
          .toEqual([expect.objectContaining({ executionRunId: null })]);
        expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, f.retryRunId)))
          .toEqual([expect.objectContaining({ status: "cancelled" })]);
        const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.retryRunId));
        await vi.advanceTimersByTimeAsync(120_000);
        expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.retryRunId))).toEqual(events);
        expect(coordinator.nextWakeAt()).toBeNull();
      } finally { await coordinator.stop(); }
    });

    it("recovers when the caller loses the committed cancellation-fence response", async () => {
      const f = await seedIssueWithRetry({ agentStatus: "paused" });
      const service = heartbeatService(db, { runtimeEnv: {} });
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      await service.registerScheduledRetryCancellationWork(coordinator, () => true).ready;
      let injected = false;
      const transaction = db.transaction.bind(db);
      const transactions = vi.spyOn(db, "transaction").mockImplementation((async (callback, options) => {
        const result = await transaction(callback, options);
        if (!injected && result && typeof result === "object" && "id" in result && result.id === f.retryRunId) {
          injected = true;
          throw new Error("Lost cancellation-fence response");
        }
        return result;
      }) as typeof db.transaction);
      try {
        await expect(service.cancelRun(f.retryRunId, "Stop before settlement", { expectedStatus: "scheduled_retry" }))
          .rejects.toThrow("Lost cancellation-fence response");
        expect(injected).toBe(true);
        transactions.mockRestore();
        await waitCancelled(f.retryRunId);
        expect((await runRow(f.retryRunId)).error).toBe("Stop before settlement");
      } finally { transactions.mockRestore(); await coordinator.stop(); }
    });

    it("reactivates when dispatch parks a queued retry with an existing cancellation", async () => {
      const f = await seedIssueWithRetry({ retryStatus: "queued" });
      await db.update(heartbeatRuns).set({ runtimeMode: "legacy", resultJson: {
        conversationContinuation: "continue_conversation_v1", workspaceRestoreFailure: "restore_failed",
      } }).where(eq(heartbeatRuns.id, f.sourceRunId));
      await db.update(heartbeatRuns).set({ runtimeMode: "legacy", resultJson: {
        ...intent(), conversationContinuation: "continue_conversation_v1",
      } }).where(eq(heartbeatRuns.id, f.retryRunId));
      await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId,
        heartbeatRunId: f.sourceRunId, status: "pending_cleanup", cleanupStatus: "failed",
      });
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      try {
        await heartbeatService(db, { runtimeEnv: {} }).registerScheduledRetryCancellationWork(coordinator, () => true).ready;
        expect(coordinator.nextWakeAt()).toBeNull();
        expect(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ companyId: f.companyId,
          runId: f.retryRunId, expectedStatus: "queued", now: new Date(),
        })).toMatchObject({ outcome: "deferred" });
        await waitCancelled(f.retryRunId);
        expect((await runRow(f.retryRunId)).error).toBe("Interrupted operator stop");
        await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        expect(coordinator.nextWakeAt()).toBeNull();
      } finally { await coordinator.stop(); }
    });

    it("preserves existing cancellation metadata through recovery", async () => {
      const f = await seedIssueWithRetry({ agentStatus: "paused" });
      const budgetEnforcement = { companyId: f.companyId, scopeType: "agent", scopeId: f.agentId };
      const saved = intent();
      await db.update(heartbeatRuns).set({ resultJson: { ...saved,
        startupCancellation: { ...saved.startupCancellation, budgetEnforcement },
        cancelledByUserId: "original-operator", recoveryEvidence: "retain-me",
      } }).where(eq(heartbeatRuns.id, f.retryRunId));
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      try {
        await heartbeatService(db, { runtimeEnv: {} }).registerScheduledRetryCancellationWork(coordinator, () => true).ready;
        await waitCancelled(f.retryRunId);
        expect((await runRow(f.retryRunId)).resultJson).toMatchObject({
          cancellation: saved.cancellation, startupCancellation: { budgetEnforcement },
          cancelledByUserId: "original-operator", recoveryEvidence: "retain-me",
        });
      } finally { await coordinator.stop(); }
    });

    it("waits for the outer transaction and ignores a rolled-back intent", async () => {
      const f = await seedIssueWithRetry({ agentStatus: "paused" });
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      try {
        await heartbeatService(db, { runtimeEnv: {} }).registerScheduledRetryCancellationWork(coordinator, () => true).ready;
        await expect(db.transaction(async tx => {
          await writeIntent(f, tx as unknown as typeof db);
          await vi.advanceTimersByTimeAsync(1000);
          expect((await runRow(f.retryRunId)).resultJson).toBeNull();
          throw new Error("outer rollback");
        })).rejects.toThrow("outer rollback");
        await vi.advanceTimersByTimeAsync(1000);
        expect((await runRow(f.retryRunId)).status).toBe("scheduled_retry");
        await db.transaction(async tx => {
          await writeIntent(f, tx as unknown as typeof db);
          await vi.advanceTimersByTimeAsync(1000);
          expect((await runRow(f.retryRunId)).resultJson).toBeNull();
        });
        await waitCancelled(f.retryRunId);
      } finally { await coordinator.stop(); }
    });

    it.each(["restart", "drain", "standby"] as const)("retains a pending cancellation through %s", async mode => {
      const f = await seedIssueWithRetry({ agentStatus: "paused" });
      if (mode === "restart") await writeIntent(f);
      let canRun = mode === "restart";
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun,
        canReconcile: () => mode !== "standby", onError: error => { throw error; } });
      try {
        await heartbeatService(db, { runtimeEnv: {} }).registerScheduledRetryCancellationWork(coordinator, () => canRun).ready;
        if (mode !== "restart") {
          await writeIntent(f);
          await vi.advanceTimersByTimeAsync(30_000);
          if (mode !== "standby") await expect.poll(() => idleWorkSnapshot().active).toBe(0);
          const reads = vi.spyOn(db, "select");
          await vi.advanceTimersByTimeAsync(60_000);
          expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
          expect((await runRow(f.retryRunId)).status).toBe("scheduled_retry");
          canRun = true;
          await vi.advanceTimersByTimeAsync(30_000);
        }
        await waitCancelled(f.retryRunId);
      } finally { await coordinator.stop(); }
    });

    it.each(["manual", "expiry"] as const)("resumes a real task drain after %s release without passive SQL", async mode => {
      const f = await seedIssueWithRetry({ agentStatus: "paused" });
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      try {
        await heartbeatService(db, { runtimeEnv: {} }).registerScheduledRetryCancellationWork(coordinator, () => true).ready;
        startTaskDrain(mode === "expiry" ? { ttlMs: 60_000 } : {});
        await writeIntent(f);
        await vi.advanceTimersByTimeAsync(1000);
        await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        const reads = vi.spyOn(db, "select");
        await vi.advanceTimersByTimeAsync(30_000);
        expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
        expect((await runRow(f.retryRunId)).status).toBe("scheduled_retry");
        if (mode === "manual") stopTaskDrain();
        await vi.advanceTimersByTimeAsync(31_000);
        await waitCancelled(f.retryRunId);
      } finally { stopTaskDrain(); await coordinator.stop(); }
    });

    it("observes a real worktree activation without polling disabled settings", async () => {
      const f = await seedIssueWithRetry({ agentStatus: "paused" });
      await writeIntent(f);
      const runtimeEnv = { PAPERCLIP_IN_WORKTREE: "true", PAPERCLIP_INSTANCE_ID: "sleep39-activation" };
      const settings = instanceSettingsService(db, { runtimeEnv });
      await settings.updateExperimental({ enableWorktreeRunExecution: false });
      const service = heartbeatService(db, { runtimeEnv });
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      try {
        await service.registerScheduledRetryCancellationWork(coordinator, () => true).ready;
        expect(coordinator.nextWakeAt()).toBeNull();
        const reads = vi.spyOn(db, "select");
        await vi.advanceTimersByTimeAsync(60_000);
        expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
        await service.resolveSchedulingSuppression();
        await settings.updateExperimental({ enableWorktreeRunExecution: true });
        await waitCancelled(f.retryRunId);
      } finally { await coordinator.stop(); await settings.updateExperimental({ enableWorktreeRunExecution: false }); }
    });

    it("retains a second committed intent while the first cancellation is running", async () => {
      const first = await seedIssueWithRetry({ agentStatus: "paused" });
      const second = await seedIssueWithRetry({ agentStatus: "paused" });
      await writeIntent(first);
      const service = heartbeatService(db, { runtimeEnv: {} });
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      const cancel = vi.fn(async (...args: Parameters<typeof service.cancelRun>) => {
        if (args[0] === first.retryRunId) { enter(); await held; }
        return service.cancelRun(...args);
      });
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      const worker = createScheduledRetryCancellationRecovery(db, cancel).register(coordinator, () => true, async () => true);
      try {
        await entered;
        await writeIntent(second);
        release(); await worker.ready;
        await waitCancelled(first.retryRunId); await waitCancelled(second.retryRunId);
        expect(cancel.mock.calls.filter(args => args[0] === first.retryRunId)).toHaveLength(1);
        expect(cancel.mock.calls.filter(args => args[0] === second.retryRunId)).toHaveLength(1);
      } finally { release(); await coordinator.stop(); }
    });

    it("does not repeat settlement when a foreground cancellation wins", async () => {
      const f = await seedIssueWithRetry({ agentStatus: "paused" });
      await writeIntent(f);
      const service = heartbeatService(db, { runtimeEnv: {} });
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      clock();
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      const worker = createScheduledRetryCancellationRecovery(db, async (...args) => {
        enter(); await held; return service.cancelRun(...args);
      }).register(coordinator, () => true, async () => true);
      try {
        await entered;
        await service.cancelRun(f.retryRunId, "Foreground stop", { expectedStatus: "scheduled_retry" });
        const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.retryRunId));
        release(); await worker.ready;
        await vi.advanceTimersByTimeAsync(1000);
        await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.retryRunId))).toEqual(events);
        expect((await runRow(f.retryRunId)).error).toBe("Foreground stop");
      } finally { release(); await coordinator.stop(); }
    });

    it("joins an in-flight authority read at shutdown without starting cancellation", async () => {
      const f = await seedIssueWithRetry({ agentStatus: "paused" });
      await writeIntent(f);
      const service = heartbeatService(db, { runtimeEnv: {} });
      let enter!: () => void, release!: () => void, checks = 0;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      const cancel = vi.fn(service.cancelRun);
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      const worker = createScheduledRetryCancellationRecovery(db, cancel).register(coordinator, () => true, async () => {
        if (++checks === 2) { enter(); await held; }
        return true;
      });
      let stopping: Promise<void> | undefined;
      try {
        await entered;
        let stopped = false;
        stopping = coordinator.stop().then(() => { stopped = true; });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(stopped).toBe(false);
        release(); await worker.ready; await stopping;
        expect(cancel).not.toHaveBeenCalled();
        expect((await runRow(f.retryRunId)).status).toBe("scheduled_retry");
      } finally { release(); await (stopping ?? coordinator.stop()); }
      const restarted = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      try {
        await heartbeatService(db, { runtimeEnv: {} }).registerScheduledRetryCancellationWork(restarted, () => true).ready;
        expect((await runRow(f.retryRunId)).status).toBe("cancelled");
      } finally { await restarted.stop(); }
    });

    it("manual recovery starts cancellation without loading the full backlog", async () => {
      const f = await seedIssueWithRetry({ agentStatus: "paused" });
      const work = await db.insert(heartbeatRuns).values(Array.from({ length: 120 }, () => ({
        companyId: f.companyId, agentId: f.agentId, status: "scheduled_retry", resultJson: intent(),
      }))).returning({ id: heartbeatRuns.id });
      const service = heartbeatService(db, { runtimeEnv: {} });
      const reads = vi.spyOn(db, "select");
      let readsBeforeFirstCancellation: number | undefined;
      try {
        await createScheduledRetryCancellationRecovery(db, async (...args) => {
          readsBeforeFirstCancellation ??= reads.mock.calls.filter(([fields]) => fields &&
            "result" in fields && "errorCode" in fields).length;
          return service.cancelRun(...args);
        }).sweep();
        expect(readsBeforeFirstCancellation).toBe(2);
        const states = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
          .where(inArray(heartbeatRuns.id, work.map(row => row.id)));
        expect(states.filter(row => row.status === "cancelled")).toHaveLength(20);
        expect(states.filter(row => row.status === "scheduled_retry")).toHaveLength(100);
      } finally { reads.mockRestore(); }
    });

    it("pages past malformed intents and drains fair batches without revisiting completed history", async () => {
      const a = await seedIssueWithRetry({ agentStatus: "paused" });
      const b = await seedIssueWithRetry({ agentStatus: "paused" });
      await db.insert(heartbeatRuns).values(Array.from({ length: 103 }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, companyId: a.companyId, agentId: a.agentId,
        status: "scheduled_retry", resultJson: { startupCancellation: {}, cancellation: { expected: true } },
      })));
      const work = await db.insert(heartbeatRuns).values([...[a, b].flatMap((f, index) =>
        Array.from({ length: index === 0 ? 25 : 3 }, () => ({ companyId: f.companyId, agentId: f.agentId,
          status: "scheduled_retry", resultJson: intent() }))),
      ]).returning({ id: heartbeatRuns.id });
      const states = () => db.select({ companyId: heartbeatRuns.companyId, status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, work.map(row => row.id)));
      clock();
      let completeFirstPass!: (result: { error: unknown } | undefined) => void;
      const firstPassCompleted = new Promise<{ error: unknown } | undefined>(resolve => { completeFirstPass = resolve; });
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
        onError: error => { completeFirstPass({ error }); throw error; } });
      const register = coordinator.register.bind(coordinator);
      let initial: Awaited<ReturnType<typeof states>> | undefined;
      let releaseFirstPass!: () => void;
      const firstPassHeld = new Promise<void>(resolve => { releaseFirstPass = resolve; });
      vi.spyOn(coordinator, "register").mockImplementation((queue, task) => register(queue, {
        ...task,
        run: async signal => {
          const result = await task.run(signal);
          if (initial) return result;
          const cancelled = (await states()).filter(row => row.status === "cancelled");
          if (cancelled.length === 0) return result;
          initial = cancelled;
          completeFirstPass(undefined);
          await firstPassHeld;
          return result;
        },
      }));
      try {
        await heartbeatService(db, { runtimeEnv: {} }).registerScheduledRetryCancellationWork(coordinator, () => true).ready;
        expect((await states()).filter(row => row.status === "cancelled")).toHaveLength(0);
        const earlierId = "00000000-0000-4000-8000-000000000000";
        work.push({ id: earlierId });
        await writeIntent({ companyId: a.companyId, retryRunId: earlierId });
        await vi.advanceTimersByTimeAsync(1000);
        const firstPass = await firstPassCompleted;
        if (firstPass) throw firstPass.error;
        expect(initial).toHaveLength(20);
        expect(new Set(initial!.map(row => row.companyId)).size).toBe(2);
        releaseFirstPass();
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(1000);
          expect((await states()).filter(row => row.status === "cancelled")).toHaveLength(29);
        }, { timeout: 10_000 });
        await expect.poll(() => idleWorkSnapshot().active).toBe(0);
        await vi.advanceTimersByTimeAsync(1000);
        await expect.poll(() => coordinator.nextWakeAt()).toBeNull();
        const reads = vi.spyOn(db, "select");
        await vi.advanceTimersByTimeAsync(180_000);
        expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
      } finally { releaseFirstPass(); await coordinator.stop(); }
    });
  });

  it("finishes a parked retry cancellation after its owner loses the final database write", async () => {
    const f = await seedIssueWithRetry({ agentStatus: "paused" });
    const unrelated = await seedIssueWithRetry({ agentStatus: "paused" });
    await db.execute(sql`ALTER TABLE heartbeat_runs ADD CONSTRAINT reject_retry_cancellation CHECK (status <> 'cancelled') NOT VALID`);
    try {
      await expect(heartbeatService(db).cancelRun(f.retryRunId, "Superseded by a human comment", {
        expectedStatus: "scheduled_retry",
      })).rejects.toThrow();
      // A failed sweep leaves the same durable intent available for a later one.
      await heartbeatService(db).reapOrphanedRuns();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.retryRunId)))
        .toEqual([expect.objectContaining({ status: "scheduled_retry" })]);
    } finally {
      await db.execute(sql`ALTER TABLE heartbeat_runs DROP CONSTRAINT reject_retry_cancellation`);
    }
    const [interrupted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.retryRunId));
    expect(interrupted).toMatchObject({ status: "scheduled_retry", resultJson: {
      startupCancellation: expect.any(Object), cancellation: { reason: "Superseded by a human comment" },
    } });

    // A fresh service has no process-local cancellation owner or settlement promise.
    await heartbeatService(db).reapOrphanedRuns();
    const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.retryRunId));
    expect(cancelled).toMatchObject({ status: "cancelled", error: "Superseded by a human comment" });
    expect(cancelled!.resultJson!.cancellation).toEqual(interrupted!.resultJson!.cancellation);
    expect(await db.select().from(issues).where(eq(issues.id, f.issueId)))
      .toEqual([expect.objectContaining({ executionRunId: null, assigneeAgentId: f.agentId })]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, f.retryRunId)))
      .toEqual([expect.objectContaining({ status: "cancelled" })]);
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.retryRunId));
    await heartbeatService(db).reapOrphanedRuns();
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.retryRunId))).toEqual(events);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unrelated.retryRunId)))
      .toEqual([expect.objectContaining({ status: "scheduled_retry", resultJson: null })]);
  });

  it.each(["post", "patch"] as const)("keeps a retry's live process and saved work owner when a %s comment arrives", async method => {
    const f = await seedIssueWithRetry({ retryStatus: "running" });
    const child = spawn(process.execPath, ["-e", `
      process.on('message', message => {
        if (message === 'continue-work') process.send('work-continues');
      });
      process.send('ready');
    `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const exited = once(child, "exit");
    const heartbeat = heartbeatService(db);
    try {
      await once(child, "message", { signal: AbortSignal.timeout(5_000) });
      runningProcesses.set(f.retryRunId, { child, graceSec: 1, processGroupId: null });
      await db.update(heartbeatRuns).set({
        startedAt: new Date(), runtimeModeResolvedAt: new Date(), processPid: child.pid,
      }).where(eq(heartbeatRuns.id, f.retryRunId));
      const app = createApp(boardActor(f.companyId));

      const res = method === "post"
        ? await request(app).post(`/api/issues/${f.issueId}/comments`).send({ body: "Verified source recovery; continue the original work." })
        : await request(app).patch(`/api/issues/${f.issueId}`).send({ comment: "Verified source recovery; continue the original work." });

      expect(res.status, JSON.stringify(res.body)).toBe(method === "post" ? 201 : 200);
      const [comment] = await db.select({ id: issueComments.id }).from(issueComments)
        .where(eq(issueComments.issueId, f.issueId));
      expect(comment).toBeDefined();
      await expect.poll(async () => db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.companyId, f.companyId),
          sql`${agentWakeupRequests.payload}->>'commentId' = ${comment!.id}`))).toHaveLength(1);
      await heartbeat.drainActiveRunExecutions();
      const progress = once(child, "message", { signal: AbortSignal.timeout(5_000) });
      child.send("continue-work");
      expect((await progress)[0]).toBe("work-continues");
      const [savedIssue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      const [savedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.retryRunId));
      expect(savedIssue).toMatchObject({ status: "in_progress", executionRunId: f.retryRunId });
      expect(savedRun).toMatchObject({ status: "running", processPid: child.pid });
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId)))
        .toHaveLength(1);
      expect(await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "running"),
      ))).toHaveLength(1);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      runningProcesses.delete(f.retryRunId);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
  });

  it("surfaces the current scheduled retry in the issue read model", async () => {
    const { companyId, issueId, agentId, sourceRunId, retryRunId, scheduledRetryAt } = await seedIssueWithRetry();

    const res = await request(createApp(boardActor(companyId, "local_implicit"))).get(`/api/issues/${issueId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.scheduledRetry).toMatchObject({
      runId: retryRunId,
      status: "scheduled_retry",
      agentId,
      agentName: "CodexCoder",
      retryOfRunId: sourceRunId,
      scheduledRetryAttempt: 2,
      scheduledRetryReason: "transient_failure",
    });
    expect(res.body.scheduledRetry.scheduledRetryAt).toBe(scheduledRetryAt.toISOString());
  });

  it.each(["queued", "running"] as const)(
    "surfaces a %s retry with its real live status",
    async (retryStatus) => {
      const { companyId, issueId, retryRunId } = await seedIssueWithRetry({ retryStatus });

      const res = await request(createApp(boardActor(companyId, "local_implicit"))).get(`/api/issues/${issueId}`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.scheduledRetry).toMatchObject({
        runId: retryRunId,
        status: retryStatus,
        scheduledRetryReason: "transient_failure",
      });
    },
  );

  it("includes a blocker's live retry in relation summaries", async () => {
    const { companyId, issueId: blockerId, retryRunId } = await seedIssueWithRetry({ retryStatus: "running" });
    const blockedId = randomUUID();
    await db.insert(issues).values({
      id: blockedId,
      companyId,
      title: "Waiting for recovery",
      status: "blocked",
      priority: "medium",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
    });

    const res = await request(createApp(boardActor(companyId, "local_implicit"))).get(`/api/issues/${blockedId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.blockedBy).toHaveLength(1);
    expect(res.body.blockedBy[0]).toMatchObject({
      id: blockerId,
      scheduledRetry: {
        runId: retryRunId,
        status: "running",
        scheduledRetryReason: "transient_failure",
      },
    });
  });

  it("starts exactly one run when the owner retries an unanswered chat after saved-work recovery settled", async () => {
    const f = await seedIssueWithRetry();
    await db.insert(authUsers).values({ id: "board-user", name: "Conversation owner", email: "owed@example.test",
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.update(issues).set({ status: "blocked", conversationAgentId: f.agentId, conversationUserId: "board-user",
      conversationState: "active", conversationSessionGeneration: 2, executionRunId: null, executionLockedAt: null,
      executionAgentNameKey: null }).where(eq(issues.id, f.issueId));
    await db.update(agents).set({ status: "error" }).where(eq(agents.id, f.agentId));
    await db.update(agentWakeupRequests).set({ status: "failed", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.companyId, f.companyId));
    const [message] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorUserId: "board-user", authorType: "user", body: "Continue the work I asked for",
      createdAt: new Date("2026-05-06T17:59:00Z") }).returning();
    await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native", nativeIssueId: f.issueId, scopeKind: "issue",
      scheduledRetryAt: null, scheduledRetryReason: null, finishedAt: new Date(), errorCode: "native_predecessor_retirement_unproven",
      contextSnapshot: { issueId: f.issueId, conversationSessionGeneration: 2, wakeCommentId: message.id },
      resultJson: { failureCause: "native_predecessor_retirement_unproven", continuationScheduling: "refused" },
      createdAt: new Date("2026-05-06T18:00:01Z") }).where(eq(heartbeatRuns.id, f.retryRunId));
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", status: "resolved", outcome: "restored", ownerType: "system",
      returnOwnerAgentId: f.agentId, cause: "native_session_interrupted", fingerprint: randomUUID(),
      nextAction: "Saved work recovered.", resolutionNote: "workspace_recovered_by_sibling_action",
      evidence: { runId: f.retryRunId, continuationDelivery: "not_requested" } });
    // Exercise the real route/admission/run rows without launching a model or
    // requiring credentials. Drain the admitted execution before fixture teardown.
    registerServerAdapter({ type: "codex_local", supportsLocalAgentJwt: false,
      execute: async () => {
        await db.update(issues).set({ status: "todo", conversationState: "waiting" }).where(eq(issues.id, f.issueId));
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({ adapterType: "codex_local", status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
    try {
      const app = createApp(boardActor(f.companyId));
      const detail = await request(app).get(`/api/issues/${f.issueId}`);
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      expect(detail.body.interruption).toMatchObject({ state: "failed", canRetry: true, unansweredCommentId: message.id });
      const body = { idempotencyKey: randomUUID(), observedRunId: f.retryRunId };
      const retry = await request(app).post(`/api/issues/${f.issueId}/retry`).send(body);
      expect(retry.status, JSON.stringify(retry.body)).toBe(202);
      expect(retry.body.accepted).toBe(true);
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, retry.body.requestId));
      expect(receipt.runId).toEqual(expect.any(String));
      await heartbeatService(db).drainActiveRunExecutions();
      const [started] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, receipt.runId!));
      expect(started.status).toBe("succeeded");
      const replay = await request(app).post(`/api/issues/${f.issueId}/retry`).send(body);
      expect(replay.body.requestId).toBe(retry.body.requestId);
      const allRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
      expect(allRuns.filter(run => run.id !== f.sourceRunId && run.id !== f.retryRunId)).toHaveLength(1);
    } finally {
      await heartbeatService(db).drainActiveRunExecutions();
      unregisterServerAdapter("codex_local");
      await db.delete(agentTaskSessions).where(eq(agentTaskSessions.companyId, f.companyId));
      await db.delete(agentRuntimeState).where(eq(agentRuntimeState.companyId, f.companyId));
      await db.delete(companySkills).where(eq(companySkills.companyId, f.companyId));
      await db.delete(costEvents).where(eq(costEvents.companyId, f.companyId));
    }
  });

  it("starts a scheduled retry now when the task Retry is clicked during its countdown", async () => {
    const f = await seedIssueWithRetry();
    await db.update(heartbeatRuns).set({ createdAt: new Date("2026-05-06T18:00:01.000Z") })
      .where(eq(heartbeatRuns.id, f.retryRunId));
    const app = createApp(boardActor(f.companyId));

    const res = await request(app).post(`/api/issues/${f.issueId}/retry`)
      .send({ idempotencyKey: randomUUID(), observedRunId: f.retryRunId });

    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toMatchObject({ accepted: true, scheduledRetry: { outcome: "promoted" } });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.retryRunId));
    expect(run!.status).toBe("queued");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.sourceRunId))).toHaveLength(1);
  });

  it("starts the scheduled retry when a saved task Retry is replayed after its promotion was lost", async () => {
    const f = await seedIssueWithRetry();
    await db.update(heartbeatRuns).set({ createdAt: new Date("2026-05-06T18:00:01.000Z") })
      .where(eq(heartbeatRuns.id, f.retryRunId));
    const app = createApp(boardActor(f.companyId));
    const body = { idempotencyKey: randomUUID(), observedRunId: f.retryRunId };
    const first = await request(app).post(`/api/issues/${f.issueId}/retry`).send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    await db.update(heartbeatRuns).set({ status: "scheduled_retry", scheduledRetryAt: new Date(Date.now() + 60 * 60_000) })
      .where(eq(heartbeatRuns.id, f.retryRunId));

    const replay = await request(app).post(`/api/issues/${f.issueId}/retry`).send(body);

    expect(replay.status, JSON.stringify(replay.body)).toBe(202);
    expect(replay.body).toMatchObject({ accepted: true, requestId: first.body.requestId, scheduledRetry: { outcome: "promoted" } });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.retryRunId));
    expect(run!.status).toBe("queued");
  });

  it("refuses Retry now on a private task the member cannot see, like the task Retry", async () => {
    const f = await seedIssueWithRetry();
    await db.update(issues).set({ visibility: "private", createdByUserId: "task-owner", responsibleUserId: "task-owner" })
      .where(eq(issues.id, f.issueId));
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: "other-member",
      status: "active", membershipRole: "member" });
    const app = createApp({ ...boardActor(f.companyId), userId: "other-member",
      memberships: [{ companyId: f.companyId, membershipRole: "member", status: "active" }] });

    const retry = await request(app).post(`/api/issues/${f.issueId}/retry`)
      .send({ idempotencyKey: randomUUID(), observedRunId: f.retryRunId });
    const retryNow = await request(app).post(`/api/issues/${f.issueId}/scheduled-retry/retry-now`).send({});

    expect(retry.status, JSON.stringify(retry.body)).toBe(404);
    expect(retryNow.status, JSON.stringify(retryNow.body)).toBe(404);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.retryRunId));
    expect(run!.status).toBe("scheduled_retry");
  });

  it("promotes the existing scheduled retry and treats duplicate clicks as idempotent", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry();
    const app = createApp(boardActor(companyId));

    const first = await request(app).post(`/api/issues/${issueId}/scheduled-retry/retry-now`).send({});

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      outcome: "promoted",
      scheduledRetry: {
        runId: retryRunId,
        status: "queued",
      },
    });

    const second = await request(app).post(`/api/issues/${issueId}/scheduled-retry/retry-now`).send({});

    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body).toMatchObject({
      outcome: "already_promoted",
      scheduledRetry: {
        runId: retryRunId,
        status: "queued",
      },
    });

    const retryRuns = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.retryOfRunId, first.body.scheduledRetry.retryOfRunId), eq(heartbeatRuns.companyId, companyId)));
    expect(retryRuns).toHaveLength(1);
    expect(retryRuns[0]).toMatchObject({ id: retryRunId, status: "queued" });
  });

  it("reports cleanup waits with the saved schedule and promotes the same retry after release", async () => {
    const f = await seedIssueWithRetry();
    await db.update(heartbeatRuns)
      .set({ resultJson: { conversationContinuation: "continue_conversation_v1" } })
      .where(inArray(heartbeatRuns.id, [f.sourceRunId, f.retryRunId]));
    const [lease] = await db.insert(environmentLeases).values({
      companyId: f.companyId, issueId: f.issueId, heartbeatRunId: f.sourceRunId,
      status: "pending_cleanup", cleanupStatus: "failed",
    }).returning();
    const app = createApp(boardActor(f.companyId));
    for (let click = 0; click < 2; click++) {
      const before = Date.now();
      const res = await request(app).post(`/api/issues/${f.issueId}/scheduled-retry/retry-now`).send({});
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ outcome: "waiting", scheduledRetry: {
        runId: f.retryRunId, status: "scheduled_retry", scheduledRetryAttempt: 2,
      } });
      expect(res.body.message).toContain("Waiting for execution cleanup");
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.retryRunId));
      expect(res.body.scheduledRetry.scheduledRetryAt).toBe(saved!.scheduledRetryAt!.toISOString());
      expect(saved!.scheduledRetryAt!.getTime()).toBeGreaterThanOrEqual(before + 30_000);
    }
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.sourceRunId))).toHaveLength(1);
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date() })
      .where(eq(environmentLeases.id, lease!.id));
    const resumed = await request(app).post(`/api/issues/${f.issueId}/scheduled-retry/retry-now`).send({});
    expect(resumed.body).toMatchObject({ outcome: "promoted", scheduledRetry: {
      runId: f.retryRunId, status: "queued", scheduledRetryAttempt: 2,
    } });
  });

  it("returns a clear no-op response when there is no scheduled retry", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "NONE",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board-user",
      status: "active", membershipRole: "admin" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "No retry",
      status: "todo",
      priority: "medium",
      issueNumber: 1,
      identifier: "NONE-1",
    });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "no_scheduled_retry",
      scheduledRetry: null,
    });
  });

  it("reports already-promoted retries without creating another run", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry({ retryStatus: "queued" });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "already_promoted",
      scheduledRetry: {
        runId: retryRunId,
        status: "queued",
      },
    });
  });

  it("uses normal promotion gates and records gate-suppressed retries", async () => {
    const { companyId, issueId, retryRunId } = await seedIssueWithRetry({ agentStatus: "paused" });

    const res = await request(createApp(boardActor(companyId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      outcome: "gate_suppressed",
      scheduledRetry: {
        runId: retryRunId,
        status: "cancelled",
        errorCode: "agent_not_invokable",
      },
    });

    const [run] = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, retryRunId));
    expect(run).toEqual({ status: "cancelled", errorCode: "agent_not_invokable" });

    const [activity] = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, runId: activityLog.runId })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(activity).toEqual({
      action: "issue.scheduled_retry_retry_now",
      entityId: issueId,
      runId: retryRunId,
    });
  });

  // Never-OK authority guard: owning a run/header or a grant must not borrow another person's authority.
  describe("agent Retry with authenticated original-person authority, not grants", () => {
    async function fixture() {
      const f = await seedIssueWithRetry();
      await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), responsibleUserId: "board-user",
        runtimeMode: "legacy", errorCode: "setup_failed", executionStage: "preparing",
        runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
        createdAt: new Date("2026-05-06T18:00:01.000Z"),
      }).where(eq(heartbeatRuns.id, f.retryRunId));
      await db.update(issues).set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null })
        .where(eq(issues.id, f.issueId));
      const [presser] = await db.insert(agents).values({ companyId: f.companyId, name: "Presser", adapterType: "process" }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: presser.id,
        status: "running", responsibleUserId: "board-user" }).returning();
      // Occupy the worker: the route dispatches a real queued successor without provider work.
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
      return { ...f, presserId: presser.id, presserRunId: run.id };
    }
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    function actor(f: Fixture): Express.Request["actor"] {
      return { ...agentActor(f.companyId, f.presserId), runId: f.presserRunId, onBehalfOfUserId: "board-user",
        onBehalfOfMemberships: [{ companyId: f.companyId, membershipRole: "admin", status: "active" }] };
    }
    function retry(f: Fixture, opts: { idempotencyKey?: string; actor?: Partial<Express.Request["actor"]> } = {}) {
      return request(createApp({ ...actor(f), ...opts.actor } as Express.Request["actor"]))
        .post(`/api/issues/${f.issueId}/retry`)
        .send({ idempotencyKey: opts.idempotencyKey ?? randomUUID(), observedRunId: f.retryRunId });
    }
    async function counted(f: Fixture) {
      return db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId),
        eq(activityLog.action, "issue.retry_requested_by_agent")));
    }
    it.each(["none", "unrelated", "scoped", "revoked"])("admits without any effective grant: %s", async grant => {
      const f = await fixture();
      if (grant !== "none") await db.insert(principalPermissionGrants).values({ companyId: f.companyId,
        principalType: "agent", principalId: f.presserId, permissionKey: "tasks:retry", grantedByUserId: "someone-else",
        scope: grant === "scoped" ? { projectIds: [randomUUID()] } : null });
      if (grant === "revoked") await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, f.companyId));
      const res = await retry(f);
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      expect(res.body.accepted).toBe(true);
      expect(await counted(f)).toEqual([expect.objectContaining({ actorType: "agent", actorId: f.presserId, runId: f.presserRunId })]);
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
      expect(successors).toEqual([expect.objectContaining({ responsibleUserId: "board-user" })]);
    });
    it.each(["different_person", "plain_key", "unsigned_header", "other_run"])("refuses presser authority mismatch: %s", async kind => {
      const f = await fixture();
      let change: Partial<Express.Request["actor"]> = {};
      if (kind === "different_person") {
        await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: "paul",
          status: "active", membershipRole: "admin" });
        await db.update(heartbeatRuns).set({ responsibleUserId: "paul" }).where(eq(heartbeatRuns.id, f.presserRunId));
        change = { onBehalfOfUserId: "paul", onBehalfOfMemberships: [{ companyId: f.companyId, membershipRole: "admin", status: "active" }] };
      }
      if (kind === "plain_key" || kind === "unsigned_header") change = { source: "agent_key", keyId: randomUUID(),
        runId: kind === "plain_key" ? undefined : f.presserRunId };
      if (kind === "other_run") change = { runId: f.sourceRunId };
      const res = await retry(f, { actor: change });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body).toMatchObject({ details: { reason: "presser_not_acting_for_original_person" } });
    });
    it.each([false, true])("uses actual actorMiddleware: signed run accepted, plain API key refused (plain: %s)", async plain => {
      vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "agent-task-retry-jwt-test-secret");
      vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
      try {
        const f = await fixture();
        await db.insert(authUsers).values({ id: "board-user", name: "Board User", email: "board-user@example.com",
          emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
        let token = createLocalAgentJwt(f.presserId, f.companyId, "process", f.presserRunId, "board-user")!;
        if (plain) {
          token = `retry-fixture-${randomUUID()}`;
          await db.insert(agentApiKeys).values({ companyId: f.companyId, agentId: f.presserId, name: "Plain fixture key",
            keyHash: createHash("sha256").update(token).digest("hex"), responsibleUserId: "board-user" });
        }
        const app = express();
        app.use(express.json());
        app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
        app.use("/api", issueRoutes(db, {} as any));
        app.use(errorHandler);
        const res = await request(app).post(`/api/issues/${f.issueId}/retry`)
          .set("Authorization", `Bearer ${token}`).set("X-Paperclip-Run-Id", f.presserRunId)
          .send({ idempotencyKey: randomUUID(), observedRunId: f.retryRunId });
        expect(res.status, JSON.stringify(res.body)).toBe(plain ? 403 : 202);
        if (plain) expect(res.body).toMatchObject({ details: { reason: "presser_not_acting_for_original_person" } });
        else expect(res.body.accepted).toBe(true);
      } finally { vi.unstubAllEnvs(); }
    });
    it("enforces the agent's responsible-user write ceiling for a viewer", async () => {
      const f = await fixture();
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: "viewer-user",
        status: "active", membershipRole: "viewer" });
      const res = await retry(f, { actor: { onBehalfOfUserId: "viewer-user",
        onBehalfOfMemberships: [{ companyId: f.companyId, membershipRole: "viewer", status: "active" }] } });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body).toMatchObject({ details: { code: "RESPONSIBLE_USER_UNAUTHORIZED" } });
    });
    it("refuses scheduled automatic retries, rather than promoting them", async () => {
      const f = await fixture();
      await db.update(heartbeatRuns).set({ status: "scheduled_retry", finishedAt: null }).where(eq(heartbeatRuns.id, f.retryRunId));
      const res = await retry(f);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body).toMatchObject({ details: { reason: "automatic_retry_pending" } });
    });
    it("requires the original person to remain active", async () => {
      const f = await fixture();
      await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.companyId, f.companyId));
      const res = await retry(f);
      // Ordinary access containment may hide the task before Retry admission.
      expect([403, 404], JSON.stringify(res.body)).toContain(res.status);
    });
    it("fails closed with 404 for a cross-company task", async () => {
      const f = await fixture(), other = await fixture();
      const res = await request(createApp(actor(f))).post(`/api/issues/${other.issueId}/retry`)
        .send({ idempotencyKey: randomUUID(), observedRunId: other.retryRunId });
      expect(res.status, JSON.stringify(res.body)).toBe(404);
    });
    it.each(["conversation", "connected"])("refuses %s chat tasks", async kind => {
      const f = await fixture();
      await db.update(issues).set(kind === "connected" ? { originKind: "chat_channel" } : {
        conversationAgentId: f.agentId, conversationUserId: "board-user", conversationState: "waiting",
      }).where(eq(issues.id, f.issueId));
      const res = await retry(f);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    });
    it("caps all agents' presses on one task per day, including refused attempts", async () => {
      const f = await fixture();
      await db.update(heartbeatRuns).set({ status: "scheduled_retry", finishedAt: null }).where(eq(heartbeatRuns.id, f.retryRunId));
      for (let i = 0; i < 3; i++) expect((await retry(f)).status).toBe(403);
      const res = await retry(f, { actor: { agentId: f.agentId } });
      expect(res.status, JSON.stringify(res.body)).toBe(429);
      expect(res.body).toMatchObject({ details: { code: "agent_task_retry_cap_reached" } });
    });
    it("counts an admitted replay once toward the cap", async () => {
      const f = await fixture(), idempotencyKey = randomUUID();
      for (let i = 0; i < 4; i++) expect((await retry(f, { idempotencyKey })).status).toBe(202);
      expect(await counted(f)).toHaveLength(1);
    });
    it("does not let yesterday's unsaved key bypass today's cap", async () => {
      const f = await fixture(), oldUnsavedKey = randomUUID();
      await db.update(heartbeatRuns).set({ status: "scheduled_retry", finishedAt: null }).where(eq(heartbeatRuns.id, f.retryRunId));
      await db.insert(activityLog).values({ companyId: f.companyId, actorType: "agent", actorId: f.presserId,
        agentId: f.presserId, runId: f.presserRunId, action: "issue.retry_requested_by_agent", entityType: "issue",
        entityId: f.issueId, details: { idempotencyKey: oldUnsavedKey }, createdAt: new Date(Date.now() - 2 * 86400000) });
      for (let i = 0; i < 3; i++) expect((await retry(f)).status).toBe(403);
      expect((await retry(f, { idempotencyKey: oldUnsavedKey })).status).toBe(429);
    });
    it("deduplicates overlapping calls with the same key in the current window", async () => {
      const f = await fixture(), idempotencyKey = randomUUID();
      const results = await Promise.all([retry(f, { idempotencyKey }), retry(f, { idempotencyKey })]);
      expect(results.map(result => result.status)).toEqual([202, 202]);
      expect(await counted(f)).toHaveLength(1);
    });
    it("keeps a low-trust agent within its task boundary", async () => {
      const f = await fixture();
      await db.update(agents).set({ permissions: { trustPreset: "low_trust_review", authorizationPolicy: {
        trustBoundary: { mode: "low_trust_review", companyId: f.companyId, rootIssueId: randomUUID() } } } })
        .where(eq(agents.id, f.presserId));
      expect([403, 404]).toContain((await retry(f)).status);
    });
    it("keeps scoped keys within their limits", async () => {
      const f = await fixture();
      const res = await retry(f, { actor: { keyScope: { kind: "skill_test", issueId: randomUUID() } } as Partial<Express.Request["actor"]> });
      expect(res.status, JSON.stringify(res.body)).toBe(403);
    });
  });

  it("requires board access for retry-now", async () => {
    const { companyId, agentId, issueId } = await seedIssueWithRetry();

    const res = await request(createApp(agentActor(companyId, agentId)))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status).toBe(403);
  });

  it("enforces company scoping for retry-now with a uniform 404", async () => {
    const { issueId } = await seedIssueWithRetry();

    const res = await request(createApp(boardActor(randomUUID())))
      .post(`/api/issues/${issueId}/scheduled-retry/retry-now`)
      .send({});

    expect(res.status).toBe(404);
  });

});
