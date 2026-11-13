import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, authUsers, companyMemberships, createDb, heartbeatRuns, issueComments, issues, nativeRunFinalizations } from "@paperclipai/db";
import type { NativeRunIdentity, NativeSession, NativeSessionBackend, PrpEvent } from "@paperclipai/paperclip-runner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { heartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { closeIdleWarmNativeSessionsForRestart } from "../services/native-runtime/native-session-executor.js";
import { nativeRestartFixture, waitForCondition } from "./helpers/native-restart-fixture.js";
import { getRecoveryPostgresSupport } from "./helpers/recovery-postgres-fixture.js";

// Keep reason: a paid-provider refusal and a startup transport loss cannot be
// reached cheaply in a live flow. Everything except the provider boundary is real,
// including PostgreSQL, human-message admission, dispatch, finalization and reply.
const support = await getRecoveryPostgresSupport({});
const RETRY_REASON = "transient_start_wait";
const RETRY_NOTICE = "The provider is temporarily unavailable. Retrying automatically.";

function backend(db: ReturnType<typeof createDb>, startup: { failures: number; starts: number; turns: number; kind: "transport" | "overloaded" }):
  NonNullable<HeartbeatServiceOptions["nativeSessionBackendFactory"]> {
  return execution => {
    let identity: NativeRunIdentity;
    let sourceInstanceId = "";
    let turn = Promise.withResolvers<string>();
    const capabilities = { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
    const session: NativeSession = {
      identity: () => identity,
      capabilities: async () => capabilities,
      attachRun: async input => { identity = input.identity; },
      startTurn: async () => { startup.turns++; const turnId = randomUUID(); turn.resolve(turnId); return { turnId }; },
      async *events() {
        const turnId = await turn.promise;
        const event = (sourceSeq: number, eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent => ({
          schema: "paperclip.prp.event.v1", sourceKind: "runner", sourceInstanceId,
          sourceEventId: `${sourceInstanceId}:${identity.runId}:${sourceSeq}`, sourceSeq,
          runId: identity.runId, normalizedSessionId: identity.sessionId, turnId,
          schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), eventType, payload,
        });
        yield event(1, "turn.started", {});
        yield event(2, "item.completed", { kind: "agentMessage", channel: "final", text: "Answered your original message." });
        turn = Promise.withResolvers<string>();
        yield event(3, "turn.completed", { status: "completed" });
      },
      result: async () => null,
      snapshot: async () => ({ backendKind: "mock", sessionId: "transient-start-session", identity,
        providerSessionId: "transient-start-provider", cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }),
      close: async () => {},
    };
    const result: NativeSessionBackend = {
      descriptor: async () => {
        const [run] = await db.select({ runnerInstanceId: heartbeatRuns.runnerInstanceId }).from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, execution.binding.runId));
        if (!run?.runnerInstanceId) throw new Error("Native admission did not persist a runner identity");
        sourceInstanceId = run.runnerInstanceId;
        return { kind: "mock", name: "transient-start", version: "1", capabilities,
          runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } };
      },
      openSession: async input => {
        startup.starts++;
        if (startup.failures-- > 0) {
          if (startup.kind === "transport") throw new Error("runnerd transport closed during provider startup");
          throw Object.assign(new Error("PRP command session.open failed: provider unavailable"), { providerFailure: {
            schema: "paperclip.provider-failure.v1", provider: "codex", phase: "startup", category: "overloaded",
            message: "The provider is temporarily unavailable", httpStatus: 503, retryability: "transient" } });
        }
        identity = input.identity; return session;
      },
      recoverSession: async snapshot => { identity = snapshot.identity; return { recovered: true, session }; },
    };
    return result;
  };
}

describe.skipIf(!support.supported)("human-message transient start retries", () => {
  const fixture = nativeRestartFixture({});
  afterEach(() => { vi.useRealTimers(); });

  async function start(options: { leaseFailures?: number; startupFailures?: number; startupFailureKind?: "transport" | "overloaded"; unknown?: boolean; conversation?: boolean } = {}) {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 6 });
    const agentId = randomUUID(), userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Message owner", email: `${userId}@example.invalid`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reply agent", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true, enableNativeRunner: true });
    const runtime = environmentRuntimeService(db);
    const acquire = runtime.acquireRunLease.bind(runtime);
    let leaseCalls = 0;
    runtime.acquireRunLease = async input => {
      leaseCalls++;
      if (leaseCalls <= (options.leaseFailures ?? 0)) throw Object.assign(new Error("Boat: sandbox starts temporarily refused"),
        options.unknown ? { code: "BOAT_UNKNOWN_START_FAILURE" } : { status: 429 });
      return acquire(input);
    };
    const startup = { failures: options.startupFailures ?? 0, starts: 0, turns: 0, kind: options.startupFailureKind ?? "transport" as const };
    const heartbeat = heartbeatService(db, { environmentRuntime: runtime, nativeSessionBackendFactory: backend(db, startup) });
    const [issue] = await db.insert(issues).values({ companyId, title: "Answer the original message", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: userId,
      ...(options.conversation === false ? {} : { conversationAgentId: agentId,
        conversationUserId: userId, conversationState: "active" }) }).returning();
    const [message] = await db.insert(issueComments).values({ companyId, issueId: issue!.id,
      authorType: "user", authorUserId: userId, body: "Please answer here, without me pressing Retry." }).returning();
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: userId, manualUserWake: true,
      payload: { issueId: issue!.id, commentId: message!.id },
      contextSnapshot: { issueId: issue!.id, taskKey: issue!.id, wakeCommentId: message!.id } });
    if (!run) throw new Error("Human message was not admitted");
    await waitForCondition("first attempt settlement", () => heartbeat.getTaskDrainStatus().quiescent);
    const children = (id: string) => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, id)));
    const notices = () => db.select().from(issueComments).where(and(eq(issueComments.issueId, issue!.id), eq(issueComments.body, RETRY_NOTICE)));
    const read = async (id = run.id) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
    const cleanup = async () => { await heartbeat.drainActiveRunExecutions(); await closeIdleWarmNativeSessionsForRestart(); await db.$client.end(); };
    return { db, companyId, agentId, heartbeat, issue: issue!, message: message!, run, children, notices, read, cleanup,
      startup, leaseCalls: () => leaseCalls };
  }

  it("retries two Boat 429 start refusals and answers once in the SAME conversation, with one delayed persistent notice", async () => {
    const f = await start({ leaseFailures: 2 });
    try {
      expect(await f.read()).toMatchObject({ status: "failed", errorCode: "environment_provider_unavailable" });
      const [first] = await f.children(f.run.id);
      expect(first).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: RETRY_REASON, scheduledRetryAttempt: 1 });
      expect(first!.scheduledRetryAt!.getTime() - Date.now()).toBeGreaterThan(295_000);
      expect(first!.contextSnapshot?.executionRetryAccounting).toMatchObject({ failureRetries: 0 });
      expect(await f.notices()).toHaveLength(0);
      const began = Date.parse((first!.contextSnapshot!.transientStartWait as { firstFailureAt: string }).firstFailureAt);
      // Simulate the scheduler's clock, not the PostgreSQL lease clock.
      expect(await f.heartbeat.promoteDueScheduledRetries(new Date(began + 59_999))).toMatchObject({ promoted: 0 });
      expect(await f.notices()).toHaveLength(0);
      await Promise.all([f.heartbeat.promoteDueScheduledRetries(new Date(began + 60_000)),
        f.heartbeat.promoteDueScheduledRetries(new Date(began + 60_000))]);
      const notices = await f.notices();
      expect(notices).toHaveLength(1);
      expect(notices[0]!.presentation).toMatchObject({ kind: "system_notice" });
      expect(f.leaseCalls()).toBe(1);
      // The failure/recovery observer and scheduler race on the same source.
      await Promise.all([f.heartbeat.scheduleBoundedRetry(f.run.id), f.heartbeat.scheduleBoundedRetry(f.run.id)]);
      expect(await f.children(f.run.id)).toHaveLength(1);
      await Promise.all([f.heartbeat.promoteDueScheduledRetries(first!.scheduledRetryAt!),
        f.heartbeat.promoteDueScheduledRetries(first!.scheduledRetryAt!)]);
      await f.heartbeat.resumeQueuedRuns();
      await waitForCondition("second refusal", () => f.heartbeat.getTaskDrainStatus().quiescent);
      expect(f.leaseCalls()).toBe(2);
      const [second] = await f.children(first!.id);
      expect(second).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: RETRY_REASON, scheduledRetryAttempt: 2 });
      await f.heartbeat.promoteDueScheduledRetries(second!.scheduledRetryAt!);
      await f.heartbeat.resumeQueuedRuns();
      await waitForCondition("answer", async () => (await f.read(second!.id)).status === "succeeded");
      await waitForCondition("answer settlement", () => f.heartbeat.getTaskDrainStatus().quiescent);
      expect(f.leaseCalls()).toBe(3);
      expect(f.startup.turns).toBe(1);
      const comments = await f.db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id));
      expect(comments.filter(comment => comment.authorType === "user")).toEqual([expect.objectContaining({ id: f.message.id })]);
      expect(comments.filter(comment => comment.body.includes("Answered your original message."))).toHaveLength(1);
      expect(await f.notices()).toHaveLength(1);
    } finally { await f.cleanup(); }
  }, 90_000);

  it("never exhausts a proven transient START wait or increases paid-start frequency", async () => {
    const f = await start({ leaseFailures: 1 });
    try {
      const [retry] = await f.children(f.run.id);
      expect(retry?.scheduledRetryReason).toBe(RETRY_REASON);
      await f.db.update(heartbeatRuns).set({ status: "failed", errorCode: "environment_provider_unavailable",
        scheduledRetryAttempt: 64, finishedAt: new Date(),
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, providerFailure: {
          schema: "paperclip.provider-failure.v1", provider: "sandbox", phase: "startup", category: "rate_limit",
          message: "Start refused", httpStatus: 429, retryability: "transient" } },
        contextSnapshot: { ...retry!.contextSnapshot, executionRetryAccounting: { version: 1, failureRetries: 0, maxTurnContinuations: 0, transientStarts: 64 } },
      }).where(eq(heartbeatRuns.id, retry!.id));
      const result = await f.heartbeat.scheduleBoundedRetry(retry!.id);
      expect(result).toMatchObject({ outcome: "scheduled", run: { scheduledRetryAttempt: 65 } });
      if (result.outcome !== "scheduled") throw new Error("Start wait was exhausted");
      expect(result.dueAt.getTime() - Date.now()).toBeGreaterThan(295_000);
      expect(result.run!.contextSnapshot?.executionRetryAccounting).toMatchObject({ failureRetries: 0, transientStarts: 65 });
    } finally { await f.cleanup(); }
  }, 90_000);

  it.each(["blocked", "done", "reassigned", "live_owner"] as const)("does not use a START wait to override task admission: %s", async refusal => {
    const f = await start({ leaseFailures: 1, conversation: false });
    const ownerId = randomUUID();
    try {
      const [retry] = await f.children(f.run.id);
      expect(retry?.scheduledRetryReason).toBe(RETRY_REASON);
      if (refusal === "live_owner") await f.db.insert(heartbeatRuns).values({ id: ownerId, companyId: f.companyId,
        agentId: f.agentId, scopeKind: "issue", issueId: f.issue.id, status: "running", invocationSource: "automation" });
      await f.db.update(issues).set(refusal === "reassigned" ? { assigneeAgentId: null }
        : refusal === "live_owner" ? { executionRunId: ownerId } : { status: refusal })
        .where(eq(issues.id, f.issue.id));
      await f.heartbeat.promoteDueScheduledRetries(retry!.scheduledRetryAt!);
      expect((await f.read(retry!.id)).status).not.toBe("queued");
      expect(f.leaseCalls()).toBe(1);
      expect(f.startup.turns).toBe(0);
    } finally {
      if (refusal === "live_owner") await f.db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, ownerId));
      await f.cleanup();
    }
  }, 90_000);

  it("does NOT retry an unknown lease failure", async () => {
    const f = await start({ leaseFailures: 1, unknown: true });
    try {
      expect(await f.read()).toMatchObject({ status: "failed", errorCode: "setup_failed" });
      expect(await f.children(f.run.id)).toHaveLength(0);
      expect(f.leaseCalls()).toBe(1);
      expect(f.startup.turns).toBe(0);
    } finally { await f.cleanup(); }
  }, 90_000);

  it.each(["transport", "overloaded"] as const)("retries %s-at-startup on the same native run and never resubmits a tool or comment", async kind => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const f = await start({ startupFailures: 4, startupFailureKind: kind });
    try {
      for (let attempt = 1; attempt <= 4; attempt++) {
        const [coordinator] = await f.db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id));
        expect(coordinator).toMatchObject({ phase: "retryable_failure", attempt, failureDetail: {
          originalFailureCode: kind === "transport" ? "provider_startup_transport_closed" : "provider_startup_unavailable",
          recoveryMode: "bootstrap_retry" } });
        expect(coordinator!.nextAttemptAt).toBeInstanceOf(Date);
        expect(coordinator!.nextAttemptAt!.getTime() - Date.now()).toBeGreaterThanOrEqual(300_000);
        expect(f.startup.turns).toBe(0);
        if (attempt === 1) {
          vi.setSystemTime(Date.now() + 60_000);
          await Promise.all([f.heartbeat.promoteDueScheduledRetries(), f.heartbeat.promoteDueScheduledRetries()]);
          expect(await f.notices()).toHaveLength(1);
        }
        vi.setSystemTime(coordinator!.nextAttemptAt!);
        await f.heartbeat.reapOrphanedRuns();
        await waitForCondition("same-run retry settlement", () => f.heartbeat.getTaskDrainStatus().quiescent);
      }
      await waitForCondition("same-run answer", async () => (await f.read()).status === "succeeded");
      expect(await f.children(f.run.id)).toHaveLength(0);
      expect(f.startup.starts).toBe(5);
      expect(await f.notices()).toHaveLength(1);
      expect(f.startup.turns).toBe(1);
      const replies = await f.db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id));
      expect(replies.filter(comment => comment.body.includes("Answered your original message."))).toHaveLength(1);
    } finally { await f.cleanup(); }
  }, 90_000);
});
