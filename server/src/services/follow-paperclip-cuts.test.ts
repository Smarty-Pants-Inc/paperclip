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
import { settleUnansweredPersonMessagesForTask, UNANSWERED_MESSAGE_SETTLE_MS } from "./recovery/unanswered-person-message.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
// A typed fresh-thread refusal (runner-reconciliation-refusal.ts FRESH_THREAD_REFUSAL_CODES).
const TYPED = "runner_remote_state_unavailable";
// B-2 (proposed for RFL's ruling): the ONE bound is the fork's K=2 chain cap; this is the text the person
// sees when it is reached. Factual, keeps the input, names the person's next step; no permanent refusal.
const BOUND_REACHED_TEXT = "Paperclip tried to continue this task twice from its saved work, and both attempts failed. "
  + "Your message and the saved work are kept. Press Retry or send a new message to try again.";

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
  // The obsolete-lease path after Cut A is upstream's guarded destroy (environment-runtime destroyReusableSandboxLease).
  // A typed destroyed receipt is recorded on the old lease; a failed or void destroy records none and strips the old
  // stop receipt (environments.ts releaseLease). Either way the person's held message is still answered: continued
  // within upstream's bound and delivered once, carrying the message (RFL A-5: A and B ship together).
  describe("A-5: follow-up acquisition with boot-source drift destroys the obsolete source; the held message is still answered", () => {
    async function driftedReusableSource(f: Awaited<ReturnType<typeof heldTypedMessage>>) {
      const environmentId = randomUUID(), pluginId = randomUUID(), leaseId = randomUUID();
      const [environment] = await db.insert(environments).values({ id: environmentId, name: `Boat ${environmentId.slice(0, 8)}`, driver: "sandbox", status: "active",
        config: { provider: "boat", image: "boot-source-before-upgrade", reuseLease: true } }).returning();
      await db.insert(plugins).values({ id: pluginId, pluginKey: "paperclip.boat", packageName: "@paperclipai/plugin-boat",
        version: "1.0.0", apiVersion: 1, status: "ready", categories: ["automation"],
        manifestJson: { id: "paperclip.boat", apiVersion: 1, version: "1.0.0", displayName: "Boat", description: "Boat peer", author: "Paperclip",
          categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
          environmentDrivers: [{ driverKey: "boat", kind: "sandbox_provider", displayName: "Boat", supportsReusableLeases: true,
            configSchema: { type: "object" } }] } } as never);
      const releasedAt = new Date(f.finishedAt.getTime() - 1_000);
      const binding = { companyId, runId: f.runId, leaseId, provider: "boat", providerLeaseId: `bx-old-${leaseId.slice(0, 8)}`,
        confirmedAt: releasedAt.toISOString() };
      await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, issueId: f.issueId, heartbeatRunId: f.runId,
        provider: "boat", providerLeaseId: binding.providerLeaseId, leasePolicy: "reuse_by_environment", status: "released",
        cleanupStatus: "success", acquiredAt: new Date(f.finishedAt.getTime() - 10 * 60_000), releasedAt,
        metadata: { driver: "sandbox", sandboxProviderPlugin: true, pluginId, pluginKey: "paperclip.boat", agentId, ...environment!.config,
          pendingCleanupInFlight: false, remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", state: "stopped", ...binding } } });
      // The next image changes the boot source.
      const drifted = { ...environment!.config, image: "boot-source-after-upgrade" };
      await db.update(environments).set({ config: drifted }).where(eq(environments.id, environmentId));
      return { environment: { ...environment!, config: drifted, envVars: {} } as unknown as Environment, pluginId, leaseId,
        providerLeaseId: binding.providerLeaseId };
    }

    it.each(["destroyed", "failed", "void"] as const)("%s destroy", async variant => {
      await company();
      const f = await heldTypedMessage();
      expect(isFreshThreadRefusal({ errorCode: TYPED })).toBe(true);
      const source = await driftedReusableSource(f);
      // A different task's run on the same environment acquires after the image change.
      const [otherIssue] = await db.insert(issues).values({ companyId, title: "Another task", status: "in_progress", assigneeAgentId: agentId }).returning();
      const [followUp] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: otherIssue!.id, nativeIssueId: otherIssue!.id,
        runtimeMode: "native", status: "running", contextSnapshot: { issueId: otherIssue!.id } }).returning();
      const call = vi.fn(async (_id: string, method: string, params: Record<string, unknown>) => {
        if (method === "environmentAcquireLease") return { providerLeaseId: "bx-fresh", metadata: { ...source.environment.config, remoteCwd: "/workspace" } };
        if (method === "environmentDestroyLease") {
          if (variant === "failed") throw new Error("boat destroy timed out");
          return variant === "void" ? undefined : { providerLeaseId: params.providerLeaseId, state: "destroyed" };
        }
        throw new Error(`unexpected provider call ${method}`);
      });
      const runtime = environmentRuntimeService(db, { pluginWorkerManager: { isRunning: () => true, call,
        getWorker: () => ({ supportedMethods: ["environmentAcquireLease", "environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease", "environmentStopLease"] }),
      } as unknown as PluginWorkerManager });
      const acquired = await runtime.acquireRunLease({ companyId, environment: source.environment, issueId: otherIssue!.id, agentId,
        heartbeatRunId: followUp!.id, adapterType: "paperclip_runner", persistedExecutionWorkspace: null } as never);
      expect(acquired.lease.providerLeaseId).toBe("bx-fresh");

      // Cut A: upstream's obsolete-lease destroy ran for the drifted source (no stop-only intent, no skip).
      expect.soft(call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")
        .map(([, , params]) => params.providerLeaseId), "the drifted source is destroyed through upstream's guarded path").toEqual([source.providerLeaseId]);
      expect.soft(call.mock.calls.some(([, method]) => method === "environmentStopLease"), "no acquisition-issued stop").toBe(false);
      const [old] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, source.leaseId));
      if (variant === "destroyed") {
        expect.soft(old).toMatchObject({ status: "expired", cleanupStatus: "success",
          metadata: { remoteExecutionTermination: { state: "destroyed", leaseId: source.leaseId, runId: f.runId, providerLeaseId: source.providerLeaseId } } });
        expect.soft(hasRemoteTerminationReceipt(old!)).toBe(true);
      } else {
        expect.soft(old!.metadata?.remoteExecutionTermination, "a failed or void destroy is no termination receipt").toBeUndefined();
        expect.soft(old!.status).toBe(variant === "failed" ? "pending_cleanup" : "expired");
      }

      // The person's message is still answered: continued within upstream's bound, delivered exactly once.
      let result: Awaited<ReturnType<typeof ensureFreshContinuation>> | null = null;
      for (const at of [0, FRESH_CONTINUATION_PENDING_BOUND_MS + 60_000]) {
        result = await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery", now: new Date(Date.now() + at) });
        if (result.kind === "continued") break;
      }
      expect(result, "continued within ~10 min (upstream's bound), never held forever").toMatchObject({ kind: "continued" });
      await occupySlot();
      await deliver();
      const next = await successors(f.runId);
      expect(next).toHaveLength(1);
      expect(next[0]!.contextSnapshot).toMatchObject({ issueId: f.issueId, previousRunId: f.runId, forceFreshSession: true,
        wakeCommentIds: [f.messageId] });
    }, 60_000);
  });

  // ---------------------------------------------------------------- B-5 + B-2
  // The kept held-notice writer returns early for the typed family (native-session-executor.ts noticeHeldUnfinishedPredecessor,
  // `if (freshThreadRefusalCode(error)) return`). After Cut B the typed family is an ordinary failure: the fallback continues it
  // (its user text is the recovery action's nextAction, no thread comment), and the ONE thread note owner is the unanswered-message
  // sweep (recovery/unanswered-person-message.ts). B-2: the ONE bound is the K=2 chain cap; #21394's hourly window does not
  // re-open it.
  describe("B-5 / B-2: a typed chain that reaches the one bound gets exactly one note, from the unanswered-message sweep", () => {
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

    it("K=2 typed continuations, then the bound: no third run (even past the hourly window), one note within the settle time", async () => {
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
        await settleUnansweredPersonMessagesForTask(db, { companyId, issueId: f.issueId, now: new Date(Date.now() + 30_000) });
        expect.soft(await currentSystemNotes(f.issueId), `no thread note while continuation ${attempt} is owed`).toHaveLength(0);
        source = next[0]!.id;
        await failContinuation(source, f.issueId);
      }
      const endedAt = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source)))[0]!.finishedAt!;
      // B-2: the bound holds. Neither the held backlog nor delivery starts a third, even after #21394's hourly window.
      for (const at of [0, FRESH_CONTINUATION_WINDOW_MS + 60_000]) {
        await continueHeldExecutions(db, new Date(Date.now() + at));
        await deliver();
      }
      expect.soft(await successors(source), "the K=2 bound: no third continuation").toHaveLength(0);
      // B-5: the one note, from the unanswered-message sweep, within its settle time after the last run ended.
      const acceptance = endedAt.getTime() + UNANSWERED_MESSAGE_SETTLE_MS + 1_000;
      await settleUnansweredPersonMessagesForTask(db, { companyId, issueId: f.issueId, now: new Date(acceptance) });
      await settleUnansweredPersonMessagesForTask(db, { companyId, issueId: f.issueId, now: new Date(acceptance + 60_000) });
      const notes = await currentSystemNotes(f.issueId);
      expect(notes, `exactly one note, posted by ${UNANSWERED_MESSAGE_SETTLE_MS / 1000 + 1} s after the last run ended`).toHaveLength(1);
      expect(notes[0]!.metadata).toMatchObject({ authorizationReason: `unanswered_message:${f.messageId}` });
      expect(notes[0]!.body).toBe(BOUND_REACHED_TEXT);
      expect(notes[0]!.createdAt.getTime() - endedAt.getTime()).toBeLessThan(UNANSWERED_MESSAGE_SETTLE_MS + 60_000);
    }, 60_000);
  });

  // Keep the reference so a missing export is a type error, not a silent skip.
  void sql;
});
