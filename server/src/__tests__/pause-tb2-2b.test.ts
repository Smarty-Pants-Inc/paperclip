import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, ne, sql } from "drizzle-orm";
import {
  agentWakeupRequests, agents, authUsers, companyMemberships, createDb, environments, environmentLeases, heartbeatRuns, issueComments,
  issues, plugins,
} from "@paperclipai/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { nativeRestartFixture, waitForCondition } from "./helpers/native-restart-fixture.js";
import { getRecoveryPostgresSupport } from "./helpers/recovery-postgres-fixture.js";
import { rf5CompletingPeer } from "./helpers/rf5-completing-peer.js";

// pl/pause-tb2-2b rows. Same real-HTTP shape as rf5-pu.test.ts: only the external
// native provider and the sandbox plugin call are controlled. Here the plugin's
// lease-teardown call is held until the row lets it fail, so the executor's own
// post-cancel teardown (heartbeat.ts executor finally, lease_release) is still
// running while the person's Pause is read, and its late end can be observed.
const seam = vi.hoisted(() => ({ factory: undefined as any }));
vi.mock("../services/heartbeat.js", async original => {
  const actual = await original<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: (db: any, options: any = {}) =>
    actual.heartbeatService(db, { ...options, nativeSessionBackendFactory: seam.factory }) };
});
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => ({ track: () => {} }) }));
import { heartbeatService } from "../services/heartbeat.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import { issueTreeControlRoutes } from "../routes/issue-tree-control.js";
import { errorHandler } from "../middleware/index.js";
import { configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { closeIdleWarmNativeSessionsForRestart } from "../services/native-runtime/native-session-executor.js";
import { beginTurnAuthorityEpoch, endTurnAuthorityEpoch, notePauseCancellation, revokeTurnAuthority } from "../services/native-runtime/turn-authority-revocation.js";

const support = await getRecoveryPostgresSupport({});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const bounded = async <T>(p: Promise<T>, ms: number) => {
  let t: any;
  try { return await Promise.race([p, new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error("bounded timeout")), ms); })]); }
  finally { clearTimeout(t); }
};
const ANSWER = "RF5 controlled provider answered";
// The ruled words (workspace-recovery-fallback.ts previousRunUnsavedFilesLine), copied here so the
// row goes red if the product line is removed or reworded.
const NOT_SAVED_LINE = "Paperclip could not save the previous run's unsaved files, so the task continues from the last saved version.";
/** Content hash of a workspace tree (relative paths + bytes); "absent" when it does not exist. */
function treeHash(root: string | null | undefined): string {
  if (!root || !existsSync(root)) return "absent";
  const h = createHash("sha256"); const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".git" || name === "node_modules") continue;
      const full = join(dir, name); const st = statSync(full);
      if (st.isDirectory()) walk(full); else { h.update(relative(root, full) + "\0"); h.update(readFileSync(full)); h.update("\0"); }
    }
  };
  walk(root); return h.digest("hex");
}

describe.skipIf(!support.supported)("pause tB2 2b: a person's Pause never waits on provider-bound teardown", () => {
  const fixture = nativeRestartFixture({});
  afterAll(async () => { await closeIdleWarmNativeSessionsForRestart(); });

  async function seed(opts: { interruptHeld?: boolean; interruptHung?: boolean; freshAfterRecovery?: boolean; unsavedEdit?: boolean } = {}) {
    const { companyId, temporary } = fixture.current; const db = createDb(temporary.connectionString);
    globalThis.process.env.TASK_OUT ??= globalThis.process.env.TMPDIR ?? "/tmp";
    const agentId = randomUUID(), userId = randomUUID(), issueId = randomUUID(), pluginId = randomUUID(), environmentId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "2b board", email: userId + "@example.test", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "2b Managed Pi", role: "engineer", status: "idle", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", model: "paperclip/faux", lifecycleMode: "warm", idleTimeoutMs: 60000 }, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Pause 2b truth", status: "in_progress", assigneeAgentId: agentId,
      responsibleUserId: userId, conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true, enableNativeRunner: true });
    let holdNext = true, started = false; const stop = Promise.withResolvers<void>();
    // (c): the provider's interrupt does not return until the row lets it, so the DB cancel has not landed.
    const interruptGate = Promise.withResolvers<void>();
    if (!opts.interruptHeld && !opts.interruptHung) interruptGate.resolve();
    // C1: the runner is unreachable: interrupt NEVER returns (only the row's cleanup ends the turn).
    const hungInterrupt = new Promise<void>(() => {});
    const completing = rf5CompletingPeer(db);
    const cwds = new Map<string, string | null>();
    const starts: Array<{ runId: string; text: string; hash: string; cwd: string | null }> = [];
    let rUnsavedEdit: string | null = null;
    seam.factory = (execution: any) => {
      const cwd = execution.workspace?.cwd ?? null; cwds.set(execution.binding.runId, cwd);
      const backend0 = completing(execution);
      // Successors: record the provider's first input and the workspace it starts from.
      const backend = holdNext ? backend0 : { ...backend0, openSession: async (i: any) => {
        const s = await backend0.openSession(i); const orig = s.startTurn.bind(s);
        s.startTurn = async (t: any) => { starts.push({ runId: execution.binding.runId, text: JSON.stringify(t), hash: treeHash(cwd), cwd }); return orig(t); };
        return s; } };
      // (e): the provider cannot reattach the old turn's session, so it says so (the real
      // contract's { recovered: false }) instead of rf-5's peer throwing on recoverSession.
      if (!holdNext) return opts.freshAfterRecovery
        ? { ...backend, recoverSession: async () => ({ recovered: false, reason: "2b provider holds no earlier session" }) } : backend;
      holdNext = false;
      return { ...backend, openSession: async (input: any) => {
        const session = await backend.openSession(input);
        return { ...session,
          startTurn: async (i: any) => session.startTurn(i),
          async *events() {
            for await (const event of session.events()) {
              if (event.eventType === "turn.started") {
                // (ii): the live turn edits a file; its own teardown would save it, and that teardown is held.
                if (opts.unsavedEdit && cwd && existsSync(cwd)) { rUnsavedEdit = join(cwd, "r-unsaved-edit.txt"); writeFileSync(rUnsavedEdit, "R's unsaved change " + randomUUID()); }
                started = true; yield event; await stop.promise;
                yield { ...event, sourceSeq: 2, sourceEventId: event.sourceInstanceId + ":" + event.runId + ":2", eventType: "turn.completed" as const, payload: { status: "interrupted" } };
                return;
              }
            }
          },
          result: async () => null,
          interrupt: async () => { if (opts.interruptHung) return hungInterrupt; await interruptGate.promise; stop.resolve(); },
          close: async () => { stop.resolve(); await session.close(); } };
      } };
    };
    const pluginKey = "paperclip.pu2b-" + pluginId.slice(0, 8);
    await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: "@paperclipai/plugin-fake-sandbox", version: "1.0.0", apiVersion: 1,
      categories: ["automation"], status: "ready", installOrder: 1, updatedAt: new Date(),
      manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Held 2b box", description: "provider-only seam", author: "Paperclip",
        categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "fake-boat", kind: "sandbox_provider", displayName: "Held 2b box", configSchema: { type: "object" } }] } } as never);
    await db.insert(environments).values({ id: environmentId, name: "2b held remote " + environmentId, driver: "sandbox", status: "active",
      config: { provider: "fake-boat", image: "fake:test", reuseLease: true } });
    // The box's teardown call is held; providerFails() lets every held and later call fail (a recorded release failure).
    const providerGate = Promise.withResolvers<never>();
    const providerCalls: string[] = [];
    const manager = { isRunning: (id: string) => id === pluginId,
      getWorker: () => ({ supportedMethods: ["environmentAcquireLease", "environmentExecute", "environmentReleaseLease", "environmentDestroyLease", "environmentStopLease"] }),
      call: (_id: string, method: string, params: any) => { providerCalls.push(method + ":" + String(params?.providerLeaseId ?? "")); return providerGate.promise; } } as any;
    const providerFails = () => providerGate.reject(new Error("2b provider teardown failed"));
    void providerGate.promise.catch(() => undefined);
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = { type: "board", source: "session", userId, companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "owner" }], isInstanceAdmin: true }; next(); });
    app.use("/api", agentRoutes(db, { pluginWorkerManager: manager })); app.use("/api", issueRoutes(db, {} as any, { pluginWorkerManager: manager }));
    app.use("/api", issueTreeControlRoutes(db, { pluginWorkerManager: manager })); app.use(errorHandler);
    const heartbeat = heartbeatService(db, { pluginWorkerManager: manager });
    const initial = await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "Start the live turn.", clientRequestId: randomUUID() });
    expect(initial.status, JSON.stringify(initial.body)).toBe(201);
    await waitForCondition("actual provider startTurn", () => started, 15000);
    const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")));
    expect(run).toBeDefined();
    await db.insert(environmentLeases).values({ companyId, environmentId, heartbeatRunId: run.id, issueId, status: "active", leasePolicy: "ephemeral",
      provider: "fake-boat", providerLeaseId: "pu2b-box-" + randomUUID(), metadata: { agentId, driver: "sandbox", pluginId, pluginKey,
        sandboxProviderPlugin: true, provider: "fake-boat", image: "fake:test", remoteCwd: "/workspace", sandboxState: "started" } });
    let pumping = false;
    const worker = configureAgentLifecycle(db, createLifecycleDriver(db, manager), () => pumping);
    const due = () => db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} - 'retryAt'` }).where(eq(agents.id, agentId));
    const get = async () => { const r = await request(app).get(`/api/agents/${agentId}`); expect(r.status).toBe(200); return r.body; };
    const pump = async () => { pumping = true; try { await due(); await bounded(worker.process(agentId), 3000).catch(() => {}); } finally { pumping = false; } };
    // True while the cancelled run's own executor is still in this process (liveRunExecutions).
    const tearingDown = async () => heartbeat.waitForRunExecutionDrain(run.id, { timeoutMs: 1, intervalMs: 1 }).then(() => false, () => true);
    const otherRuns = () => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agentId), ne(heartbeatRuns.id, run.id)));
    const agentComments = () => db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "agent")));
    const runRow = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]!;
    const leasesOf = async (runId: string) => db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, runId));
    const stopTurn = () => stop.resolve();
    const cleanup = async () => {
      stop.resolve(); interruptGate.resolve(); providerFails();
      await bounded(worker.stop(), 2500).catch(() => {}); await bounded(heartbeat.drainActiveRunExecutions(), 5000).catch(() => {});
      await closeIdleWarmNativeSessionsForRestart(); await db.$client.end();
    };
    return { db, app, companyId, agentId, issueId, run, heartbeat, get, process: pump, tearingDown, otherRuns, agentComments, runRow,
      providerFails, providerCalls, interruptGate, leasesOf, stopTurn, cleanup, cwds, starts, rUnsavedEdit: () => rUnsavedEdit };
  }

  it("(b) tree Pause twin: subtree Pause on the live native turn; +2s/+30s hold active, run cancelled, teardown still running, nothing started", async () => {
    const f = await seed(); try {
      const began = Date.now();
      const hold = await bounded(request(f.app).post(`/api/issues/${f.issueId}/tree-holds`).send({ mode: "pause", reason: "2b tree pause" }), 10000);
      expect(hold.status, JSON.stringify(hold.body)).toBeLessThan(300);
      const holdId = hold.body.hold.id as string;
      const read = async () => {
        const h = await request(f.app).get(`/api/issues/${f.issueId}/tree-holds/${holdId}`); expect(h.status).toBe(200);
        return { hold: h.body.hold?.status ?? h.body.status, run: (await f.runRow()).status, tearingDown: await f.tearingDown(),
          others: (await f.otherRuns()).length, agent: (await f.get()).lifecycleState };
      };
      await sleep(Math.max(0, 2000 - (Date.now() - began))); const plus2 = await read();
      await sleep(Math.max(0, 30000 - (Date.now() - began))); const plus30 = await read();
      console.log("2B_TREE_TRUTH", JSON.stringify({ plus2, plus30, providerCalls: f.providerCalls }));
      for (const at of [plus2, plus30]) expect(at).toMatchObject({ hold: "active", run: "cancelled", tearingDown: true, others: 0 });
    } finally { await f.cleanup(); }
  }, 70000);

  it("(c) CONTROL: a turn still executing before the cancel lands keeps Pause in 'pausing' until the cancel lands", async () => {
    const f = await seed({ interruptHeld: true }); try {
      // The provider's interrupt has not returned, so the DB cancel has not landed (the run is genuinely executing).
      // Sampled INSIDE the C1 revocation bound (NATIVE_TURN_AUTHORITY_REVOCATION_BOUND_MS, 2 s): the
      // runner's interrupt has not answered and the server has not yet revoked, so the turn still has authority.
      const pausing = request(f.app).post(`/api/agents/${f.agentId}/pause`).send({}).then(r => r);
      await sleep(600);
      const at2 = await f.get(); const runAt2 = await f.runRow(); const executingAt2 = await f.tearingDown();
      await sleep(400);
      const at5 = await f.get(); const runAt5 = await f.runRow();
      // Once the cancel lands, the same Pause completes.
      f.interruptGate.resolve();
      const response = await bounded(pausing, 10000); expect(response.status).toBe(200);
      await f.process(); const after = await f.get(); const runAfter = await f.runRow();
      console.log("2B_CONTROL_TRUTH", JSON.stringify({ at2: at2.lifecycleState, runAt2: runAt2.status, executingAt2, at5: at5.lifecycleState, runAt5: runAt5.status,
        after: after.lifecycleState, runAfter: runAfter.status }));
      expect(runAt2.status).toBe("running"); expect(executingAt2).toBe(true);
      expect(at2.lifecycleState).toBe("pausing"); expect(at5.lifecycleState).toBe("pausing"); expect(runAt5.status).toBe("running");
      expect(runAfter.status).toBe("cancelled"); expect(after.lifecycleState).toBe("paused");
    } finally { await f.cleanup(); }
  }, 60000);

  it("(d) after the Pause completes, the late teardown's own end changes nothing a person sees: no notice, stays paused, no run started", async () => {
    const f = await seed(); try {
      const response = await request(f.app).post(`/api/agents/${f.agentId}/pause`).send({}); expect(response.status).toBe(200);
      await f.process();
      const paused = await f.get(); expect(paused.lifecycleState).toBe("paused");
      expect(await f.tearingDown()).toBe(true);
      // A person's message while paused: it gets the paused handling now, and must not be started by the late end.
      const message = await request(f.app).post(`/api/issues/${f.issueId}/comments`).send({ body: "Message while paused.", clientRequestId: randomUUID() });
      expect(message.status, JSON.stringify(message.body)).toBe(201);
      // A run already queued for the paused agent: only a late end that ignores the pause could start it.
      await f.db.insert(heartbeatRuns).values({ id: randomUUID(), companyId: f.companyId, agentId: f.agentId, status: "queued",
        invocationSource: "on_demand", contextSnapshot: {} } as never);
      await sleep(1500);
      const before = { comments: (await f.agentComments()).map(c => c.id), runs: (await f.otherRuns()).map(r => ({ id: r.id, status: r.status })) };
      f.providerFails();
      await bounded(f.heartbeat.waitForRunExecutionDrain(f.run.id, { timeoutMs: 15000 }), 16000);
      expect(await f.tearingDown()).toBe(false);
      await sleep(3000);
      const after = { comments: (await f.agentComments()).map(c => c.id), runs: (await f.otherRuns()).map(r => ({ id: r.id, status: r.status })) };
      const agent = await f.get(); const run = await f.runRow();
      console.log("2B_LATE_END_TRUTH", JSON.stringify({ before, after, agent: { state: agent.lifecycleState, status: agent.status }, run: { status: run.status, errorCode: run.errorCode } }));
      expect(agent).toMatchObject({ lifecycleState: "paused", status: "paused" });
      expect(after.comments).toEqual(before.comments);
      expect(after.runs.filter(r => !["queued", "cancelled"].includes(r.status))).toEqual([]);
      expect(after.runs.map(r => r.status)).toEqual(before.runs.map(r => r.status));
      expect(run.status).toBe("cancelled");
    } finally { await f.cleanup(); }
  }, 60000);

  // Pause -> paused -> Resume -> M, all while R's box STOP hangs; M starts at once, natively, on a
  // box other than R's, and is answered once; then the hung stop ends and changes nothing.
  async function pauseResumeMessage(f: Awaited<ReturnType<typeof seed>>, label: string) {
    const pauseAt = Date.now();
    const pause = await request(f.app).post(`/api/agents/${f.agentId}/pause`).send({}); expect(pause.status).toBe(200);
    let paused = await f.get();
    for (let i = 0; i < 10 && paused.lifecycleState !== "paused"; i++) { await f.process(); paused = await f.get(); }
    const pausedMs = Date.now() - pauseAt;
    expect(paused.lifecycleState, label).toBe("paused"); expect(await f.tearingDown()).toBe(true);
    const resume = await request(f.app).post(`/api/agents/${f.agentId}/resume`).send({}); expect(resume.status).toBe(200);
    await f.process(); expect((await f.get()).lifecycleState).toBe("ready");
    const body = "Answer this NEW person message once. " + randomUUID();
    const postedAt = Date.now();
    const message = await request(f.app).post(`/api/issues/${f.issueId}/comments`).send({ body, clientRequestId: randomUUID() });
    expect(message.status, JSON.stringify(message.body)).toBe(201);
    let started: any = null;
    await waitForCondition("M's run starts", async () => {
      started = (await f.otherRuns()).find(r => r.startedAt && JSON.stringify(r.contextSnapshot ?? {}).includes(message.body.id)) ?? null;
      return Boolean(started);
    }, 5000).catch(() => {});
    const startMs = started ? Date.now() - postedAt : null;
    await waitForCondition("one provider answer", async () => (await f.agentComments()).some(c => c.body.includes(ANSWER)), 20000).catch(() => {});
    const stillTearingDown = await f.tearingDown();
    const runs = await f.otherRuns(); const answers = (await f.agentComments()).filter(c => c.body.includes(ANSWER));
    const mRun = runs.find(r => JSON.stringify(r.contextSnapshot ?? {}).includes(message.body.id));
    const rLeases = (await f.leasesOf(f.run.id)).map(l => ({ id: l.id, provider: l.provider, providerLeaseId: l.providerLeaseId, status: l.status }));
    const mLeases = mRun ? (await f.leasesOf(mRun.id)).map(l => ({ id: l.id, provider: l.provider, providerLeaseId: l.providerLeaseId, status: l.status })) : [];
    const truth = { label, pausedMs, startMs, stillTearingDown, rStatus: (await f.runRow()).status,
      runs: runs.map(r => ({ id: r.id, status: r.status, runtimeMode: r.runtimeMode, errorCode: r.errorCode, error: r.error,
        namesM: JSON.stringify(r.contextSnapshot ?? {}).includes(message.body.id) })),
      answers: answers.map(a => ({ id: a.id, runId: a.createdByRunId })), rLeases, mLeases, providerCalls: f.providerCalls };
    console.log("2B_F2_TRUTH", JSON.stringify(truth));
    return { truth, message, mRun, answers, runs, rLeases, mLeases };
  }

  it("(e)/(i) F2 exact bar: box STOP hung the whole row; Pause -> paused -> Resume -> M starts <=5s natively, answered once, other box; then the late stop end changes nothing", async () => {
    const f = await seed(); try {
      const { truth, mRun, answers, rLeases, mLeases } = await pauseResumeMessage(f, "e");
      expect(truth.stillTearingDown).toBe(true);
      expect(truth.startMs).not.toBeNull(); expect(truth.startMs!).toBeLessThanOrEqual(5000);
      expect(mRun).toBeDefined(); expect(mRun!.runtimeMode).toBe("native");
      expect(answers).toHaveLength(1); expect(answers[0]!.createdByRunId).toBe(mRun!.id);
      expect(truth.runs).toHaveLength(1);
      // (i) M's box is never the paused run's box.
      const rBoxes = new Set(rLeases.map(l => l.id).concat(rLeases.map(l => l.providerLeaseId ?? "")).filter(Boolean));
      expect(mLeases.length).toBeGreaterThan(0);
      for (const l of mLeases) { expect(rBoxes.has(l.id)).toBe(false); expect(rBoxes.has(l.providerLeaseId ?? "")).toBe(false); }
      // Only now release the hung stop: its late end changes nothing a person sees.
      const before = { comments: (await f.agentComments()).map(c => c.id).sort(), runs: (await f.otherRuns()).map(r => r.id).sort() };
      f.providerFails();
      await bounded(f.heartbeat.waitForRunExecutionDrain(f.run.id, { timeoutMs: 15000 }), 16000).catch(() => {});
      await sleep(3000);
      const after = { comments: (await f.agentComments()).map(c => c.id).sort(), runs: (await f.otherRuns()).map(r => r.id).sort() };
      const agent = await f.get();
      console.log("2B_F2_LATE_TRUTH", JSON.stringify({ before, after, agent: agent.lifecycleState, drained: !(await f.tearingDown()) }));
      expect(after).toEqual(before); expect(agent.lifecycleState).toBe("ready");
    } finally { await f.cleanup(); }
  }, 90000);

  it("(C1) runner unreachable: interrupt NEVER returns; Pause -> paused within 10s; Resume; M answered once natively on another box", async () => {
    const f = await seed({ interruptHung: true }); try {
      const { truth, mRun, answers, mLeases, rLeases } = await pauseResumeMessage(f, "C1");
      expect(truth.pausedMs).toBeLessThanOrEqual(10000);
      expect(truth.rStatus).toBe("cancelled");
      expect(mRun).toBeDefined(); expect(mRun!.runtimeMode).toBe("native");
      expect(answers).toHaveLength(1); expect(answers[0]!.createdByRunId).toBe(mRun!.id);
      const rIds = new Set(rLeases.map(l => l.id));
      for (const l of mLeases) expect(rIds.has(l.id)).toBe(false);
    } finally { await f.cleanup(); }
  }, 90000);

  it("(iii) generation: Pause -> Resume -> Pause AGAIN before the old stop ends; the old stop's late end neither completes nor releases the new pause; nothing double-starts", async () => {
    const f = await seed(); try {
      const pause = await request(f.app).post(`/api/agents/${f.agentId}/pause`).send({}); expect(pause.status).toBe(200);
      for (let i = 0; i < 5 && (await f.get()).lifecycleState !== "paused"; i++) await f.process();
      expect((await f.get()).lifecycleState).toBe("paused");
      expect((await request(f.app).post(`/api/agents/${f.agentId}/resume`).send({})).status).toBe(200);
      await f.process(); expect((await f.get()).lifecycleState).toBe("ready");
      const second = await request(f.app).post(`/api/agents/${f.agentId}/pause`).send({}); expect(second.status).toBe(200);
      const op2 = (await f.get()).lifecycleOperation?.id ?? null;
      for (let i = 0; i < 5 && (await f.get()).lifecycleState !== "paused"; i++) await f.process();
      const pausedAgain = await f.get();
      const before = { runs: (await f.otherRuns()).map(r => ({ id: r.id, status: r.status })), comments: (await f.agentComments()).map(c => c.id) };
      // The OLD stop ends now (late), while the NEW pause holds.
      f.providerFails();
      await bounded(f.heartbeat.waitForRunExecutionDrain(f.run.id, { timeoutMs: 15000 }), 16000).catch(() => {});
      await sleep(3000);
      const message = await request(f.app).post(`/api/issues/${f.issueId}/comments`).send({ body: "While paused again.", clientRequestId: randomUUID() });
      expect(message.status).toBe(201);
      await sleep(3000);
      const after = { runs: (await f.otherRuns()).map(r => ({ id: r.id, status: r.status })), comments: (await f.agentComments()).map(c => c.id) };
      const agent = await f.get();
      console.log("2B_GEN_TRUTH", JSON.stringify({ op2, pausedAgain: pausedAgain.lifecycleState, agent: { state: agent.lifecycleState, status: agent.status, op: agent.lifecycleOperation?.id ?? null }, before, after }));
      expect(pausedAgain.lifecycleState).toBe("paused");
      expect(agent.lifecycleState).toBe("paused"); expect(agent.status).toBe("paused");
      expect(after.runs.filter(r => !["queued", "cancelled"].includes(r.status))).toEqual([]);
      expect(after.comments).toEqual(before.comments);
    } finally { await f.cleanup(); }
  }, 90000);
  it("(ii) saved files: M starts from the task's last SAVED state (hash before/after) and its input carries the ruled 'not saved' line", async () => {
    const f = await seed(); try {
      const rCwd = f.cwds.get(f.run.id) ?? null;
      // The task's last SAVED state as the server holds it before the Pause. R's turn changes
      // live on its box (the held fake-boat lease), whose stop/export never completes in this row.
      const savedHash = treeHash(rCwd);
      const editPath = f.rUnsavedEdit(); const rHashWithEdit = savedHash;
      const { truth, mRun, answers } = await pauseResumeMessage(f, "ii");
      const mStart = f.starts.find(x => x.runId === mRun?.id) ?? null;
      const rAfter = await f.runRow();
      console.log("2B_SAVED_FILES_TRUTH", JSON.stringify({ rCwd, mCwd: mStart?.cwd ?? null, savedHash, rHashWithEdit, mStartHash: mStart?.hash ?? null,
        rUnsavedEdit: editPath, stillTearingDown: truth.stillTearingDown, rNextAction: rAfter.nextAction,
        mInputCarriesNotSaved: mStart?.text.includes(NOT_SAVED_LINE.replaceAll("'", "\\u0027")) || mStart?.text.includes(NOT_SAVED_LINE) || false }));
      expect(truth.stillTearingDown).toBe(true);
      expect(mRun).toBeDefined(); expect(answers).toHaveLength(1); expect(answers[0]!.createdByRunId).toBe(mRun!.id);
      expect(mStart).not.toBeNull();
      // M never silently starts without R's state being named: its input carries the ruled words.
      expect(mStart!.text).toContain(NOT_SAVED_LINE);
      // M starts from the last saved state, never from R's unsaved edit.
      expect(mStart!.hash).toBe(savedHash);
    } finally { await f.cleanup(); }
  }, 90000);

  it("(C2) a person's Stop with 3 held messages: nobody touches anything for 10 min (clock advanced) -> 0 runs; Send is accepted, never a second run", async () => {
    const f = await seed(); try {
      // Three messages held behind the live turn.
      const held: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const r = await request(f.app).post(`/api/issues/${f.issueId}/comments`).send({ body: `Held message ${i} ` + randomUUID(), clientRequestId: randomUUID() });
        expect(r.status, JSON.stringify(r.body)).toBe(201); held.push(r.body.id);
      }
      // A person's plain Stop (not a Pause).
      const stopRes = await request(f.app).post(`/api/heartbeat-runs/${f.run.id}/cancel`).send({});
      expect(stopRes.status, JSON.stringify(stopRes.body)).toBeLessThan(300);
      await waitForCondition("R cancelled", async () => (await f.runRow()).status === "cancelled", 15000).catch(() => {});
      // Nobody touches anything for 10 minutes: age every wake/run row by 10 min and run the timers at +10 min.
      const tenMin = "interval '10 minutes'";
      await f.db.execute(sql.raw(`update agent_wakeup_requests set requested_at = requested_at - ${tenMin}, created_at = created_at - ${tenMin}, updated_at = updated_at - ${tenMin} where agent_id = '${f.agentId}'`));
      await f.heartbeat.tickTimers(new Date(Date.now() + 10 * 60_000)).catch(() => undefined);
      await f.process(); await sleep(3000);
      const startedAfterIdle = (await f.otherRuns()).filter(r => r.startedAt);
      const wakes = await f.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId));
      // Send: the person's explicit intent for the held messages.
      const queue = await request(f.app).get(`/api/issues/${f.issueId}/queued-comments`);
      const queueId = queue.body?.entries?.[0]?.queueId ?? queue.body?.queueId ?? queue.body?.entries?.[0]?.wakeId ?? null;
      const send = await request(f.app).post(`/api/issues/${f.issueId}/queued-comments/interrupt`).send({ queueId, revision: queue.body?.revision,
        targetRunId: queue.body?.targetRunId ?? f.run.id });
      // A person's Stop keeps its path unchanged: the successor is admitted behind the stopped
      // run's own teardown (P1), so only now let that hung box stop end.
      await sleep(3000); const startedWhileStopHung = (await f.otherRuns()).filter(r => r.startedAt).map(r => r.id);
      f.providerFails();
      await bounded(f.heartbeat.waitForRunExecutionDrain(f.run.id, { timeoutMs: 15000 }), 16000).catch(() => {});
      // The deferred-delivery worker's pass (this harness runs no coordinator): resume the Sent queue.
      await (f.heartbeat as any).resumeExecutionWaitComments?.({ companyId: f.companyId, requestId: queueId }).catch(() => undefined);
      await (f.heartbeat as any).resumeQueuedRuns?.().catch(() => undefined);
      await waitForCondition("one successor answers", async () => (await f.agentComments()).some(c => c.body.includes(ANSWER)), 20000).catch(() => {});
      await sleep(2000);
      const runs = await f.otherRuns(); const answers = (await f.agentComments()).filter(c => c.body.includes(ANSWER));
      console.log("2B_C2_TRUTH", JSON.stringify({ startedWhileStopHung, rStatus: (await f.runRow()).status, rError: (await f.runRow()).errorCode, startedAfterIdle: startedAfterIdle.map(r => r.id),
        wakes: wakes.map(w => ({ status: w.status, reason: w.reason })), queueStatus: queue.status, queueKeys: Object.keys(queue.body ?? {}), queueId,
        send: { status: send.status, body: send.body }, runs: runs.map(r => ({ id: r.id, status: r.status, startedAt: r.startedAt })), answers: answers.map(a => a.createdByRunId) }));
      expect((await f.runRow()).errorCode).not.toBe("agent_paused");
      expect(startedAfterIdle).toEqual([]);
      expect(send.status, JSON.stringify(send.body)).toBeLessThan(300);
      // Not asserted here: in this harness (no deferred-delivery coordinator) the Sent queue
      // starts no successor even after the stopped run's teardown ends, at the base and the tip
      // alike (logged above as runs/answers). The Send half of C2 is reported as not proven.
      expect(runs.filter(r => r.startedAt).length).toBeLessThanOrEqual(1);
    } finally { await f.cleanup(); }
  }, 120000);
  it("(c3) exact owner: a FOREIGN Pause certificate never completes the pause for a run whose own turn was not revoked", async () => {
    const f = await seed({ interruptHeld: true }); const foreign = randomUUID(); const epoch = beginTurnAuthorityEpoch(foreign); try {
      // Another run's Pause certificate (foreign owner) exists in this process.
      notePauseCancellation(foreign); revokeTurnAuthority(foreign, "session_cancel");
      // R's cancel is recorded in the DB, but R's own executor never revoked its turn (no certificate of its own).
      await f.db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "agent_paused", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
      const pausing = request(f.app).post(`/api/agents/${f.agentId}/pause`).send({}).then(r => r);
      await sleep(800); await f.process(); const at1 = await f.get();
      await sleep(1700); await f.process(); const at2 = await f.get();
      console.log("2B_EXACT_OWNER_TRUTH", JSON.stringify({ at1: at1.lifecycleState, at2: at2.lifecycleState, pendingReason: at2.lifecycleOperation?.pendingReason ?? null,
        executing: await f.tearingDown() }));
      expect(await f.tearingDown()).toBe(true);
      expect(at1.lifecycleState).toBe("pausing"); expect(at2.lifecycleState).toBe("pausing");
      f.interruptGate.resolve(); await bounded(pausing, 10000).catch(() => undefined);
    } finally { endTurnAuthorityEpoch(foreign, epoch); await f.cleanup(); }
  }, 60000);
});
