import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issueComments,
  issues, nativeRunFinalizations,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";

// pl/pausing (fam-stop r3 gate 2, S10 no-file row): Stop of a warm turn (A), the
// held messages, Send, ONE successor (B) on the SAME box, B answers, then the
// person pauses the agent. Live: status 'paused', lifecycleState 'pausing' for
// 15+ min (agent-execution-stop.ts remote_stop_unconfirmed for A). Real here:
// the Send admission and its out-of-transaction runner-exit proof stamp, B's
// acquisition of the same box (environments.ts replacesReusableLeaseId), the
// keep_running release, the lifecycle driver and the pause. Only the s3 fence's
// boolean answer (a live Boat Runner) is stood in for, as in
// explicit-native-send-after-stop.test.ts.
// pl/pausing2 adds: calls counts the stood-in TERM+exit proof, busy stands in
// for the warm entry's own busy/preparing flag (the real handedOffWarmOwnerRunnerExited
// answers false for it without stopping anything), hang for a proof that never answers.
const proof = vi.hoisted(() => ({ exited: true, calls: 0, busy: false, hang: false, fail: false, txDepth: 0, depths: [] as number[] }));
vi.mock("./native-runtime/native-session-executor.js", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  handedOffWarmOwnerRunnerExited: async () => {
    proof.calls += 1;
    proof.depths.push(proof.txDepth);
    if (proof.busy) return false;
    if (proof.fail) throw new Error('502 persistent audit proof failure');
    if (proof.hang) return new Promise<boolean>(() => undefined);
    return proof.exited;
  },
  handedOffWarmOwnerBusy: () => proof.busy,
}));
const { heartbeatService } = await import("./heartbeat.js");
const { environmentService } = await import("./environments.js");
const { createAgentLifecycle, configureAgentLifecycle } = await import("./agent-lifecycle.js");
const { createLifecycleDriver, pauseProofBound, pauseBoundExport, PAUSE_STOP_UNCONFIRMED_ERROR, PAUSE_EXPORT_KEPT_ERROR } = await import("./agent-lifecycle-driver.js");
const { remoteTerminationReceipt } = await import("./remote-execution-termination.js");
const { agentExecutionStopBlocker } = await import("./agent-execution-stop.js");
const { HANDED_OFF_WARM_EXIT_KEY, HANDED_OFF_WARM_STOP_KEY, handedOffWarmProofTimeout } = await import("./native-runtime/handed-off-warm-lease.js");

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("pl/pausing: pause after a Send's successor on the handed-off warm box", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("pl-pausing-");
    db = createDb(database.connectionString);
    const original = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementation((async (...args: Parameters<typeof db.transaction>) => {
      proof.txDepth++;
      try { return await original(...args); } finally { proof.txDepth--; }
    }) as typeof db.transaction);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seedAgent() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), environmentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Warm Stop", defaultResponsibleUserId: "board", issuePrefix: `P${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner",
      status: "idle", lifecycleState: "ready", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(environments).values({ id: environmentId, companyId, name: `Boat ${environmentId}`, driver: "plugin", status: "active", config: {} } as never);
    return { companyId, agentId, issueId, environmentId, providerLeaseId: `bx_${randomUUID().slice(0, 8)}` };
  }

  /** Stop of a warm turn: A cancelled (acknowledged, keep_running), its lease retained/success with no receipt. */
  async function seedStoppedWarmTurn() {
    const base = await seedAgent();
    const { companyId, agentId, issueId, environmentId, providerLeaseId } = base;
    const sourceRunId = randomUUID(), leaseId = randomUUID();
    const stoppedAt = new Date(Date.now() - 1_000);
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, nativeIssueId: issueId, runtimeMode: "native",
      status: "cancelled", errorCode: "cancelled", contextSnapshot: { issueId }, startedAt: new Date(stoppedAt.getTime() - 5_000), finishedAt: stoppedAt,
      runnerProfileJson: { nativeResourceDisposition: "keep_running" },
      resultJson: { stopReason: "cancelled", nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: sourceRunId, companyId,
        issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: stoppedAt.toISOString() } } });
    await db.insert(nativeRunFinalizations).values({ runId: sourceRunId, companyId, issueId, phase: "terminal_failure", failureCode: "native_retry_cancelled" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, issueId, heartbeatRunId: sourceRunId, provider: "boat", providerLeaseId,
      status: "retained", leasePolicy: "reuse_by_environment", cleanupStatus: "success", metadata: { pluginId: "boat-plugin", agentId } });
    const comments = ["M1", "M2", "M3"].map((body, index) => ({ id: randomUUID(), companyId, issueId, authorType: "user" as const,
      authorUserId: "board", body, createdAt: new Date(stoppedAt.getTime() - 3_000 + index) }));
    await db.insert(issueComments).values(comments);
    const queueId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId, agentId, source: "on_demand", reason: "issue_commented",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId, _paperclipWakeContext: { wakeCommentIds: comments.map(c => c.id) },
        queuedCommentInterrupt: { actorId: "board", requestedAt: new Date().toISOString() } } });
    return { ...base, sourceRunId, leaseId, queueId };
  }

  /** Send: the real admission runs the runner-exit proof and admits ONE successor. */
  async function send(f: Awaited<ReturnType<typeof seedStoppedWarmTurn>>) {
    proof.exited = true;
    await heartbeatService(db).resumeQueuedCommentInterrupt(f.companyId, f.queueId);
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.queueId));
    expect(receipt.status).toBe("coalesced");
    const successorRunId = receipt.runId!;
    // The admission also kicks the queue; let that in-process start attempt drain
    // before this test plays B's turn on the box (the live B was a cold launch there).
    await heartbeatService(db).waitForRunExecutionDrain(successorRunId, { timeoutMs: 30_000 });
    const [a] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    expect(a.metadata?.[HANDED_OFF_WARM_EXIT_KEY]).toMatchObject({ runId: f.sourceRunId });
    return successorRunId;
  }

  /** B's turn on the SAME box: the real reusable-lease replacement (adopt_remote's lease side). */
  async function successorTurn(f: Awaited<ReturnType<typeof seedStoppedWarmTurn>> | Awaited<ReturnType<typeof seedAgent>>,
    runId: string, replacesLeaseId: string | null) {
    await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: f.issueId, startedAt: new Date(),
      errorCode: null, error: null, finishedAt: null,
      runnerProfileJson: { nativeResourceDisposition: "keep_running" } }).where(eq(heartbeatRuns.id, runId));
    const lease = await environmentService(db).acquireLease({ companyId: f.companyId, environmentId: f.environmentId, issueId: f.issueId,
      heartbeatRunId: runId, leasePolicy: "reuse_by_environment", provider: "boat", providerLeaseId: f.providerLeaseId,
      metadata: { pluginId: "boat-plugin", agentId: f.agentId }, ...(replacesLeaseId ? { replacesReusableLeaseId: replacesLeaseId } : {}) });
    return lease;
  }
  async function finishTurn(runId: string, leaseId: string) {
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), controllerLeaseExpiresAt: null }).where(eq(heartbeatRuns.id, runId));
    // keep_running + reuse_by_environment release (environment-runtime.ts releaseForRun).
    await environmentService(db).releaseLease(leaseId, "retained", { cleanupStatus: "success" });
  }

  async function pause(agentId: string) {
    const work = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete",
      runHost: createLifecycleDriver(db, {} as never).runHost });
    await createAgentLifecycle(db).pauseAgent(agentId);
    return work;
  }
  async function processUntil(work: Awaited<ReturnType<typeof pause>>, agentId: string, state: string, ms = 60_000) {
    const deadline = Date.now() + ms;
    let agent = (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
    while (agent.lifecycleState !== state && Date.now() < deadline) {
      await work.process(agentId).catch(() => undefined);
      agent = (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
      if (agent.lifecycleState !== state) await new Promise(resolve => setTimeout(resolve, 200));
    }
    return agent;
  }

  it("Stop -> held -> Send -> ONE successor on the same box answers -> pause settles 'paused' within 60 s", async () => {
    const f = await seedStoppedWarmTurn();
    const b = await send(f);
    const bLease = await successorTurn(f, b, f.leaseId);
    await finishTurn(b, bLease.id);
    const [aLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    // The live rows: A's lease retired to B (expired/released/success + successor binding), NO stop receipt.
    expect(aLease).toMatchObject({ status: "expired", cleanupStatus: "success", providerLeaseId: f.providerLeaseId });
    expect(aLease.metadata?.remoteExecutionTermination).toBeUndefined();
    expect(aLease.metadata?.reusableLeaseSuccessor).toMatchObject({ previousRunId: f.sourceRunId, successorRunId: b });
    const before = Date.now();
    const work = await pause(f.agentId);
    try {
      const agent = await processUntil(work, f.agentId, "paused");
      expect(agent).toMatchObject({ status: "paused", lifecycleState: "paused", lifecycleError: null });
      expect(Date.now() - before).toBeLessThan(60_000);
    } finally { await work.stop(); }
    // B's box is untouched: retained/success, not destroyed, not released; A's row unchanged; nothing deleted.
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, bLease.id)))[0])
      .toMatchObject({ status: "retained", cleanupStatus: "success", releasedAt: null, providerLeaseId: f.providerLeaseId });
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId)))[0])
      .toMatchObject({ status: "expired", cleanupStatus: "success" });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).map(run => run.status).sort())
      .toEqual(["cancelled", "succeeded"]);
  }, 90_000);

  it("pause during B's live turn stays 'pausing' (B is not stopped by this fix) until B ends, then 'paused'", async () => {
    const f = await seedStoppedWarmTurn();
    const b = await send(f);
    const bLease = await successorTurn(f, b, f.leaseId);
    // B's turn in flight: its controller lease is held by the executor.
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 10 * 60_000) }).where(eq(heartbeatRuns.id, b));
    const work = await pause(f.agentId);
    try {
      const pausing = await processUntil(work, f.agentId, "paused", 3_000);
      expect(pausing.lifecycleState).toBe("pausing");
      // The box B is using is not stopped, destroyed or released by the pause.
      const held = (await db.select().from(environmentLeases).where(eq(environmentLeases.id, bLease.id)))[0]!;
      expect(held.metadata?.sandboxStopAndRetain).toBeUndefined();
      expect(held.metadata?.remoteExecutionTermination).toBeUndefined();
      // B's turn ends; its warm box is retained (keep_running release), as after any warm turn.
      await db.update(heartbeatRuns).set({ status: "succeeded", errorCode: null, finishedAt: new Date(), controllerLeaseExpiresAt: null })
        .where(eq(heartbeatRuns.id, b));
      await db.update(environmentLeases).set({ status: "retained", cleanupStatus: "success", releasedAt: null, failureReason: null })
        .where(eq(environmentLeases.id, bLease.id));
      const paused = await processUntil(work, f.agentId, "paused");
      expect(paused).toMatchObject({ status: "paused", lifecycleState: "paused" });
    } finally { await work.stop(); }
  }, 90_000);

  it("plain warm agent (no Stop) paused after a successful warm turn -> 'paused' (base behaviour)", async () => {
    const f = await seedAgent();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "queued", contextSnapshot: { issueId: f.issueId } });
    const lease = await successorTurn(f, runId, null);
    await finishTurn(runId, lease.id);
    const work = await pause(f.agentId);
    try {
      const agent = await processUntil(work, f.agentId, "paused");
      expect(agent).toMatchObject({ status: "paused", lifecycleState: "paused" });
    } finally { await work.stop(); }
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0])
      .toMatchObject({ status: "retained", cleanupStatus: "success", releasedAt: null });
  }, 90_000);

  it("never-OK: without the runner-exit proof naming A, A's retired lease is not stop proof (remote_stop_unconfirmed)", async () => {
    const f = await seedStoppedWarmTurn();
    const b = await send(f);
    const bLease = await successorTurn(f, b, f.leaseId);
    await finishTurn(b, bLease.id);
    const [aLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    const { [HANDED_OFF_WARM_EXIT_KEY]: _exit, ...rest } = aLease.metadata ?? {};
    await db.update(environmentLeases).set({ metadata: rest }).where(eq(environmentLeases.id, f.leaseId));
    expect(await agentExecutionStopBlocker(db, [f.agentId])).toBe("remote_stop_unconfirmed");
    // A successor binding naming another run is not this run's handoff either.
    await db.update(environmentLeases).set({ metadata: { ...aLease.metadata, reusableLeaseSuccessor: {
      ...(aLease.metadata?.reusableLeaseSuccessor as Record<string, unknown>), previousRunId: randomUUID() } } }).where(eq(environmentLeases.id, f.leaseId));
    expect(await agentExecutionStopBlocker(db, [f.agentId])).toBe("remote_stop_unconfirmed");
  }, 90_000);

  // pl/pausing2: a warm Stop and NO Send. A's box is the retained warm handoff
  // (retained/success, no receipt, the warm Runner idle and alive); the pause
  // runs the Send's own out-of-transaction runner-exit proof and settles on it.
  async function noSendLease(f: Awaited<ReturnType<typeof seedStoppedWarmTurn>>) {
    return (await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId)))[0]!;
  }
  async function resume(agentId: string) {
    const work = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete",
      runHost: createLifecycleDriver(db, {} as never).runHost });
    await createAgentLifecycle(db).resumeAgent(agentId);
    return work;
  }
  /** The stopped turn's files (stand-in for the box's workspace): sha of every file. */
  async function filesSha(dir: string) {
    const hash = createHash("sha256");
    for (const name of (await readdir(dir)).sort()) hash.update(name).update(await readFile(join(dir, name)));
    return hash.digest("hex");
  }

  it("pausing2: warm Stop, NO Send, pause -> runner-exit proof stamps A -> 'paused' in 60 s; box kept; resume -> ONE run, files sha-equal", async () => {
    const f = await seedStoppedWarmTurn();
    const files = await mkdtemp(join(tmpdir(), "pl-pausing2-files-"));
    try {
      await writeFile(join(files, "notes.md"), "turn A wrote this\n");
      await writeFile(join(files, "data.json"), JSON.stringify({ step: 3 }));
      const shaBefore = await filesSha(files);
      proof.calls = 0; proof.exited = true;
      const before = Date.now();
      const work = await pause(f.agentId);
      try {
        const agent = await processUntil(work, f.agentId, "paused");
        expect(agent).toMatchObject({ status: "paused", lifecycleState: "paused", lifecycleError: null });
        expect(Date.now() - before).toBeLessThan(60_000);
      } finally { await work.stop(); }
      // The pause TERMed the idle Runner (the stood-in proof) and persisted the stamp naming A.
      expect(proof.calls).toBeGreaterThanOrEqual(1);
      const a = await noSendLease(f);
      expect(a.metadata?.[HANDED_OFF_WARM_EXIT_KEY]).toMatchObject({ runId: f.sourceRunId });
      // GUARD 2: the box is kept: retained/success, unreleased, no stop/destroy intent or receipt.
      expect(a).toMatchObject({ status: "retained", cleanupStatus: "success", releasedAt: null, providerLeaseId: f.providerLeaseId });
      expect(a.metadata?.sandboxStopAndRetain).toBeUndefined();
      expect(a.metadata?.[HANDED_OFF_WARM_STOP_KEY]).toBeUndefined();
      expect(a.metadata?.remoteExecutionTermination).toBeUndefined();
      // Resume, then the held message: ONE run admitted (no refusal).
      const resumed = await resume(f.agentId);
      try {
        const agent = await processUntil(resumed, f.agentId, "ready");
        expect(agent.lifecycleState).toBe("ready");
      } finally { await resumed.stop(); }
      // (the pause cancels the earlier held wake; the person's message after the resume is a new one)
      const [held] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.queueId));
      expect(held.runId).toBeNull();
      const commentId = randomUUID(), queueId = randomUUID();
      await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId, authorType: "user",
        authorUserId: "board", body: "M4 after resume" });
      await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: f.agentId, source: "on_demand",
        reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
        payload: { issueId: f.issueId, _paperclipWakeContext: { wakeCommentIds: [commentId] },
          queuedCommentInterrupt: { actorId: "board", requestedAt: new Date().toISOString() } } });
      const runsBefore = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId));
      const successor = await send({ ...f, queueId });
      const runsAfter = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId));
      expect(runsAfter.length - runsBefore.length).toBe(1);
      expect(runsAfter.filter(run => run.id !== f.sourceRunId).map(run => run.id)).toEqual([successor]);
      expect(await filesSha(files)).toBe(shaBefore);
    } finally { await rm(files, { recursive: true, force: true }); }
  }, 120_000);

  it("pausing2 NEG GUARD 1: busy warm Runner -> no TERM, no stamp, no stop intent; stays 'pausing'", async () => {
    const f = await seedStoppedWarmTurn();
    proof.calls = 0; proof.busy = true;
    const work = await pause(f.agentId);
    try {
      const agent = await processUntil(work, f.agentId, "paused", 3_000);
      expect(agent.lifecycleState).toBe("pausing");
      expect(await agentExecutionStopBlocker(db, [f.agentId])).toBe("remote_stop_unconfirmed");
    } finally { await work.stop(); proof.busy = false; }
    expect(proof.calls).toBe(0);
    const a = await noSendLease(f);
    expect(a.metadata?.[HANDED_OFF_WARM_EXIT_KEY]).toBeUndefined();
    expect(a.metadata?.sandboxStopAndRetain).toBeUndefined();
    expect(a).toMatchObject({ status: "retained", cleanupStatus: "success", releasedAt: null });
  }, 90_000);

  it("pausing2 NEG: another run's runner-exit stamp on A's retained lease is refused", async () => {
    const f = await seedStoppedWarmTurn();
    const a = await noSendLease(f);
    await db.update(environmentLeases).set({ metadata: { ...a.metadata,
      [HANDED_OFF_WARM_EXIT_KEY]: { runId: randomUUID(), provenAt: new Date().toISOString() } } }).where(eq(environmentLeases.id, f.leaseId));
    expect(await agentExecutionStopBlocker(db, [f.agentId])).toBe("remote_stop_unconfirmed");
  }, 90_000);

  it('AUDIT P5 pause proof is called at transaction depth zero and only persists its own stamp', async () => {
    const f = await seedStoppedWarmTurn();
    proof.calls = 0; proof.depths = [];
    const work = await pause(f.agentId);
    try {
      const agent = await processUntil(work, f.agentId, 'paused');
      expect(agent.lifecycleState).toBe('paused');
      expect(proof.depths.length).toBeGreaterThan(0);
      expect(proof.depths.every(depth => depth === 0)).toBe(true);
      console.log('AUDIT_P5_PROOF_DEPTHS', JSON.stringify(proof.depths));
      const a = await noSendLease(f);
      expect(a.metadata?.[HANDED_OFF_WARM_EXIT_KEY]).toMatchObject({ runId: f.sourceRunId });
      expect(a).toMatchObject({ status: 'retained', cleanupStatus: 'success', releasedAt: null });
      expect(a.metadata?.sandboxStopAndRetain).toBeUndefined();
    } finally { await work.stop(); }
  }, 90000);

  it('AUDIT P2 busy owner is not TERMed and settles after owner ends', async () => {
    const f = await seedStoppedWarmTurn();
    proof.calls = 0; proof.busy = true;
    const work = await pause(f.agentId);
    try {
      const waiting = await processUntil(work, f.agentId, 'paused', 1500);
      expect(waiting.lifecycleState).toBe('pausing');
      expect(proof.calls).toBe(0);
      expect((await noSendLease(f)).metadata?.sandboxStopAndRetain).toBeUndefined();
      proof.busy = false;
      const settled = await processUntil(work, f.agentId, 'paused');
      expect(settled).toMatchObject({ lifecycleState: 'paused', lifecycleError: null });
      expect(proof.calls).toBeGreaterThan(0);
    } finally { proof.busy = false; await work.stop(); }
  }, 90000);

  // (rf-4 ruling 22:32Z: P3 replaced) The documented stop_and_retain at the
  // bound is OK, through the export-before-stop guard. Fake clock: Date only
  // (timers stay real); each pass moves the clock past the lifecycle's retryAt,
  // so the bound and the receipt bound are reached inside the test window.
  async function clockedUntil(work: Awaited<ReturnType<typeof pause>>, f: { agentId: string; leaseId: string },
    done: (agent: typeof agents.$inferSelect) => boolean, stepMs = 20_000, maxSteps = 30,
    onPass?: (agent: typeof agents.$inferSelect, lease: typeof environmentLeases.$inferSelect) => void) {
    let agent = (await db.select().from(agents).where(eq(agents.id, f.agentId)))[0]!;
    for (let step = 0; step < maxSteps && !done(agent); step++) {
      await work.process(f.agentId).catch(() => undefined);
      agent = (await db.select().from(agents).where(eq(agents.id, f.agentId)))[0]!;
      onPass?.(agent, (await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId)))[0]!);
      if (!done(agent)) vi.setSystemTime(Date.now() + stepMs);
    }
    return agent;
  }
  const errored = (agent: typeof agents.$inferSelect) => agent.lifecycleState === "paused"
    || (agent.lifecycleError != null && agent.lifecycleOperation?.retryRequired === true);
  /** The provider's stop-and-retain receipt (as settleStopOnlyCleanup writes it). */
  async function receiptArrives(f: Awaited<ReturnType<typeof seedStoppedWarmTurn>>) {
    const lease = await noSendLease(f);
    const { sandboxStopAndRetain: intent, ...rest } = lease.metadata as Record<string, any>;
    const now = new Date();
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", failureReason: null, releasedAt: now,
      metadata: { ...rest, pendingCleanupInFlight: false,
        remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" }),
        sandboxStopAndRetainReceipt: { schema: "paperclip.sandbox-stop-and-retain-receipt.v1", requestId: intent.requestId,
          companyId: lease.companyId, runId: lease.heartbeatRunId, leaseId: lease.id, provider: lease.provider,
          providerLeaseId: lease.providerLeaseId, pluginId: intent.pluginId, method: "environmentStopLease", confirmedAt: now.toISOString() } } })
      .where(eq(environmentLeases.id, f.leaseId));
  }

  it.each(['502', 'hang'])("(rf-4 ruling 22:32Z: P3 replaced) persistent %s: bound <= 2 min (fake clock), stop intent only with no prepared descriptor, no receipt -> lifecycleError + retryRequired + 'Retry now'; Retry opens a NEW receipt window", async mode => {
    const f = await seedStoppedWarmTurn();
    const saved = handedOffWarmProofTimeout.ms;
    handedOffWarmProofTimeout.ms = 100;
    proof.calls = 0; proof.fail = mode === '502'; proof.hang = mode === 'hang';
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const work = await pause(f.agentId);
    try {
      const start = Date.now();
      let intentAt: number | null = null;
      const agent = await clockedUntil(work, f, errored, 20_000, 30, (_agent, lease) => {
        if (intentAt === null && lease.metadata?.sandboxStopAndRetain) intentAt = Date.now();
      });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
      const a = await noSendLease(f);
      console.log('AUDIT_P3', JSON.stringify({ mode, calls: proof.calls, state: agent.lifecycleState, error: agent.lifecycleError,
        boundMs: intentAt === null ? null : intentAt - start, errorMs: Date.now() - start, operation: agent.lifecycleOperation }));
      expect(proof.calls).toBeGreaterThan(1);
      // The bound is reached within 2 min of the fake clock.
      expect(intentAt).not.toBeNull();
      expect(intentAt! - start).toBeLessThanOrEqual(pauseProofBound.ms);
      // The stop intent was written with no prepared descriptor (export-before-stop guard).
      expect((run.runnerProfileJson as Record<string, any>)?.remoteWorkspace?.state).not.toBe("prepared");
      expect(a.metadata?.sandboxStopAndRetain).toMatchObject({ [HANDED_OFF_WARM_STOP_KEY]: true });
      expect(a.metadata?.sandboxStopAndRetainReceipt).toBeUndefined();
      // No receipt: never 'pausing' forever; a TRUE line with "Retry now".
      expect(agent).toMatchObject({ lifecycleState: "pausing", lifecycleError: PAUSE_STOP_UNCONFIRMED_ERROR });
      expect(agent.lifecycleOperation?.retryRequired).toBe(true);
      expect(agent.lifecycleError).toContain("Retry now");
      const firstWindow = (a.metadata?.handedOffWarmPauseProof as { stopRequestedAt: string }).stopRequestedAt;
      // Retry now opens a NEW receipt window: the record's stopRequestedAt is reset, no error until the new bound.
      vi.setSystemTime(Date.now() + 1_000);
      await createAgentLifecycle(db).retry(f.agentId);
      const retried = await clockedUntil(work, f, () => false, 20_000, 2);
      const reset = (await noSendLease(f)).metadata?.handedOffWarmPauseProof as { stopRequestedAt: string };
      expect(Date.parse(reset.stopRequestedAt)).toBeGreaterThan(Date.parse(firstWindow));
      expect(retried).toMatchObject({ lifecycleState: "pausing", lifecycleError: null });
      const again = await clockedUntil(work, f, errored);
      expect(again.lifecycleError).toBe(PAUSE_STOP_UNCONFIRMED_ERROR);
    } finally { vi.useRealTimers(); proof.fail = false; proof.hang = false; handedOffWarmProofTimeout.ms = saved; await work.stop(); }
  }, 60000);

  it("pausing4: the stop's receipt arrives after the bound's intent -> 'paused' (box stopped and kept)", async () => {
    const f = await seedStoppedWarmTurn();
    const saved = handedOffWarmProofTimeout.ms;
    handedOffWarmProofTimeout.ms = 100;
    proof.fail = true;
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const work = await pause(f.agentId);
    try {
      await clockedUntil(work, f, () => false, 5_000, 3);
      expect((await noSendLease(f)).metadata?.sandboxStopAndRetain).toBeTruthy();
      await receiptArrives(f);
      const agent = await clockedUntil(work, f, a => a.lifecycleState === "paused", 2_000, 5);
      expect(agent).toMatchObject({ status: "paused", lifecycleState: "paused", lifecycleError: null });
      expect(await noSendLease(f)).toMatchObject({ status: "released", cleanupStatus: "success", providerLeaseId: f.providerLeaseId });
    } finally { vi.useRealTimers(); proof.fail = false; handedOffWarmProofTimeout.ms = saved; await work.stop(); }
  }, 60000);

  it("pausing4: a busy owner at the bound -> no stop, no TERM; stays 'pausing' with its true state (remote_stop_unconfirmed)", async () => {
    const f = await seedStoppedWarmTurn();
    const saved = handedOffWarmProofTimeout.ms;
    handedOffWarmProofTimeout.ms = 100;
    proof.calls = 0; proof.fail = true;
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const work = await pause(f.agentId);
    try {
      await clockedUntil(work, f, () => false, 20_000, 2);
      const callsBeforeBusy = proof.calls;
      proof.busy = true;
      // Past both bounds (attempts and 2 min) while the owner is busy.
      const agent = await clockedUntil(work, f, () => false, 60_000, 4);
      expect(proof.calls).toBe(callsBeforeBusy);
      expect(agent).toMatchObject({ lifecycleState: "pausing", lifecycleError: null });
      expect(agent.lifecycleOperation).toMatchObject({ pendingReason: "remote_stop_unconfirmed" });
      expect(await agentExecutionStopBlocker(db, [f.agentId])).toBe("remote_stop_unconfirmed");
      const a = await noSendLease(f);
      expect(a.metadata?.sandboxStopAndRetain).toBeUndefined();
      expect(a).toMatchObject({ status: "retained", cleanupStatus: "success", releasedAt: null });
    } finally { vi.useRealTimers(); proof.busy = false; proof.fail = false; handedOffWarmProofTimeout.ms = saved; await work.stop(); }
  }, 60000);

  async function markPrepared(f: Awaited<ReturnType<typeof seedStoppedWarmTurn>>) {
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeResourceDisposition: "keep_running",
      remoteWorkspace: { state: "prepared", leaseId: f.leaseId, providerLeaseId: f.providerLeaseId } } }).where(eq(heartbeatRuns.id, f.sourceRunId));
  }

  it("pausing4: a 'prepared' turn at the bound whose export can't finish -> KEPT (no stop intent) + a true line + Retry now", async () => {
    const f = await seedStoppedWarmTurn();
    await markPrepared(f);
    const saved = handedOffWarmProofTimeout.ms;
    handedOffWarmProofTimeout.ms = 100;
    proof.fail = true;
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const work = await pause(f.agentId);
    try {
      const agent = await clockedUntil(work, f, errored);
      expect(agent).toMatchObject({ lifecycleState: "pausing", lifecycleError: PAUSE_EXPORT_KEPT_ERROR });
      expect(agent.lifecycleOperation?.retryRequired).toBe(true);
      const a = await noSendLease(f);
      expect(a.metadata?.sandboxStopAndRetain).toBeUndefined();
      expect(a).toMatchObject({ status: "retained", cleanupStatus: "success", releasedAt: null });
    } finally { vi.useRealTimers(); proof.fail = false; handedOffWarmProofTimeout.ms = saved; await work.stop(); }
  }, 60000);

  it("pausing4: a 'prepared' turn at the bound is exported first (finalized), THEN the stop intent; receipt -> 'paused'", async () => {
    const f = await seedStoppedWarmTurn();
    await markPrepared(f);
    const saved = handedOffWarmProofTimeout.ms, savedFinish = pauseBoundExport.finish;
    handedOffWarmProofTimeout.ms = 100;
    proof.fail = true;
    const order: string[] = [];
    // Stand-in for the cancel-finalize export owner (its real export is
    // cancel-finalize-warm-stop.test.ts): it finalizes the descriptor.
    pauseBoundExport.finish = async (database, run) => {
      const [lease] = await database.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
      order.push(lease.metadata?.sandboxStopAndRetain ? "stop-before-export" : "export");
      await database.update(heartbeatRuns).set({ runnerProfileJson: { nativeResourceDisposition: "keep_running",
        remoteWorkspace: { state: "finalized", leaseId: f.leaseId, providerLeaseId: f.providerLeaseId } } }).where(eq(heartbeatRuns.id, run.id));
      return { outcome: "finalized" };
    };
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const work = await pause(f.agentId);
    try {
      await clockedUntil(work, f, () => false, 5_000, 3);
      expect(order).toEqual(["export"]);
      expect((await noSendLease(f)).metadata?.sandboxStopAndRetain).toBeTruthy();
      await receiptArrives(f);
      const agent = await clockedUntil(work, f, a => a.lifecycleState === "paused", 2_000, 5);
      expect(agent).toMatchObject({ lifecycleState: "paused", lifecycleError: null });
    } finally { vi.useRealTimers(); pauseBoundExport.finish = savedFinish; proof.fail = false; handedOffWarmProofTimeout.ms = saved; await work.stop(); }
  }, 60000);

  it("pausing2 NEG: proof timeout -> 'pausing' (no stamp, no stop intent); the next attempt proves -> 'paused'", async () => {
    const f = await seedStoppedWarmTurn();
    const saved = handedOffWarmProofTimeout.ms;
    handedOffWarmProofTimeout.ms = 300;
    proof.hang = true;
    const work = await pause(f.agentId);
    try {
      const agent = await processUntil(work, f.agentId, "paused", 3_000);
      expect(agent.lifecycleState).toBe("pausing");
      const a = await noSendLease(f);
      expect(a.metadata?.[HANDED_OFF_WARM_EXIT_KEY]).toBeUndefined();
      expect(a.metadata?.sandboxStopAndRetain).toBeUndefined();
      expect(a.metadata?.[HANDED_OFF_WARM_STOP_KEY]).toBeUndefined();
      proof.hang = false; proof.exited = true;
      const paused = await processUntil(work, f.agentId, "paused");
      expect(paused).toMatchObject({ status: "paused", lifecycleState: "paused" });
    } finally { await work.stop(); proof.hang = false; handedOffWarmProofTimeout.ms = saved; }
  }, 90_000);
});
