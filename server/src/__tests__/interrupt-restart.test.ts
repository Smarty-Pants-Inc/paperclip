import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  environmentLeases, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// adopt-row12b (rf-4 / review-fleet-4 row 12): after a SERVER RESTART an
// Interrupt / Send hand-off must not wait for warm expiry (8 h on Paul's server).
// The warm-session map (native-session-executor warmNativeSessions) and the
// in-flight proof map (handed-off-warm-lease proofsInFlight) are module-level,
// process-local state. THE RESTART is simulated as a fresh process would see it:
// vi.resetModules() drops every loaded module, so the server code is re-imported
// as a FRESH module graph (empty warmNativeSessions, empty proofsInFlight, a
// fresh heartbeatService on a fresh connection pool); the database survives.
// Before the restart the old process held the stopped run's warm session; the
// only stand-in is the s3 fence's proof on it (needs a live Boat Runner), as in
// interrupt-native.test.ts. After the restart the REAL executor answers from its
// empty map. Provider edges as in interrupt-native / send-after-stop3 (713e7d1b):
// the Runner's cancel acknowledgement, the orchestrator's releaseForRun, and the
// provider's stop receipt through the real settleStopOnlyCleanup.
const proc = vi.hoisted(() => ({ restarted: false, calls: [] as Array<{ runId: string; providerLeaseId: string | null; restarted: boolean }> }));
vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  const { heartbeatRuns: runs } = await import("@paperclipai/db");
  const { eq: same } = await import("drizzle-orm");
  const real = actual as unknown as Record<string, unknown>;
  return {
    ...actual,
    handedOffWarmOwnerRunnerExited: async (input: { runId: string; providerLeaseId: string | null }) => {
      proc.calls.push({ ...input, restarted: proc.restarted });
      // Before the restart: this process holds the idle warm session and its Runner exits (stand-in).
      // After: the fresh module's real answer (its warm map is empty).
      return proc.restarted ? actual.handedOffWarmOwnerRunnerExited(input) : true;
    },
    handedOffWarmOwnerProofUnavailable: (input: { runId: string; providerLeaseId: string | null }) =>
      proc.restarted ? (real.handedOffWarmOwnerProofUnavailable as ((i: unknown) => boolean) | undefined)?.(input) === true : false,
    cancelNativeSession: (async (...args: Parameters<typeof actual.cancelNativeSession>) => {
      const result = await actual.cancelNativeSession(...args);
      const db = args[2]?.db as ReturnType<typeof createDb> | undefined;
      if (db && typeof result === "object" && result) {
        const [run] = await db.select().from(runs).where(same(runs.id, args[0]));
        const intent = run?.resultJson?.nativeCancellation as Record<string, unknown> | undefined;
        if (intent?.dispatchState === "acknowledged") await db.update(runs).set({ resultJson: { ...run!.resultJson,
          nativeCancellation: { ...intent, dispatched: true } } }).where(same(runs.id, args[0]));
        return { ...result, dispatched: true };
      }
      return result;
    }) as typeof actual.cancelNativeSession,
  };
});
const environmentOrchestrator = await import("../services/environment-run-orchestrator.js");
const { heartbeatService } = await import("../services/heartbeat.js");
const { issueRoutes } = await import("../routes/issues.js");
const { errorHandler } = await import("../middleware/index.js");
const { instanceSettingsService } = await import("../services/instance-settings.js");
const { preserveCancelledNativeWorkspaces } = await import("../services/native-runtime/native-failed-workspace-recovery.js");
const { unansweredPersonMessageCommentCondition } = await import("../services/recovery/unanswered-person-message.js");
// The pre-restart process's holder stamp on the lease (written when the lease went active).
const { currentControllerProcessStamp } = await import("../services/controller-process-identity.js");

const support = await getEmbeddedPostgresTestSupport();

/** THE SERVER RESTART: a fresh module graph (process-local maps empty) on a fresh pool. */
async function restartServer(connectionString: string) {
  proc.restarted = true;
  vi.resetModules();
  const fresh = await import("@paperclipai/db");
  const db = fresh.createDb(connectionString);
  const { heartbeatService: freshHeartbeat } = await import("../services/heartbeat.js");
  const { settleStopOnlyCleanup } = await import("../services/sandbox-stop-and-retain.js");
  const { buildExecutionContinuation } = await import("../services/execution-continuation.js");
  const executor = await import("../services/native-runtime/native-session-executor.js");
  return { db, heartbeat: freshHeartbeat(db), settleStopOnlyCleanup, buildExecutionContinuation, executor, at: Date.now() };
}

describe.skipIf(!support.supported)("row 12: a hand-off after a SERVER RESTART never waits for warm expiry", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const fresh: Array<ReturnType<typeof createDb>> = [];
  const userId = "rs-person";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("interrupt-restart-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Person", email: "rs@example.invalid", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    for (const pool of fresh) await pool.$client.end({ timeout: 1 }).catch(() => {});
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  const evidence = async (label: string, value: unknown) => {
    if (process.env.RS_EVIDENCE) await fs.appendFile(process.env.RS_EVIDENCE, JSON.stringify({ label, value }) + "\n");
  };
  const leaseOf = async (id: string) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0]!;
  const wakeOf = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;
  const runsOf = async (companyId: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
  const unanswered = async (issueId: string, ids: string[]) => db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.issueId, issueId), inArray(issueComments.id, ids), unansweredPersonMessageCommentCondition()));

  // The same live warm native turn as interrupt-native.test.ts (Paul 11-19 06:09).
  async function seedLiveNativeTurn() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), liveRunId = randomUUID();
    const wakeId = randomUUID(), leaseId = randomUUID(), providerLeaseId = `bx_${randomUUID().slice(0, 8)}`;
    const [own, held] = [randomUUID(), randomUUID()];
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "RS", issuePrefix, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Boat Pi", role: "engineer", status: "running",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
    const t = (m: number) => new Date(Date.now() - (10 - m) * 60_000);
    await db.insert(heartbeatRuns).values({ id: liveRunId, companyId, agentId, invocationSource: "on_demand",
      triggerDetail: "manual", status: "running", runtimeMode: "native", startedAt: t(3), responsibleUserId: userId,
      contextSnapshot: { issueId, wakeCommentId: own, commentId: own, wakeCommentIds: [own], responsibleUserId: userId },
      runnerProfileJson: { nativeResourceDisposition: "keep_running", nativeWorkspaceSync: { state: "prepared",
        schema: "paperclip.native-workspace-sync/v3", leaseId, remoteCwd: "/home/user/paperclip-workspace", workspaceId: randomUUID(),
        baselineSha256: "a".repeat(64), finalHostSha256: null, providerLeaseId, descriptorSha256: "b".repeat(64),
        resourceDisposition: "keep_running" } } });
    await db.insert(issues).values({ id: issueId, companyId, identifier: `${issuePrefix}-1`, title: "Chat", status: "in_progress",
      priority: "medium", assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: userId,
      conversationState: "active", responsibleUserId: userId, executionRunId: liveRunId });
    await db.update(heartbeatRuns).set({ nativeIssueId: issueId }).where(eq(heartbeatRuns.id, liveRunId));
    await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, heartbeatRunId: liveRunId, provider: "daytona",
      providerLeaseId, status: "active", leasePolicy: "reuse_by_environment",
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/home/user/paperclip-workspace",
        leaseController: currentControllerProcessStamp() } });
    await db.insert(issueComments).values([[own, "OWN", 2], [held, "MSG 1", 4]].map(([id, body, m]) => ({
      id: id as string, companyId, issueId, authorType: "user" as const, authorUserId: userId, body: body as string,
      createdAt: t(m as number), updatedAt: t(m as number) })));
    await db.insert(issueComments).values({ companyId, issueId, authorAgentId: agentId, authorType: "agent",
      createdByRunId: liveRunId, origin: "comment", body: "answer to OWN", createdAt: t(3), updatedAt: t(3) });
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId, source: "issue_comment",
      reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedByActorType: "user",
      requestedByActorId: userId, payload: { issueId, commentId: held,
        _paperclipWakeContext: { commentId: held, wakeCommentId: held, wakeCommentIds: [held] } } });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId: liveRunId, phase: "observed" });
    // Keeps the successor in the ordinary queue (no provider launch), as interrupt-rows does.
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: { issueId: randomUUID() } });
    const client = express();
    client.use(express.json());
    client.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "session", userId, companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false };
      next();
    });
    client.use("/api", issueRoutes(db, {} as any, {}));
    client.use(errorHandler);
    return { companyId, agentId, issueId, liveRunId, wakeId, leaseId, providerLeaseId, held, client };
  }

  /** The person's real Interrupt click, the Runner's ack and the keep_running release: the box is handed off. */
  async function interruptAndHandOff(f: Awaited<ReturnType<typeof seedLiveNativeTurn>>) {
    const originalFactory = environmentOrchestrator.environmentRunOrchestrator;
    const release = vi.fn(async (input: { heartbeatRunId: string; providerResourceDisposition?: string }) => {
      await db.update(environmentLeases).set(input.providerResourceDisposition === "keep_running"
        ? { status: "retained", cleanupStatus: "success", lastUsedAt: new Date() }
        : { status: "released", cleanupStatus: "success", releasedAt: new Date() })
        .where(and(eq(environmentLeases.heartbeatRunId, input.heartbeatRunId), eq(environmentLeases.status, "active")));
      return { released: [], errors: [] };
    });
    const factory = vi.spyOn(environmentOrchestrator, "environmentRunOrchestrator").mockImplementation((...args) => ({
      ...originalFactory(...args), releaseForRun: release,
    }));
    try {
      const queue = await request(f.client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200);
      const pressed = await request(f.client).post(`/api/issues/${f.issueId}/queued-comments/interrupt`)
        .send({ queueId: queue.body.queueId, targetRunId: f.liveRunId, revision: queue.body.revision });
      expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
      const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.liveRunId));
      expect(stopped.status).toBe("cancelled");
      await db.update(heartbeatRuns).set({ processPid: 999_999_999, processGroupId: null }).where(eq(heartbeatRuns.id, f.liveRunId));
      await db.update(heartbeatRuns).set({ resultJson: { ...stopped.resultJson,
        nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: f.liveRunId, companyId: f.companyId,
          issueId: f.issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
          intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: new Date().toISOString() } } })
        .where(eq(heartbeatRuns.id, f.liveRunId));
      await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null, failureCode: "native_retry_cancelled" })
        .where(eq(nativeRunFinalizations.runId, f.liveRunId));
      await heartbeatService(db).releaseEnvironmentLeasesForRun({ runId: f.liveRunId, companyId: f.companyId, agentId: f.agentId,
        status: "cancelled", providerResourceDisposition: "keep_running" });
      await preserveCancelledNativeWorkspaces(db);
      expect(await leaseOf(f.leaseId)).toMatchObject({ status: "retained", releasedAt: null });
      return { queueId: (pressed.body.queueId ?? queue.body.queueId) as string, release };
    } finally {
      factory.mockRestore();
    }
  }

  it("R12a: warm turn -> Interrupt with a held message -> SERVER RESTART -> the successor starts and answers once within 60 s", async () => {
    proc.restarted = false; proc.calls.length = 0;
    const f = await seedLiveNativeTurn();
    const { queueId } = await interruptAndHandOff(f);
    // ---- SERVER RESTART ----
    const server = await restartServer(tempDb.connectionString);
    fresh.push(server.db);
    // The fresh process holds no warm session for the interrupted run: the real s3-fence proof is unavailable (false).
    expect(await server.executor.handedOffWarmOwnerRunnerExited({ runId: f.liveRunId, providerLeaseId: f.providerLeaseId })).toBe(false);
    // Boot / receipt worker: the automatic resume of the stopped run, then the Interrupt's dispatch pass.
    const [stoppedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.liveRunId));
    await server.heartbeat.resumeRemoteStopComments(stoppedRun!);
    await server.heartbeat.resumeQueuedCommentInterrupt(f.companyId, queueId);
    const afterRestart = await wakeOf(f.wakeId);
    const stopping = await leaseOf(f.leaseId);
    await evidence("R12a_wake_after_restart", { status: afterRestart.status, executionWait: afterRestart.payload?.executionWait ?? null });
    await evidence("R12a_lease_after_restart", { status: stopping.status, intent: stopping.metadata?.sandboxStopAndRetain ?? null });
    await evidence("R12a_proof_calls", proc.calls);
    // AT ONCE (not at warm expiry): the stop-only owner's stop_and_retain intent on THIS lease, marked proof-unavailable.
    expect(stopping.status).toBe("pending_cleanup");
    expect(stopping.metadata?.sandboxStopAndRetain).toMatchObject({ runId: f.liveRunId, leaseId: f.leaseId,
      providerLeaseId: f.providerLeaseId, handedOffWarmProofUnavailable: true });
    // Idempotent: another pass requests no second stop and admits nothing yet.
    await server.heartbeat.resumeQueuedCommentInterrupt(f.companyId, queueId);
    expect((await leaseOf(f.leaseId)).metadata?.sandboxStopAndRetain).toEqual(stopping.metadata?.sandboxStopAndRetain);
    // The provider's stop receipt through the real stop-only settle (the cleanup sweep's provider edge).
    const settled = await server.settleStopOnlyCleanup(server.db, stopping, { attemptId: String(stopping.metadata?.pendingCleanupAttemptId),
      receipt: { providerLeaseId: f.providerLeaseId, state: "stopped" } });
    expect(settled).toMatchObject({ status: "released", providerLeaseId: f.providerLeaseId });
    // The sweep's receipt path (recovery.ts: acknowledgeRemoteStop -> resumeRemoteStopComments).
    await server.heartbeat.resumeRemoteStopComments((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.liveRunId)))[0]!);
    const wake = await wakeOf(f.wakeId);
    const runs = await runsOf(f.companyId);
    const successors = runs.filter(run => run.id !== f.liveRunId && run.contextSnapshot?.issueId === f.issueId);
    const carrying = successors.filter(run => ((run.contextSnapshot?.wakeCommentIds as string[] | undefined) ?? []).includes(f.held));
    const elapsedMs = Date.now() - server.at;
    await evidence("R12a_admitted", { wake: { status: wake.status, runId: wake.runId }, elapsedMs,
      successors: successors.map(run => ({ status: run.status, errorCode: run.errorCode, wakeCommentIds: run.contextSnapshot?.wakeCommentIds ?? null })) });
    expect(carrying).toHaveLength(1);
    expect(wake).toMatchObject({ status: "coalesced", runId: carrying[0]!.id });
    expect(["queued", "running"]).toContain(carrying[0]!.status);
    expect(elapsedMs).toBeLessThan(60_000);
    const cards = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    expect(cards.map(card => card.cause)).toEqual([]);
    // The successor answers: MSG 1 answered exactly once.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, carrying[0]!.id));
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
      authorType: "agent", createdByRunId: carrying[0]!.id, origin: "comment", body: "answer to MSG 1" });
    expect(await unanswered(f.issueId, [f.held])).toEqual([]);
    expect((await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
      eq(issueComments.authorType, "agent"), eq(issueComments.createdByRunId, carrying[0]!.id))))).toHaveLength(1);
  }, 120_000);

  // send-after-stop3 (713e7d1b)'s Stop shape: the person's Stop of a warm turn, the box handed off, messages saved.
  async function seedStoppedWarmTurn() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sourceRunId = randomUUID();
    const stoppedAt = new Date(Date.now() - 1_000);
    await db.insert(companies).values({ id: companyId, name: "Warm Stop", defaultResponsibleUserId: "board", issuePrefix: `S${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", assigneeAgentId: agentId });
    const leaseId = randomUUID(), providerLeaseId = `bx_${randomUUID().slice(0, 8)}`;
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native",
      status: "cancelled", errorCode: "cancelled", contextSnapshot: { issueId }, finishedAt: stoppedAt,
      runnerProfileJson: { nativeResourceDisposition: "keep_running" },
      resultJson: { stopReason: "cancelled", nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: sourceRunId, companyId,
        issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: stoppedAt.toISOString() } } });
    await db.insert(nativeRunFinalizations).values({ runId: sourceRunId, companyId, issueId, phase: "terminal_failure", failureCode: "native_retry_cancelled" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: sourceRunId, provider: "boat", providerLeaseId,
      status: "retained", leasePolicy: "reuse_by_environment", cleanupStatus: "success", lastUsedAt: stoppedAt,
      metadata: { pluginId: "boat-plugin", warmSandboxIdleTimeoutMs: 8 * 3_600_000, leaseController: currentControllerProcessStamp() } });
    const comments = ["A", "B", "C"].map((body, index) => ({ id: randomUUID(), companyId, issueId, authorType: "user" as const,
      authorUserId: "board", body, createdAt: new Date(stoppedAt.getTime() - 3_000 + index) }));
    await db.insert(issueComments).values(comments);
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId, agentId, source: "on_demand", reason: "issue_commented",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId, _paperclipWakeContext: { wakeCommentIds: comments.map(c => c.id) },
        queuedCommentInterrupt: { actorId: "board", requestedAt: new Date().toISOString() } } });
    // Keeps the successor in the ordinary queue (no provider launch), as interrupt-rows does.
    const blockerId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: blockerId, companyId, agentId, status: "running", contextSnapshot: { issueId: randomUUID() } });
    return { blockerId, companyId, agentId, issueId, sourceRunId, queueId, leaseId, providerLeaseId, commentIds: comments.map(c => c.id as string) };
  }

  it("R12b: warm turn -> Stop -> SERVER RESTART -> Send => ONE run, each held message answered once, within 60 s", async () => {
    proc.restarted = false; proc.calls.length = 0;
    const f = await seedStoppedWarmTurn();
    const server = await restartServer(tempDb.connectionString);
    fresh.push(server.db);
    // The person's Send (as proof-out-of-tx 22b: the Send's resume of the saved messages).
    const sentAt = Date.now();
    await server.heartbeat.resumeQueuedCommentInterrupt(f.companyId, f.queueId, { retryCleanup: true });
    const sendMs = Date.now() - sentAt;
    const stopping = await leaseOf(f.leaseId);
    await evidence("R12b_after_send", { sendMs, wait: (await wakeOf(f.queueId)).payload?.executionWait ?? null,
      lease: { status: stopping.status, intent: stopping.metadata?.sandboxStopAndRetain ?? null } });
    expect(sendMs).toBeLessThan(2_000);
    expect(stopping.status).toBe("pending_cleanup");
    expect(stopping.metadata?.sandboxStopAndRetain).toMatchObject({ runId: f.sourceRunId, providerLeaseId: f.providerLeaseId,
      pluginId: "boat-plugin", handedOffWarmProofUnavailable: true });
    await server.heartbeat.resumeQueuedCommentInterrupt(f.companyId, f.queueId, { retryCleanup: true });
    expect((await runsOf(f.companyId)).map(run => run.id).filter(id => id !== f.blockerId)).toEqual([f.sourceRunId]);
    const settled = await server.settleStopOnlyCleanup(server.db, stopping, { attemptId: String(stopping.metadata?.pendingCleanupAttemptId),
      receipt: { providerLeaseId: f.providerLeaseId, state: "stopped" } });
    expect(settled).toMatchObject({ status: "released", providerLeaseId: f.providerLeaseId });
    await server.heartbeat.resumeRemoteStopComments((await runsOf(f.companyId)).find(run => run.id === f.sourceRunId)!);
    const receipt = await wakeOf(f.queueId);
    const runs = await runsOf(f.companyId);
    const elapsedMs = Date.now() - server.at;
    await evidence("R12b_admitted", { wake: { status: receipt.status, runId: receipt.runId }, elapsedMs,
      runs: runs.filter(run => run.id !== f.blockerId).map(run => ({ source: run.id === f.sourceRunId, status: run.status })) });
    expect(receipt).toMatchObject({ status: "coalesced", payload: { queuedCommentInterrupt: { continuation: {
      previousRunId: f.sourceRunId, queuedCommentInterruptId: f.queueId } } } });
    const successors = runs.filter(run => run.id !== f.sourceRunId && run.id !== f.blockerId);
    expect(successors).toHaveLength(1);
    expect(successors[0]!.id).toBe(receipt.runId);
    expect(elapsedMs).toBeLessThan(60_000);
    const envelope = await server.buildExecutionContinuation({ db: server.db, companyId: f.companyId, issueId: f.issueId,
      agentId: successors[0]!.agentId, runId: successors[0]!.id, context: successors[0]!.contextSnapshot!, summary: null, exposeLowTrustRaw: false });
    expect([...envelope.originCommentIds].sort()).toEqual([...f.commentIds].sort());
    expect(envelope.messages.filter(message => f.commentIds.includes(message.id)).map(message => message.body)).toEqual(["A", "B", "C"]);
    // The ONE successor answers; each held message is answered once.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, successors[0]!.id));
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
      authorType: "agent", createdByRunId: successors[0]!.id, origin: "comment", body: "answer to A, B, C" });
    expect(await unanswered(f.issueId, f.commentIds)).toEqual([]);
  }, 120_000);
});
