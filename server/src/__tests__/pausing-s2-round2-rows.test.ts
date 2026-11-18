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
import { activityLog, agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
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
describe("pausing stage 2 round 2 builder rows", () => {
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
    database = await startEmbeddedPostgresTestDatabase("paperclip-pausing-s2r2-");
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

  it("F5: the repaired Retry is idempotent: same response, no second repair or activity; only a fresh Resume readies", async () => {
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
    expect(retry.status).toBe(200);
    const again = await request(app()).post(`/api/agents/${agent.id}/lifecycle/retry`).send({}).expect(200);
    expect(again.body).toEqual(retry.body);
    const after = await agentRow(agent.id);
    expect(after.lifecycleOperation).toEqual(proved.lifecycleOperation);
    expect(after.lifecycleVersion).toBe(proved.lifecycleVersion);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, agent.id), eq(activityLog.action, "agent.lifecycle_retried")))).toHaveLength(1);
    await passes(work, agent.id);
    expect((await agentRow(agent.id)).lifecycleState).toBe("paused");
    await request(app()).post(`/api/agents/${agent.id}/resume`).send({}).expect(200);
    await passes(work, agent.id);
    expect((await agentRow(agent.id)).lifecycleState).toBe("ready");
  });

});
