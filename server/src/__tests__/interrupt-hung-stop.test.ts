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

// adopt-hung-stop (org criterion (b)): after a person's Interrupt of a live warm
// native turn, the Runner-exit proof is UNPROVEN, the unproven bound passes and
// the stop-and-retain request goes to Boat, and Boat NEVER answers (no provider
// receipt ever reaches settleStopOnlyCleanup: the hung stand-in is simply never
// called). Everything else is the real Interrupt route, real cancel, real
// release, real admission and real Postgres, from adopt-unproven-bound's rows.
// The held message must start ONCE within unproven bound + receipt bound + N,
// on a box that is NOT the old one (the old lease carries the existing
// replace-before-reuse marker and stays pending_cleanup: stop debt, never
// reused), and the old session writes nothing into the conversation afterwards.
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
// adopt-hung-stop: the SECOND bound (no stop receipt) is shortened the same way; absent on the base (there: wait forever).
const receiptBound = (handedOff as { handedOffWarmStopReceiptBound?: { ms: number } }).handedOffWarmStopReceiptBound;
const RECEIPT_BOUND_MS = Number(process.env.HUNG_RECEIPT_BOUND_MS ?? 2_000);
if (receiptBound) receiptBound.ms = RECEIPT_BOUND_MS;
/** N: slack past both bounds for the one-shot timer, the redispatch and admission (named in the result). */
const N_MS = 5_000;

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("adopt-hung-stop: Boat never answers the stop-and-retain request; the successor still starts within the bound on a fresh box", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const userId = "hs-person";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("interrupt-hung-stop-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Person", email: "hs@example.invalid", emailVerified: true,
      createdAt: new Date(), updatedAt: new Date() });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  const evidence = async (label: string, value: unknown) => {
    if (process.env.HUNG_EVIDENCE) await fs.appendFile(process.env.HUNG_EVIDENCE, JSON.stringify({ label, value }) + "\n");
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

  /** The person's Interrupt, the unproven bound passes, the stop intent is written: from here Boat is hung or answers. */
  async function interruptToStopIntent() {
    const { f, queueId, heartbeat, t0 } = await interruptSameBoot("runner_stop_failed_or_refused");
    const stopping = await until(async () => { const lease = await leaseOf(f.leaseId); return lease.status === "pending_cleanup" ? lease : null; },
      BOUND_MS + 8_000);
    expect(stopping, "stop-and-retain intent at the unproven bound").not.toBeNull();
    expect(stopping!.metadata?.sandboxStopAndRetain).toMatchObject({ providerLeaseId: f.providerLeaseId, handedOffWarmProofUnproven: true });
    return { f, queueId, heartbeat, t0, stopping: stopping!, stopMs: Date.now() - t0 };
  }
  const carryingOf = async (f: { companyId: string; liveRunId: string; issueId: string; held: string }) =>
    (await runsOf(f.companyId)).filter(run => run.id !== f.liveRunId && run.contextSnapshot?.issueId === f.issueId
      && ((run.contextSnapshot?.wakeCommentIds as string[] | undefined) ?? []).includes(f.held));

  it("HUNG: Boat never answers the stop -> the held message starts ONCE within both bounds + N on a fresh box, the old box is stop debt, the old session writes nothing", async () => {
    const { f, queueId, heartbeat, t0, stopping, stopMs } = await interruptToStopIntent();
    const handOffAt = new Date();
    // Boat is hung: settleStopOnlyCleanup is NEVER called. No further click either.
    const limitMs = BOUND_MS + RECEIPT_BOUND_MS + N_MS;
    const admitted = await until(async () => { const c = await carryingOf(f); return c.length ? c : null; }, limitMs + 1_000);
    const admittedMs = Date.now() - t0;
    const old = await leaseOf(f.leaseId);
    const wake = await wakeOf(f.wakeId);
    await evidence("hung_admitted", { stopMs, admittedMs, limitMs, boundMs: BOUND_MS, receiptBoundMs: RECEIPT_BOUND_MS, nMs: N_MS,
      wake: { status: wake.status, runId: wake.runId, wait: wake.payload?.executionWait ?? null },
      old: { status: old.status, providerLeaseId: old.providerLeaseId, replaceBeforeReuse: old.metadata?.replaceBeforeReuse ?? null,
        overdue: old.metadata?.handedOffWarmStopReceiptOverdue ?? null, intent: Boolean(old.metadata?.sandboxStopAndRetain) },
      successors: admitted ? admitted.map(run => run.id) : null });
    expect(admitted, `the held message starts within ${limitMs} ms with no stop receipt (else: waits for the receipt forever)`).not.toBeNull();
    expect(admitted).toHaveLength(1);
    expect(admittedMs).toBeLessThanOrEqual(limitMs);
    expect(wake).toMatchObject({ status: "coalesced", runId: admitted![0]!.id });
    // The old box: stop still owed (stop debt), never reused (replace-before-reuse).
    expect(old).toMatchObject({ status: "pending_cleanup", providerLeaseId: f.providerLeaseId });
    expect(old.metadata?.sandboxStopAndRetain).toEqual(stopping.metadata?.sandboxStopAndRetain);
    expect(old.metadata?.replaceBeforeReuse).toMatchObject({ schema: "paperclip.replace-before-reuse.v1", predecessorRunId: f.liveRunId });
    // No lease of the successor names the old box (a fresh box is acquired for it).
    const successorLeases = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, admitted![0]!.id));
    expect(successorLeases.filter(lease => lease.providerLeaseId === f.providerLeaseId)).toEqual([]);
    // Once only: further passes add no second successor.
    await heartbeat.resumeQueuedCommentInterrupt(f.companyId, queueId);
    await heartbeat.resumeRemoteStopComments((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.liveRunId)))[0]!);
    expect(await carryingOf(f)).toHaveLength(1);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).map(c => c.cause)).toEqual([]);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, admitted![0]!.id));
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId,
      authorType: "agent", createdByRunId: admitted![0]!.id, origin: "comment", body: "answer to MSG 1" });
    expect(await unanswered(f.issueId, [f.held])).toEqual([]);
    // No second writer: nothing from the old run after the hand-off.
    const oldWrites = (await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
      eq(issueComments.createdByRunId, f.liveRunId)))).filter(c => c.createdAt >= handOffAt);
    expect(oldWrites).toEqual([]);
  }, 120_000);

  it("control: the stop DOES answer within the receipt bound -> today's receipt path, no replace-before-reuse, ONE successor", async () => {
    const { f, heartbeat, t0, stopping } = await interruptToStopIntent();
    const settled = await settleStopOnlyCleanup(db, stopping, { attemptId: String(stopping.metadata?.pendingCleanupAttemptId),
      receipt: { providerLeaseId: f.providerLeaseId, state: "stopped" } });
    expect(settled).toMatchObject({ status: "released", providerLeaseId: f.providerLeaseId });
    await heartbeat.resumeRemoteStopComments((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.liveRunId)))[0]!);
    expect(await carryingOf(f)).toHaveLength(1);
    // Past the receipt bound: nothing marks the answered box for replacement.
    await new Promise(r => setTimeout(r, RECEIPT_BOUND_MS + 1_000));
    const old = await leaseOf(f.leaseId);
    await evidence("control_answered", { ms: Date.now() - t0, old: { status: old.status, replaceBeforeReuse: old.metadata?.replaceBeforeReuse ?? null } });
    expect(old.metadata?.replaceBeforeReuse).toBeUndefined();
    expect(old.metadata?.handedOffWarmStopReceiptOverdue).toBeUndefined();
    expect(await carryingOf(f)).toHaveLength(1);
  }, 120_000);

  it("control: another live turn holds the box -> never stopped, never handed to a fresh box past both bounds", async () => {
    const { f } = await interruptSameBoot("busy_or_preparing", true);
    await new Promise(r => setTimeout(r, BOUND_MS + RECEIPT_BOUND_MS + 1_500));
    const lease = await leaseOf(f.leaseId);
    await evidence("control_live_turn", { lease: { status: lease.status, intent: lease.metadata?.sandboxStopAndRetain ?? null } });
    expect(lease.status).toBe("retained");
    expect(lease.metadata?.sandboxStopAndRetain).toBeUndefined();
    expect(lease.metadata?.replaceBeforeReuse).toBeUndefined();
    expect(await carryingOf(f)).toHaveLength(0);
  }, 120_000);
});
