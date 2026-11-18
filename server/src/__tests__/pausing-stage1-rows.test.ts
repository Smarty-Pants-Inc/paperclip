import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/error-handler.js";
import { configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { heartbeatService } from "../services/heartbeat.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { settleRetainedOrphanSandbox } from "../services/environment-retained-orphan-settlement.js";
import { nextEnvironmentCleanupAt } from "../services/environment-cleanup-state.js";
import { settleUnansweredPersonMessage } from "../services/recovery/unanswered-person-message.js";

// Stage-1 'pausing' rows (PAUSING-DESIGN-R2 A, B, E, F; RFL C1-C6) on the real
// pause/resume/cancel routes, the real lifecycle worker and embedded Postgres.
// The fake provider sits at the runtime boundary and answers the typed state a
// Boat plugin answers: stop-and-retain is "stopped", never "destroyed".
describe("pausing stage 1 rows", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db; let companyId: string; let environmentId: string;
  const workers: ReturnType<typeof configureAgentLifecycle>[] = [];
  let providerAnswer: (lease: { providerLeaseId: string | null }) => unknown = () => undefined;
  const inspect = vi.fn(async (leaseId: string) => {
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
    return providerAnswer(lease!) as never;
  });
  const releaseRunLeases = vi.fn(async () => []);

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-pausing-s1-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { for (const work of workers) await work.stop(); await database?.cleanup(); });
  beforeEach(async () => {
    for (const work of workers.splice(0)) await work.stop();
    inspect.mockClear(); releaseRunLeases.mockClear();
    companyId = randomUUID(); environmentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pausing", issuePrefix: `P${companyId.slice(0, 7)}` });
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
  function worker() {
    const runtime = environmentRuntimeService(db);
    const heartbeat = heartbeatService(db, { environmentRuntime: { ...runtime, inspectLeaseResource: inspect, releaseRunLeases } as never });
    const work = configureAgentLifecycle(db, createLifecycleDriver(db, { call: vi.fn() } as never, heartbeat));
    workers.push(work); return work;
  }
  const agentRow = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
  const leaseRow = async (id: string) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0]!;

  /** cc137d81's shape: a person's Stop on a remote Boat lease, which then
   * expires with cleanup success and no receipt. */
  async function stoppedRemoteAgent() {
    const [agent] = await db.insert(agents).values({ companyId, name: "Stack Lead", adapterType: "process",
      status: "running", defaultEnvironmentId: environmentId, lifecycleRequiredPluginIds: [] }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "running",
      invocationSource: "on_demand", runtimeMode: "legacy", startedAt: new Date(Date.now() - 60_000) }).returning();
    const providerLeaseId = `boat-${randomUUID()}`;
    const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId, heartbeatRunId: run!.id,
      status: "active", leasePolicy: "ephemeral", provider: "boat", providerLeaseId,
      metadata: { agentId: agent!.id, pluginId: randomUUID() } }).returning();
    const stop = await request(app()).post(`/api/heartbeat-runs/${run!.id}/cancel`).send({});
    expect(stop.status, JSON.stringify(stop.body)).toBe(200);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)))[0]!.status).toBe("cancelled");
    // The lease later expires: cleanup success, no termination receipt.
    await db.update(environmentLeases).set({ status: "expired", cleanupStatus: "success", releasedAt: new Date(),
      metadata: { agentId: agent!.id, pluginId: (lease!.metadata as Record<string, unknown>).pluginId } })
      .where(eq(environmentLeases.id, lease!.id));
    return { agent: agent!, run: run!, lease: lease!, providerLeaseId };
  }
  async function pause(agentId: string) {
    const response = await request(app()).post(`/api/agents/${agentId}/pause`).send({});
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    await worker().process(agentId);
  }

  it("row A: a provider-proved stop settles the pause; Resume then makes the agent ready", async () => {
    const { agent, providerLeaseId } = await stoppedRemoteAgent();
    providerAnswer = lease => ({ providerLeaseId: lease.providerLeaseId, state: "stopped" });
    await pause(agent.id);
    expect(inspect).toHaveBeenCalled();
    expect(await agentRow(agent.id)).toMatchObject({ lifecycleState: "paused", status: "paused" });
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.providerLeaseId, providerLeaseId));
    expect((lease!.metadata as Record<string, unknown>).remoteExecutionTermination).toMatchObject({ state: "stopped", providerLeaseId });
    const resume = await request(app()).post(`/api/agents/${agent.id}/resume`).send({});
    expect(resume.status, JSON.stringify(resume.body)).toBe(200);
    const ready = worker();
    for (let pass = 0; pass < 3 && (await agentRow(agent.id)).lifecycleState !== "ready"; pass += 1) await ready.process(agent.id);
    expect((await agentRow(agent.id)), JSON.stringify((await agentRow(agent.id)).lifecycleOperation)).toMatchObject({ lifecycleState: "ready" });
  });

  it.each([["unproved", { state: "running" }], ["unsupported", undefined]] as const)(
    "row A (%s): without the provider's proof the agent never becomes ready, and the confirmer says why", async (kind, answer) => {
      const { agent, lease } = await stoppedRemoteAgent();
      providerAnswer = row => answer && { providerLeaseId: row.providerLeaseId, ...answer };
      await pause(agent.id);
      expect((await agentRow(agent.id)).lifecycleState).toBe("pausing");
      await request(app()).post(`/api/agents/${agent.id}/resume`).send({}).expect(200);
      await worker().process(agent.id);
      expect((await agentRow(agent.id)).lifecycleState).not.toBe("ready");
      const { confirmRemoteLeaseStop } = await import("../services/remote-execution-termination.js") as Record<string, any>;
      expect(typeof confirmRemoteLeaseStop).toBe("function");
      expect(await confirmRemoteLeaseStop(db, await leaseRow(lease.id), inspect)).toBe(kind);
      if (kind === "unsupported") expect((await agentRow(agent.id)).lifecycleOperation).toMatchObject({ pendingReason: "remote_stop_unsupported" });
    });

  it("row B: a retained orphan's carried stop proof settles the pause; its cleanup is parked and the computer stays in inventory", async () => {
    const [agent] = await db.insert(agents).values({ companyId, name: "Orphan Lead", adapterType: "process",
      status: "running", defaultEnvironmentId: environmentId, lifecycleRequiredPluginIds: [] }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "cancelled",
      invocationSource: "on_demand", runtimeMode: "legacy", startedAt: new Date(Date.now() - 120_000),
      finishedAt: new Date(Date.now() - 100_000) }).returning();
    const providerLeaseId = `boat-${randomUUID()}`;
    const identity = { id: randomUUID(), companyId, heartbeatRunId: run!.id, provider: "boat", providerLeaseId };
    const receipt = remoteTerminationReceipt(identity, { providerLeaseId, state: "stopped" });
    await db.insert(environmentLeases).values({ ...identity, environmentId, status: "failed", cleanupStatus: "success",
      leasePolicy: "reuse_by_environment", releasedAt: new Date(Date.now() - 90_000), expiresAt: new Date(Date.now() - 60_000),
      metadata: { agentId: agent!.id, retainOnDestroy: true, remoteExecutionTermination: receipt } });
    const settled = await settleRetainedOrphanSandbox(db, { recordId: identity.id, companyId, runId: run!.id, issueId: null,
      owner: "environment" as never, updatedAt: null }, { now: new Date(), proof: { reason: "owner_gone" } as never });
    expect(settled).toMatchObject({ settled: true });
    const after = await leaseRow(identity.id);
    expect(after).toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed", failureReason: "retained_orphan_sandbox_released" });
    expect((after.metadata as Record<string, any>).cleanupDisposition).toMatchObject({ state: "parked", code: "provider_retains_resource" });
    // Parked: no automatic destroy deadline wakes the worker for this row.
    const next = await nextEnvironmentCleanupAt(db, 0);
    expect(next === null || next > Date.now() + 60 * 60_000).toBe(true);
    await pause(agent!.id);
    expect(await agentRow(agent!.id)).toMatchObject({ lifecycleState: "paused", status: "paused" });
    expect(releaseRunLeases).not.toHaveBeenCalled();
    expect(await leaseRow(identity.id)).toMatchObject({ status: "pending_cleanup" });
  });

  it("row E: a message to a pausing agent whose old run is unproved gets the true line, never silence", async () => {
    const { agent } = await stoppedRemoteAgent();
    providerAnswer = () => undefined;
    await pause(agent.id);
    expect((await agentRow(agent.id)).lifecycleState).toBe("pausing");
    const [issue] = await db.insert(issues).values({ companyId, title: "Chat", status: "in_progress",
      assigneeAgentId: agent.id, createdAt: new Date(Date.now() - 60 * 60_000) }).returning();
    await db.insert(issueComments).values({ companyId, issueId: issue!.id, body: "Are you there?", authorType: "user",
      authorUserId: "person-1", createdAt: new Date(Date.now() - 30 * 60_000) });
    await settleUnansweredPersonMessage(db, { companyId, issueId: issue!.id, now: new Date() });
    const notes = await db.select().from(issueComments).where(and(eq(issueComments.issueId, issue!.id), eq(issueComments.authorType, "system")));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toBe("Stack Lead is paused for new work. We could not confirm that its previous run stopped. Your message is saved.");
  });

  it("row G: the pausing inventory is report-only and names the blocker", async () => {
    const { agent, run, lease } = await stoppedRemoteAgent();
    providerAnswer = () => undefined;
    await pause(agent.id);
    const before = { agent: await agentRow(agent.id), lease: await leaseRow(lease.id) };
    const first = await request(app()).get(`/api/companies/${companyId}/agents/pausing-report`);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toEqual({ reportOnly: true, agents: [expect.objectContaining({ agentId: agent.id, blocker: "remote_stop_unconfirmed",
      runIds: [run.id], leases: [expect.objectContaining({ id: lease.id, status: "expired", cleanupStatus: "success" })] })] });
    expect((await request(app()).get(`/api/companies/${companyId}/agents/pausing-report`)).body).toEqual(first.body);
    expect({ agent: await agentRow(agent.id), lease: await leaseRow(lease.id) }).toEqual(before);
  });
});
