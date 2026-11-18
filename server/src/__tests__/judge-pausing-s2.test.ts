import { appendFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/error-handler.js";
import { configureAgentLifecycle, startAgentLifecycle } from "../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import * as heartbeatModule from "../services/heartbeat.js";
import { heartbeatService } from "../services/heartbeat.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { settleUnansweredPersonMessage } from "../services/recovery/unanswered-person-message.js";

// Stage-2 'pausing' rows (PAUSING-DESIGN-R2 C and D, R2: no ready+U, time never
// grants readiness) on the real pause/resume/retry/report routes, the real
// lifecycle worker and embedded Postgres. The fake provider sits at the runtime
// boundary (inspectLeaseResource). Only Date is faked, to pass the 120 s bound.
describe("independent judge pausing stage 2", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db; let companyId: string; let environmentId: string;
  const workers: ReturnType<typeof configureAgentLifecycle>[] = [];
  let providerAnswer: (lease: { providerLeaseId: string | null }) => unknown = () => undefined;
  const inspect = vi.fn(async (leaseId: string) => {
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
    return providerAnswer(lease!) as never;
  });
  const releaseRunLeases = vi.fn(async () => []);
  const advance = (ms: number) => { vi.setSystemTime(Date.now() + ms); };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-pausing-s2-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { for (const work of workers) await work.stop(); await database?.cleanup(); });
  afterEach(() => { vi.useRealTimers(); });
  beforeEach(async () => {
    for (const work of workers.splice(0)) await work.stop();
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    inspect.mockClear(); releaseRunLeases.mockClear();
    companyId = randomUUID(); environmentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pausing", issuePrefix: `Q${companyId.slice(0, 7)}` });
    await db.insert(environments).values({ id: environmentId, companyId, name: `Boat ${environmentId}`, driver: "sandbox",
      status: "active", config: { provider: "boat" } } as never);
  });

  function app() {
    const value = express(); value.use(express.json());
    value.use((req, _res, next) => {
      req.actor = { type: "board", userId: "person-1", source: "local_implicit", companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: true } as Express.Request["actor"];
      next();
    });
    value.use("/api", agentRoutes(db)); value.use(errorHandler); return value;
  }
  /** One lifecycle worker: the same physical-Stop owner for the whole row. */
  function worker() {
    const runtime = environmentRuntimeService(db);
    const heartbeat = heartbeatService(db, { environmentRuntime: { ...runtime, inspectLeaseResource: inspect, releaseRunLeases } as never });
    const work = configureAgentLifecycle(db, createLifecycleDriver(db, { call: vi.fn() } as never, heartbeat));
    workers.push(work); return work;
  }
  const agentRow = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
  const leaseCount = async () => (await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, companyId))).length;
  /** Joins any route-scheduled pass, then runs passes on the same worker. */
  async function passes(work: ReturnType<typeof worker>, id: string, count = 3) {
    for (let pass = 0; pass < count; pass += 1) { advance(61_000); await work.process(id); }
  }

  /** cc137d81's shape: a person's Stop on a remote Boat lease that then expires with cleanup success and no receipt. */
  async function stoppedRemoteAgent(name = "Stack Lead") {
    const [agent] = await db.insert(agents).values({ companyId, name, adapterType: "process",
      status: "running", defaultEnvironmentId: environmentId, lifecycleRequiredPluginIds: [] }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "running",
      invocationSource: "on_demand", runtimeMode: "legacy", startedAt: new Date(Date.now() - 60_000) }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId, heartbeatRunId: run!.id,
      status: "active", leasePolicy: "ephemeral", provider: "boat", providerLeaseId: `boat-${randomUUID()}`,
      metadata: { agentId: agent!.id } }).returning();
    await request(app()).post(`/api/heartbeat-runs/${run!.id}/cancel`).send({}).expect(200);
    await db.update(environmentLeases).set({ status: "expired", cleanupStatus: "success", releasedAt: new Date(),
      metadata: { agentId: agent!.id } }).where(eq(environmentLeases.id, lease!.id));
    return { agent: agent!, run: run!, lease: lease! };
  }
  async function pauseUnproved(work: ReturnType<typeof worker>, id: string) {
    providerAnswer = row => ({ providerLeaseId: row.providerLeaseId, state: "running" });
    await request(app()).post(`/api/agents/${id}/pause`).send({}).expect(200);
    await work.process(id);
    expect((await agentRow(id)).lifecycleState).toBe("pausing");
  }
  async function noteFor(agentId: string) {
    const [issue] = await db.insert(issues).values({ companyId, title: "Chat", status: "in_progress",
      assigneeAgentId: agentId, createdAt: new Date(Date.now() - 60 * 60_000) }).returning();
    await db.insert(issueComments).values({ companyId, issueId: issue!.id, body: "Are you there?", authorType: "user",
      authorUserId: "person-1", createdAt: new Date(Date.now() - 30 * 60_000) });
    await settleUnansweredPersonMessage(db, { companyId, issueId: issue!.id, now: new Date() });
    return (await db.select().from(issueComments).where(and(eq(issueComments.issueId, issue!.id), eq(issueComments.authorType, "system"))))
      .map(note => note.body);
  }

  function coordinatorOwner() {
    const runtime = environmentRuntimeService(db);
    const heartbeat = heartbeatService(db, { environmentRuntime: { ...runtime, inspectLeaseResource: inspect, releaseRunLeases } as never });
    return startAgentLifecycle(db, createLifecycleDriver(db, { call: vi.fn() } as never, heartbeat), () => true);
  }

  it("restart before and after B: durable bound, residual proof owner, no new run/box until exact proof", async () => {
    const original = worker();
    const { agent } = await stoppedRemoteAgent();
    await pauseUnproved(original, agent.id);
    const prior = await agentRow(agent.id);
    await original.stop();
    advance(50_000);
    const beforeB = coordinatorOwner();
    try {
      await beforeB.sweep();
      expect((await agentRow(agent.id)).lifecycleState).toBe("pausing");
      advance(71_000); await beforeB.sweep();
      const bounded = await agentRow(agent.id);
      expect(bounded).toMatchObject({ lifecycleState: "paused", status: "paused" });
      expect(bounded.lifecycleOperation).toMatchObject({ id: prior.lifecycleOperation!.id,
        pauseRequestedAt: prior.lifecycleOperation!.pauseRequestedAt, pauseDeadlineAt: prior.lifecycleOperation!.pauseDeadlineAt,
        stopPending: true, hostComplete: false });
    } finally { await beforeB.stop(); }
    const afterB = coordinatorOwner();
    try {
      const calls = inspect.mock.calls.length;
      advance(61_000); await afterB.sweep();
      expect(inspect.mock.calls.length).toBeGreaterThan(calls);
      expect((await agentRow(agent.id)).lifecycleState).toBe("paused");
      await request(app()).post(`/api/agents/${agent.id}/resume`).send({}).expect(200);
      advance(61_000); await afterB.sweep();
      expect((await agentRow(agent.id)).lifecycleState).toBe("paused");
      expect(await leaseCount()).toBe(1);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agent.id))).map(r => r.status)).toEqual(["cancelled"]);
      providerAnswer = lease => ({ providerLeaseId: lease.providerLeaseId, state: "stopped" });
      advance(61_000); await afterB.sweep();
      expect((await agentRow(agent.id)).lifecycleState).toBe("ready");
      expect(await leaseCount()).toBe(1);
    } finally { await afterB.stop(); }
  });

  it.each(["resume-first", "proof-first"])("race %s: Resume concurrent with exact proof landing is fail-closed", async order => {
    const work = worker();
    const { agent } = await stoppedRemoteAgent();
    await pauseUnproved(work, agent.id);
    let entered!: () => void, release!: (value: unknown) => void;
    const enteredPromise = new Promise<void>(r => entered = r);
    const observation = new Promise(r => release = r);
    let leaseId: string | null = null;
    providerAnswer = lease => { leaseId = lease.providerLeaseId; entered(); return observation; };
    advance(61_000);
    const proving = work.process(agent.id);
    await enteredPromise;
    try {
      if (order === "resume-first") {
        const response = await request(app()).post(`/api/agents/${agent.id}/resume`).send({}).expect(200);
        expect(response.body.resumeDisposition).toBe("waiting_for_stop");
        advance(61_000); await work.sweep();
        expect((await agentRow(agent.id)).lifecycleState).toBe("paused");
        expect(await leaseCount()).toBe(1);
        release({ providerLeaseId: leaseId, state: "stopped" });
      } else {
        release({ providerLeaseId: leaseId, state: "stopped" });
        await request(app()).post(`/api/agents/${agent.id}/resume`).send({}).expect(200);
      }
      await proving;
      await passes(work, agent.id, 3);
      expect((await agentRow(agent.id)).lifecycleState).toBe("ready");
      expect(await leaseCount()).toBe(1);
    } finally { release({ providerLeaseId: leaseId, state: "running" }); await proving; }
  });

  it("F report-only on upgrade: a pre-fix queued Resume must not auto-ready when proof improves before selected repair", async () => {
    const work = worker();
    const { agent } = await stoppedRemoteAgent();
    await pauseUnproved(work, agent.id);
    await request(app()).post(`/api/agents/${agent.id}/resume`).send({}).expect(200);
    const op = { ...(await agentRow(agent.id)).lifecycleOperation } as Record<string, unknown>;
    delete op.pauseRequestedAt; delete op.pauseDeadlineAt; delete op.resumeRequested;
    await db.update(agents).set({ lifecycleOperation: op as never }).where(eq(agents.id, agent.id));
    await work.stop();
    const restarted = coordinatorOwner();
    providerAnswer = lease => ({ providerLeaseId: lease.providerLeaseId, state: "stopped" });
    try {
      advance(3600_000); await restarted.sweep();
      const upgraded = await agentRow(agent.id);
      console.log("LEGACY_UPGRADE_OBSERVED", upgraded.lifecycleState, upgraded.lifecycleHolds, upgraded.lifecycleOperation);
      expect(upgraded.lifecycleState, "Deploy is report-only, not authority to replay old saved work").not.toBe("ready");
    } finally { await restarted.stop(); }
  });

  it("C deadline is independent of hung provider I/O through the actual delivery coordinator", async () => {
    const first = worker();
    const { agent } = await stoppedRemoteAgent();
    await pauseUnproved(first, agent.id); await first.stop(); advance(61_000);
    let entered!: () => void, release!: (value: unknown) => void;
    const enteredPromise = new Promise<void>(r => entered = r);
    const observation = new Promise(r => release = r);
    providerAnswer = () => { entered(); return observation; };
    const owner = coordinatorOwner();
    const delivery = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: e => { throw e; } });
    const registration = delivery.register(DELIVERY_QUEUES.agentLifecycle, {
      retryMs: 1_000, run: () => owner.sweep(), hasPending: () => owner.hasPending(), nextRunAt: () => owner.nextRunAt(),
    });
    owner.setWake(registration.wake);
    await enteredPromise;
    try {
      advance(121_000); registration.wake();
      await new Promise(r => setTimeout(r, 80));
      const atB = await agentRow(agent.id);
      console.log("HUNG_PROVIDER_BOUND_OBSERVED", atB.lifecycleState, atB.lifecycleOperation);
      expect(atB.lifecycleState, "Visibility bound must not wait behind physical Stop I/O").toBe("paused");
    } finally {
      release(undefined); await registration.ready; await delivery.stop(); await owner.stop();
    }
  });

  it("C/D visible reason: the incumbent waiting note upgrades after Resume rather than keeping old agent_paused text", async () => {
    const work = worker(); const { agent } = await stoppedRemoteAgent();
    await pauseUnproved(work, agent.id); advance(121_000); await work.sweep();
    expect(await noteFor(agent.id)).toHaveLength(1);
    const [issue] = await db.select().from(issues).where(eq(issues.assigneeAgentId, agent.id));
    await request(app()).post(`/api/agents/${agent.id}/resume`).send({}).expect(200);
    advance(61_000);
    await settleUnansweredPersonMessage(db, { companyId, issueId: issue!.id, now: new Date() });
    const notes = await db.select().from(issueComments).where(and(eq(issueComments.issueId, issue!.id), eq(issueComments.authorType, "system")));
    console.log("NOTE_AFTER_RESUME", notes.map(n => n.body));
    expect(notes.map(n => n.body)).toEqual(["Resume was requested for Stack Lead. New work is waiting for its previous run to stop."]);
  });

  it("C exact-run authority: late route-level Pause cancellation must not cancel a post-Resume turn", async () => {
    const work = worker();
    const { agent } = await stoppedRemoteAgent();
    providerAnswer = lease => ({ providerLeaseId: lease.providerLeaseId, state: "stopped" });
    let entered!: () => void, release!: () => void;
    const enteredPromise = new Promise<void>(r => entered = r);
    const deliveryGate = new Promise<void>(r => release = r);
    const actualFactory = heartbeatModule.heartbeatService;
    const spy = vi.spyOn(heartbeatModule, "heartbeatService").mockImplementation((...args) => {
      const service = actualFactory(...args);
      const cancel = service.cancelActiveForAgent;
      service.cancelActiveForAgent = async (...params) => { entered(); await deliveryGate; return cancel(...params); };
      return service;
    });
    const oldPause = request(app()).post(`/api/agents/${agent.id}/pause`).send({}).then(r => r);
    await enteredPromise;
    try {
      await passes(work, agent.id, 2);
      expect((await agentRow(agent.id)).lifecycleState).toBe("paused");
      await request(app()).post(`/api/agents/${agent.id}/resume`).send({}).expect(200);
      await passes(work, agent.id, 2);
      expect((await agentRow(agent.id)).lifecycleState).toBe("ready");
      const [newRun] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, status: "running",
        invocationSource: "on_demand", runtimeMode: "legacy", startedAt: new Date() }).returning();
      release(); expect((await oldPause).status).toBe(200);
      const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, newRun!.id));
      console.log("LATE_PAUSE_NEW_RUN_STATUS", after!.status);
      expect(after!.status, "Old Pause has authority only over the runs captured before Resume").toBe("running");
    } finally { release(); await oldPause; spy.mockRestore(); }
  });


  it("process restart after B: a fresh controller process recovers paused residual, keeps proving, starts nothing", async () => {
    const work = worker();
    const { agent } = await stoppedRemoteAgent();
    await pauseUnproved(work, agent.id);
    advance(121_000); await work.sweep();
    const prior = await agentRow(agent.id);
    expect(prior.lifecycleState).toBe("paused");
    await work.stop();
    const executable = promisify(execFile);
    const child = fileURLToPath(new URL("./helpers/judge-pausing-child.ts", import.meta.url));
    const loader = fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url));
    const pids: number[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      advance(61_000);
      const { stdout, stderr } = await executable(process.execPath, ["--import", loader, child, database.connectionString, agent.id, String(Date.now())],
        { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
      const line = stdout.split("\n").find(l => l.startsWith("RESTART_PROCESS_RESULT="));
      expect(line, stderr).toBeTruthy();
      const result = JSON.parse(line!.slice("RESTART_PROCESS_RESULT=".length));
      if (process.env.TASK_OUT) appendFileSync(`${process.env.TASK_OUT}/restart-process-receipts.jsonl`, JSON.stringify(result) + "\n");
      console.log("INDEPENDENT_PROCESS_RESTART", result.pid, result.inspectCount, result.agent.lifecycleState, result.runStatuses);
      pids.push(result.pid);
      expect(result.pid).not.toBe(process.pid);
      expect(result.inspectCount).toBeGreaterThan(0);
      expect(result.agent).toMatchObject({ lifecycleState: "paused", status: "paused" });
      expect(result.agent.lifecycleOperation).toMatchObject({ id: prior.lifecycleOperation!.id, stopPending: true,
        pauseRequestedAt: prior.lifecycleOperation!.pauseRequestedAt, pauseDeadlineAt: prior.lifecycleOperation!.pauseDeadlineAt });
      expect(result.runStatuses).toEqual(["cancelled"]);
      expect(await leaseCount()).toBe(1);
    }
    expect(pids[0]).not.toBe(pids[1]);
  }, 80_000);


  it("F repeated repair remains idempotent even after proof clears stopPending and before fresh Resume", async () => {
    const work = worker();
    const { agent } = await stoppedRemoteAgent();
    await pauseUnproved(work, agent.id);
    await request(app()).post(`/api/agents/${agent.id}/resume`).send({}).expect(200);
    const op = { ...(await agentRow(agent.id)).lifecycleOperation } as Record<string, unknown>;
    delete op.pauseRequestedAt; delete op.pauseDeadlineAt; delete op.resumeRequested;
    await db.update(agents).set({ lifecycleOperation: op as never }).where(eq(agents.id, agent.id));
    await request(app()).post(`/api/agents/${agent.id}/lifecycle/retry`).send({}).expect(200);
    providerAnswer = lease => ({ providerLeaseId: lease.providerLeaseId, state: "stopped" });
    await passes(work, agent.id);
    const proved = await agentRow(agent.id);
    expect(proved.lifecycleState).toBe("paused");
    expect(proved.lifecycleOperation).toMatchObject({ repairNeedsFreshResume: true });
    expect(proved.lifecycleOperation).not.toHaveProperty("stopPending");
    const retry = await request(app()).post(`/api/agents/${agent.id}/lifecycle/retry`).send({});
    console.log("REPEATED_REPAIR_AFTER_PROOF", retry.status, retry.body);
    expect(retry.status, "A second repair is idempotent; it does not become an unsupported paused-state command").toBe(200);
  });

});
