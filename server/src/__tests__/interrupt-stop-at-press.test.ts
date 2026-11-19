import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  environmentLeases, heartbeatRuns, issueComments, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// adopt-stop-at-press: a person's Interrupt cuts a native turn whose box is
// retained (remote, no stop receipt) but is NOT a hand-off: here the admitted
// disposition is not keep_running (the release still keeps the box running, as
// operator_interrupted's release does). Nothing asked Boat to stop that box, so
// the successor sat on remote_cleanup until warm expiry (release + 300 s idle +
// 120 s margin, ~7 min). With the fix the press requests the stop-and-retain at
// once through the stop-only owner, arms the 60 s receipt bound, and the
// successor starts within seconds of the receipt, or on a fresh box past the
// bound when Boat never answers. Real Interrupt route, real cancel, real release,
// real admission, real Postgres; Boat's stop is the stand-in (settleStopOnlyCleanup
// called = answers; never called = hung). The proof answer is scripted (provider edge).
const proc = vi.hoisted(() => ({ cause: "busy_or_preparing" as string, liveClaim: false, proven: false,
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
      return proc.proven;
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
const { currentControllerProcessStamp } = await import("../services/controller-process-identity.js");
const { settleStopOnlyCleanup } = await import("../services/sandbox-stop-and-retain.js");
const { stopWarmSandboxesPastWindow } = await import("../services/warm-sandbox-expiry.js");
// The product bound (30 s) is shortened for the row; absent on the base (there: warm expiry).
const handedOff = await import("../services/native-runtime/handed-off-warm-lease.js") as { handedOffWarmUnprovenBound?: { ms: number }; handedOffWarmUnprovenWaitMessage: () => string };
const BOUND_MS = Number(process.env.UNPROVEN_BOUND_MS ?? 2_000);
if (handedOff.handedOffWarmUnprovenBound) handedOff.handedOffWarmUnprovenBound.ms = BOUND_MS;
// adopt-hung-stop: the SECOND bound (no stop receipt) is shortened the same way; absent on the base (there: wait forever).
const receiptBound = (handedOff as { handedOffWarmStopReceiptBound?: { ms: number } }).handedOffWarmStopReceiptBound;
const RECEIPT_BOUND_MS = Number(process.env.HUNG_RECEIPT_BOUND_MS ?? 2_000);
if (receiptBound) receiptBound.ms = RECEIPT_BOUND_MS;
/** N: slack past both bounds for the one-shot timer, the redispatch and admission (named in the result). */
const N_MS = 5_000;

const support = await getEmbeddedPostgresTestSupport();
/** The gates' warm window (runner idle default 300 s); expiry adds the 120 s margin. */
const WARM_WINDOW_MS = 300_000;
const EXPIRY_MS = WARM_WINDOW_MS + 120_000;
/** "At the press": the stop is requested within this of the turn-finish hook (never warm expiry). */
const AT_PRESS_MS = 3_000;

describe.skipIf(!support.supported)("adopt-stop-at-press: a person-cut box that is NOT a hand-off is stopped at the press; the wait is bounded", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const userId = "sp-person";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("interrupt-stop-at-press-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Person", email: "sp@example.invalid", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  const evidence = async (label: string, value: unknown) => {
    if (process.env.PRESS_EVIDENCE) await fs.appendFile(process.env.PRESS_EVIDENCE, JSON.stringify({ label, value }) + "\n");
  };
  const leaseOf = async (id: string) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0]!;
  const wakeOf = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;
  const runsOf = async (companyId: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
  async function until<T>(read: () => Promise<T | null | undefined | false>, ms: number) {
    const end = Date.now() + ms;
    for (;;) { const value = await read(); if (value) return value; if (Date.now() > end) return null; await new Promise(r => setTimeout(r, 100)); }
  }

  /** A live native turn on a remote box. disposition: the run's ADMITTED disposition
   * (keep_running = the hand-off path; stop_and_retain = NOT a hand-off). */
  async function seedLiveNativeTurn(disposition: "keep_running" | "stop_and_retain") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), liveRunId = randomUUID();
    const wakeId = randomUUID(), leaseId = randomUUID(), providerLeaseId = `bx_${randomUUID().slice(0, 8)}`;
    const [own, held] = [randomUUID(), randomUUID()];
    const issuePrefix = `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "SP", issuePrefix, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Boat Pi", role: "engineer", status: "running",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
    const t = (m: number) => new Date(Date.now() - (10 - m) * 60_000);
    await db.insert(heartbeatRuns).values({ id: liveRunId, companyId, agentId, invocationSource: "on_demand",
      triggerDetail: "manual", status: "running", runtimeMode: "native", startedAt: t(3), responsibleUserId: userId,
      contextSnapshot: { issueId, wakeCommentId: own, commentId: own, wakeCommentIds: [own], responsibleUserId: userId },
      runnerProfileJson: { nativeResourceDisposition: disposition, nativeWorkspaceSync: { state: "prepared",
        schema: "paperclip.native-workspace-sync/v3", leaseId, remoteCwd: "/home/user/paperclip-workspace", workspaceId: randomUUID(),
        baselineSha256: "a".repeat(64), finalHostSha256: null, providerLeaseId, descriptorSha256: "b".repeat(64),
        resourceDisposition: disposition } } });
    await db.insert(issues).values({ id: issueId, companyId, identifier: `${issuePrefix}-1`, title: "Chat", status: "in_progress",
      priority: "medium", assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: userId,
      conversationState: "active", responsibleUserId: userId, executionRunId: liveRunId });
    await db.update(heartbeatRuns).set({ nativeIssueId: issueId }).where(eq(heartbeatRuns.id, liveRunId));
    await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, heartbeatRunId: liveRunId, provider: "daytona",
      providerLeaseId, status: "active", leasePolicy: "reuse_by_environment",
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/home/user/paperclip-workspace",
        leaseController: currentControllerProcessStamp(), warmSandboxIdleTimeoutMs: WARM_WINDOW_MS } });
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
    const [busy] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: { issueId: randomUUID() } })
      .returning({ id: heartbeatRuns.id });
    const client = express();
    client.use(express.json());
    client.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "session", userId, companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false };
      next();
    });
    client.use("/api", issueRoutes(db, {} as any, {}));
    client.use(errorHandler);
    return { companyId, agentId, issueId, liveRunId, wakeId, leaseId, providerLeaseId, held, client, busyRunId: busy!.id };
  }

  /** The person's real Interrupt click, the Runner's ack and the release (operator_interrupted keeps the box running: retained). */
  async function interruptAndRetain(f: Awaited<ReturnType<typeof seedLiveNativeTurn>>) {
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
      return { queueId: (pressed.body.queueId ?? queue.body.queueId) as string };
    } finally {
      factory.mockRestore();
    }
  }

  /** The Interrupt, then the turn-finish hook (resumeRemoteStopComments) and the Interrupt's dispatch pass, in THIS boot. */
  async function press(disposition: "keep_running" | "stop_and_retain", opts: { proven?: boolean; holder?: boolean } = {}) {
    proc.cause = "runner_stop_failed_or_refused"; proc.liveClaim = false; proc.proven = opts.proven ?? false; proc.calls.length = 0;
    const f = await seedLiveNativeTurn(disposition);
    if (opts.holder) // (c): another live turn holds the same box (its own active lease on it).
      await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: f.busyRunId,
        provider: "daytona", providerLeaseId: f.providerLeaseId, status: "active", leasePolicy: "reuse_by_environment",
        metadata: { driver: "sandbox", sandboxProviderPlugin: true } });
    const { queueId } = await interruptAndRetain(f);
    const heartbeat = heartbeatService(db);
    const [stoppedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.liveRunId));
    const t0 = Date.now();
    await heartbeat.resumeRemoteStopComments(stoppedRun!);
    await heartbeat.resumeQueuedCommentInterrupt(f.companyId, queueId);
    return { f, queueId, heartbeat, t0, stoppedRun: stoppedRun! };
  }
  const carryingOf = async (f: { companyId: string; liveRunId: string; issueId: string; held: string }) =>
    (await runsOf(f.companyId)).filter(run => run.id !== f.liveRunId && run.contextSnapshot?.issueId === f.issueId
      && ((run.contextSnapshot?.wakeCommentIds as string[] | undefined) ?? []).includes(f.held));

  /** The stop intent at the press; when absent (the base) prove, with a clock advance, that only warm expiry would stop the box. */
  async function stopAtPress(f: { leaseId: string; wakeId: string }, t0: number, label: string) {
    const atPress = await until(async () => { const lease = await leaseOf(f.leaseId); return lease.status === "pending_cleanup" ? lease : null; },
      AT_PRESS_MS);
    if (!atPress) {
      const lease = await leaseOf(f.leaseId);
      const releasedAt = lease.lastUsedAt!.getTime();
      const beforeExpiry = await stopWarmSandboxesPastWindow(db, new Date(releasedAt + EXPIRY_MS - 1_000));
      const statusBefore = (await leaseOf(f.leaseId)).status;
      const atExpiry = await stopWarmSandboxesPastWindow(db, new Date(releasedAt + EXPIRY_MS + 1_000));
      const after = await leaseOf(f.leaseId);
      await evidence(`${label}_no_stop_at_press_clock_advance`, { status: lease.status, intent: lease.metadata?.sandboxStopAndRetain ?? null,
        successorWait: { wake: (await wakeOf(f.wakeId)).status, executionWait: (await wakeOf(f.wakeId)).payload?.executionWait ?? null },
        clock: { "release+419s": { stopping: beforeExpiry.stopping, status: statusBefore },
          "release+421s": { stopping: atExpiry.stopping, status: after.status, intent: after.metadata?.sandboxStopAndRetain ?? null } } });
    }
    expect(atPress, `${label}: a stop-and-retain intent at the press (within ${AT_PRESS_MS} ms), never warm expiry (release + ${EXPIRY_MS / 1000} s)`).not.toBeNull();
    expect(atPress!.metadata?.sandboxStopAndRetain).toMatchObject({ personCutStopAtPress: true });
    return { stopping: atPress!, stopMs: Date.now() - t0 };
  }

  it("(a) NOT a hand-off, Boat answers -> stop requested at the press; the successor starts within seconds of the receipt", async () => {
    const { f, heartbeat, t0, queueId } = await press("stop_and_retain");
    const { stopping, stopMs } = await stopAtPress(f, t0, "a");
    // During the receipt wait: the bounded line (receipt phase), not the unbounded generic one.
    const line = (await request(f.client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200)).body.executionWait ?? null;
    expect(await carryingOf(f)).toHaveLength(0);
    const receiptAt = Date.now();
    const settled = await settleStopOnlyCleanup(db, stopping, { attemptId: String(stopping.metadata?.pendingCleanupAttemptId),
      receipt: { providerLeaseId: f.providerLeaseId, state: "stopped" } });
    expect(settled).toMatchObject({ status: "released", providerLeaseId: f.providerLeaseId });
    await heartbeat.resumeRemoteStopComments((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.liveRunId)))[0]!);
    await heartbeat.resumeQueuedCommentInterrupt(f.companyId, queueId);
    const admitted = await until(async () => { const c = await carryingOf(f); return c.length ? c : null; }, 5_000);
    const afterReceiptMs = Date.now() - receiptAt;
    await evidence("a_answered", { stopMs, afterReceiptMs, line, wake: (await wakeOf(f.wakeId)).status, successors: admitted?.map(r => r.id) ?? null });
    expect(line).toMatchObject({ reason: "remote_cleanup", message: handedOff.handedOffWarmUnprovenWaitMessage() });
    expect(admitted, "the successor starts within seconds of the receipt").not.toBeNull();
    expect(admitted).toHaveLength(1);
    expect(afterReceiptMs).toBeLessThan(5_000);
    expect((await leaseOf(f.leaseId)).metadata?.replaceBeforeReuse).toBeUndefined();
  }, 120_000);

  it("(a') NOT a hand-off, Boat never answers -> the successor starts within the receipt bound + N on a fresh box; the old box is stop debt", async () => {
    const { f, t0 } = await press("stop_and_retain");
    const { stopping, stopMs } = await stopAtPress(f, t0, "a_prime");
    const limitMs = AT_PRESS_MS + RECEIPT_BOUND_MS + N_MS;
    const admitted = await until(async () => { const c = await carryingOf(f); return c.length ? c : null; }, limitMs + 1_000);
    const admittedMs = Date.now() - t0;
    const old = await leaseOf(f.leaseId);
    await evidence("a_prime_hung", { stopMs, admittedMs, limitMs, receiptBoundMs: RECEIPT_BOUND_MS,
      old: { status: old.status, replaceBeforeReuse: old.metadata?.replaceBeforeReuse ?? null, overdue: old.metadata?.handedOffWarmStopReceiptOverdue ?? null },
      successors: admitted?.map(r => r.id) ?? null });
    expect(admitted, `the successor starts within ${limitMs} ms with no stop receipt`).not.toBeNull();
    expect(admitted).toHaveLength(1);
    expect(admittedMs).toBeLessThanOrEqual(limitMs);
    expect(old).toMatchObject({ status: "pending_cleanup", providerLeaseId: f.providerLeaseId });
    expect(old.metadata?.sandboxStopAndRetain).toEqual(stopping.metadata?.sandboxStopAndRetain);
    expect(old.metadata?.replaceBeforeReuse).toMatchObject({ schema: "paperclip.replace-before-reuse.v1", predecessorRunId: f.liveRunId });
    const successorLeases = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, admitted![0]!.id));
    expect(successorLeases.filter(lease => lease.providerLeaseId === f.providerLeaseId)).toEqual([]);
  }, 120_000);

  it("(b) control: the hand-off path is unchanged (keep_running, proof proven) -> no stop at the press, the successor takes the same box", async () => {
    const { f, t0 } = await press("keep_running", { proven: true });
    const admitted = await until(async () => { const c = await carryingOf(f); return c.length ? c : null; }, 5_000);
    const lease = await leaseOf(f.leaseId);
    await evidence("b_handoff", { ms: Date.now() - t0, proofCalls: proc.calls.length, lease: { status: lease.status,
      intent: lease.metadata?.sandboxStopAndRetain ?? null, proven: lease.metadata?.handedOffWarmOwnerRunnerExited ?? null }, successors: admitted?.map(r => r.id) ?? null });
    expect(proc.calls.length).toBeGreaterThan(0);
    expect(lease.metadata?.sandboxStopAndRetain).toBeUndefined();
    expect(lease.metadata?.handedOffWarmOwnerRunnerExited).toMatchObject({ runId: f.liveRunId });
    expect(admitted).toHaveLength(1);
  }, 120_000);

  it("(c) control: a live holder on the box -> never stopped at the press, nor past the receipt bound", async () => {
    const { f } = await press("stop_and_retain", { holder: true });
    await new Promise(r => setTimeout(r, AT_PRESS_MS + RECEIPT_BOUND_MS + 1_000));
    const lease = await leaseOf(f.leaseId);
    await evidence("c_live_holder", { lease: { status: lease.status, intent: lease.metadata?.sandboxStopAndRetain ?? null } });
    expect(lease.status).toBe("retained");
    expect(lease.metadata?.sandboxStopAndRetain).toBeUndefined();
    expect(lease.metadata?.replaceBeforeReuse).toBeUndefined();
  }, 120_000);
  it("(p) bc-stop: a person's Stop (not an Interrupt) of a retained box is NOT stopped at the press (the successor is not sent into a stopped-box resume)", async () => {
    proc.cause = "runner_stop_failed_or_refused"; proc.liveClaim = false; proc.proven = false; proc.calls.length = 0;
    const f = await seedLiveNativeTurn("stop_and_retain");
    await interruptAndRetain(f);
    // The cut reshaped as a person's acknowledged Stop (gate 7, run 483f3219): errorCode cancelled, cancelled by the user.
    const [cut] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.liveRunId));
    await db.update(heartbeatRuns).set({ errorCode: "cancelled", resultJson: { ...cut!.resultJson,
      cancelledByActorType: "user", cancelledByUserId: userId } }).where(eq(heartbeatRuns.id, f.liveRunId));
    const [stoppedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.liveRunId));
    await heartbeatService(db).resumeRemoteStopComments(stoppedRun!);
    const atPress = await until(async () => { const lease = await leaseOf(f.leaseId); return lease.status === "pending_cleanup" ? lease : null; },
      AT_PRESS_MS);
    await evidence("p_person_stop", { status: (await leaseOf(f.leaseId)).status,
      intent: (await leaseOf(f.leaseId)).metadata?.sandboxStopAndRetain ?? null });
    expect(atPress?.metadata?.sandboxStopAndRetain ?? null, "a person's Stop is not stop-and-retained at the press").toBeNull();
    expect((await leaseOf(f.leaseId)).status).toBe("retained");
  }, 120_000);
});

