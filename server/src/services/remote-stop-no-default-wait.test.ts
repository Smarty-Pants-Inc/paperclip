import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, companies, companyMemberships, createDb, environmentLeases, heartbeatRuns, issueComments,
  issueRecoveryActions, issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { providerResourceDispositionForTerminalRun } from "./runner-environment-lifecycle.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { agentExecutionStopBlocker } from "./agent-execution-stop.js";
import { recoveryService } from "./recovery/service.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";
import { personFacingText, STOP_ABSENT_LINES } from "../__tests__/helpers/person-facing-lines.js";

// adopt-stopu: no handed-off lease. The stopped run's lease is released as its
// own teardown releases it (runner-environment-lifecycle.ts, the real
// disposition for a person's Stop of a warm run); a stop_and_retain release of a
// reuse lease is `released` with the provider's bound stop receipt
// (environment-runtime.ts releaseRunLease). Everything else is the real code.
const { heartbeatService } = await import("./heartbeat.js");
const { issueRoutes } = await import("../routes/issues.js");
const { errorHandler } = await import("../middleware/index.js");
const { buildExecutionContinuation } = await import("./execution-continuation.js");

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("pl/no-default-wait (U shape): Stop with held messages on a warm box released stop_and_retain", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("no-default-wait-");
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

  // M2-M4 held behind a running turn, then the person's Stop on a warm handed-off box.
  async function seed(options: { receipt?: boolean; person?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), sourceRunId = randomUUID();
    const stoppedAt = new Date(Date.now() - 60_000);
    await db.insert(companies).values({ id: companyId, name: "Warm Stop", defaultResponsibleUserId: "board", issuePrefix: `W${companyId.replaceAll("-", "")}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", assigneeAgentId: agentId, conversationAgentId: agentId, conversationUserId: "board", conversationState: "active" });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native",
      status: "cancelled", errorCode: "cancelled", contextSnapshot: { issueId }, finishedAt: stoppedAt,
      runnerProfileJson: { nativeResourceDisposition: "keep_running" },
      resultJson: options.person === false
        // adopt-stopu-bound2 control: a non-person stop (no person's Stop intent).
        ? { stopReason: "cancelled", cancelledByActorType: "system" } : { stopReason: "cancelled", cancelledByActorType: "user", cancelledByUserId: "board",
        executionCancellation: { state: "acknowledged" },
        nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: sourceRunId, companyId,
          issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
          intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: stoppedAt.toISOString() } } });
    await db.insert(nativeRunFinalizations).values({ runId: sourceRunId, companyId, issueId, phase: "terminal_failure", failureCode: "native_retry_cancelled" });
    const leaseId = randomUUID(), providerLeaseId = "bx_warm";
    const disposition = providerResourceDispositionForTerminalRun("keep_running", "cancelled", "cancelled");
    const identity = { id: leaseId, companyId, heartbeatRunId: sourceRunId, provider: "daytona", providerLeaseId };
    await db.insert(environmentLeases).values({ ...identity, leasePolicy: "reuse_by_environment", cleanupStatus: "success",
      ...(options.receipt === false
        // adopt-stopu r2 (U9): the stop_and_retain release ran, Boat's stop receipt has not landed.
        ? { status: "pending_cleanup", cleanupStatus: "pending", metadata: {} }
        : disposition === "stop_and_retain"
        // The release: released, with Boat's stop receipt landing inside the run's cleanup.
        ? { status: "released", releasedAt: stoppedAt,
            metadata: { remoteExecutionTermination: remoteTerminationReceipt(identity, { providerLeaseId, state: "stopped" }) } }
        // c1x: the warm handoff (retained, still running, no stop receipt).
        : { status: "retained", metadata: {} }) });
    const base = stoppedAt.getTime() - 3_000;
    const comments = ["M2", "M3", "M4"].map((body, index) => ({ id: randomUUID(), companyId, issueId, authorType: "user" as const,
      authorUserId: "board", body, createdAt: new Date(base + index) }));
    await db.insert(issueComments).values(comments);
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId, agentId, source: "on_demand", reason: "issue_commented",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      requestedAt: new Date(base + 10),
      payload: { issueId, commentId: comments.at(-1)!.id, _paperclipWakeContext: { wakeCommentIds: comments.map(c => c.id), wakeReason: "issue_commented" } } });
    return { companyId, agentId, issueId, sourceRunId, queueId, providerLeaseId, commentIds: comments.map(c => c.id as string) };
  }

  const wakeOf = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;
  const readQueue = async (f: { companyId: string; issueId: string }) =>
    (await request(app(f.companyId)).get(`/api/issues/${f.issueId}/queued-comments`).expect(200)).body;

  it("the automatic resume after Stop saves no default wait, keeps the Send line, and Send delivers M2-M4 once", async () => {
    const f = await seed();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    await heartbeatService(db).resumeRemoteStopComments(run);
    vi.setSystemTime(Date.now() + 60_000);
    await heartbeatService(db).resumeRemoteStopComments(run);
    vi.useRealTimers();
    const held = await wakeOf(f.queueId);
    expect(held).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(held.payload?.executionWait).toBeUndefined();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).map(r => r.id)).toEqual([f.sourceRunId]);
    const queue = await readQueue(f);
    expect(queue.executionWait).toEqual({ reason: "stopped_by_person",
      message: "Stopped. These messages are waiting: Send them, or delete any first." });
    expect(queue.entries.map((entry: { comment: { id: string } }) => entry.comment.id)).toEqual(f.commentIds);

    // The person's Send: one successor through the existing admission (same receipt gate).
    const sent = await request(app(f.companyId)).post(`/api/issues/${f.issueId}/queued-comments/interrupt`)
      .send({ queueId: queue.queueId, revision: queue.revision, targetRunId: null });
    expect(sent.status).toBeLessThan(300);
    await vi.waitFor(async () => {
      const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).filter(r => r.id !== f.sourceRunId);
      expect(runs).toHaveLength(1);
    }, { timeout: 15_000, interval: 200 });
    const [successor] = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).filter(r => r.id !== f.sourceRunId);
    const envelope = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId,
      runId: successor.id, context: successor.contextSnapshot!, summary: null, exposeLowTrustRaw: false });
    expect(envelope.messages.filter(message => f.commentIds.includes(message.id)).map(message => message.body)).toEqual(["M2", "M3", "M4"]);
    const done = await wakeOf(f.queueId);
    expect(done.status).not.toBe("deferred_issue_execution");
    expect((done.payload?.executionWait as { reason?: string } | undefined)?.reason).not.toBe("execution_recovery");
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(0);
    // adopt-stopu r2 (rf-4 ii): none of the absent lines in the Stop line, the
    // transcript or the notices (control: the reader sees the held messages).
    const seen = await personFacingText(db, f.companyId, f.issueId);
    expect(seen.text).toContain("\"m2\"");
    expect(STOP_ABSENT_LINES.filter(line => (seen.text + queue.executionWait.message.toLowerCase()).includes(line))).toEqual([]);
  }, 60_000);
  // adopt-stopu U5 (RED at c1x: the warm handoff leaves no stop receipt, so the
  // admission gate explicit-native-continuation.ts remote_cleanup holds the wake).
  it("U5: after the stop_and_retain release no wake waits on remote_cleanup; the +0 message is woken and admitted", async () => {
    const f = await seed();
    const after = { id: randomUUID(), companyId: f.companyId, issueId: f.issueId, authorType: "user" as const,
      authorUserId: "board", body: "Next message", createdAt: new Date() };
    await db.insert(issueComments).values(after);
    // The +0 next message, held while the stopped turn was still cleaning up.
    const nextId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: nextId, companyId: f.companyId, agentId: f.agentId, source: "on_demand",
      reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      requestedAt: new Date(),
      payload: { issueId: f.issueId, commentId: after.id, _paperclipWakeContext: { wakeCommentIds: [after.id], wakeReason: "issue_commented" } } });
    // The end of the stopped run's cleanup (heartbeat.ts -> run-control.ts resumeRemoteStopComments).
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    await heartbeatService(db).resumeRemoteStopComments(run);
    const waits = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
      .map(wake => (wake.payload as Record<string, any> | null)?.executionWait?.reason ?? null);
    expect(waits).not.toContain("remote_cleanup");
    await vi.waitFor(async () => {
      const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).filter(r => r.id !== f.sourceRunId);
      expect(runs).toHaveLength(1);
    }, { timeout: 15_000, interval: 200 });
    expect((await wakeOf(nextId)).status).not.toBe("deferred_issue_execution");
    // The pre-Stop held messages are not started by the automatic pass (Send-only).
    expect((await wakeOf(f.queueId)).status).toBe("deferred_issue_execution");
    const seen = await personFacingText(db, f.companyId, f.issueId);
    expect(seen.text).toContain("next message");
    expect(STOP_ABSENT_LINES.filter(line => seen.text.includes(line))).toEqual([]);
  }, 60_000);
  // adopt-stopu r2 (rf-4 iii / U9): the late stop receipt, by line.
  // - At the end of the stopped run's cleanup heartbeat.ts:4448 calls
  //   resumeRemoteStopComments (run-control.ts:665). Without the receipt,
  //   nativeStopExecutionProven (run-control.ts:797-807) is false, so the
  //   dry-run admission runs (run-control.ts:766-781); it returns null with no
  //   named gate (explicit-native-continuation.ts:363: no recovery action, no
  //   queued Send), so NO executionWait is saved (pl/no-default-wait). The
  //   message stays plain deferred and the person sees the Stop line with Send.
  // - The updatedAt + 30 s re-poll (deferred-receipt-work.ts:156-157, 177-180;
  //   run-control.ts:1076-1125) only re-polls wakes WITH an executionWait, and
  //   the stranded pass (queue.ts:2173+) keeps post-Stop input behind the
  //   Stop: it does not admit this message even after the receipt lands.
  // - What admits it is the receipt writer: the pending-cleanup retry writes
  //   the receipt and calls resumeRemoteStopComments (recovery.ts:2156-2161).
  //   Its cadence: pendingCleanupRetryAfterMs = max(30 s, backoff), at most
  //   30 min (recovery.ts:2148-2149); escalated after
  //   PENDING_CLEANUP_SWEEP_ATTEMPT_CAP = 5 attempts (environment-cleanup-state.ts:10).
  async function heldAfterStop(f: Awaited<ReturnType<typeof seed>>) {
    const after = { id: randomUUID(), companyId: f.companyId, issueId: f.issueId, authorType: "user" as const,
      authorUserId: "board", body: "Next message", createdAt: new Date() };
    await db.insert(issueComments).values(after);
    const nextId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: nextId, companyId: f.companyId, agentId: f.agentId, source: "on_demand",
      reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      requestedAt: new Date(),
      payload: { issueId: f.issueId, commentId: after.id, _paperclipWakeContext: { wakeCommentIds: [after.id], wakeReason: "issue_commented" } } });
    return nextId;
  }
  const successors = async (f: { companyId: string; sourceRunId: string }) =>
    (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).filter(r => r.id !== f.sourceRunId);
  const seenBy = async (f: Awaited<ReturnType<typeof seed>>, nextId: string) => {
    const wake = await wakeOf(nextId);
    const wait = wake.payload?.executionWait as { reason?: string; message?: string } | undefined;
    const cards = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))
      .map(card => `${card.cause}:${card.status}`);
    return { status: wake.status, wait: wait ? { reason: wait.reason, message: wait.message } : null,
      blocker: (await getExecutionBlocker(db, f.companyId, f.issueId))?.nextAction ?? null, cards,
      queueLine: (await readQueue(f)).executionWait?.message ?? null };
  };
  const evidence = async (line: string) => {
    if (process.env.U9_EVIDENCE_FILE) await import("node:fs/promises").then(fs => fs.appendFile(process.env.U9_EVIDENCE_FILE!, `${line}\n`));
  };
  const landReceipt = async (f: Awaited<ReturnType<typeof seed>>) => {
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.sourceRunId));
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date(),
      metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: f.providerLeaseId, state: "stopped" }) } })
      .where(eq(environmentLeases.id, lease.id));
  };
  const STOP_LINE = "Stopped. These messages are waiting: Send them, or delete any first.";

  it("U9 late receipt: held with the Stop/Send line (no wait saved); the 30 s re-poll does not admit it; the receipt writer's resume admits it once", async () => {
    const f = await seed({ receipt: false });
    const nextId = await heldAfterStop(f);
    const service = heartbeatService(db);
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    try {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
      await service.resumeRemoteStopComments(run);   // heartbeat.ts:4448, the end of the run's cleanup
      const atStop = await seenBy(f, nextId);
      expect(atStop).toMatchObject({ status: "deferred_issue_execution", wait: null, blocker: null, cards: [], queueLine: STOP_LINE });
      vi.setSystemTime(t0 + 31_000);
      await service.resumeQueuedRuns();              // the first poll
      expect(await successors(f)).toHaveLength(0);
      vi.setSystemTime(t0 + 40_000);
      await landReceipt(f);                          // late: after the first poll
      vi.setSystemTime(t0 + 71_000);
      await service.resumeQueuedRuns();              // the 30 s re-poll alone
      const rePoll = await seenBy(f, nextId);
      expect(await successors(f)).toHaveLength(0);
      expect(rePoll).toMatchObject({ status: "deferred_issue_execution", queueLine: STOP_LINE });
      await service.resumeRemoteStopComments(run);   // recovery.ts:2161, the receipt writer
      vi.useRealTimers();
      await vi.waitFor(async () => expect(await successors(f)).toHaveLength(1), { timeout: 15_000, interval: 200 });
      expect((await wakeOf(nextId)).status).not.toBe("deferred_issue_execution");
      expect((await seenBy(f, nextId)).cards).toEqual([]);   // adopt-stopu-bound2: late receipt, no card
      const seen = await import("../__tests__/helpers/person-facing-lines.js").then(m => m.personFacingText(db, f.companyId, f.issueId));
      await evidence(`late ${JSON.stringify({ atStop, rePoll, successors: (await successors(f)).length, willStartAutomatically: seen.text.includes("will start automatically") })}`);
    } finally { vi.useRealTimers(); }
  }, 60_000);

  // adopt-stopu-bound2: the receipt never arrives. BOUND, by line:
  //   the environment-cleanup worker sweeps with backoffMs = ENVIRONMENT_CLEANUP_RETRY_MS
  //   = 5 min (environment-cleanup-work.ts, environment-cleanup-state.ts:7); the
  //   lease is due at updatedAt + 5 min (recovery.ts sweep cutoff), so the first
  //   retry runs 5 min after the Stop. Without the receipt that retry raises the
  //   existing Stop-pending card (PERSON_STOP_CARD_ATTEMPTS = 1) for a person's
  //   Stop. Stop -> card = 5 min (+ at most one 30 s worker tick).
  // Counts only this row's lease (other rows' leases in this database stay stuck too).
  const stuckRuntime = (calls: { n: number; runId: string }, receiptAt?: number) => ({
    retryPendingSandboxTeardown: async ({ lease }: { lease: { providerLeaseId: string | null; heartbeatRunId: string | null } }) => {
      if (lease.heartbeatRunId !== calls.runId) throw new Error("sandbox_stop_pending");
      calls.n += 1;
      if (receiptAt !== undefined && calls.n >= receiptAt) return { providerLeaseId: lease.providerLeaseId, state: "stopped" };
      throw new Error("sandbox_stop_pending");   // Boat's stop stuck: no receipt
    },
  }) as never;
  const RETRY_MS = 5 * 60_000;   // ENVIRONMENT_CLEANUP_RETRY_MS
  const CARD = "execution_stop_pending:escalated";
  const leaseOf = async (f: { sourceRunId: string }) =>
    (await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.sourceRunId)))[0]!;

  it("U9 BOUND: the receipt never arrives: at 5 min the Stop-pending card + its true line; Send then shows no 'will start automatically'", async () => {
    const f = await seed({ receipt: false });
    const nextId = await heldAfterStop(f);
    const calls = { n: 0, runId: f.sourceRunId };
    const service = heartbeatService(db);
    const cleanup = heartbeatService(db, { environmentRuntime: stuckRuntime(calls) });
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    const trail: unknown[] = [];
    try {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
      await service.resumeRemoteStopComments(run);
      vi.setSystemTime(t0 + 4 * 60_000);
      await cleanup.sweepPendingCleanupLeases({ backoffMs: RETRY_MS });   // not due yet
      const before = await seenBy(f, nextId);
      trail.push({ atMs: 4 * 60_000, attempts: calls.n, ...before });
      expect(calls.n).toBe(0);
      expect(before.cards).toEqual([]);
      vi.setSystemTime(t0 + RETRY_MS);
      await cleanup.sweepPendingCleanupLeases({ backoffMs: RETRY_MS });   // the first retry: still no receipt
      const atBound = await seenBy(f, nextId);
      trail.push({ atMs: RETRY_MS, attempts: calls.n, ...atBound });
      expect(calls.n).toBe(1);
      expect(atBound.cards).toEqual([CARD]);
      const [card] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
      trail.push({ cardLine: card!.nextAction });
      expect(card!.nextAction).toContain("Paperclip cannot confirm that the previous execution stopped.");
      expect(atBound.status).toBe("deferred_issue_execution");
      // The person presses Send at the bound.
      const queue = await readQueue(f);
      const sent = await request(app(f.companyId)).post(`/api/issues/${f.issueId}/queued-comments/interrupt`)
        .send({ queueId: queue.queueId, revision: queue.revision, targetRunId: null });
      vi.setSystemTime(t0 + RETRY_MS + 31_000);
      await service.resumeQueuedRuns();
      const wakes = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)))
        .map(w => ({ id: w.id === nextId ? "next" : w.id === f.queueId ? "queue" : "other", status: w.status,
          wait: (w.payload as Record<string, any> | null)?.executionWait ?? null }));
      const afterSendQueue = await readQueue(f);
      const seen = await personFacingText(db, f.companyId, f.issueId);
      const lines = [seen.text, sent.body?.executionWait?.message ?? "", afterSendQueue.executionWait?.message ?? "",
        ...wakes.map(w => w.wait?.message ?? "")].join("\n").toLowerCase();
      trail.push({ afterSend: { status: sent.status, sendLine: sent.body?.executionWait ?? null,
        queueLine: afterSendQueue.executionWait ?? null, successors: (await successors(f)).length, wakes } });
      expect(await successors(f)).toHaveLength(0);
      expect(wakes.find(w => w.id === "queue")?.wait).toMatchObject({ reason: "execution_stop_pending",
        message: "Stop pending: Paperclip cannot confirm that the previous execution stopped. Your message is saved." });
      expect(lines).not.toContain("will start automatically");
      expect(afterSendQueue.executionWait).toEqual({ reason: "execution_stop_pending",
        message: "Stop pending: Paperclip cannot confirm that the previous execution stopped. Your message is saved." });
    } finally { vi.useRealTimers(); await evidence(`bound ${JSON.stringify(trail)}`); }
  }, 60_000);

  it("U9 BOUND, receipt after the card: the retry that gets the receipt retires the card and admits the message once", async () => {
    const f = await seed({ receipt: false });
    const nextId = await heldAfterStop(f);
    const calls = { n: 0, runId: f.sourceRunId };
    const cleanup = heartbeatService(db, { environmentRuntime: stuckRuntime(calls, 2) });
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    try {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
      await heartbeatService(db).resumeRemoteStopComments(run);
      vi.setSystemTime(t0 + RETRY_MS);
      await cleanup.sweepPendingCleanupLeases({ backoffMs: RETRY_MS });
      expect((await seenBy(f, nextId)).cards).toEqual([CARD]);
      vi.setSystemTime(t0 + 2 * RETRY_MS + 1_000);
      await cleanup.sweepPendingCleanupLeases({ backoffMs: RETRY_MS });   // the receipt lands
      vi.useRealTimers();
      expect(calls.n).toBe(2);
      await vi.waitFor(async () => expect(await successors(f)).toHaveLength(1), { timeout: 15_000, interval: 200 });
      const after = await seenBy(f, nextId);
      await evidence(`receiptAfterCard ${JSON.stringify({ attempts: calls.n, ...after, successors: (await successors(f)).length })}`);
      expect(after.cards).toEqual(["execution_stop_pending:resolved"]);
      expect(after.status).not.toBe("deferred_issue_execution");
    } finally { vi.useRealTimers(); }
  }, 60_000);

  it("U9 control: a non-person stop's cleanup escalation is unchanged (no card; capped at 5 attempts, then 30 min)", async () => {
    const f = await seed({ receipt: false, person: false });
    const calls = { n: 0, runId: f.sourceRunId };
    const cleanup = heartbeatService(db, { environmentRuntime: stuckRuntime(calls) });
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    const capped: unknown[] = [];
    try {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        vi.setSystemTime(t0 + attempt * (RETRY_MS + 1_000));
        await cleanup.sweepPendingCleanupLeases({ backoffMs: RETRY_MS });
        const metadata = (await leaseOf(f)).metadata as Record<string, unknown>;
        capped.push({ attempts: metadata.pendingCleanupRetryAttempts, warned: metadata.pendingCleanupRetryCapWarned ?? null,
          retryAfterMinutes: (Number(metadata.pendingCleanupRetryAfterMs) - Date.now()) / 60_000 });
      }
      const lease = await leaseOf(f);
      expect(calls.n).toBe(5);
      expect(capped.map(row => (row as { retryAfterMinutes: number }).retryAfterMinutes)).toEqual([5, 5, 5, 5, 30]);
      expect(lease.metadata?.pendingCleanupRetryAfterMs).toBe(t0 + 5 * (RETRY_MS + 1_000) + 30 * 60_000);
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))).toHaveLength(0);
      await evidence(`control ${JSON.stringify({ attempts: calls.n, capped, retryAfterMs: lease.metadata?.pendingCleanupRetryAfterMs, t0 })}`);
    } finally { vi.useRealTimers(); }
  }, 60_000);

  // adopt-stopu PAUSE row (unit): after a Stop + a successor, the agent's pause is not
  // held by remote_stop_unconfirmed (agent-execution-stop.ts executionStopBlocker): the
  // stop_and_retain release wrote the receipt. RED at c1x (the warm handoff has none).
  it("PAUSE: after a Stop + a successor, no remote_stop_unconfirmed blocker holds the agent's pause", async () => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ id: randomUUID(), companyId: f.companyId, agentId: f.agentId, nativeIssueId: f.issueId,
      runtimeMode: "native", status: "succeeded", contextSnapshot: { issueId: f.issueId }, finishedAt: new Date() });
    expect(await agentExecutionStopBlocker(db, [f.agentId])).not.toBe("remote_stop_unconfirmed");
  });
});
