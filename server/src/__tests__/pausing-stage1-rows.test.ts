import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentInstructionWorkingCopies, agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/error-handler.js";
import { configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { heartbeatService } from "../services/heartbeat.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
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
    // The resume route schedules a pass on the configured worker (scheduleAgentLifecycle).
    // Join that in-flight pass: a second worker's claim finds the lease held and returns at once.
    const ready = workers.at(-1)!;
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

  /** A Boat lease on a pending destroy (pending_cleanup / failed), then the real pending-destroy sweep.
   * `answer` is the provider's destroy answer (a function may throw, as a refused destroy does). */
  async function pendingDestroy(metadata: (identity: { id: string; heartbeatRunId: string; providerLeaseId: string }) => Record<string, unknown>,
    answer: (lease: { providerLeaseId: string | null }) => unknown, held = false) {
    const [agent] = await db.insert(agents).values({ companyId, name: "Boat Lead", adapterType: "process",
      status: "running", defaultEnvironmentId: environmentId, lifecycleRequiredPluginIds: [] }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "cancelled",
      invocationSource: "on_demand", runtimeMode: "legacy", startedAt: new Date(Date.now() - 120_000),
      finishedAt: new Date(Date.now() - 100_000) }).returning();
    const identity = { id: randomUUID(), companyId, heartbeatRunId: run!.id, provider: "boat", providerLeaseId: `boat-${randomUUID()}` };
    // ephemeral: the sweep tears down through retryPendingSandboxTeardown and reads its answer.
    await db.insert(environmentLeases).values({ ...identity, environmentId, status: "pending_cleanup", cleanupStatus: "failed",
      leasePolicy: "ephemeral", releasedAt: new Date(Date.now() - 90_000), failureReason: "retained_orphan_sandbox_released",
      updatedAt: new Date(Date.now() - 3_600_000), metadata: { agentId: agent!.id, ...metadata(identity) } });
    let copy: { localRoot: string; before: unknown } | undefined;
    if (held) {
      // The live stuck copy (gate 4): unavailable + savePending, failures 15, bound to this lease.
      const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pausing-held-"));
      await fs.writeFile(path.join(localRoot, "unsaved-note.txt"), "unsaved note");
      const since = new Date(Date.now() - 4 * 3600_000);
      await db.insert(agentInstructionWorkingCopies).values({ runId: run!.id, companyId, agentId: agent!.id, responsibleUserId: "person-1",
        entryFile: "AGENTS.md", baseHash: "base", localRoot, executionRoot: "/workspace/.paperclip-runtime/agent-files/held",
        location: `remote:${environmentId}`, state: "unavailable", processStoppedAt: since, errorCode: "AGENT_FILES_SAVE_FAILED",
        receipt: { schema: "paperclip.agent-files.v1", warm: true, cleanup: { leaseId: identity.id, remoteCwd: "/workspace" },
          savePending: { code: "AGENT_FILES_SAVE_FAILED", since: since.toISOString(), reason: "Boat sandbox lease is no longer active.", failures: 15 } } });
      copy = { localRoot, before: (await db.select().from(agentInstructionWorkingCopies).where(eq(agentInstructionWorkingCopies.runId, run!.id)))[0] };
    }
    const destroy = vi.fn(async (input: { lease: { providerLeaseId: string | null } }) => answer(input.lease));
    const runtime = environmentRuntimeService(db);
    const sweeper = heartbeatService(db, { environmentRuntime: { ...runtime, inspectLeaseResource: inspect, releaseRunLeases,
      isPendingCleanupWorkerReady: async () => true, destroyRunLease: destroy, retryPendingSandboxTeardown: destroy } as never });
    await sweeper.sweepPendingCleanupLeases({ backoffMs: 0 }).catch(() => undefined);
    return { agent: agent!, run: run!, leaseId: identity.id, destroy, copy };
  }
  const carriedStop = (identity: { id: string; heartbeatRunId: string; providerLeaseId: string }) => ({ workspaceRecoveryCleanup: {
    runId: identity.heartbeatRunId, reason: "retained_orphan_sandbox_released",
    stopReceipt: remoteTerminationReceipt({ ...identity, companyId, provider: "boat" }, { providerLeaseId: identity.providerLeaseId, state: "stopped" }) } });
  const disposition = async (leaseId: string) => ((await leaseRow(leaseId)).metadata as Record<string, any>).cleanupDisposition;

  it("row B (Boat): a proved stop whose destroy answers 'stopped' is parked, stays in inventory, and the pause settles", async () => {
    const { agent, leaseId, destroy } = await pendingDestroy(carriedStop, lease => ({ providerLeaseId: lease.providerLeaseId, state: "stopped" }));
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(await disposition(leaseId)).toMatchObject({ state: "parked", code: "provider_retains_resource" });
    expect(((await leaseRow(leaseId)).metadata as Record<string, any>).retainOnDestroy).toBeUndefined();
    expect(await leaseRow(leaseId)).toMatchObject({ status: "pending_cleanup" });
    // Parked: no automatic destroy deadline wakes the worker for this row.
    const next = await nextEnvironmentCleanupAt(db, 0);
    expect(next === null || next > Date.now() + 60 * 60_000).toBe(true);
    await pause(agent.id);
    expect(await agentRow(agent.id)).toMatchObject({ lifecycleState: "paused", status: "paused" });
    expect(releaseRunLeases).not.toHaveBeenCalled();
    expect(await leaseRow(leaseId)).toMatchObject({ status: "pending_cleanup" });
  });

  it("row B-held (gate 4, 0eb2069c shape): a proved stop held by unsaved files is parked with its debt, never destroyed, files untouched, and the pause settles", async () => {
    const { agent, run, leaseId, destroy, copy } = await pendingDestroy(identity => ({ retainOnDestroy: true, ...carriedStop(identity) }),
      lease => ({ providerLeaseId: lease.providerLeaseId, state: "destroyed" }), true);
    expect(destroy).not.toHaveBeenCalled();
    expect(await disposition(leaseId)).toMatchObject({ state: "parked", code: "held_for_unsaved_files",
      debt: "Agent-file changes are not saved. The original source is retained; retry collection before discarding or releasing this sandbox." });
    expect(await leaseRow(leaseId)).toMatchObject({ status: "pending_cleanup" });
    await pause(agent.id);
    expect(await agentRow(agent.id)).toMatchObject({ lifecycleState: "paused", status: "paused" });
    expect(releaseRunLeases).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect((await db.select().from(agentInstructionWorkingCopies).where(eq(agentInstructionWorkingCopies.runId, run.id)))[0]).toEqual(copy!.before);
    expect(await fs.readFile(path.join(copy!.localRoot, "unsaved-note.txt"), "utf8")).toBe("unsaved note");
  });

  it("row B-real-destroy: a proved stop on a provider that really destroys, nothing held, is destroyed as before", async () => {
    const { leaseId, destroy } = await pendingDestroy(carriedStop, lease => ({ providerLeaseId: lease.providerLeaseId, state: "destroyed" }));
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(await disposition(leaseId)).toBeUndefined();
    expect(await leaseRow(leaseId)).toMatchObject({ status: "expired", cleanupStatus: "success" });
  });

  it("row B-unproved: no proved stop is neither parked nor destroyed (retainOnDestroy and a save hold alone never park); the pause keeps its true line", async () => {
    providerAnswer = () => undefined;
    const { agent, leaseId } = await pendingDestroy(() => ({ retainOnDestroy: true }), () => {
      throw new Error("Agent-file changes are not saved. The original source is retained; retry collection before discarding or releasing this sandbox.");
    }, true);
    expect(await disposition(leaseId)).toBeUndefined();
    expect(await leaseRow(leaseId)).toMatchObject({ status: "pending_cleanup" });
    await pause(agent.id);
    expect((await agentRow(agent.id)).lifecycleState).toBe("pausing");
    const [issue] = await db.insert(issues).values({ companyId, title: "Chat", status: "in_progress",
      assigneeAgentId: agent.id, createdAt: new Date(Date.now() - 60 * 60_000) }).returning();
    await db.insert(issueComments).values({ companyId, issueId: issue!.id, body: "Are you there?", authorType: "user",
      authorUserId: "person-1", createdAt: new Date(Date.now() - 30 * 60_000) });
    await settleUnansweredPersonMessage(db, { companyId, issueId: issue!.id, now: new Date() });
    const notes = await db.select().from(issueComments).where(and(eq(issueComments.issueId, issue!.id), eq(issueComments.authorType, "system")));
    expect(notes.map(note => note.body)).toEqual(["Boat Lead is paused for new work. We could not confirm that its previous run stopped. Your message is saved."]);
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
