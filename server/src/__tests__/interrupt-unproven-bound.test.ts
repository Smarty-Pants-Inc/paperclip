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

// adopt-unproven-bound (V4ROWS point 5, GATING P0 (c) 'stuck'): a person's
// Interrupt of a live warm native turn whose Runner-exit proof comes back
// UNPROVEN in the SAME boot (no restart) must not leave the successor on
// "Waiting for the previous environment to stop" until warm expiry (up to 8 h).
// The proof returns false at once for three causes (native-session-executor
// handedOffWarmOwnerRunnerExited): the stopped turn's session is still busy or
// preparing; the Runner stop fails or is refused (retireSandboxRunnerPortHolders
// throws, owner_not_settled); no exit record (sandboxSessionRunnerExited false).
// All three need a live Boat Runner, so the proof's ANSWER is the only scripted
// edge (false, labelled by cause); everything else is the real Interrupt route,
// real cancel, real release, real admission, real Postgres, and the provider's
// stop receipt through the real settleStopOnlyCleanup (as interrupt-restart).
// Same boot: the lease carries THIS process's holder stamp, so row12b's
// another-boot path never fires; the warm-session map is the real (empty) one,
// so the real handedOffWarmOwnerClaimedByAnotherRun answers unless a control scripts it.
const proc = vi.hoisted(() => ({ cause: "busy_or_preparing" as string, liveClaim: false,
  calls: [] as Array<{ runId: string; providerLeaseId: string | null; cause: string; at: number }> }));
vi.mock("../services/native-runtime/native-session-executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  const { heartbeatRuns: runs } = await import("@paperclipai/db");
  const { eq: same } = await import("drizzle-orm");
  const real = actual as unknown as Record<string, unknown>;
  return {
    ...actual,
    // Provider edge: the s3 fence's proof answers FALSE in this boot (one of the 3 causes).
    handedOffWarmOwnerRunnerExited: async (input: { runId: string; providerLeaseId: string | null }) => {
      proc.calls.push({ ...input, cause: proc.cause, at: Date.now() });
      return false;
    },
    // The real process-local discriminator (absent on the base), unless the control scripts a live claim.
    handedOffWarmOwnerClaimedByAnotherRun: (input: { runId: string; providerLeaseId: string | null }) =>
      proc.liveClaim || (real.handedOffWarmOwnerClaimedByAnotherRun as ((i: unknown) => boolean) | undefined)?.(input) === true,
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
const { currentControllerProcessStamp } = await import("../services/controller-process-identity.js");
const { settleStopOnlyCleanup } = await import("../services/sandbox-stop-and-retain.js");
// The product bound (30 s) is shortened for the row; absent on the base (there: warm expiry).
const handedOff = await import("../services/native-runtime/handed-off-warm-lease.js") as { handedOffWarmUnprovenBound?: { ms: number } };
const BOUND_MS = Number(process.env.UNPROVEN_BOUND_MS ?? 2_000);
if (handedOff.handedOffWarmUnprovenBound) handedOff.handedOffWarmUnprovenBound.ms = BOUND_MS;

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("adopt-unproven-bound: a same-boot UNPROVEN hand-off proof is bounded, never warm expiry", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const userId = "ub-person";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("interrupt-unproven-bound-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Person", email: "ub@example.invalid", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  const evidence = async (label: string, value: unknown) => {
    if (process.env.UB_EVIDENCE) await fs.appendFile(process.env.UB_EVIDENCE, JSON.stringify({ label, value }) + "\n");
  };
  const leaseOf = async (id: string) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0]!;
  const wakeOf = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;
  const runsOf = async (companyId: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
  const unanswered = async (issueId: string, ids: string[]) => db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.issueId, issueId), inArray(issueComments.id, ids), unansweredPersonMessageCommentCondition()));
  async function until<T>(read: () => Promise<T | null | undefined | false>, ms: number) {
    const end = Date.now() + ms;
    for (;;) { const value = await read(); if (value) return value; if (Date.now() > end) return null; await new Promise(r => setTimeout(r, 100)); }
  }

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


  /** The Interrupt, then the turn-finish hook (heartbeat.ts resumeRemoteStopComments) and the Interrupt's dispatch pass, in THIS boot. */
  async function interruptSameBoot(cause: string, liveClaim = false) {
    proc.cause = cause; proc.liveClaim = liveClaim; proc.calls.length = 0;
    const f = await seedLiveNativeTurn();
    const { queueId } = await interruptAndHandOff(f);
    const heartbeat = heartbeatService(db);
    const t0 = Date.now();
    const [stoppedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.liveRunId));
    await heartbeat.resumeRemoteStopComments(stoppedRun!);
    await heartbeat.resumeQueuedCommentInterrupt(f.companyId, queueId);
    return { f, queueId, heartbeat, t0 };
  }

  for (const cause of ["busy_or_preparing", "runner_stop_failed_or_refused", "no_exit_record"]) {
    it(`${cause}: Interrupt, proof UNPROVEN in the same boot -> stop-and-retain within the bound with NO further click, ONE successor, answered once`, async () => {
      const { f, queueId, heartbeat, t0 } = await interruptSameBoot(cause);
      const atOnce = await leaseOf(f.leaseId);
      await evidence(`${cause}_at_once`, { lease: atOnce.status, since: atOnce.metadata?.handedOffWarmUnprovenSince ?? null,
        wait: (await wakeOf(f.wakeId)).payload?.executionWait ?? null, proofCalls: proc.calls.length });
      expect(proc.calls.length).toBeGreaterThan(0);
      expect(atOnce.status).toBe("retained");
      // adopt-unproven-words: the screen's queue GET during the bound names the bound.
      const during = await request(f.client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200);
      await evidence(`${cause}_words_during`, { executionWait: during.body.executionWait ?? null });
      expect(during.body.executionWait).toMatchObject({ reason: "remote_cleanup",
        message: `Waiting up to ${Math.ceil(BOUND_MS / 1000)} seconds for the previous environment to stop. Your message will start automatically.` });
      // No further route call: the one-shot re-proof at the bound must stop and keep the box.
      const stopping = await until(async () => { const lease = await leaseOf(f.leaseId); return lease.status === "pending_cleanup" ? lease : null; },
        BOUND_MS + 8_000);
      const stopMs = Date.now() - t0;
      await evidence(`${cause}_stop`, { stopMs, boundMs: BOUND_MS, lease: stopping ? { status: stopping.status,
        intent: stopping.metadata?.sandboxStopAndRetain ?? null } : null, proofCalls: proc.calls.map(c => c.at - t0) });
      expect(stopping, "stop-and-retain intent within the bound (else: warm expiry)").not.toBeNull();
      expect(stopMs).toBeGreaterThanOrEqual(BOUND_MS - 500);
      expect(stopping!.metadata?.sandboxStopAndRetain).toMatchObject({ runId: f.liveRunId, leaseId: f.leaseId,
        providerLeaseId: f.providerLeaseId, handedOffWarmProofUnproven: true, unprovenBoundMs: BOUND_MS });
      expect(proc.calls.length).toBeGreaterThanOrEqual(2);
      // Idempotent: another pass writes no second stop.
      await heartbeat.resumeQueuedCommentInterrupt(f.companyId, queueId);
      expect((await leaseOf(f.leaseId)).metadata?.sandboxStopAndRetain).toEqual(stopping!.metadata?.sandboxStopAndRetain);
      // The provider's stop receipt (cleanup sweep edge) and the sweep's receipt path.
      const settled = await settleStopOnlyCleanup(db, stopping!, { attemptId: String(stopping!.metadata?.pendingCleanupAttemptId),
        receipt: { providerLeaseId: f.providerLeaseId, state: "stopped" } });
      expect(settled).toMatchObject({ status: "released", providerLeaseId: f.providerLeaseId });
      await heartbeat.resumeRemoteStopComments((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.liveRunId)))[0]!);
      const wake = await wakeOf(f.wakeId);
      const runs = await runsOf(f.companyId);
      const successors = runs.filter(run => run.id !== f.liveRunId && run.contextSnapshot?.issueId === f.issueId);
      const carrying = successors.filter(run => ((run.contextSnapshot?.wakeCommentIds as string[] | undefined) ?? []).includes(f.held));
      const admittedMs = Date.now() - t0;
      await evidence(`${cause}_admitted`, { admittedMs, wake: { status: wake.status, runId: wake.runId },
        successors: successors.map(run => ({ status: run.status, wakeCommentIds: run.contextSnapshot?.wakeCommentIds ?? null })) });
      expect(carrying).toHaveLength(1);
      expect(wake).toMatchObject({ status: "coalesced", runId: carrying[0]!.id });
      expect(admittedMs).toBeLessThan(60_000);
      const after = await request(f.client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200);
      await evidence(`${cause}_words_after`, { executionWait: after.body.executionWait ?? null });
      expect(after.body.executionWait ?? null).toBeNull();
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).map(c => c.cause)).toEqual([]);
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, carrying[0]!.id));
      await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
        authorType: "agent", createdByRunId: carrying[0]!.id, origin: "comment", body: "answer to MSG 1" });
      expect(await unanswered(f.issueId, [f.held])).toEqual([]);
    }, 120_000);
  }

  it("control (process-local): busy/preparing for ANOTHER live turn on the box -> NOT stopped past the bound", async () => {
    const { f, t0 } = await interruptSameBoot("busy_or_preparing", true);
    await new Promise(r => setTimeout(r, BOUND_MS + 2_000));
    const lease = await leaseOf(f.leaseId);
    await evidence("control_live_claim", { waitedMs: Date.now() - t0, lease: lease.status, intent: lease.metadata?.sandboxStopAndRetain ?? null });
    expect(lease.status).toBe("retained");
    expect(lease.metadata?.sandboxStopAndRetain).toBeUndefined();
    // Control for the words: no unproven-bound marker -> today's unbounded words.
    expect(lease.metadata?.handedOffWarmUnprovenSince).toBeUndefined();
    const queue = await request(f.client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200);
    const gate = (await wakeOf(f.wakeId)).payload?.executionWait ?? null;
    await evidence("control_live_claim_words", { executionWait: queue.body.executionWait ?? null, gate });
    // The gate keeps today's remote_cleanup words, and the screen keeps today's hand-off line.
    expect(gate).toMatchObject({ reason: "remote_cleanup",
      message: "Waiting for the previous environment to stop. Your message will start automatically." });
    expect(queue.body.executionWait).toEqual({ reason: "interrupt_handoff", message: "Sending your messages." });
  }, 60_000);

  it("control (database): another RUNNING turn on the task holds the box -> NOT stopped past the bound", async () => {
    proc.liveClaim = false;
    const { f, heartbeat, queueId, t0 } = await interruptSameBoot("busy_or_preparing");
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running", runtimeMode: "native",
      nativeIssueId: f.issueId, contextSnapshot: { issueId: f.issueId } });
    await new Promise(r => setTimeout(r, BOUND_MS + 2_000));
    await heartbeat.resumeQueuedCommentInterrupt(f.companyId, queueId);
    const lease = await leaseOf(f.leaseId);
    await evidence("control_live_run", { waitedMs: Date.now() - t0, lease: lease.status, intent: lease.metadata?.sandboxStopAndRetain ?? null });
    expect(lease.status).toBe("retained");
    expect(lease.metadata?.sandboxStopAndRetain).toBeUndefined();
  }, 60_000);
});
