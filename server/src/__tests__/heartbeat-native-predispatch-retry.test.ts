import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { activityLog, agents, agentWakeupRequests, authUsers, companyMemberships, createDb, environmentLeases, environments, heartbeatRuns, heartbeatRunEvents, nativeRunFinalizations, issueComments,
  issueRecoveryActions, issueRelations, issues } from "@paperclipai/db";
import { NativePredecessorRetirementUnprovenError } from "../services/native-runtime/predecessor-retirement.js";
import { NativeProviderArtifactTransferTimeoutError } from "../services/native-runtime/native-provider-artifacts.js";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.js";
import type { NativeRunIdentity, NativeSession, NativeSessionBackend, PrpEvent } from "@paperclipai/paperclip-runner";
import type { ExecutionContinuationEnvelope } from "@paperclipai/shared";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import { heartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { environmentService } from "../services/environments.js";
import { closeIdleWarmNativeSessionsForRestart, scopedRunnerdStateRoot } from "../services/native-runtime/native-session-executor.js";
import { nativeRestartFixture, waitForCondition } from "./helpers/native-restart-fixture.js";
import { getRecoveryPostgresSupport } from "./helpers/recovery-postgres-fixture.js";

// Budget admission is the last database write before the dispatch gate enters
// the native executor. Exhausted serialization retries there fail the run with
// no provider work started.
const admissionFaults = vi.hoisted(() => ({ remaining: 0,
  beforeReserve: undefined as ((runId: string) => Promise<void>) | undefined }));
vi.mock("../services/budget-reservations.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/budget-reservations.js")>();
  const { AccountingContentionError } = await import("../services/accounting-transaction.js");
  return {
    ...actual,
    reserveRunBudget: async (...args: Parameters<typeof actual.reserveRunBudget>) => {
      if (admissionFaults.remaining > 0) {
        admissionFaults.remaining -= 1;
        throw new AccountingContentionError(Object.assign(new Error("could not serialize access due to concurrent update"),
          { name: "PostgresError", code: "40001" }), 4);
      }
      await admissionFaults.beforeReserve?.(args[2]);
      return actual.reserveRunBudget(...args);
    },
  };
});

const firstTurnGate = vi.hoisted(() => ({ afterAdmission: undefined as (() => Promise<void>) | undefined }));
vi.mock("../services/native-runtime/first-turn-queued-input.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/first-turn-queued-input.js")>();
  return { ...actual, claimFirstTurnQueuedInput: async (...args: Parameters<typeof actual.claimFirstTurnQueuedInput>) => {
    await firstTurnGate.afterAdmission?.();
    return actual.claimFirstTurnQueuedInput(...args);
  } };
});

const support = await getRecoveryPostgresSupport({});

type AdmissionFailure = { remaining: number; turnNeverIssued: boolean; environmentId: string; provider: string;
  providerLeaseId: string; leasePolicy: "reuse_by_environment" | "reuse_by_execution_workspace"; failedRuns: string[];
  sessionRoots: string[] };

function nativeBackend(db: ReturnType<typeof createDb>, options: { failDescriptorOnce?: { failed: boolean };
  unretiredPredecessorOnce?: { failed: boolean; environmentId: string; taskBlocked?: boolean; repeat?: string[] }; turnMessages?: Map<string, string>;
  admissionFailure?: AdmissionFailure; beforeAttach?: (runId: string) => Promise<void>; turnSubmissions?: string[];
  liveTurn?: { runId: string; interrupted: boolean; submissions: number; end: ReturnType<typeof Promise.withResolvers<void>> } } = {}):
  NonNullable<HeartbeatServiceOptions["nativeSessionBackendFactory"]> {
  return execution => {
    let identity: NativeRunIdentity;
    let sourceInstanceId = "", activeTurnId: string | null = null;
    let turn = Promise.withResolvers<string>();
    const capabilities = { resume: true, typedEvents: true, steering: Boolean(options.liveTurn), interruption: true, structuredResult: true };
    const session: NativeSession = {
      identity: () => identity,
      capabilities: async () => capabilities,
      attachRun: async input => { identity = input.identity; await options.beforeAttach?.(identity.runId); },
      steer: async () => {},
      interrupt: async () => { if (options.liveTurn?.runId === identity.runId) {
        options.liveTurn.interrupted = true; options.liveTurn.end.resolve();
      } },
      startTurn: async input => {
        options.turnSubmissions?.push(identity.runId);
        options.turnMessages?.set(identity.runId, JSON.stringify(input.message));
        if (options.liveTurn?.runId === identity.runId) options.liveTurn.submissions += 1;
        const turnId = randomUUID();
        activeTurnId = turnId;
        turn.resolve(turnId);
        return { turnId };
      },
      async *events() {
        const turnId = await turn.promise;
        const event = (sourceSeq: number, eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent => ({
          schema: "paperclip.prp.event.v1", sourceKind: "runner", sourceInstanceId,
          sourceEventId: `${sourceInstanceId}:${identity.runId}:${sourceSeq}`, sourceSeq,
          runId: identity.runId, normalizedSessionId: identity.sessionId, turnId,
          schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), eventType, payload,
        });
        yield event(1, "turn.started", {});
        if (options.liveTurn?.runId === identity.runId) {
          await options.liveTurn.end.promise;
          activeTurnId = null;
          // Pi's person interrupt saves its short final and completes the PRP turn.
          yield event(2, "item.completed", { kind: "agentMessage", channel: "final", text: "Stopped." });
          turn = Promise.withResolvers<string>();
          yield event(3, "turn.completed", { status: "completed" });
          return;
        }
        yield event(2, "item.completed", { kind: "agentMessage", channel: "final", text: "Done." });
        activeTurnId = null;
        turn = Promise.withResolvers<string>();
        yield event(3, "turn.completed", { status: "completed" });
      },
      result: async () => null,
      snapshot: async () => ({ backendKind: "mock", sessionId: "predispatch-session", identity,
        providerSessionId: "predispatch-provider-session", cursor: null, activeTurnId, pendingRuntimeRequests: [], lineage: [] }),
      close: async () => {},
    };
    const backend: NativeSessionBackend = {
      descriptor: async () => {
        if (options.failDescriptorOnce && !options.failDescriptorOnce.failed) {
          options.failDescriptorOnce.failed = true;
          throw Object.assign(new Error("could not serialize access due to concurrent update"), { name: "PostgresError", code: "40001" });
        }
        const unretired = options.unretiredPredecessorOnce;
        if (unretired && (!unretired.failed || unretired.repeat)) {
          unretired.repeat?.push(execution.binding.runId);
          // Staging: this run resumed the task's reused sandbox, where
          // the previous run's warm Runner could not be retired before any
          // provider work. The executor reports that after its coordinator claim.
          unretired.failed = true;
          if (unretired.taskBlocked) await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, execution.binding.issueId));
          const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, execution.binding.runId));
          await db.insert(environmentLeases).values({ companyId: run!.companyId, environmentId: unretired.environmentId,
            issueId: execution.binding.issueId, heartbeatRunId: run!.id, provider: "daytona", providerLeaseId: "sandbox-reused",
            leasePolicy: "reuse_by_environment", status: "active", metadata: { remoteCwd: "/workspace" } });
          throw new NativePredecessorRetirementUnprovenError("previous-run", "sandbox-reused",
            new Error("Controller journal drain timed out; preserve the session before replacing its writer."));
        }
        const [run] = await db.select({ runnerInstanceId: heartbeatRuns.runnerInstanceId }).from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, execution.binding.runId));
        if (!run?.runnerInstanceId) throw new Error("Normal native admission did not persist a runner identity");
        sourceInstanceId = run.runnerInstanceId;
        return { kind: "mock", name: "native-predispatch-retry", version: "1", capabilities,
          runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } };
      },
      openSession: async input => { identity = input.identity; await options.beforeAttach?.(identity.runId); return session; },
      recoverSession: async snapshot => { identity = snapshot.identity; await options.beforeAttach?.(identity.runId); return { recovered: true, session }; },
    };
    const failure = options.admissionFailure;
    if (!failure) return backend;
    return Object.assign(backend, {
      providerTurnNeverIssued: () => failure.turnNeverIssued,
      providerAdmissionPersisted: async () => {
        if (failure.remaining <= 0) return;
        failure.remaining -= 1;
        const runId = execution.binding.runId;
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        await db.insert(environmentLeases).values({ companyId: run!.companyId, environmentId: failure.environmentId,
          issueId: execution.binding.issueId, heartbeatRunId: runId, provider: failure.provider,
          providerLeaseId: `${failure.providerLeaseId}-${failure.failedRuns.length}`, leasePolicy: failure.leasePolicy,
          status: "active", metadata: { remoteCwd: "/workspace" } });
        failure.failedRuns.push(runId);
        const root = scopedRunnerdStateRoot(execution);
        mkdirSync(root, { recursive: true, mode: 0o700 });
        writeFileSync(join(root, "failed-attempt"), runId);
        failure.sessionRoots.push(root);
        throw new NativeProviderArtifactTransferTimeoutError("upload", 120_000, 512 * 1024 * 1024);
      },
    });
  };
}

describe.skipIf(!support.supported)("heartbeat native pre-dispatch failure retry", () => {
  const fixture = nativeRestartFixture({});

  async function startTask(db: ReturnType<typeof createDb>, heartbeat: ReturnType<typeof heartbeatService>,
    status: "in_progress" | "blocked" = "in_progress", provider: "codex" | "pi_rpc" = "codex") {
    const { companyId, agentId } = fixture.current;
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Task owner", email: `${userId}@example.invalid`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
    await db.update(agents).set({ status: "idle", adapterConfig: { provider } }).where(eq(agents.id, agentId));
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true, enableNativeRunner: true });
    const [issue] = await db.insert(issues).values({ companyId, title: "Survive a database fault", status,
      assigneeAgentId: agentId, responsibleUserId: userId, conversationAgentId: agentId, conversationUserId: userId,
      conversationState: "active" }).returning();
    if (status === "blocked") {
      const [blocker] = await db.insert(issues).values({ companyId, title: "Open subtask", status: "todo" }).returning();
      await db.insert(issueRelations).values({ companyId, issueId: blocker!.id, relatedIssueId: issue!.id, type: "blocks" });
    }
    const [message] = await db.insert(issueComments).values({ companyId, issueId: issue!.id,
      authorType: "user", authorUserId: userId, body: "Start." }).returning();
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      requestedByActorType: "user", requestedByActorId: userId, manualUserWake: true,
      payload: { issueId: issue!.id, commentId: message!.id },
      contextSnapshot: { issueId: issue!.id, taskKey: issue!.id, wakeCommentId: message!.id } });
    expect(run).not.toBeNull();
    await waitForCondition("the first run to settle", () => heartbeat.getTaskDrainStatus().quiescent);
    return { issueId: issue!.id, runId: run!.id, userId };
  }

  it.each(["local", "borrowed", "staged"] as const)("warm Pi session survives Stop before dispatch and answers two later messages in the same session (%s)", async mode => {
    const { companyId, agentId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const messages = new Map<string, string>();
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db, { turnMessages: messages }) });
    const gate = Promise.withResolvers<void>();
    let entered = false;
    try {
      const { issueId, runId, userId } = await startTask(db, heartbeat, "in_progress", "pi_rpc");
      const good = (await heartbeat.getRun(runId))!;
      expect(good.status).toBe("succeeded");
      expect(good.nativeSessionId).toEqual(expect.any(String));
      const send = async (body: string) => {
        const [comment] = await db.insert(issueComments).values({ companyId, issueId,
          authorType: "user", authorUserId: userId, body }).returning();
        return heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
          requestedByActorType: "user", requestedByActorId: userId, manualUserWake: true,
          payload: { issueId, commentId: comment!.id },
          contextSnapshot: { issueId, taskKey: issueId, wakeCommentId: comment!.id } });
      };
      const svc = environmentService(db);
      let borrowed: typeof environmentLeases.$inferSelect | undefined;
      const acquiredRuns = new Map<string, string>();
      const providerLeaseId = `warm-box-${runId}`;
      if (mode !== "local") {
        const [environment] = await db.insert(environments).values({ name: `warm-${runId}`, driver: "sandbox" }).returning();
        const metadata = { agentId, savedSessionId: good.nativeSessionId,
          reusableSandboxLease: { adapterType: "paperclip_runner" } };
        borrowed = await svc.acquireLease({ companyId, environmentId: environment!.id, heartbeatRunId: runId, issueId,
          provider: "daytona", providerLeaseId, leasePolicy: "reuse_by_environment", metadata });
        await svc.releaseLease(borrowed.id, "retained", { cleanupStatus: "success" });
      }
      const acquire = async (nextRunId: string) => {
        if (!borrowed) return;
        borrowed = await svc.acquireLease({ companyId, environmentId: borrowed.environmentId!, heartbeatRunId: nextRunId,
          issueId, provider: "daytona", providerLeaseId, leasePolicy: "reuse_by_environment",
          metadata: { agentId, savedSessionId: good.nativeSessionId, reusableSandboxLease: { adapterType: "paperclip_runner" } },
          replacesReusableLeaseId: borrowed.id });
        borrowed = await svc.acquireLease({ companyId, environmentId: borrowed.environmentId!, heartbeatRunId: nextRunId,
          issueId, provider: "daytona", providerLeaseId, leasePolicy: "reuse_by_environment",
          metadata: borrowed.metadata, reusesReusableLeaseId: borrowed.id });
        acquiredRuns.set(nextRunId, borrowed.id);
      };
      admissionFaults.beforeReserve = async nextRunId => {
        await acquire(nextRunId);
        if (mode === "staged") {
          // Full staged inherited profile, with no committed recovery-v1 metadata.
          const profile = { ...good.runnerProfileJson };
          delete profile.nativeControllerRecovery;
          const checkpoint = profile.sessionCheckpoint as Record<string, unknown>;
          profile.sessionCheckpoint = { ...checkpoint, identity: { ...(checkpoint.identity as Record<string, unknown>), runId: nextRunId } };
          await db.update(heartbeatRuns).set({ runnerProfileJson: profile }).where(eq(heartbeatRuns.id, nextRunId));
        }
        entered = true; await gate.promise;
      };
      const stopped = await send("Accidental submission; Stop before start");
      expect(stopped).not.toBeNull();
      await waitForCondition("pre-dispatch admission gate", () => entered);
      await heartbeat.cancelRun(stopped!.id, "Person Stop", {
        resultJson: { cancelledByActorType: "user", cancelledByUserId: userId } });
      admissionFaults.beforeReserve = undefined;
      gate.resolve();
      await waitForCondition("Stop preparation settlement", () => heartbeat.getTaskDrainStatus().quiescent);
      const cancelled = (await heartbeat.getRun(stopped!.id))!;
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.resultJson?.preDispatchCancellationSettledAt).toEqual(expect.any(String));
      expect(messages.has(stopped!.id)).toBe(false);
      if (borrowed) {
        expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, borrowed.id)))[0])
          .toMatchObject({ status: "released", cleanupStatus: "success", providerLeaseId,
            metadata: { savedSessionId: good.nativeSessionId } });
        const holds = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
        expect(holds.filter(hold => hold.evidence?.runId === stopped!.id), JSON.stringify(holds)).toEqual([
          expect.objectContaining({ status: "resolved", outcome: "cancelled", resolutionNote: "stopped before dispatch" }),
        ]);
      }
      admissionFaults.beforeReserve = acquire;
      for (const body of ["First follow-up", "Second follow-up"]) {
        const next = await send(body);
        expect(next).not.toBeNull();
        await waitForCondition("follow-up settlement", () => heartbeat.getTaskDrainStatus().quiescent);
        const answered = (await heartbeat.getRun(next!.id))!;
        expect(answered.status, JSON.stringify(answered.resultJson)).toBe("succeeded");
        expect(answered.nativeSessionId).toBe(good.nativeSessionId);
        expect(messages.get(next!.id)).toContain(body);
        if (borrowed) {
          expect(acquiredRuns.has(next!.id)).toBe(true);
          expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, acquiredRuns.get(next!.id)!)))[0])
            .toMatchObject({ providerLeaseId, metadata: { savedSessionId: good.nativeSessionId } });
          await svc.releaseLease(borrowed.id, "retained", { cleanupStatus: "success" });
        }
      }
      const all = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, issueId));
      expect(all.filter(run => run.status === "succeeded")).toHaveLength(3);
      expect(all.some(run => run.error?.includes("metadata_format"))).toBe(false);
      expect(all.some(run => run.status === "scheduled_retry")).toBe(false);
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments.filter(comment => comment.body === "Done.")).toHaveLength(3);
      expect(comments.some(comment => comment.body === "New session")).toBe(false);
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status).not.toBe("blocked");
      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 0 });
      if (process.env.CS_STOP_EVIDENCE_DIR) writeFileSync(join(process.env.CS_STOP_EVIDENCE_DIR, `warm-stop-${mode}.json`),
        JSON.stringify({ mode, seedRunId: runId, stoppedRunId: stopped!.id, sessionId: good.nativeSessionId, providerLeaseId,
          runs: all.map(row => ({ id: row.id, status: row.status, nativeSessionId: row.nativeSessionId,
            errorCode: row.errorCode, profileKeys: Object.keys(row.runnerProfileJson ?? {}),
            recoverySchema: (row.runnerProfileJson?.nativeControllerRecovery as Record<string, unknown> | undefined)?.schema ?? null })),
          acquiredRuns: [...acquiredRuns], replies: comments.filter(comment => comment.body === "Done.").map(comment => comment.body),
          leases: (await db.select().from(environmentLeases).where(eq(environmentLeases.issueId, issueId)))
            .filter(row => row.provider === "daytona").map(row => ({ id: row.id, heartbeatRunId: row.heartbeatRunId,
              providerLeaseId: row.providerLeaseId, status: row.status, cleanupStatus: row.cleanupStatus })),
          recovery: await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId)),
        }, null, 2));
    } finally {
      admissionFaults.beforeReserve = undefined; gate.resolve();
      await heartbeat.drainActiveRunExecutions(); await closeIdleWarmNativeSessionsForRestart(); await db.$client.end();
    }
  }, 90_000);

  // 0427: a real PG row on either side of firstTurnDispatchCommitted's transaction.
  it.each(["before_admission", "person_before_admission", "held_before_admission", "postpress_before_release", "after_admission", "after_submitted"] as const)("honors a person's Stop %s and continues the same Pi session", async boundary => {
    const { companyId, agentId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 8 });
    const submissions: string[] = [];
    const messages = new Map<string, string>(), gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const liveTurn = { runId: "", interrupted: false, submissions: 0, end: Promise.withResolvers<void>() };
    let pauseAttach = false, stop: Promise<request.Response> | undefined;
    let delivery: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
    const deliveryErrors: unknown[] = [];
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db, {
      turnMessages: messages, turnSubmissions: submissions, liveTurn,
      beforeAttach: async () => { if (pauseAttach) { entered.resolve(); await gate.promise; } },
    }) });
    try {
      const { issueId, runId: seedRunId, userId } = await startTask(db, heartbeat, "in_progress", "pi_rpc");
      if (boundary === "postpress_before_release") {
        delivery = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { deliveryErrors.push(error); } });
        await heartbeat.registerDeferredReceiptWork(delivery, () => true).ready;
      }
      const good = (await heartbeat.getRun(seedRunId))!;
      expect(good.status).toBe("succeeded");
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId, companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "admin", status: "active" }], isInstanceAdmin: false }; next(); });
      app.use("/api", agentRoutes(db, {}));
      const unusedStorage = async () => { throw new Error("Stop restoration must not access object storage"); };
      app.use("/api", issueRoutes(db, { provider: "local_disk", putFile: unusedStorage,
        getObject: unusedStorage, headObject: unusedStorage, deleteObject: unusedStorage }));
      app.use(errorHandler);
      const send = async (body: string) => {
        const [comment] = await db.insert(issueComments).values({ companyId, issueId, authorType: "user", authorUserId: userId, body }).returning();
        const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
          requestedByActorType: "user", requestedByActorId: userId, manualUserWake: true,
          payload: { issueId, commentId: comment!.id }, contextSnapshot: { issueId, taskKey: issueId, wakeCommentId: comment!.id } });
        return { run: run!, comment: comment! };
      };
      const dispatched = boundary === "after_admission" || boundary === "after_submitted";
      if (dispatched) firstTurnGate.afterAdmission = async () => { entered.resolve(); await gate.promise; };
      else pauseAttach = true;
      const { run: stopped, comment: m1 } = await send("M1 accidental input 0427");
      liveTurn.runId = dispatched ? stopped.id : "";
      await Promise.race([entered.promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("First-turn gate did not open")), 10_000).unref())]);
      const before = (await heartbeat.getRun(stopped.id))!;
      const eventsBefore = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, stopped.id));
      expect(eventsBefore.some(event => event.eventType === "native.process_start_requested")).toBe(true);
      expect(messages.has(stopped.id)).toBe(false);
      expect(Boolean(before.resultJson?.firstTurnDispatchCommitted)).toBe(dispatched);
      if (boundary === "after_submitted") {
        firstTurnGate.afterAdmission = undefined; gate.resolve();
        await waitForCondition("Pi turn submitted", () => messages.has(stopped.id));
      }
      if (boundary === "held_before_admission" || boundary === "person_before_admission") {
        // Exercise admission itself, without a route-written startup fence.
        const pressedAt = new Date().toISOString();
        await db.update(heartbeatRuns).set({ resultJson: { ...before.resultJson,
          ...(boundary === "held_before_admission" ? { personStopHeld: { pressedAt, userId } }
            : { personStop: { requestedAt: pressedAt, userId } }) } }).where(eq(heartbeatRuns.id, stopped.id));
      } else {
        stop = request(app).post(`/api/heartbeat-runs/${stopped.id}/cancel`).send({}).then(response => response);
        await waitForCondition("Stop to commit before releasing first-turn gate", async () => {
          const current = (await heartbeat.getRun(stopped.id))!;
          return boundary === "after_admission" ? Boolean(current.resultJson?.personStopHeld)
            : boundary === "after_submitted" ? Boolean(current.resultJson?.personStop) : Boolean(current.resultJson?.startupCancellation);
        });
      }
      // M2 arrives after the press but BEFORE the blocked runtime unwinds.
      // The page acknowledges M1's return while that gate still owns startup.
      let pendingM2: Awaited<ReturnType<typeof send>> | undefined;
      if (boundary === "postpress_before_release") {
        expect((await request(app).delete(`/api/issues/${issueId}/comments/${m1.id}`).send({})).status).toBe(200);
        pendingM2 = await send("M2 corrected request 0427 during Stop");
        expect(pendingM2.run).toBeNull();
      }
      pauseAttach = false; firstTurnGate.afterAdmission = undefined; gate.resolve();
      if (stop) expect((await stop).status).toBe(boundary === "after_admission" ? 202 : 200);
      await waitForCondition("stopped run to drain", () => heartbeat.getTaskDrainStatus().quiescent);
      const ended = (await heartbeat.getRun(stopped.id))!;
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, stopped.id));
      const personStop = ended.resultJson?.personStop as { returned?: string[] } | undefined;
      if (dispatched) {
        expect(liveTurn.interrupted).toBe(true);
        expect(liveTurn.submissions).toBe(1);
        expect(ended.status).toBe("succeeded");
        expect((await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).some(comment => comment.body === "Stopped.")).toBe(true);
        expect(messages.get(stopped.id)).toContain(m1.body);
        expect(personStop?.returned ?? []).not.toContain(m1.id);
        expect(ended.resultJson?.startupCancellation).toBeUndefined();
        expect((await db.select().from(issueComments).where(eq(issueComments.id, m1.id)))[0].deletedAt).toBeNull();
      } else {
        expect(ended.status).toBe("cancelled");
        expect(ended.resultJson?.startupCancellation).toBeTruthy();
        expect(personStop?.returned).toContain(m1.id);
        expect(messages.has(stopped.id)).toBe(false);
        expect(events.filter(event => event.eventType.startsWith("turn."))).toHaveLength(0);
        if (!pendingM2) {
          const restored = await request(app).delete(`/api/issues/${issueId}/comments/${m1.id}`).send({});
          expect(restored.status).toBe(200); // The page's back-in-box acknowledgement.
        }
        expect((await db.select().from(issueComments).where(eq(issueComments.id, m1.id)))[0].deletedAt).toBeInstanceOf(Date);
      }
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, stopped.id)))).toHaveLength(0);
      const { run: next, comment: m2 } = pendingM2 ?? await send("M2 corrected request 0427");
      await waitForCondition("next message delivered after Stop", () => [...messages].some(([id, message]) => id !== stopped.id && message.includes(m2.body)), pendingM2 ? 45_000 : 10_000).catch(async error => {
        const state = { runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)),
          wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
          issue: await db.select().from(issues).where(eq(issues.id, issueId)),
          finalization: await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.companyId, companyId)),
          leases: await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, companyId)),
          deliveryErrors,
          recovery: await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId)) };
        if (process.env.CS_STOP_EVIDENCE_DIR) writeFileSync(join(process.env.CS_STOP_EVIDENCE_DIR, "m2-wait-failure.json"), JSON.stringify(state, null, 2));
        throw error;
      });
      await waitForCondition("next message answered", () => heartbeat.getTaskDrainStatus().quiescent);
      const nextId = next?.id ?? [...messages].find(([id, message]) => id !== stopped.id && message.includes(m2.body))?.[0];
      expect(nextId).toBeTruthy();
      const answered = (await heartbeat.getRun(nextId!))!;
      expect(answered.status, JSON.stringify(answered.resultJson)).toBe("succeeded");
      expect(answered.nativeSessionId).toBe(good.nativeSessionId);
      expect(messages.get(answered.id)).toContain(m2.body);
      expect([...messages.values()].filter(message => message.includes(m2.body))).toHaveLength(1);
      expect(submissions.filter(id => id === answered.id)).toHaveLength(1);
      if (!dispatched) {
        expect(messages.get(answered.id)).not.toContain(m1.body);
        expect(submissions.filter(id => id === stopped.id)).toHaveLength(0);
      }
      expect(deliveryErrors).toEqual([]);
      const proof = { boundary, seedRunId, stoppedRunId: stopped.id, nextRunId: answered.id,
        sessionId: good.nativeSessionId, nextSessionId: answered.nativeSessionId, stoppedStatus: ended.status,
        personStop, m1: m1.id, m1SoftDeleted: !dispatched, m2: m2.id, m2SentBeforeRuntimeRelease: Boolean(pendingM2),
        turnEvents: events.filter(event => event.eventType.startsWith("turn.")).map(event => event.eventType),
        m1Submissions: submissions.filter(id => id === stopped.id).length,
        m2Submissions: submissions.filter(id => id === answered.id).length,
        interrupted: liveTurn.interrupted, nextStatus: answered.status };
      process.stdout.write(`STOP_ADMISSION_PROOF ${JSON.stringify(proof)}\n`);
      if (process.env.CS_STOP_EVIDENCE_DIR) writeFileSync(join(process.env.CS_STOP_EVIDENCE_DIR, `admission-${boundary}.json`), JSON.stringify(proof, null, 2));
    } finally {
      pauseAttach = false; firstTurnGate.afterAdmission = undefined; gate.resolve(); liveTurn.end.resolve();
      await stop?.catch(() => undefined);
      await delivery?.stop();
      await heartbeat.drainActiveRunExecutions(); await closeIdleWarmNativeSessionsForRestart(); await db.$client.end();
    }
  }, 90_000);

  it("re-queues a native run that failed at budget admission and completes it without a Retry", async () => {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db) });
    try {
      admissionFaults.remaining = 1;
      const { issueId, runId } = await startTask(db, heartbeat);
      const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(failed).toMatchObject({ status: "failed", runtimeMode: "native", errorCode: "adapter_failed",
        resultJson: expect.objectContaining({ failureCause: "40001",
          nativePreDispatchFailure: { version: 1, providerWorkStarted: false } }) });
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId)));
      expect(successors).toEqual([expect.objectContaining({ scheduledRetryReason: "interrupted_preparation",
        scheduledRetryAttempt: 1 })]);
      expect(successors[0]!.contextSnapshot?.executionRetryAccounting).toMatchObject({ failureRetries: 0 });
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.status).not.toBe("blocked");
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);

      // The first attempt is due at once; the scheduler promotes it and the
      // queue starts it, exactly once.
      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 1 });
      await heartbeat.resumeQueuedRuns();
      await waitForCondition("the retry to succeed", async () =>
        (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successors[0]!.id)))[0]?.status === "succeeded");
      await waitForCondition("the retry to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId)))).toHaveLength(1);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
    } finally {
      admissionFaults.remaining = 0;
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.$client.end();
    }
  }, 90_000);

  it("re-queues a run whose predecessor could not be retired onto a fresh sandbox without a Retry", async () => {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const [environment] = await db.insert(environments).values({ name: `reused-${randomUUID()}`, driver: "sandbox" }).returning();
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db,
      { unretiredPredecessorOnce: { failed: false, environmentId: environment!.id } }) });
    try {
      const { issueId, runId } = await startTask(db, heartbeat);
      const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(failed).toMatchObject({ status: "failed", runtimeMode: "native", errorCode: "adapter_failed",
        resultJson: expect.objectContaining({ failureCause: "native_predecessor_retirement_unproven",
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
          predecessorRetirementFallback: expect.objectContaining({ version: 1, providerWorkStarted: false,
            predecessorRunId: "previous-run", replacedProviderLeaseIds: ["sandbox-reused"] }) }) });
      // The reused sandbox is replaced at the next acquisition, not resumed.
      const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.heartbeatRunId, runId),
        eq(environmentLeases.providerLeaseId, "sandbox-reused")));
      expect(lease?.metadata).toMatchObject({ replaceBeforeReuse: { schema: "paperclip.replace-before-reuse.v1", runId,
        predecessorRunId: "previous-run" } });
      expect(await db.select().from(activityLog).where(and(eq(activityLog.runId, runId),
        eq(activityLog.action, "environment.lease_replacement_requested")))).toHaveLength(1);
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId)));
      expect(successors).toEqual([expect.objectContaining({ scheduledRetryReason: "interrupted_preparation", scheduledRetryAttempt: 1 })]);
      expect(successors[0]!.contextSnapshot?.executionRetryAccounting).toMatchObject({ failureRetries: 0 });
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.status).not.toBe("blocked");
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);

      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 1 });
      await heartbeat.resumeQueuedRuns();
      await waitForCondition("the retry to succeed", async () =>
        (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successors[0]!.id)))[0]?.status === "succeeded");
      await waitForCondition("the retry to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.$client.end();
    }
  }, 90_000);

  it("stops retrying with a truthful failure when the next attempt met the same unretired sandbox instead of a fresh one", async () => {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const [environment] = await db.insert(environments).values({ name: `reused-${randomUUID()}`, driver: "sandbox" }).returning();
    const attempts: string[] = [];
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db,
      { unretiredPredecessorOnce: { failed: false, environmentId: environment!.id, repeat: attempts } }) });
    try {
      const { issueId, runId } = await startTask(db, heartbeat);
      const [first] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId)));
      expect(first).toMatchObject({ scheduledRetryReason: "interrupted_preparation", scheduledRetryAttempt: 1 });
      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 1 });
      await heartbeat.resumeQueuedRuns();
      await waitForCondition("the second attempt to end", async () =>
        (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first!.id)))[0]?.status === "failed");
      await waitForCondition("the second attempt to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      expect(attempts).toEqual([runId, first!.id]);
      const [second] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first!.id));
      expect(second?.resultJson ?? {}).not.toHaveProperty("predecessorRetirementFallback");
      expect(second?.error ?? "").not.toMatch(/fresh sandbox/i);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, first!.id)))).toHaveLength(0);
      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 0 });
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(await taskInterruptionPresentation(db, issue!)).toMatchObject({ canRetry: true });
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
        eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "scheduled_retry"])));
      await db.$client.end();
    }
  }, 90_000);

  it.each([
    { title: "continues a follow-up on a blocked task whose predecessor could not be retired", blockedAfter: false },
    { title: "does not continue a task that was blocked only after its run failed", blockedAfter: true },
  ])("$title", async ({ blockedAfter }) => {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const [environment] = await db.insert(environments).values({ name: `reused-${randomUUID()}`, driver: "sandbox" }).returning();
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db,
      { unretiredPredecessorOnce: { failed: false, environmentId: environment!.id, taskBlocked: !blockedAfter } }) });
    try {
      const { issueId, runId } = await startTask(db, heartbeat, blockedAfter ? "in_progress" : "blocked");
      const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(failed).toMatchObject({ status: "failed", resultJson: expect.objectContaining({
        failureCause: "native_predecessor_retirement_unproven",
        predecessorRetirementFallback: expect.objectContaining({ issueStatusAtFailure: blockedAfter ? "in_progress" : "blocked" }) }) });
      if (blockedAfter) await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));
      const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(task?.status).toBe("blocked");
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId)));
      expect(successors).toEqual([expect.objectContaining({ status: "scheduled_retry", scheduledRetryReason: "interrupted_preparation" })]);
      expect(await taskInterruptionPresentation(db, task!)).toMatchObject({ state: "working", canRetry: false });
      if (blockedAfter) {
        await heartbeat.promoteDueScheduledRetries();
        await heartbeat.resumeQueuedRuns();
        await waitForCondition("the stale retry to settle", () => heartbeat.getTaskDrainStatus().quiescent);
        const [stale] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successors[0]!.id));
        expect(["cancelled", "scheduled_retry"]).toContain(stale?.status);
        return;
      }
      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 1 });
      await heartbeat.resumeQueuedRuns();
      await waitForCondition("the retry to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      const [retried] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successors[0]!.id));
      expect({ status: retried?.status, errorCode: retried?.errorCode, error: retried?.error }).toEqual({ status: "succeeded", errorCode: null, error: null });
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
        eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "scheduled_retry"])));
      await db.$client.end();
    }
  }, 90_000);

  it("delivers the monitor check to the automatic retry of a monitor run that failed before provider work", async () => {
    const { companyId, agentId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const [environment] = await db.insert(environments).values({ name: `reused-${randomUUID()}`, driver: "sandbox" }).returning();
    const turnMessages = new Map<string, string>();
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db,
      { unretiredPredecessorOnce: { failed: false, environmentId: environment!.id }, turnMessages }) });
    try {
      await db.update(agents).set({ status: "idle", adapterConfig: { provider: "codex" } }).where(eq(agents.id, agentId));
      await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true });
      const userId = randomUUID();
      await db.insert(authUsers).values({ id: userId, name: "Task owner", email: `${userId}@example.invalid`,
        createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
      const [issue] = await db.insert(issues).values({ companyId, title: "Phase 2 on the monitor check", status: "in_progress",
        assigneeAgentId: agentId, responsibleUserId: userId, monitorNotes: "Phase 2 check" }).returning();
      const run = await heartbeat.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "issue_monitor_due",
        payload: { issueId: issue!.id }, contextSnapshot: { issueId: issue!.id, taskKey: issue!.id,
          source: "issue.monitor", wakeReason: "issue_monitor_due", monitorNotes: "Phase 2 check" } });
      expect(run).not.toBeNull();
      await waitForCondition("the monitor run to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      expect(failed).toMatchObject({ status: "failed", resultJson: expect.objectContaining({
        failureCause: "native_predecessor_retirement_unproven" }) });
      const [successor] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, run!.id)));
      expect(successor).toMatchObject({ scheduledRetryReason: "interrupted_preparation" });

      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 1 });
      await heartbeat.resumeQueuedRuns();
      await waitForCondition("the retry to start its provider turn", () => turnMessages.has(successor!.id));
      await waitForCondition("the retry to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      const [retried] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successor!.id));
      const continuation = retried!.contextSnapshot?.executionContinuation as ExecutionContinuationEnvelope;
      expect(continuation.trigger).toMatchObject({ sourceRunId: run!.id, retriedReason: "issue_monitor_due" });
      expect(renderPaperclipWakePrompt(retried!.contextSnapshot?.paperclipWake)).toContain("- retried wake: issue_monitor_due");
      expect(turnMessages.get(successor!.id)).toContain("- retried wake: issue_monitor_due");
      expect(turnMessages.has(run!.id)).toBe(false);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.$client.end();
    }
  }, 90_000);

  it.each([
    { target: "remote sandbox", provider: "e2b", leasePolicy: "reuse_by_execution_workspace" as const },
    { target: "plugin-task sandbox", provider: "daytona", leasePolicy: "reuse_by_environment" as const },
  ])("continues on a fresh $target when the provider artifacts fail to save before any turn", async ({ provider, leasePolicy }) => {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const [environment] = await db.insert(environments).values({ name: `capture-${randomUUID()}`, driver: "sandbox" }).returning();
    const turnMessages = new Map<string, string>();
    const failure: AdmissionFailure = { remaining: 1, turnNeverIssued: true, environmentId: environment!.id, provider,
      providerLeaseId: `sandbox-${provider}`, leasePolicy, failedRuns: [], sessionRoots: [] };
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db, { admissionFailure: failure, turnMessages }) });
    const warn = vi.spyOn(logger, "warn");
    try {
      const { issueId, runId } = await startTask(db, heartbeat);
      expect(failure.failedRuns).toEqual([runId]);
      expect(warn.mock.calls.filter(([, message]) => typeof message === "string" && message.includes("could not be marked workspace_failed")))
        .toEqual([]);
      expect(turnMessages.has(runId)).toBe(false);
      expect(existsSync(failure.sessionRoots[0]!)).toBe(false);
      const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(failed).toMatchObject({ status: "failed", runtimeMode: "native",
        resultJson: expect.objectContaining({ failureCause: "native_failed_before_provider_turn",
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
          predecessorRetirementFallback: expect.objectContaining({ version: 1, providerWorkStarted: false,
            predecessorRunId: null, replacedProviderLeaseIds: [`sandbox-${provider}-0`] }) }) });
      expect(failed!.error).toBe("Setting up the computer took too long, so the task is continuing on a fresh one.");
      expect(failed!.error).not.toMatch(/[a-z0-9]+_[a-z0-9_]+|\d|\(|\)/i);
      expect(failed!.runnerProfileJson).toMatchObject({ failedBeforeProviderTurn: {
        cause: "native_failed_before_provider_turn", technicalCause: "native_provider_artifacts_transfer_timeout" } });
      const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.heartbeatRunId, runId),
        eq(environmentLeases.providerLeaseId, `sandbox-${provider}-0`)));
      expect(lease?.metadata).toMatchObject({ replaceBeforeReuse: { schema: "paperclip.replace-before-reuse.v1", runId } });
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId)));
      expect(successors).toEqual([expect.objectContaining({ scheduledRetryReason: "interrupted_preparation", scheduledRetryAttempt: 1 })]);
      expect(successors[0]!.contextSnapshot?.executionRetryAccounting).toMatchObject({ failureRetries: 0 });
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(issue!.status).not.toBe("blocked");
      expect(await taskInterruptionPresentation(db, issue!)).toMatchObject({ state: "working", canRetry: false });
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);

      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 1 });
      await heartbeat.resumeQueuedRuns();
      await waitForCondition("the continuation to succeed", async () =>
        (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successors[0]!.id)))[0]?.status === "succeeded");
      await waitForCondition("the continuation to settle", () => heartbeat.getTaskDrainStatus().quiescent);
      expect(turnMessages.has(successors[0]!.id)).toBe(true);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId)))).toHaveLength(1);
      const [settled] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(await taskInterruptionPresentation(db, settled!)).toMatchObject({ state: "resolved", canRetry: false });
    } finally {
      warn.mockRestore();
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
        eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "scheduled_retry"])));
      await db.$client.end();
    }
  }, 90_000);

  it("keeps today's ambiguous hold when the Runner ledger cannot prove no turn was sent", async () => {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const [environment] = await db.insert(environments).values({ name: `capture-${randomUUID()}`, driver: "sandbox" }).returning();
    const failure: AdmissionFailure = { remaining: 1, turnNeverIssued: false, environmentId: environment!.id, provider: "daytona",
      providerLeaseId: "sandbox-turn-maybe-sent", leasePolicy: "reuse_by_environment", failedRuns: [], sessionRoots: [] };
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db, { admissionFailure: failure }) });
    try {
      const { runId } = await startTask(db, heartbeat);
      const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(failed?.status).toBe("failed");
      expect(failed?.resultJson ?? {}).not.toHaveProperty("predecessorRetirementFallback");
      expect(failed?.resultJson?.failureCause).not.toBe("native_failed_before_provider_turn");
      const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.heartbeatRunId, runId),
        eq(environmentLeases.providerLeaseId, "sandbox-turn-maybe-sent-0")));
      expect(lease?.metadata ?? {}).not.toHaveProperty("replaceBeforeReuse");
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId), eq(heartbeatRuns.scheduledRetryReason, "interrupted_preparation")))).toHaveLength(0);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
        eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "scheduled_retry"])));
      await db.$client.end();
    }
  }, 90_000);

  it("backs off a lasting pre-turn failure and stops at the shared lane cap without hammering", async () => {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const [environment] = await db.insert(environments).values({ name: `capture-${randomUUID()}`, driver: "sandbox" }).returning();
    const failure: AdmissionFailure = { remaining: Number.POSITIVE_INFINITY, turnNeverIssued: true, environmentId: environment!.id,
      provider: "daytona", providerLeaseId: "sandbox-lasting", leasePolicy: "reuse_by_environment", failedRuns: [], sessionRoots: [] };
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db, { admissionFailure: failure }) });
    const successorOf = async (runId: string) => (await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, runId))));
    const runToEnd = async (runId: string) => {
      await heartbeat.resumeQueuedRuns();
      await waitForCondition("the attempt to end", async () =>
        (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.status === "failed");
      await waitForCondition("the attempt to settle", () => heartbeat.getTaskDrainStatus().quiescent);
    };
    try {
      const { issueId, runId } = await startTask(db, heartbeat);
      const [first] = await successorOf(runId);
      expect(first).toMatchObject({ scheduledRetryReason: "interrupted_preparation", scheduledRetryAttempt: 1 });
      expect((await heartbeat.promoteDueScheduledRetries()).runIds).toEqual([first!.id]);
      const secondStartedAt = Date.now();
      await runToEnd(first!.id);
      const [second] = await successorOf(first!.id);
      expect(second).toMatchObject({ scheduledRetryReason: "interrupted_preparation", scheduledRetryAttempt: 2 });
      expect(second!.scheduledRetryAt!.getTime() - secondStartedAt).toBeGreaterThanOrEqual(15_000);
      expect((await heartbeat.promoteDueScheduledRetries()).runIds).not.toContain(second!.id);
      expect(failure.failedRuns).toHaveLength(2);
      const [waiting] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(await taskInterruptionPresentation(db, waiting!)).toMatchObject({ state: "working", canRetry: false });

      await db.update(heartbeatRuns).set({ scheduledRetryAttempt: 12, scheduledRetryAt: new Date(Date.now() - 1_000),
        contextSnapshot: { ...second!.contextSnapshot, executionRetryAccounting: {
          ...(second!.contextSnapshot?.executionRetryAccounting as Record<string, unknown>), interruptedPreparations: 12 } } })
        .where(eq(heartbeatRuns.id, second!.id));
      expect((await heartbeat.promoteDueScheduledRetries()).runIds).toEqual([second!.id]);
      await runToEnd(second!.id);
      expect(await successorOf(second!.id)).toHaveLength(0);
      expect(failure.failedRuns).toHaveLength(3);
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(await taskInterruptionPresentation(db, issue!)).toMatchObject({ state: "failed", canRetry: true });
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
        eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ["queued", "scheduled_retry"])));
      await db.$client.end();
    }
  }, 120_000);

  it("keeps the hold when the failure follows entry into the native executor", async () => {
    const { companyId } = fixture.current;
    const db = createDb(fixture.current.temporary.connectionString, { maxConnections: 4 });
    const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: nativeBackend(db, { failDescriptorOnce: { failed: false } }) });
    try {
      const { runId } = await startTask(db, heartbeat);
      const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(failed?.status).toBe("failed");
      expect(failed?.resultJson ?? {}).not.toHaveProperty("nativePreDispatchFailure");
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.retryOfRunId, runId), eq(heartbeatRuns.scheduledRetryReason, "interrupted_preparation")))).toHaveLength(0);
    } finally {
      await heartbeat.drainActiveRunExecutions();
      await closeIdleWarmNativeSessionsForRestart();
      await db.$client.end();
    }
  }, 90_000);
});
