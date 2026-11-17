// Follow-Paperclip Cuts A + B (adopt-lead 05:37Z; spec fp-FINAL-WITH-RFL-FIXES, RFL A-5 / B-5 / B-2).
// RED first, test-only: these pin the behaviour the two cuts must reach, through the real acquisition,
// the real fresh-continuation fallback and delivery, and the real unanswered-message sweep. Only provider
// I/O is a controlled peer (the Boat plugin worker).
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, environmentLeases, environments, heartbeatRuns,
  issueComments, issueRecoveryActions, issues, nativeRunFinalizations, plugins,
} from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { truncateTablesWithDeadlockRetry } from "../__tests__/helpers/truncate-with-deadlock-retry.js";
import { environmentRuntimeService } from "./environment-runtime.js";
import { deliverReconciledExecutions, settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";
import {
  FRESH_CONTINUATION_PENDING_BOUND_MS, FRESH_CONTINUATIONS_PER_CHAIN, FRESH_CONTINUATION_WINDOW_MS,
  continueHeldExecutions, ensureFreshContinuation, resetBacklogContinuationPacingForTests,
} from "./fresh-continuation-fallback.js";
import { heartbeatService } from "./heartbeat.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { isFreshThreadRefusal } from "./native-runtime/runner-reconciliation-refusal.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";

// Custody peer, the same rule as environment-runtime-reusable-resume-replacement.test.ts: a lease's backup verifies only when
// its stamp authorizes that exact provider lease. Everything else in the module is the real implementation.
vi.mock("./native-runtime/native-harness-backup-storage.js", async importOriginal => ({
  ...await importOriginal<typeof import("./native-runtime/native-harness-backup-storage.js")>(),
  verifyRecoverableNativeHarnessBackup: vi.fn(async (input: { stamp: unknown; providerLeaseId: string }) =>
    Boolean(input.stamp && (input.stamp as { authorizedProviderLeaseId?: unknown }).authorizedProviderLeaseId === input.providerLeaseId)),
}));

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
// A typed fresh-thread refusal (runner-reconciliation-refusal.ts FRESH_THREAD_REFUSAL_CODES).
const TYPED = "runner_remote_state_unavailable";

suite("follow-Paperclip Cuts A + B: REDs (A-5, B-5, B-2)", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let companyId = "", agentId = "", userId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-follow-paperclip-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterEach(async () => {
    vi.useRealTimers();
    resetBacklogContinuationPacingForTests(db);
    await heartbeatService(db).drainActiveRunExecutions();
    await truncateTablesWithDeadlockRetry(db, "truncate table companies, environments, plugins cascade");
  });
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function company() {
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Paul", email: `${userId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Follow Paperclip", issuePrefix: `FP${companyId.slice(0, 4)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
  }

  /** A person's message whose run ended with a typed fresh-thread refusal, held by its recovery action. */
  async function heldTypedMessage(finishedAt = new Date(Date.now() - 60_000)) {
    const issueId = randomUUID(), runId = randomUUID(), messageId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Answer Paul", status: "blocked",
      assigneeAgentId: agentId, responsibleUserId: userId, statusVersion: 4, blockedTransitionAt: finishedAt });
    await db.insert(issueComments).values({ id: messageId, companyId, issueId, authorType: "user", authorUserId: userId,
      body: "Please summarise the copper orchard report.", createdAt: new Date(finishedAt.getTime() - 11 * 60_000) });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", issueId, nativeIssueId: issueId,
      runtimeMode: "native", status: "failed", errorCode: TYPED, error: TYPED, nativePhase: "terminal_failure", responsibleUserId: userId,
      startedAt: new Date(finishedAt.getTime() - 10 * 60_000), finishedAt, createdAt: new Date(finishedAt.getTime() - 10.5 * 60_000),
      contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentId: messageId, wakeCommentIds: [messageId] } });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure",
      recoveryState: "blocked", failureCode: "native_continuation_requires_reconciliation", leaseOwner: null });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      status: "active", ownerType: "board", returnOwnerAgentId: agentId, cause: "native_continuation_requires_reconciliation",
      fingerprint: `native-continuation:${runId}`, nextAction: "Continue from the last saved work.", maxAttempts: 3, createdAt: finishedAt,
      evidence: { runId, originalFailureCode: TYPED, nativeFailureBlock: { runId, statusVersion: 4 } } }).returning();
    return { issueId, runId, messageId, actionId: action!.id, finishedAt };
  }

  const successors = (runId: string) => db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, runId)));
  const currentSystemNotes = async (issueId: string) => (await db.select().from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system"))))
    .filter(note => !(note.metadata as Record<string, unknown> | null)?.supersededByCommentId && !note.deletedAt);
  async function occupySlot() {
    const [other] = await db.insert(issues).values({ companyId, title: "Other work", status: "in_progress", assigneeAgentId: agentId }).returning();
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: other!.id, status: "running", contextSnapshot: { issueId: other!.id } });
  }
  async function deliver(database = db) {
    const heartbeat = heartbeatService(database);
    await deliverReconciledExecutions(database, heartbeat.wakeup);
    await deliverReconciledExecutions(database, heartbeat.wakeup);
  }

  // ---------------------------------------------------------------- A-5
  // The person's next message wakes a follow-up run on the SAME task (reuse leases are scoped to the task). After the image
  // change its acquisition finds the old boot-source lease obsolete. After Cut A that is upstream's guarded destroy
  // (destroyReusableSandboxLease), dispatched ONLY with the box's native session in verified custody (RFL's A-5 condition,
  // upstream's own resume-replacement guard verifyRecoverableNativeHarnessBackup). A typed destroyed receipt lands on the old
  // lease; a failed or void destroy records none and strips the old stop receipt (environments.ts releaseLease). Without
  // custody nothing is destroyed: the lease is kept, and source mismatch keeps it from serving the next run. In every case
  // the follow-up, which then fails with a typed fresh-thread refusal, is still continued within upstream's bound and
  // delivered once, carrying the message (RFL A-5: A and B ship together).
  describe("A-5: a follow-up acquisition with boot-source drift; the held message is still answered", () => {
    it.each(["destroyed", "failed", "void", "no_custody"] as const)("%s", async variant => {
      await company();
      expect(isFreshThreadRefusal({ errorCode: TYPED })).toBe(true);
      const issueId = randomUUID(), messageId = randomUUID(), oldRunId = randomUUID(), followUpId = randomUUID();
      const environmentId = randomUUID(), pluginId = randomUUID(), oldLeaseId = randomUUID();
      const t0 = new Date(Date.now() - 3600_000);
      await db.insert(issues).values({ id: issueId, companyId, title: "Answer Paul", status: "in_progress",
        assigneeAgentId: agentId, responsibleUserId: userId, statusVersion: 4 });
      const [environment] = await db.insert(environments).values({ id: environmentId, name: `Boat ${environmentId.slice(0, 8)}`, driver: "sandbox",
        status: "active", config: { provider: "boat", image: "boot-source-before-upgrade", reuseLease: true } }).returning();
      await db.insert(plugins).values({ id: pluginId, pluginKey: "paperclip.boat", packageName: "@paperclipai/plugin-boat",
        version: "1.0.0", apiVersion: 1, status: "ready", categories: ["automation"],
        manifestJson: { id: "paperclip.boat", apiVersion: 1, version: "1.0.0", displayName: "Boat", description: "Boat peer", author: "Paperclip",
          categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
          environmentDrivers: [{ driverKey: "boat", kind: "sandbox_provider", displayName: "Boat", supportsReusableLeases: true,
            configSchema: { type: "object" } }] } } as never);
      // The earlier turn: its warm box was released for reuse with a bound stop receipt.
      await db.insert(heartbeatRuns).values({ id: oldRunId, companyId, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native",
        status: "succeeded", createdAt: t0, startedAt: t0, finishedAt: new Date(t0.getTime() + 60_000), contextSnapshot: { issueId } });
      const releasedAt = new Date(t0.getTime() + 61_000), providerLeaseId = `bx-old-${oldLeaseId.slice(0, 8)}`;
      await db.insert(environmentLeases).values({ id: oldLeaseId, companyId, environmentId, issueId, heartbeatRunId: oldRunId,
        provider: "boat", providerLeaseId, leasePolicy: "reuse_by_environment", status: "released", cleanupStatus: "success",
        acquiredAt: t0, releasedAt,
        metadata: { driver: "sandbox", sandboxProviderPlugin: true, pluginId, pluginKey: "paperclip.boat", agentId, ...environment!.config,
          reusableSandboxLease: { adapterType: "paperclip_runner" }, pendingCleanupInFlight: false,
          ...(variant === "no_custody" ? {} : { nativeHarnessBackup: { authorizedProviderLeaseId: providerLeaseId } }),
          remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", state: "stopped", companyId, runId: oldRunId,
            leaseId: oldLeaseId, provider: "boat", providerLeaseId, confirmedAt: releasedAt.toISOString() } } });
      const [oldBefore] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, oldLeaseId));
      // Paul's message wakes the follow-up on the same task; the next image changed the boot source.
      await db.insert(issueComments).values({ id: messageId, companyId, issueId, authorType: "user", authorUserId: userId,
        body: "Please summarise the copper orchard report.", createdAt: new Date(Date.now() - 5 * 60_000) });
      await db.insert(heartbeatRuns).values({ id: followUpId, companyId, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native",
        invocationSource: "on_demand", status: "running", responsibleUserId: userId, createdAt: new Date(Date.now() - 4 * 60_000),
        startedAt: new Date(Date.now() - 4 * 60_000),
        contextSnapshot: { issueId, wakeReason: "issue_commented", wakeCommentId: messageId, wakeCommentIds: [messageId] } });
      const drifted = { ...environment!.config, image: "boot-source-after-upgrade" };
      await db.update(environments).set({ config: drifted }).where(eq(environments.id, environmentId));
      const call = vi.fn(async (_id: string, method: string, params: Record<string, unknown>) => {
        if (method === "environmentAcquireLease") return { providerLeaseId: "bx-fresh", metadata: { ...drifted, remoteCwd: "/workspace" } };
        if (method === "environmentDestroyLease") {
          if (variant === "failed") throw new Error("boat destroy timed out");
          return variant === "void" ? undefined : { providerLeaseId: params.providerLeaseId, state: "destroyed" };
        }
        throw new Error(`unexpected provider call ${method}`);
      });
      const runtime = environmentRuntimeService(db, { pluginWorkerManager: { isRunning: () => true, call,
        getWorker: () => ({ supportedMethods: ["environmentAcquireLease", "environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease", "environmentStopLease"] }),
      } as unknown as PluginWorkerManager });
      const acquired = await runtime.acquireRunLease({ companyId, environment: { ...environment!, config: drifted, envVars: {} } as unknown as Environment,
        issueId, agentId, heartbeatRunId: followUpId, adapterType: "paperclip_runner", persistedExecutionWorkspace: null } as never);
      expect(acquired.lease.providerLeaseId, "the stale source never serves the next run").toBe("bx-fresh");

      const destroys = call.mock.calls.filter(([, method]) => method === "environmentDestroyLease").map(([, , params]) => params.providerLeaseId);
      expect.soft(call.mock.calls.some(([, method]) => method === "environmentStopLease"), "no acquisition-issued stop").toBe(false);
      const [oldAfter] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, oldLeaseId));
      if (variant === "no_custody") {
        // Never-OK guard: no verified custody of the box's session, no destroy. The lease is kept as it was.
        expect.soft(destroys, "no verified custody -> no destroy").toEqual([]);
        expect.soft(oldAfter, "the lease is kept unchanged").toEqual(oldBefore);
      } else {
        expect.soft(destroys, "the drifted source is destroyed through upstream's guarded path").toEqual([providerLeaseId]);
        if (variant === "destroyed") {
          expect.soft(oldAfter).toMatchObject({ status: "expired", cleanupStatus: "success",
            metadata: { remoteExecutionTermination: { state: "destroyed", leaseId: oldLeaseId, runId: oldRunId, providerLeaseId } } });
          expect.soft(hasRemoteTerminationReceipt(oldAfter!)).toBe(true);
        } else {
          expect.soft(oldAfter!.metadata?.remoteExecutionTermination, "a failed or void destroy is no termination receipt").toBeUndefined();
          expect.soft(oldAfter!.status).toBe(variant === "failed" ? "pending_cleanup" : "expired");
        }
      }

      // The follow-up then fails with a typed fresh-thread refusal before answering; its own box stopped with a receipt.
      // Its receipt is confirmed after the acquisition and no later than its release (the gate's time rule).
      const failedAt = new Date(Math.max(Date.now(), acquired.lease.acquiredAt.getTime() + 1));
      await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: failedAt,
        metadata: { ...acquired.lease.metadata, remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", state: "stopped",
          companyId, runId: followUpId, leaseId: acquired.lease.id, provider: "boat", providerLeaseId: "bx-fresh", confirmedAt: failedAt.toISOString() } } })
        .where(eq(environmentLeases.id, acquired.lease.id));
      const [blocked] = await db.update(issues).set({ status: "blocked", blockedTransitionAt: failedAt }).where(eq(issues.id, issueId)).returning();
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: TYPED, error: TYPED, nativePhase: "terminal_failure", finishedAt: failedAt })
        .where(eq(heartbeatRuns.id, followUpId));
      await db.insert(nativeRunFinalizations).values({ runId: followUpId, companyId, issueId, phase: "terminal_failure",
        recoveryState: "blocked", failureCode: "native_continuation_requires_reconciliation", leaseOwner: null });
      await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "active",
        ownerType: "board", returnOwnerAgentId: agentId, cause: "native_continuation_requires_reconciliation",
        fingerprint: `native-continuation:${followUpId}`, nextAction: "Continue from the last saved work.", maxAttempts: 3, createdAt: failedAt,
        evidence: { runId: followUpId, originalFailureCode: TYPED, nativeFailureBlock: { runId: followUpId, statusVersion: blocked!.statusVersion } } });

      // The person's message is still answered: continued within upstream's bound, delivered exactly once.
      let result: Awaited<ReturnType<typeof ensureFreshContinuation>> | null = null;
      for (const at of [0, FRESH_CONTINUATION_PENDING_BOUND_MS + 60_000]) {
        result = await ensureFreshContinuation(db, { companyId, runId: followUpId, trigger: "held_recovery", now: new Date(Date.now() + at) });
        if (result.kind === "continued") break;
      }
      expect(result, "continued within ~10 min (upstream's bound), never held forever").toMatchObject({ kind: "continued" });
      await occupySlot();
      await deliver();
      const next = await successors(followUpId);
      expect(next).toHaveLength(1);
      expect(next[0]!.contextSnapshot).toMatchObject({ issueId, previousRunId: followUpId, forceFreshSession: true,
        wakeCommentIds: [messageId] });
    }, 60_000);
  });

  // RFL 06:33Z: the custody guard FAILS CLOSED. Only a lease whose recorded adapter is KNOWN non-native skips it; an
  // older lease with no adapterType in its metadata, acquired by a caller with no adapter type, is guarded.
  it("fail closed: a pre-metadata warm lease (no adapterType) and a caller with no adapter type, no custody -> stopped and kept, never destroyed", async () => {
    await company();
    const issueId = randomUUID(), oldRunId = randomUUID(), followUpId = randomUUID();
    const environmentId = randomUUID(), pluginId = randomUUID(), oldLeaseId = randomUUID();
    const t0 = new Date(Date.now() - 3600_000);
    await db.insert(issues).values({ id: issueId, companyId, title: "Answer Paul", status: "in_progress", assigneeAgentId: agentId });
    const [environment] = await db.insert(environments).values({ id: environmentId, name: `Boat ${environmentId.slice(0, 8)}`, driver: "sandbox",
      status: "active", config: { provider: "boat", image: "boot-source-before-upgrade", reuseLease: true } }).returning();
    await db.insert(plugins).values({ id: pluginId, pluginKey: "paperclip.boat", packageName: "@paperclipai/plugin-boat",
      version: "1.0.0", apiVersion: 1, status: "ready", categories: ["automation"],
      manifestJson: { id: "paperclip.boat", apiVersion: 1, version: "1.0.0", displayName: "Boat", description: "Boat peer", author: "Paperclip",
        categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "boat", kind: "sandbox_provider", displayName: "Boat", supportsReusableLeases: true,
          configSchema: { type: "object" } }] } } as never);
    await db.insert(heartbeatRuns).values({ id: oldRunId, companyId, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native",
      status: "succeeded", createdAt: t0, startedAt: t0, finishedAt: new Date(t0.getTime() + 60_000), contextSnapshot: { issueId } });
    const providerLeaseId = `bx-old-${oldLeaseId.slice(0, 8)}`;
    // A warm box from an older release: retained (still running), and no reusableSandboxLease.adapterType recorded.
    await db.insert(environmentLeases).values({ id: oldLeaseId, companyId, environmentId, issueId, heartbeatRunId: oldRunId,
      provider: "boat", providerLeaseId, leasePolicy: "reuse_by_environment", status: "retained", acquiredAt: t0,
      metadata: { driver: "sandbox", sandboxProviderPlugin: true, pluginId, pluginKey: "paperclip.boat", agentId, ...environment!.config,
        pendingCleanupInFlight: false } });
    await db.insert(heartbeatRuns).values({ id: followUpId, companyId, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native",
      status: "running", createdAt: new Date(Date.now() - 60_000), startedAt: new Date(Date.now() - 60_000), contextSnapshot: { issueId } });
    const drifted = { ...environment!.config, image: "boot-source-after-upgrade" };
    await db.update(environments).set({ config: drifted }).where(eq(environments.id, environmentId));
    const call = vi.fn(async (_id: string, method: string, params: Record<string, unknown>) => {
      if (method === "environmentAcquireLease") return { providerLeaseId: "bx-fresh", metadata: { ...drifted, remoteCwd: "/workspace" } };
      if (method === "environmentDestroyLease") return { providerLeaseId: params.providerLeaseId, state: "destroyed" };
      throw new Error(`unexpected provider call ${method}`);
    });
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: { isRunning: () => true, call,
      getWorker: () => ({ supportedMethods: ["environmentAcquireLease", "environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease", "environmentStopLease"] }),
    } as unknown as PluginWorkerManager });
    const acquired = await runtime.acquireRunLease({ companyId, environment: { ...environment!, config: drifted, envVars: {} } as unknown as Environment,
      issueId, agentId, heartbeatRunId: followUpId, adapterType: null, persistedExecutionWorkspace: null } as never);
    expect(acquired.lease.providerLeaseId).toBe("bx-fresh");
    expect.soft(call.mock.calls.filter(([, method]) => method === "environmentDestroyLease"), "unknown adapter, no custody -> never destroyed")
      .toEqual([]);
    const [old] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, oldLeaseId));
    expect.soft(old, "stopped and kept through the stop-only owner: billing stops, the disk stays").toMatchObject({
      status: "pending_cleanup", metadata: { sandboxStopAndRetain: { schema: "paperclip.sandbox-stop-and-retain.v1", providerLeaseId } } });
  }, 60_000);

  // ---------------------------------------------------------------- B-5 + B-2
  // The kept held-notice writer returns early for the typed family (native-session-executor.ts noticeHeldUnfinishedPredecessor,
  // `if (freshThreadRefusalCode(error)) return`). After Cut B the typed family is an ordinary failure: the fallback continues it
  // (its user text is the recovery action's nextAction, no thread comment), and the ONE thread note owner is the unanswered-message
  // sweep (removed in delete-ours step 5). B-2: the ONE bound is the K=2 chain cap; #21394's hourly window does not
  // re-open it.
  describe("B-2: a typed chain reaches the one bound", () => {
    async function failContinuation(runId: string, issueId: string) {
      const now = new Date();
      const [task] = await db.update(issues).set({ status: "blocked", executionRunId: null, checkoutRunId: null, blockedTransitionAt: now })
        .where(eq(issues.id, issueId)).returning();
      const [run] = await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native", nativeIssueId: issueId,
        nativePhase: "terminal_failure", errorCode: TYPED, error: TYPED, startedAt: new Date(now.getTime() - 1_000), finishedAt: now })
        .where(eq(heartbeatRuns.id, runId)).returning();
      if (run!.wakeupRequestId) await db.update(agentWakeupRequests).set({ status: "failed", finishedAt: now })
        .where(eq(agentWakeupRequests.id, run!.wakeupRequestId));
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure",
        recoveryState: "blocked", failureCode: "native_continuation_requires_reconciliation" });
      const hold = await issueRecoveryActionService(db).upsertSourceScoped({ companyId, sourceIssueId: issueId,
        kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: agentId, cause: "native_continuation_requires_reconciliation",
        fingerprint: `native-continuation:${runId}`, nextAction: "Continue from the last saved work.",
        evidence: { runId, originalFailureCode: TYPED, nativeFailureBlock: { runId, statusVersion: task!.statusVersion } } });
      const [record] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id));
      await settleUnrecoverableExecutions(db, record!.createdAt);
      return now;
    }

    it("K=2 typed continuations, then the bound: no third run (even past the hourly window)", async () => {
      await company();
      const f = await heldTypedMessage();
      await occupySlot();
      let source = f.runId;
      // The first failure is the message's own run; continue it, then fail each continuation the same typed way.
      await settleUnrecoverableExecutions(db, f.finishedAt);
      for (let attempt = 1; attempt <= FRESH_CONTINUATIONS_PER_CHAIN; attempt++) {
        await continueHeldExecutions(db);
        await deliver();
        const next = await successors(source);
        expect(next, `continuation ${attempt} is delivered`).toHaveLength(1);
        expect(next[0]!.contextSnapshot).toMatchObject({ wakeCommentIds: [f.messageId] });
        expect.soft(await currentSystemNotes(f.issueId), `no thread note while continuation ${attempt} is owed`).toHaveLength(0);
        source = next[0]!.id as typeof source;
        await failContinuation(source, f.issueId);
      }
      // B-2: the bound holds. Neither the held backlog nor delivery starts a third, even after #21394's hourly window.
      for (const at of [0, FRESH_CONTINUATION_WINDOW_MS + 60_000]) {
        await continueHeldExecutions(db, new Date(Date.now() + at));
        await deliver();
      }
      expect.soft(await successors(source), "the K=2 bound: no third continuation").toHaveLength(0);
    }, 60_000);
  });

  // Keep the reference so a missing export is a type error, not a silent skip.
  void sql;
});
