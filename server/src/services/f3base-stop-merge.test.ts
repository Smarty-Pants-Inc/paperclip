import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, companies, companyMemberships, createDb, heartbeatRuns, issueComments,
  environmentLeases, issueRecoveryActions, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";

// adopt-c3-f3base: on the c3 base (no U, no card6, no personStopHoldsSavedWake), after a
// person's Stop: what happens to M1 (saved before the Stop) and M2 (posted after it)?
// Real Postgres, the real comment POST route, the real heartbeat/wake-queue code.
const { heartbeatService } = await import("./heartbeat.js");
const { issueRoutes } = await import("../routes/issues.js");
const { errorHandler } = await import("../middleware/index.js");
const { buildExecutionContinuation } = await import("./execution-continuation.js");
const { createWakeQueue } = await import("../modules/wake-queue/index.js");
const { shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake } = await import("./heartbeat/queue.js");
const { mergeCoalescedContextSnapshot } = await import("./heartbeat/run-preparation.js");
const { createHeartbeatQueueTestDependencies } = await import("../__tests__/helpers/heartbeat-queue.js");

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("adopt-c3-f3base: a message after a person's Stop on the base", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("f3base-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  function app(companyId: string) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "session", userId: "board", companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "owner" }], isInstanceAdmin: false };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  // M1 = M2-M4 bodies (the pre-Stop messages, one saved wake), then the person's Stop of a native run.
  async function seed(options: { person?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sourceRunId = randomUUID();
    const stoppedAt = new Date(Date.now() - 60_000);
    await db.insert(companies).values({ id: companyId, name: "F3 base", defaultResponsibleUserId: "board", issuePrefix: `F${companyId.replaceAll("-", "")}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Daily work", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native",
      status: "cancelled", errorCode: "cancelled", contextSnapshot: { issueId }, finishedAt: stoppedAt,
      resultJson: options.person === false
        ? { stopReason: "cancelled", cancelledByActorType: "system" } : { stopReason: "cancelled", cancelledByActorType: "user", cancelledByUserId: "board",
        executionCancellation: { state: "acknowledged" },
        nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: sourceRunId, companyId,
          issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
          intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: stoppedAt.toISOString() } } });
    await db.insert(nativeRunFinalizations).values({ runId: sourceRunId, companyId, issueId, phase: "terminal_failure", failureCode: "native_retry_cancelled" });
    // The stopped run's lease, released with the provider's stop receipt (its own teardown).
    const leaseId = randomUUID(), providerLeaseId = "bx_f3base";
    const identity = { id: leaseId, companyId, heartbeatRunId: sourceRunId, provider: "daytona", providerLeaseId };
    await db.insert(environmentLeases).values({ ...identity, leasePolicy: "reuse_by_environment", cleanupStatus: "success",
      status: "released", releasedAt: stoppedAt,
      metadata: { remoteExecutionTermination: remoteTerminationReceipt(identity, { providerLeaseId, state: "stopped" }) } });
    const base = stoppedAt.getTime() - 3_000;
    const comments = ["M2", "M3", "M4"].map((body, index) => ({ id: randomUUID(), companyId, issueId, authorType: "user" as const,
      authorUserId: "board", body, createdAt: new Date(base + index) }));
    await db.insert(issueComments).values(comments);
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId, agentId, source: "on_demand", reason: "issue_commented",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      requestedAt: new Date(base + 10),
      payload: { issueId, commentId: comments.at(-1)!.id, _paperclipWakeContext: { wakeCommentIds: comments.map(c => c.id), wakeReason: "issue_commented" } } });
    return { companyId, agentId, issueId, sourceRunId, queueId, commentIds: comments.map(c => c.id as string) };
  }
  type F = Awaited<ReturnType<typeof seed>>;

  const wakeOf = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;
  const readQueue = async (f: { companyId: string; issueId: string }) =>
    (await request(app(f.companyId)).get(`/api/issues/${f.issueId}/queued-comments`).expect(200)).body;
  const successors = async (f: { companyId: string; sourceRunId: string }) =>
    (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).filter(r => r.id !== f.sourceRunId);
  const evidence = async (line: string) => {
    if (process.env.F3BASE_EVIDENCE_FILE) await import("node:fs/promises").then(fs => fs.appendFile(process.env.F3BASE_EVIDENCE_FILE!, `${line}\n`));
  };
  const postNew = async (f: { companyId: string; issueId: string }, body: string) => {
    const posted = await request(app(f.companyId)).post(`/api/issues/${f.issueId}/comments`)
      .send({ body, clientRequestId: randomUUID() });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    const commentId = posted.body.id as string;
    let wakeId = "";
    await vi.waitFor(async () => {
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
      wakeId = wakes.find(wake => wake.payload?.commentId === commentId)?.id ?? "";
      expect(wakeId).not.toBe("");
    }, { timeout: 15_000, interval: 100 });
    return { commentId, wakeId };
  };
  const admittedOrigins = async (f: F, run: typeof heartbeatRuns.$inferSelect) =>
    (await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, runId: run.id,
      context: run.contextSnapshot!, summary: null, exposeLowTrustRaw: false })).originCommentIds;
  const snapshot = async (f: F, holderId?: string) => {
    const runs = [];
    for (const r of (await successors(f)).filter(r => r.id !== holderId))
      runs.push({ id: r.id, status: r.status, wake: r.wakeupRequestId, origins: r.contextSnapshot ? await admittedOrigins(f, r).catch(e => `err:${e}`) : null });
    return {
      issue: (await db.select().from(issues).where(eq(issues.id, f.issueId))).map(i => ({ status: i.status, executionRunId: i.executionRunId }))[0],
      wakes: (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
        .map(w => ({ id: w.id, status: w.status, runId: w.runId, coalescedCount: w.coalescedCount,
          ids: ((w.payload as any)?._paperclipWakeContext?.wakeCommentIds ?? null),
          wait: (w.payload as Record<string, any> | null)?.executionWait?.reason ?? null })),
      cards: (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).map(c => `${c.cause}:${c.status}`),
      runs,
      blocker: (await getExecutionBlocker(db, f.companyId, f.issueId))?.nextAction ?? null,
      queueLine: (await readQueue(f)).executionWait ?? null,
    };
  };
  const mergedInto = (wake: typeof agentWakeupRequests.$inferSelect, commentId: string) =>
    (((wake.payload as any)?._paperclipWakeContext?.wakeCommentIds ?? []) as string[]).includes(commentId);
  const holdTask = async (f: F, runtimeMode: "legacy" | "native") => {
    const holderId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: holderId, companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      runtimeMode, status: "running", startedAt: new Date(), contextSnapshot: { issueId: f.issueId } });
    await db.update(issues).set({ executionRunId: holderId, executionAgentNameKey: "native", executionLockedAt: new Date() })
      .where(eq(issues.id, f.issueId));
    return holderId;
  };
  // Every run that carries the given comment.
  const carriersOf = async (f: F, commentId: string, holderId?: string) => {
    const out: string[] = [];
    for (const run of (await successors(f)).filter(r => r.id !== holderId))
      if (run.contextSnapshot && (await admittedOrigins(f, run)).includes(commentId)) out.push(run.id);
    return out;
  };
  // Answered = a run carrying the comment has left the queue (claimed and started).
  const waitStarted = async (f: F, commentId: string, holderId?: string, timeout = 15_000) => {
    let carriers: string[] = [];
    try {
      await vi.waitFor(async () => {
        carriers = await carriersOf(f, commentId, holderId);
        const statuses = (await successors(f)).filter(r => carriers.includes(r.id)).map(r => r.status);
        expect(statuses.some(status => !["queued", "scheduled_retry"].includes(status))).toBe(true);
      }, { timeout, interval: 200 });
    } catch { /* recorded by the caller */ }
    return carriers;
  };

  it("(a) M1 saved before the Stop, task idle: the automatic passes (stopped run's cleanup resume, stranded pass) do not run it", async () => {
    const f = await seed();
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    await heartbeatService(db).resumeRemoteStopComments(source);
    await heartbeatService(db).resumeQueuedRuns();
    await new Promise(resolve => setTimeout(resolve, 3_000));
    const seen = await snapshot(f);
    await evidence(`a-idle ${JSON.stringify({ preStopWake: f.queueId, ...seen })}`);
    expect(seen.runs).toEqual([]);
    expect(await wakeOf(f.queueId)).toMatchObject({ status: "deferred_issue_execution", runId: null });
    // The person's Send answers M1 once.
    const queue = await readQueue(f);
    const sent = await request(app(f.companyId)).post(`/api/issues/${f.issueId}/queued-comments/interrupt`)
      .send({ queueId: queue.queueId, revision: queue.revision, targetRunId: null });
    const carriers = await waitStarted(f, f.commentIds[0]!);
    await evidence(`a-send ${JSON.stringify({ queueId: queue.queueId, entries: queue.entries?.map((e: { comment: { id: string } }) => e.comment.id),
      sendStatus: sent.status, m1Carriers: carriers, ...(await snapshot(f)) })}`);
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    expect(carriers).toHaveLength(1);
      // (d) nothing answered twice: M1 rides at most one run, and only one run started for this task.
      expect((await carriersOf(f, f.commentIds[0]!, undefined)).length).toBeLessThanOrEqual(1);
      expect((await successors(f)).filter(r => r.id !== undefined)).toHaveLength(1);
  }, 60_000);

  // cleanup=true: the stopped run's own cleanup has already run resumeRemoteStopComments (heartbeat/run-control.ts:665),
  // as it does at the end of every Stop, BEFORE M2 is posted (M1 predates the Stop, so that pass leaves it saved).
  const seedStopped = async (cleanup: boolean) => {
    const f = await seed();
    if (cleanup) {
      const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
      await heartbeatService(db).resumeRemoteStopComments(source);
    }
    return f;
  };
  for (const cleanup of [false, true]) {
    const tag = cleanup ? "+stopCleanup" : "";
    it(`(b/c legacy holder${tag}) M2 posted after the Stop while a legacy run holds the task: M2 is answered once when the holder ends`, async () => {
      const f = await seedStopped(cleanup);
      const holderId = await holdTask(f, "legacy");
      const next = await postNew(f, "M5 after the Stop, legacy holder");
      const preStop = await wakeOf(f.queueId);
      const admission = { m2Wake: next.wakeId, mergedIntoPreStop: mergedInto(preStop, next.commentId), preStop };
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, holderId));
      await db.update(issues).set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null })
        .where(eq(issues.executionRunId, holderId));
      await heartbeatService(db).resumeQueuedRuns();
      const carriers = await waitStarted(f, next.commentId, holderId);
      const seen = await snapshot(f, holderId);
      await evidence(`b-legacy${tag} ${JSON.stringify({ holderId, preStopWake: f.queueId, m2Comment: next.commentId, m1Comments: f.commentIds,
        mergedIntoPreStop: admission.mergedIntoPreStop, preStopIdsAtAdmission: (admission.preStop.payload as any)?._paperclipWakeContext?.wakeCommentIds,
        m2Carriers: carriers, ...seen })}`);
      expect(carriers).toHaveLength(1);
      // (d) nothing answered twice: M1 rides at most one run, and only one run started for this task.
      expect((await carriersOf(f, f.commentIds[0]!, holderId)).length).toBeLessThanOrEqual(1);
      expect((await successors(f)).filter(r => r.id !== holderId)).toHaveLength(1);
    }, 60_000);

    it(`(b/c idle${tag}) M2 posted after the Stop with the task idle: M2 is answered once`, async () => {
      const f = await seedStopped(cleanup);
      const next = await postNew(f, "M5 after the Stop, task idle");
      const carriers = await waitStarted(f, next.commentId);
      const seen = await snapshot(f);
      await evidence(`b-idle${tag} ${JSON.stringify({ preStopWake: f.queueId, m2Wake: next.wakeId, m2Comment: next.commentId, m1Comments: f.commentIds,
        mergedIntoPreStop: mergedInto(await wakeOf(f.queueId), next.commentId), m2Carriers: carriers, ...seen })}`);
      expect(carriers).toHaveLength(1);
      // (d) nothing answered twice: M1 rides at most one run, and only one run started for this task.
      expect((await carriersOf(f, f.commentIds[0]!, undefined)).length).toBeLessThanOrEqual(1);
      expect((await successors(f)).filter(r => r.id !== undefined)).toHaveLength(1);
    }, 60_000);

    for (const ending of ["succeeded", "failed", "failed-then-new-message"] as const) {
      it(`(b/c native holder ${ending}${tag}) M2 posted after the Stop while a native run holds the task; that run's own release`, async () => {
        const failed = ending !== "succeeded";
        const f = await seedStopped(cleanup);
        const holderId = await holdTask(f, "native");
        const next = await postNew(f, `M5 after the Stop, native holder ${ending}`);
        const mergedIntoPreStop = mergedInto(await wakeOf(f.queueId), next.commentId);
        await db.update(heartbeatRuns).set({ status: failed ? "failed" : "succeeded", finishedAt: new Date(),
          ...(failed ? { errorCode: "adapter_failed" } : {}) }).where(eq(heartbeatRuns.id, holderId));
        await db.insert(nativeRunFinalizations).values({ runId: holderId, companyId: f.companyId, issueId: f.issueId,
          phase: failed ? "terminal_failure" : "committed" });
        const scaffold = createHeartbeatQueueTestDependencies(db);
        const wakeQueue = createWakeQueue(db, {
          resolveResponsibleUserId: async () => "board",
          getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
          resolveSessionBeforeForWakeup: async () => null,
          wakeAdmissionHelpers: { filterZombieCoalesceTarget: scaffold.filterZombieCoalesceTarget, mergeCoalescedContextSnapshot,
            shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake },
          recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
        } as any);
        const released = await wakeQueue.releaseIssueExecution({ companyId: f.companyId, runId: holderId, now: new Date() });
        await heartbeatService(db).resumeQueuedRuns();
        if (ending === "failed-then-new-message") {
          // The blocker line's own way on: the person sends a new message (M6).
          const later = await postNew(f, "M6 after the native failure");
          await heartbeatService(db).resumeQueuedRuns();
          const m2Carriers = await waitStarted(f, next.commentId, holderId, 20_000);
          const m6Carriers = await carriersOf(f, later.commentId, holderId);
          const m1Carriers = await carriersOf(f, f.commentIds[0]!, holderId);
          const seen = await snapshot(f, holderId);
          await evidence(`c-native-${ending}${tag} ${JSON.stringify({ holderId, preStopWake: f.queueId, m2Wake: next.wakeId, m6Wake: later.wakeId,
            m2Comment: next.commentId, m6Comment: later.commentId, m1Comments: f.commentIds, mergedIntoPreStop, released,
            m2Carriers, m6Carriers, m1Carriers, ...seen })}`);
          expect(m2Carriers).toHaveLength(1);
          expect(m6Carriers).toHaveLength(1);
          expect(m1Carriers.length).toBeLessThanOrEqual(1);
          return;
        }
        const carriers = await waitStarted(f, next.commentId, holderId, failed ? 5_000 : 15_000);
        const seen = await snapshot(f, holderId);
        await evidence(`c-native-${ending}${tag} ${JSON.stringify({ holderId, preStopWake: f.queueId, m2Wake: next.wakeId, m2Comment: next.commentId,
          m1Comments: f.commentIds, mergedIntoPreStop, released, m2Carriers: carriers, ...seen })}`);
        if (ending === "succeeded") {
          expect(carriers).toHaveLength(1);
          // (d) nothing answered twice: M1 rides at most one run, and only one run started for this task.
          expect((await carriersOf(f, f.commentIds[0]!, holderId)).length).toBeLessThanOrEqual(1);
          expect((await successors(f)).filter(r => r.id !== holderId)).toHaveLength(1);
        } else {
          // The base's native-failure policy: the task is blocked with the reconciliation card; M2 stays saved.
          expect(carriers).toEqual([]);
          expect(seen.cards).toContain("native_continuation_requires_reconciliation:active");
          // M2 rides M1's saved wake, which stays saved (not lost) behind the reconciliation card.
        expect(mergedInto(await wakeOf(f.queueId), next.commentId)).toBe(true);
        expect((await wakeOf(f.queueId)).status).toBe("deferred_issue_execution");
        }
      }, 60_000);
    }
  }

  it("control: the failed native holder blocks the task the same way with NO person's Stop (not Stop-specific)", async () => {
    const f = await seed({ person: false });
    const holderId = await holdTask(f, "native");
    const next = await postNew(f, "M5 no Stop, native holder failed");
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), errorCode: "adapter_failed" }).where(eq(heartbeatRuns.id, holderId));
    await db.insert(nativeRunFinalizations).values({ runId: holderId, companyId: f.companyId, issueId: f.issueId, phase: "terminal_failure" });
    const scaffold = createHeartbeatQueueTestDependencies(db);
    const wakeQueue = createWakeQueue(db, {
      resolveResponsibleUserId: async () => "board",
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
      wakeAdmissionHelpers: { filterZombieCoalesceTarget: scaffold.filterZombieCoalesceTarget, mergeCoalescedContextSnapshot,
        shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake },
      recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
    } as any);
    const released = await wakeQueue.releaseIssueExecution({ companyId: f.companyId, runId: holderId, now: new Date() });
    await heartbeatService(db).resumeQueuedRuns();
    const carriers = await waitStarted(f, next.commentId, holderId, 5_000);
    const seen = await snapshot(f, holderId);
    await evidence(`control-native-failed-noStop ${JSON.stringify({ holderId, released, m2Carriers: carriers, ...seen })}`);
    expect(carriers).toEqual([]);
    expect(seen.issue?.status).toBe("blocked");
    expect(seen.cards).toContain("native_continuation_requires_reconciliation:active");
  }, 60_000);

  it("control: with NO person's Stop, a message posted behind a running turn joins the saved wake (coalesces as today)", async () => {
    const f = await seed({ person: false });
    const holderId = await holdTask(f, "legacy");
    const next = await postNew(f, "M5 no Stop");
    const merged = await wakeOf(f.queueId);
    await evidence(`control ${JSON.stringify({ holderId, nextWakeId: next.wakeId, preStopWakeId: f.queueId,
      wakeCommentIds: (merged.payload?._paperclipWakeContext as { wakeCommentIds?: string[] } | undefined)?.wakeCommentIds })}`);
    expect(mergedInto(merged, next.commentId)).toBe(true);
    expect(merged.status).toBe("deferred_issue_execution");
  }, 60_000);
});
