import { randomUUID } from "node:crypto";
import { setImmediate as immediate } from "node:timers/promises";
import { setTimeout as realTimeout, clearTimeout as clearRealTimeout } from "node:timers";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments,
  issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerDeferredReceiptWork } from "../services/heartbeat/deferred-receipt-work.js";
import { createHeartbeatQueue } from "../services/heartbeat/queue.js";
import { heartbeatService } from "../services/heartbeat.js";
import { saveUndeliveredUserComments } from "../services/work-intent-outbox.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

// S124 (STOP-PATH-SITES-1117): a parked wake (a person's saved Send behind a
// Stop) retried at updatedAt + 30 s, and every failed retry rewrote updatedAt,
// so the silence could grow without bound. The owner ruling: a monotonic
// deadline from the FIRST park, stored once as payload.firstParkedAt; the 30 s
// cadence counts from it; after the deadline ONE true note + Retry, and no
// further silent retries. The deadline is the existing bound this wait already
// has (the unanswered-message pending-attempt bound, 2 min).
const RETRY_MS = 30_000;
const DEADLINE_MS = 2 * 60_000;

vi.setConfig({ testTimeout: 120_000 });
function waitForReal(assertion: () => unknown | Promise<unknown>, { timeout = 5_000 } = {}) {
  return new Promise<void>((resolve, reject) => {
    let settled = false, lastError: unknown;
    let retry: ReturnType<typeof realTimeout> | undefined;
    const deadline = realTimeout(() => finish(lastError ?? new Error("Expectation did not complete before its deadline")), timeout);
    function finish(error?: unknown) {
      if (settled) return;
      settled = true; clearRealTimeout(deadline); if (retry) clearRealTimeout(retry);
      if (error) reject(error); else resolve();
    }
    async function attempt() {
      try { await assertion(); finish(); }
      catch (error) { lastError = error; if (!settled) retry = realTimeout(attempt, 50); }
    }
    void attempt();
  });
}

describe("S124 parked wake: monotonic first-park deadline", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator>;
  const errors: unknown[] = [];
  beforeAll(async () => {
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_DEFERRED_RECEIPT_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("s124-parked-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    db.$client.options.onnotice = () => {};
  });
  beforeEach(async () => {
    await db.execute(sql`truncate companies cascade`); errors.length = 0;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true,
      onError: error => { errors.push(error); } });
  });
  afterEach(async () => {
    await coordinator.stop(); vi.useRealTimers(); vi.restoreAllMocks(); expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), actorId = "s124-user";
    await db.insert(authUsers).values({ id: actorId, name: "Parked sender", email: `${actorId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companies).values({ id: companyId, name: "S124", issuePrefix: `S${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: actorId, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalId: actorId, principalType: "user", status: "active", membershipRole: "owner" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Parked process", adapterType: "process", status: "idle",
      adapterConfig: { command: process.execPath, args: ["-e", "console.log('s124-proof')"], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0, wakeOnDemand: true } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Send after Stop", status: "todo", assigneeAgentId: agent.id }).returning();
    const [message] = await db.insert(issueComments).values({ companyId, issueId: issue.id, body: "please continue",
      authorType: "user", authorUserId: actorId }).returning();
    return { companyId, agent, issue, actorId, message };
  }
  async function park(f: Awaited<ReturnType<typeof fixture>>, parkedAt: Date, extra: Record<string, unknown> = {}) {
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id,
      source: "on_demand", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: f.actorId,
      payload: { issueId: f.issue.id, queuedCommentInterrupt: { actorId: f.actorId,
        requestedAt: new Date(parkedAt.getTime() - 1_000).toISOString() },
      _paperclipWakeContext: { wakeCommentIds: [f.message.id] }, ...extra },
      requestedAt: parkedAt, updatedAt: parkedAt }).returning();
    return wake;
  }
  async function step(to: number) {
    await vi.advanceTimersByTimeAsync(Math.max(1, to - Date.now()));
    await waitForReal(() => expect(idleWorkSnapshot().active).toBe(0));
    await immediate();
  }
  // Production's periodic tick (queue.ts resumeQueuedRuns): the unscoped scan
  // that retries every parked Send whose updatedAt is 30 s old.
  async function tick(queue: ReturnType<typeof createHeartbeatQueue>, to: number) {
    await step(to);
    await queue.resumeDeferredExecutionReceipts();
    await waitForReal(() => expect(idleWorkSnapshot().active).toBe(0));
  }
  const notes = (issueId: string) => db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId),
    eq(issueComments.authorType, "system")));
  const readWake = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;

  it("three failed retries from the first park, then ONE true note + Retry at first park + deadline; no silent retries after", async () => {
    const f = await fixture(), parkedAt = new Date();
    const wake = await park(f, parkedAt);
    // Every retry fails the way production does: the scan rewrites updatedAt
    // (queue.ts re-dispatch claim) and the dispatch leaves the wake parked.
    const deps = createHeartbeatQueueTestDependencies(db), queue = createHeartbeatQueue(db, deps);
    await registerDeferredReceiptWork(db, coordinator, { resume: scope => queue.resumeDeferredExecutionReceipts(scope),
      settleTaskChat: async () => {}, createNativeBatch: () => async () => {}, schedulingSuppressed: async () => false }, () => true).ready;
    const at = parkedAt.getTime();
    await tick(queue, at + RETRY_MS - 1_000);
    expect(deps.resumeQueuedCommentInterrupt).toHaveBeenCalledTimes(0);
    // The periodic tick every 5 s until just before the deadline: at least
    // three retries fail, each rewrites updatedAt, and no note is written yet.
    for (let t = at + RETRY_MS; t <= at + DEADLINE_MS - 5_000; t += 5_000) await tick(queue, t);
    const retries = deps.resumeQueuedCommentInterrupt.mock.calls.length;
    expect(retries).toBeGreaterThanOrEqual(3);
    expect(retries).toBeLessThanOrEqual(DEADLINE_MS / RETRY_MS);
    expect((await readWake(wake.id)).updatedAt.getTime()).toBeGreaterThan(at + 2 * RETRY_MS);
    expect(await notes(f.issue.id)).toHaveLength(0);
    // The deadline counts from the FIRST park, not from the last rewrite.
    for (let t = at + DEADLINE_MS - 4_000; t <= at + DEADLINE_MS + 1_000; t += 1_000) await tick(queue, t);
    await waitForReal(async () => expect(await notes(f.issue.id)).toHaveLength(1));
    const atDeadline = deps.resumeQueuedCommentInterrupt.mock.calls.length;
    expect(atDeadline).toBeLessThanOrEqual(DEADLINE_MS / RETRY_MS);
    expect((await readWake(wake.id)).payload?.firstParkedAt).toBe(parkedAt.toISOString());
    const [note] = await notes(f.issue.id);
    expect(note.body).toMatch(/saved/i);
    expect(note.body).toMatch(/did not start/i);
    expect(note.body).toMatch(/Retry/);
    expect(note.body).not.toMatch(/by itself|automatically/i);
    expect((note.metadata as unknown as Record<string, unknown> | null)?.authorizationReason).toBe(`unanswered_message:${f.message.id}`);
    const noted = await readWake(wake.id);
    expect(noted.status).toBe("deferred_issue_execution");
    expect(noted.payload?.firstParkedAt).toBe(parkedAt.toISOString());
    // R-ONCE and no further silent retries: ten more minutes, nothing moves.
    for (let i = 1; i <= 20; i++) await tick(queue, at + DEADLINE_MS + 1_000 + i * RETRY_MS);
    expect(deps.resumeQueuedCommentInterrupt).toHaveBeenCalledTimes(atDeadline);
    expect(await notes(f.issue.id)).toHaveLength(1);
    // A company-wide scan (no exact hint) does not retry the noted wake either.
    await queue.resumeDeferredExecutionReceipts({ companyId: f.companyId });
    expect(deps.resumeQueuedCommentInterrupt).toHaveBeenCalledTimes(atDeadline);
  });

  it("Retry (the saved message's Send press) starts exactly one run and re-anchors the park", async () => {
    const f = await fixture(), parkedAt = new Date();
    const wake = await park(f, parkedAt);
    const deps = createHeartbeatQueueTestDependencies(db), queue = createHeartbeatQueue(db, deps);
    await registerDeferredReceiptWork(db, coordinator, { resume: scope => queue.resumeDeferredExecutionReceipts(scope),
      settleTaskChat: async () => {}, createNativeBatch: () => async () => {}, schedulingSuppressed: async () => false }, () => true).ready;
    for (let t = parkedAt.getTime() + 5_000; t <= parkedAt.getTime() + DEADLINE_MS + 1_000; t += 5_000) await tick(queue, t);
    await waitForReal(async () => expect(await notes(f.issue.id)).toHaveLength(1));
    // The press, as routes/issues.ts queued-comments/interrupt writes it, then
    // its direct dispatch through the real heartbeat, on wall time (a real
    // process run holds real leases).
    await coordinator.stop(); vi.useRealTimers();
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true,
      onError: error => { errors.push(error); } });
    const pressedAt = new Date(Math.max(Date.now(), parkedAt.getTime() + DEADLINE_MS + 2_000));
    const current = await readWake(wake.id);
    await db.update(agentWakeupRequests).set({ payload: { ...current.payload!, queuedCommentInterrupt: {
      actorId: f.actorId, requestedAt: pressedAt.toISOString() } }, updatedAt: pressedAt }).where(eq(agentWakeupRequests.id, wake.id));
    const heartbeat = heartbeatService(db);
    await heartbeat.registerRunDispatchWork(coordinator, () => true).ready;
    await heartbeat.resumeQueuedCommentInterrupt(f.companyId, wake.id, { retryCleanup: true });
    // The message's run (its own wake reason); the agent's later disposition
    // repair runs are Paperclip's ordinary follow-up, not a second send.
    const messageRuns = () => db.select().from(heartbeatRuns).where(and(
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issue.id}`,
      sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' = 'issue_commented'`));
    await waitForReal(async () => {
      const runs = await messageRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status, JSON.stringify({ error: runs[0]!.error, code: runs[0]!.errorCode })).toBe("succeeded");
    }, { timeout: 30_000 });
    await heartbeat.drainActiveRunExecutions();
    const runs = await messageRuns();
    expect(runs).toHaveLength(1);
    expect(JSON.stringify(runs[0]!.contextSnapshot)).toContain(f.message.id);
    expect((await readWake(wake.id)).status).not.toBe("deferred_issue_execution");
    await heartbeat.resumeQueuedCommentInterrupt(f.companyId, wake.id, { retryCleanup: true });
    await heartbeat.drainActiveRunExecutions();
    expect(await messageRuns()).toHaveLength(1);
    await issueServiceDone(f.issue.id);
    await heartbeat.drainActiveRunExecutions();
  });

  it("a wake that succeeds on its 2nd retry gets no note", async () => {
    const f = await fixture(), parkedAt = new Date();
    const wake = await park(f, parkedAt);
    const deps = createHeartbeatQueueTestDependencies(db), queue = createHeartbeatQueue(db, deps);
    deps.resumeQueuedCommentInterrupt.mockImplementation(async () => {
      if (deps.resumeQueuedCommentInterrupt.mock.calls.length === 2) await db.update(agentWakeupRequests)
        .set({ status: "completed", finishedAt: new Date(), updatedAt: new Date() }).where(eq(agentWakeupRequests.id, wake.id));
    });
    await registerDeferredReceiptWork(db, coordinator, { resume: scope => queue.resumeDeferredExecutionReceipts(scope),
      settleTaskChat: async () => {}, createNativeBatch: () => async () => {}, schedulingSuppressed: async () => false }, () => true).ready;
    for (let t = parkedAt.getTime() + 5_000; t <= parkedAt.getTime() + 2 * DEADLINE_MS; t += 5_000) await tick(queue, t);
    expect(deps.resumeQueuedCommentInterrupt).toHaveBeenCalledTimes(2);
    expect(await notes(f.issue.id)).toHaveLength(0);
  });

  it("the S10 Send with its exact Stop proof is still dispatched at once, even on an old anchor", async () => {
    const f = await fixture(), parkedAt = new Date();
    // An earlier park's anchor, long past its deadline, and a fresh press.
    const old = new Date(parkedAt.getTime() - 60 * 60_000).toISOString();
    const wake = await park(f, parkedAt, { firstParkedAt: old, parkedNoticeAt: old });
    await db.update(agentWakeupRequests).set({ payload: sql`jsonb_set(${agentWakeupRequests.payload},
      '{queuedCommentInterrupt,requestedAt}', to_jsonb(${parkedAt.toISOString()}::text))` }).where(eq(agentWakeupRequests.id, wake.id));
    const deps = createHeartbeatQueueTestDependencies(db);
    const queue = createHeartbeatQueue(db, { ...deps, queuedCommentInterruptTargetStopped: async () => true });
    await queue.resumeDeferredExecutionReceipts({ companyId: f.companyId, requestId: wake.id });
    expect(deps.resumeQueuedCommentInterrupt).toHaveBeenCalledExactlyOnceWith(f.companyId, wake.id);
    expect(Date.now() - parkedAt.getTime()).toBeLessThan(RETRY_MS);
    expect(await notes(f.issue.id)).toHaveLength(0);
  });

  it("a new park (a later press) gets a fresh anchor, not the earlier park's", async () => {
    const f = await fixture(), parkedAt = new Date();
    const stale = new Date(parkedAt.getTime() - 60 * 60_000).toISOString();
    const wake = await park(f, parkedAt, { firstParkedAt: stale, parkedNoticeAt: stale });
    const deps = createHeartbeatQueueTestDependencies(db), queue = createHeartbeatQueue(db, deps);
    await registerDeferredReceiptWork(db, coordinator, { resume: scope => queue.resumeDeferredExecutionReceipts(scope),
      settleTaskChat: async () => {}, createNativeBatch: () => async () => {}, schedulingSuppressed: async () => false }, () => true).ready;
    await tick(queue, parkedAt.getTime() + RETRY_MS + 1_000);
    await waitForReal(() => expect(deps.resumeQueuedCommentInterrupt).toHaveBeenCalledTimes(1));
    expect(await notes(f.issue.id)).toHaveLength(0);
    const row = await readWake(wake.id);
    expect(Date.parse(String(row.payload?.firstParkedAt))).toBeGreaterThanOrEqual(parkedAt.getTime() - 1_000);
  });

  // S124c (RFL ruling): only a NAMED wait the person controls (their own
  // pause, a budget limit) may stay unbounded. A Stop/Send park refused into
  // any other executionWait (the live case: interrupt_handoff, "Sending your
  // messages." for 5+ min with no run) is exactly the silent loop S124 bounds.
  it.each([
    ["interrupt_handoff", "Sending your messages."],
    ["remote_cleanup", "Waiting for the previous environment to stop. Your message will start automatically."],
  ])("a Send parked in executionWait %s whose re-dispatch keeps failing gets ONE note at first park + deadline", async (reason, message) => {
    const f = await fixture(), parkedAt = new Date();
    const wake = await park(f, parkedAt, { executionWait: { reason, message } });
    const deps = createHeartbeatQueueTestDependencies(db), queue = createHeartbeatQueue(db, deps);
    await registerDeferredReceiptWork(db, coordinator, { resume: scope => queue.resumeDeferredExecutionReceipts(scope),
      settleTaskChat: async () => {}, createNativeBatch: () => async () => {}, schedulingSuppressed: async () => false }, () => true).ready;
    const at = parkedAt.getTime();
    for (let t = at + 5_000; t <= at + DEADLINE_MS - 5_000; t += 5_000) await tick(queue, t);
    expect(deps.resumeQueuedCommentInterrupt.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(await notes(f.issue.id)).toHaveLength(0);
    for (let t = at + DEADLINE_MS - 4_000; t <= at + DEADLINE_MS + 1_000; t += 1_000) await tick(queue, t);
    await waitForReal(async () => expect(await notes(f.issue.id)).toHaveLength(1));
    const atDeadline = deps.resumeQueuedCommentInterrupt.mock.calls.length;
    expect(atDeadline).toBeLessThanOrEqual(DEADLINE_MS / RETRY_MS);
    const row = await readWake(wake.id);
    expect(row.payload?.firstParkedAt).toBe(parkedAt.toISOString());
    expect(typeof row.payload?.parkedNoticeAt).toBe("string");
    const [note] = await notes(f.issue.id);
    expect(note.body).toMatch(/did not start/i);
    expect(note.body).toMatch(/Retry/);
    for (let i = 1; i <= 6; i++) await tick(queue, at + DEADLINE_MS + 1_000 + i * RETRY_MS);
    expect(deps.resumeQueuedCommentInterrupt).toHaveBeenCalledTimes(atDeadline);
    expect(await notes(f.issue.id)).toHaveLength(1);
  });

  it("a Send held by the person's own pause (executionWait agent.not_invokable) stays unbounded: no anchor, no note", async () => {
    const f = await fixture(), parkedAt = new Date();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agent.id));
    const wake = await park(f, parkedAt, { executionWait: { reason: "agent.not_invokable",
      message: "This agent is paused. Resume it to send your saved message." } });
    const deps = createHeartbeatQueueTestDependencies(db), queue = createHeartbeatQueue(db, deps);
    await registerDeferredReceiptWork(db, coordinator, { resume: scope => queue.resumeDeferredExecutionReceipts(scope),
      settleTaskChat: async () => {}, createNativeBatch: () => async () => {}, schedulingSuppressed: async () => false }, () => true).ready;
    for (let t = parkedAt.getTime() + 5_000; t <= parkedAt.getTime() + 2 * DEADLINE_MS; t += 5_000) await tick(queue, t);
    expect(await notes(f.issue.id)).toHaveLength(0);
    const row = await readWake(wake.id);
    expect(row.payload?.firstParkedAt).toBeUndefined();
    expect(row.payload?.parkedNoticeAt).toBeUndefined();
    expect(row.status).toBe("deferred_issue_execution");
  });


  it.each(["remote_cleanup", "interrupt_handoff", "controller_settling"])("JUDGE: Send without queuedCommentInterrupt, executionWait %s must be bounded", async (reason) => {
    const f = await fixture(), parkedAt = new Date();
    const wake = await park(f, parkedAt, { queuedCommentInterrupt: null, executionWait: { reason,
      message: "Waiting for the previous execution. Your message is saved." } });
    await db.update(agentWakeupRequests).set({ payload: sql`${agentWakeupRequests.payload} - 'queuedCommentInterrupt'` }).where(eq(agentWakeupRequests.id, wake.id));
    const deps = createHeartbeatQueueTestDependencies(db), queue = createHeartbeatQueue(db, deps);
    await registerDeferredReceiptWork(db, coordinator, { resume: scope => queue.resumeDeferredExecutionReceipts(scope),
      settleTaskChat: async () => {}, createNativeBatch: () => async () => {}, schedulingSuppressed: async () => false }, () => true).ready;
    for (let t = parkedAt.getTime() + 5_000; t <= parkedAt.getTime() + 3 * DEADLINE_MS; t += 5_000) await tick(queue, t);
    const current = await readWake(wake.id);
    console.log("JUDGE_NON_QCI", JSON.stringify({ reason, elapsedMs: Date.now()-parkedAt.getTime(),
      status: current.status, firstParkedAt: current.payload?.firstParkedAt ?? null,
      updatedElapsedMs: current.updatedAt.getTime()-parkedAt.getTime(), systemNotes: (await notes(f.issue.id)).length,
      savedMessage: Boolean((await db.select().from(issueComments).where(eq(issueComments.id, f.message.id)))[0]) }));
    expect(await notes(f.issue.id)).toHaveLength(1);
  });

  it("JUDGE: budget.blocked exemption creates no false note or anchor", async () => {
    const f = await fixture(), parkedAt = new Date();
    const wake = await park(f, parkedAt, { executionWait: { reason: "budget.blocked", message: "Budget exhausted." } });
    const deps = createHeartbeatQueueTestDependencies(db), queue = createHeartbeatQueue(db, deps);
    await registerDeferredReceiptWork(db, coordinator, { resume: scope => queue.resumeDeferredExecutionReceipts(scope),
      settleTaskChat: async () => {}, createNativeBatch: () => async () => {}, schedulingSuppressed: async () => false }, () => true).ready;
    for (let t = parkedAt.getTime() + 5_000; t <= parkedAt.getTime() + 3 * DEADLINE_MS; t += 5_000) await tick(queue, t);
    expect(await notes(f.issue.id)).toHaveLength(0);
    expect((await readWake(wake.id)).payload?.firstParkedAt).toBeUndefined();
    expect((await readWake(wake.id)).payload?.parkedNoticeAt).toBeUndefined();
  });


  it.each(["remote_cleanup", "interrupt_handoff", "controller_settling"])("DELTA: non-QCI %s notices at first park plus two minutes, once, and keeps the message", async reason => {
    const f = await fixture(), parkedAt = new Date();
    const wake = await park(f, parkedAt, {queuedCommentInterrupt:null, executionWait:{reason,message:"Waiting. Your message is saved."}});
    await db.update(agentWakeupRequests).set({payload:sql`${agentWakeupRequests.payload} - 'queuedCommentInterrupt'`}).where(eq(agentWakeupRequests.id,wake.id));
    const deps=createHeartbeatQueueTestDependencies(db),queue=createHeartbeatQueue(db,deps);
    await registerDeferredReceiptWork(db,coordinator,{resume:scope=>queue.resumeDeferredExecutionReceipts(scope),settleTaskChat:async()=>{},createNativeBatch:()=>async()=>{},schedulingSuppressed:async()=>false},()=>true).ready;
    for(let t=parkedAt.getTime()+5000;t<=parkedAt.getTime()+115000;t+=5000) await tick(queue,t);
    expect(await notes(f.issue.id)).toHaveLength(0);
    await tick(queue,parkedAt.getTime()+121000);
    await waitForReal(async()=>expect(await notes(f.issue.id)).toHaveLength(1));
    expect((await readWake(wake.id)).payload?.firstParkedAt).toBe(parkedAt.toISOString());
    expect((await notes(f.issue.id))[0].body).toMatch(/Retry/);
    for(let t=parkedAt.getTime()+125000;t<=parkedAt.getTime()+360000;t+=5000) await tick(queue,t);
    expect(await notes(f.issue.id)).toHaveLength(1);
    expect((await readWake(wake.id)).payload?.firstParkedAt).toBe(parkedAt.toISOString());
    expect((await db.select().from(issueComments).where(eq(issueComments.id,f.message.id)))[0].body).toBe("please continue");
    console.log("DELTA_TWO_MINUTE",JSON.stringify({reason,firstParkedAt:(await readWake(wake.id)).payload?.firstParkedAt,notes:(await notes(f.issue.id)).length,saved:true}));
  });

  it("DELTA: noted non-QCI receipt has no further automatic dispatch attempts", async () => {
    const f=await fixture(),parkedAt=new Date();
    const wake=await park(f,parkedAt,{queuedCommentInterrupt:null,executionWait:{reason:"remote_cleanup",message:"Waiting. Your message is saved."}});
    await db.update(agentWakeupRequests).set({payload:sql`${agentWakeupRequests.payload} - 'queuedCommentInterrupt'`}).where(eq(agentWakeupRequests.id,wake.id));
    await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agent.id,issueId:f.issue.id,status:"failed",runtimeMode:"native",nativeIssueId:f.issue.id,
      finishedAt:parkedAt,responsibleUserId:f.actorId,contextSnapshot:{issueId:f.issue.id}});
    const deps=createHeartbeatQueueTestDependencies(db),queue=createHeartbeatQueue(db,deps);
    await registerDeferredReceiptWork(db,coordinator,{resume:scope=>queue.resumeDeferredExecutionReceipts(scope),settleTaskChat:async()=>{},createNativeBatch:()=>async()=>{},schedulingSuppressed:async()=>false},()=>true).ready;
    for(let t=parkedAt.getTime()+5000;t<=parkedAt.getTime()+121000;t+=5000) await tick(queue,t);
    await tick(queue,parkedAt.getTime()+121000);
    await waitForReal(async()=>expect(await notes(f.issue.id)).toHaveLength(1));
    const attempts=deps.releaseIssueExecutionAndPromote.mock.calls.length;
    for(let t=parkedAt.getTime()+125000;t<=parkedAt.getTime()+360000;t+=5000) await tick(queue,t);
    console.log("DELTA_POST_NOTICE",JSON.stringify({attemptsAtNotice:attempts,attemptsAtSixMinutes:deps.releaseIssueExecutionAndPromote.mock.calls.length,notes:(await notes(f.issue.id)).length}));
    expect(deps.releaseIssueExecutionAndPromote).toHaveBeenCalledTimes(attempts);
  });

  it.each([false, true])("DELTA: legacy interrupted receipt qci=%s is still bounded", async (qci) => {
    const f = await fixture(), parkedAt = new Date();
    const wake = await park(f, parkedAt, { ...(qci ? {} : {queuedCommentInterrupt: null}), executionWait: {
      reason: "remote_cleanup", message: "Waiting for previous execution. Your message is saved." } });
    if (!qci) await db.update(agentWakeupRequests).set({payload: sql`${agentWakeupRequests.payload} - 'queuedCommentInterrupt'`}).where(eq(agentWakeupRequests.id,wake.id));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agent.id, issueId: f.issue.id,
      status: "cancelled", runtimeMode: "legacy", finishedAt: parkedAt, responsibleUserId: f.actorId,
      contextSnapshot: {issueId: f.issue.id}, resultJson: {queuedCommentInterruptQueueId: wake.id,
        cancelledByActorType: "user", cancelledByActorId: f.actorId} });
    const deps = createHeartbeatQueueTestDependencies(db), queue = createHeartbeatQueue(db, deps);
    await registerDeferredReceiptWork(db, coordinator, { resume: scope => queue.resumeDeferredExecutionReceipts(scope),
      settleTaskChat: async () => {}, createNativeBatch: () => async () => {}, schedulingSuppressed: async () => false }, () => true).ready;
    for(let t=parkedAt.getTime()+5000;t<=parkedAt.getTime()+3*DEADLINE_MS;t+=5000) await tick(queue,t);
    const row=await readWake(wake.id);
    console.log("DELTA_LEGACY",JSON.stringify({qci,status:row.status,firstParkedAt:row.payload?.firstParkedAt,
      notes:(await notes(f.issue.id)).length,savedMessage:!!(await db.select().from(issueComments).where(eq(issueComments.id,f.message.id)))[0]}));
    expect(await notes(f.issue.id)).toHaveLength(1);
  });

  it("DELTA: real undelivered-user-comment writer anchors the first non-QCI deferral immediately", async () => {
    const f = await fixture();
    const id=await saveUndeliveredUserComments(db,{companyId:f.companyId,issueId:f.issue.id,agentId:f.agent.id,
      commentIds:[f.message.id],allowedStatuses:["todo"],requestedByActorId:f.actorId,
      executionWait:{reason:"wake_lost",trigger:"reconciler_backstop",message:"This message's wake was lost; it is sent now."}});
    expect(id).toBeTruthy();
    const row=await readWake(id!);
    console.log("DELTA_WRITER",JSON.stringify({status:row.status,actorType:row.requestedByActorType,
      wait:row.payload?.executionWait,firstParkedAt:row.payload?.firstParkedAt??null,updatedAt:row.updatedAt}));
    expect(typeof row.payload?.firstParkedAt).toBe("string");
    const first=row.payload?.firstParkedAt;
    await db.update(agentWakeupRequests).set({updatedAt:new Date(Date.now()+30_000)}).where(eq(agentWakeupRequests.id,id!));
    expect((await readWake(id!)).payload?.firstParkedAt).toBe(first);
  });

  async function issueServiceDone(issueId: string) {
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
  }
});
