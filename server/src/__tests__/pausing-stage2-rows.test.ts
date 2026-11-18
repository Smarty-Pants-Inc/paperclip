import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/error-handler.js";
import { configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { heartbeatService } from "../services/heartbeat.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { settleUnansweredPersonMessage } from "../services/recovery/unanswered-person-message.js";

// Stage-2 'pausing' rows (PAUSING-DESIGN-R2 C and D, R2: no ready+U, time never
// grants readiness) on the real pause/resume/retry/report routes, the real
// lifecycle worker and embedded Postgres. The fake provider sits at the runtime
// boundary (inspectLeaseResource). Only Date is faked, to pass the 120 s bound.
describe("pausing stage 2 rows", () => {
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

  it("row C: an unproved stop past the 120 s bound leaves 'pausing' for stable 'paused' (pause_stop_unconfirmed, visible line); the SAME lifecycle Stop owner keeps proving it on 'paused'", async () => {
    const work = worker();
    const { agent } = await stoppedRemoteAgent();
    await pauseUnproved(work, agent.id);
    const requested = (await agentRow(agent.id)).lifecycleOperation as unknown as Record<string, unknown>;
    expect(requested).toMatchObject({ pauseRequestedAt: expect.any(String), pauseDeadlineAt: expect.any(String) });
    expect(Date.parse(requested.pauseDeadlineAt as string) - Date.parse(requested.pauseRequestedAt as string)).toBe(120_000);
    advance(60_000); await work.sweep();
    expect((await agentRow(agent.id)).lifecycleState, "Before the bound the pause is still settling").toBe("pausing");
    advance(61_000); await work.sweep();
    const settled = await agentRow(agent.id);
    expect(settled).toMatchObject({ lifecycleState: "paused", status: "paused", lifecycleHolds: ["manual"] });
    expect(settled.lifecycleOperation).toMatchObject({ pauseOutcome: "pause_stop_unconfirmed", stopPending: true,
      pauseRequestedAt: requested.pauseRequestedAt, pauseDeadlineAt: requested.pauseDeadlineAt });
    expect(settled.lifecycleError).toBe("pause_stop_unconfirmed: Stack Lead is paused for new work. We could not confirm that its previous run stopped.");
    expect(await noteFor(agent.id)).toEqual(["Stack Lead is paused for new work. We could not confirm that its previous run stopped. Your message is saved."]);
    // The same worker keeps retrying the proof on stable 'paused'; still unproved, it stays paused with its line.
    const before = inspect.mock.calls.length;
    await passes(work, agent.id);
    expect(inspect.mock.calls.length).toBeGreaterThan(before);
    expect(await agentRow(agent.id)).toMatchObject({ lifecycleState: "paused", lifecycleError: settled.lifecycleError });
    // The provider comes back: the same owner proves the stop; the pause stays (its hold), no new box.
    providerAnswer = row => ({ providerLeaseId: row.providerLeaseId, state: "stopped" });
    await passes(work, agent.id, 1);
    const proved = await agentRow(agent.id);
    expect(proved).toMatchObject({ lifecycleState: "paused", lifecycleHolds: ["manual"], lifecycleError: null });
    expect(proved.lifecycleOperation).not.toHaveProperty("stopPending");
    expect(await leaseCount()).toBe(1);
  });

  it("row D: Resume while 'pausing' is taken (holds removed, waiting_for_stop) and the agent is ready only once the old run is proved stopped", async () => {
    const work = worker();
    const { agent } = await stoppedRemoteAgent();
    await pauseUnproved(work, agent.id);
    const resume = await request(app()).post(`/api/agents/${agent.id}/resume`).send({});
    expect(resume.status, JSON.stringify(resume.body)).toBe(200);
    expect(resume.body).toMatchObject({ lifecycleHolds: [], resumeDisposition: "waiting_for_stop" });
    await passes(work, agent.id, 1);
    expect((await agentRow(agent.id)).lifecycleState).toBe("pausing");
    providerAnswer = row => ({ providerLeaseId: row.providerLeaseId, state: "stopped" });
    await passes(work, agent.id);
    expect(await agentRow(agent.id)).toMatchObject({ lifecycleState: "ready" });
    expect(await leaseCount(), "no second box").toBe(1);
  });

  it("row D (no proof): time never grants readiness; past the bound the agent stays paused with the true line and Resume is remembered until proof", async () => {
    const work = worker();
    const { agent } = await stoppedRemoteAgent();
    await pauseUnproved(work, agent.id);
    await request(app()).post(`/api/agents/${agent.id}/resume`).send({}).expect(200);
    advance(121_000);
    await passes(work, agent.id, 4);
    const waiting = await agentRow(agent.id);
    expect(waiting).toMatchObject({ lifecycleState: "paused", status: "paused", lifecycleHolds: [] });
    expect(waiting.lifecycleOperation).toMatchObject({ pauseOutcome: "pause_stop_unconfirmed", stopPending: true, resumeRequested: true });
    expect(waiting.lifecycleError).toBe("pause_stop_unconfirmed: Resume was requested for Stack Lead. New work is waiting for its previous run to stop.");
    expect(await noteFor(agent.id)).toEqual(["Resume was requested for Stack Lead. New work is waiting for its previous run to stop."]);
    // A second Resume is remembered, not a bypass.
    const again = await request(app()).post(`/api/agents/${agent.id}/resume`).send({});
    expect(again.body).toMatchObject({ lifecycleState: "paused", resumeDisposition: "waiting_for_stop" });
    await passes(work, agent.id, 2);
    expect((await agentRow(agent.id)).lifecycleState).toBe("paused");
    providerAnswer = row => ({ providerLeaseId: row.providerLeaseId, state: "stopped" });
    await passes(work, agent.id);
    expect(await agentRow(agent.id)).toMatchObject({ lifecycleState: "ready", lifecycleError: null });
    expect(await leaseCount(), "no second box").toBe(1);
  });

  it("row F: a legacy stuck 'pausing' agent is listed report-first, settled by an authorized Retry through the same path, and becomes ready only after proof AND a fresh Resume", async () => {
    const work = worker();
    const { agent } = await stoppedRemoteAgent();
    await pauseUnproved(work, agent.id);
    // Pre-fix shape: a pausing row with no request time, whose old Resume already emptied its holds.
    await request(app()).post(`/api/agents/${agent.id}/resume`).send({}).expect(200);
    const operation = { ...(await agentRow(agent.id)).lifecycleOperation } as Record<string, unknown>;
    delete operation.pauseRequestedAt; delete operation.pauseDeadlineAt; delete operation.resumeRequested;
    await db.update(agents).set({ lifecycleOperation: operation as never }).where(eq(agents.id, agent.id));
    advance(3600_000); await work.sweep();
    expect((await agentRow(agent.id)).lifecycleState, "No deploy-time automatic settle of a legacy row").toBe("pausing");
    const report = await request(app()).get(`/api/companies/${companyId}/agents/pausing-report`).expect(200);
    expect(report.body.agents).toEqual([expect.objectContaining({ agentId: agent.id, blocker: "remote_stop_unconfirmed" })]);
    const retry = await request(app()).post(`/api/agents/${agent.id}/lifecycle/retry`).send({});
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    const repaired = await agentRow(agent.id);
    expect(repaired).toMatchObject({ lifecycleState: "paused" });
    expect(repaired.lifecycleOperation).toMatchObject({ stopPending: true, repairNeedsFreshResume: true, pauseOutcome: "pause_stop_unconfirmed" });
    expect((await request(app()).get(`/api/companies/${companyId}/agents/pausing-report`)).body.agents)
      .toEqual([expect.objectContaining({ agentId: agent.id, blocker: "remote_stop_unconfirmed" })]);
    await request(app()).post(`/api/agents/${agent.id}/lifecycle/retry`).send({}).expect(200);
    expect((await agentRow(agent.id)).lifecycleState, "a second Retry changes nothing").toBe("paused");
    // Proof arrives through the same owner; an old queued Resume never resumes it.
    providerAnswer = row => ({ providerLeaseId: row.providerLeaseId, state: "stopped" });
    await passes(work, agent.id);
    const proved = await agentRow(agent.id);
    expect(proved).toMatchObject({ lifecycleState: "paused" });
    expect(proved.lifecycleOperation).not.toHaveProperty("stopPending");
    const fresh = await request(app()).post(`/api/agents/${agent.id}/resume`).send({});
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
    await passes(work, agent.id);
    expect(await agentRow(agent.id)).toMatchObject({ lifecycleState: "ready" });
    expect(await leaseCount(), "no second box").toBe(1);
  });
});
