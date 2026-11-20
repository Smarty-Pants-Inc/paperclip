import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issueComments, issues, plugins, type Db } from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { environmentRuntimeService } from "./environment-runtime.js";
import { heartbeatService, type HeartbeatEnvironmentRuntime } from "./heartbeat.js";
import { nextWarmSandboxStopAt } from "./warm-sandbox-expiry.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { createHeartbeatQueue } from "./heartbeat/queue.js";
import { resolveRunnerReconnectGraceMsForRun, resolveWarmRunnerIdleTimeoutMsForRun } from "./runner-environment-lifecycle.js";
import { createHeartbeatQueueTestDependencies } from "../__tests__/helpers/heartbeat-queue.js";

// Keep reason: never-OK money/duplicate-provider-effect guard. The task explicitly
// requests controlled latency peers; these are not live Boat latency evidence.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("comment speculative Boat resume", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("s4-comment-resume-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await db.execute(sql`truncate table companies, environments, plugins cascade`);
  });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(resumeMs = 0) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), oldRunId = randomUUID(), pluginId = randomUUID();
    const providerLeaseId = `s4-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "S4 controlled peer", issuePrefix: "S4", defaultResponsibleUserId: "board" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", status: "idle", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, assigneeAgentId: agentId, status: "in_progress", title: "S4 retained task" });
    const [row] = await db.insert(environments).values({ name: "S4 Boat", driver: "sandbox", status: "active",
      config: { provider: "boat", image: "s4-image", reuseLease: true } }).returning();
    const environment = { ...row, envVars: {} } as Environment;
    await db.insert(plugins).values({ id: pluginId, pluginKey: "paperclip.boat", packageName: "@test/s4-boat", version: "1.0.0", apiVersion: 1,
      status: "ready", categories: ["automation"], manifestJson: { id: "paperclip.boat", apiVersion: 1, version: "1.0.0", displayName: "Boat peer",
        description: "Controlled S4 peer", author: "Test", categories: ["automation"], capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" }, environmentDrivers: [{ driverKey: "boat", kind: "sandbox_provider", displayName: "Boat peer",
          supportsReusableLeases: true, configSchema: { type: "object" } }] } });
    await db.insert(heartbeatRuns).values({ id: oldRunId, companyId, agentId, issueId, status: "running" });
    const spans: { name: string; at: number }[] = [];
    let running = false;
    let signalResumeStarted!: () => void;
    const whenResumeStarted = new Promise<void>(resolve => { signalResumeStarted = resolve; });
    const call = vi.fn(async (_id: string, method: string) => {
      if (method === "environmentAcquireLease") { running = true; return { providerLeaseId, metadata: { ...environment.config, remoteCwd: "/workspace" } }; }
      if (method === "environmentResumeLease") {
        spans.push({ name: "boat.resume.start", at: Date.now() });
        signalResumeStarted();
        await delay(resumeMs); running = true;
        spans.push({ name: "boat.resume.end", at: Date.now() });
        return { providerLeaseId, metadata: { ...environment.config, remoteCwd: "/workspace" } };
      }
      if (method === "environmentStopLease") { running = false; return { providerLeaseId, state: "stopped" }; }
      if (method === "environmentInspectLease") return { providerLeaseId, state: running ? "active" : "stopped" };
      throw new Error(`Unexpected provider method ${method}`);
    });
    const worker = { isRunning: () => true, call, getWorker: () => ({ supportedMethods: ["environmentAcquireLease", "environmentResumeLease",
      "environmentReleaseLease", "environmentDestroyLease", "environmentStopLease", "environmentInspectLease"] }) } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: worker });
    const acquire = (runId: string) => runtime.acquireRunLease({ companyId, agentId, issueId, environment, heartbeatRunId: runId,
      adapterType: "paperclip_runner", persistedExecutionWorkspace: null,
      warmRunnerIdleTimeoutMs: resolveWarmRunnerIdleTimeoutMsForRun(environment, "paperclip_runner", {}, undefined, { reusableLeaseSupported: true }),
      runnerReconnectGraceMs: resolveRunnerReconnectGraceMsForRun(environment, "paperclip_runner") });
    const initial = await acquire(oldRunId);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, oldRunId));
    await runtime.releaseRunLeases(oldRunId, "released", undefined, "stop_and_retain");
    const leaseId = initial.lease.id;
    const read = () => db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)).then(rows => rows[0]!);
    expect((await read()).status).toBe("released");
    expect(running).toBe(false);
    call.mockClear();
    const input = { companyId, agentId, issueId, commentId: randomUUID(), environmentId: environment.id, adapterType: "paperclip_runner" };
    // Base has no speculative entry point: it takes its ordinary serial path.
    // This deliberately observes a real baseline instead of failing on import.
    const start = () => (runtime as typeof runtime & { speculateCommentResume?: (candidate: typeof input) => Promise<void> })
      .speculateCommentResume?.(input) ?? Promise.resolve();
    const newRun = async () => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, status: "running" }).returning();
      return run.id;
    };
    const ingressQueue = async (commitDelayMs = 0) => {
      const [agent] = await db.update(agents).set({ defaultEnvironmentId: environment.id }).where(eq(agents.id, agentId)).returning();
      const deps = createHeartbeatQueueTestDependencies(db);
      deps.getAgent.mockResolvedValue(agent);
      deps.instanceSettings.getExperimental.mockResolvedValue({} as Awaited<ReturnType<typeof deps.instanceSettings.getExperimental>>);
      deps.getSchedulingSuppression.mockResolvedValue({ suppressed: true, reason: "task_drain" });
      deps.resolveResponsibleUserIdForRunSeed = async () => "board";
      deps.startCommentResume = async candidate => {
        expect(candidate).toMatchObject({ companyId, agentId, issueId, environmentId: environment.id });
        await start();
      };
      await db.insert(issueComments).values({ id: input.commentId, companyId, issueId, authorType: "user", authorUserId: "board", body: "Continue my task." });
      // Delay only the commit of a real successful admission transaction, not
      // any eligibility decision (including responsible-user resolution).
      const admissionDb = new Proxy(db, { get(target, key, receiver) {
        if (key === "transaction") return (work: (tx: Db) => Promise<{ kind?: string }>) => target.transaction(async tx => {
          const result = await work(tx as unknown as Db);
          if (result?.kind === "queued") await delay(commitDelayMs);
          return result;
        });
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const send = () => createHeartbeatQueue(admissionDb, deps).enqueueWakeup(agentId, { source: "on_demand", reason: "issue_commented",
        requestedByActorType: "user", requestedByActorId: "board", payload: { issueId, commentId: input.commentId },
        issueStateGuard: { assigneeAgentId: agentId, statuses: ["todo", "in_progress"] },
        contextSnapshot: { issueId, wakeCommentId: input.commentId } });
      const drain = () => Promise.all([...deps.activeWakeupPromises]);
      return { deps, send, drain };
    };
    return { companyId, agentId, issueId, runtime, input, start, newRun, acquire, read, call, spans, ingressQueue, worker, whenResumeStarted, running: () => running };
  }

  it("overlaps a 0.9s resume with 0.9s admission, retaining one authoritative resume", async () => {
    const f = await fixture(900);
    const ingress = Date.now();
    f.spans.push({ name: "comment.ingress", at: ingress });
    const speculative = f.start();
    await delay(900);
    f.spans.push({ name: "admission.end", at: Date.now() });
    const runId = await f.newRun();
    await f.acquire(runId);
    await speculative;
    f.spans.push({ name: "attach.ready", at: Date.now() });
    const elapsed = Date.now() - ingress;
    const timing = { kind: "controlled-runtime", spans: f.spans.map(s => ({ ...s, offsetMs: s.at - ingress })), elapsedMs: elapsed };
    if (process.env.PAPERCLIP_S4_TIMING_OUT) appendFileSync(process.env.PAPERCLIP_S4_TIMING_OUT, `${JSON.stringify(timing)}\n`);
    console.log("S4_TIMING", JSON.stringify(timing));
    expect(f.call.mock.calls.filter(c => c[1] === "environmentResumeLease")).toHaveLength(1);
    expect(f.spans.find(s => s.name === "boat.resume.start")!.at).toBeLessThan(f.spans.find(s => s.name === "admission.end")!.at);
    expect(elapsed).toBeLessThan(1_500);
    await f.runtime.releaseRunLeases(runId, "released", undefined, "stop_and_retain");
    expect(f.running()).toBe(false);
  });

  it("suspends an unclaimed resume at its saved deadline and counts only the confirmed stop", async () => {
    vi.stubEnv("PAPERCLIP_SPECULATIVE_RESUME_TTL_MS", "80");
    const f = await fixture();
    await f.start();
    expect(f.running()).toBe(true);
    const deadline = await nextWarmSandboxStopAt(db);
    expect(deadline).not.toBeNull();
    await delay(Math.max(0, deadline! - Date.now()) + 5);
    const hb = heartbeatService(db, { environmentRuntime: f.runtime as HeartbeatEnvironmentRuntime });
    await hb.sweepPendingCleanupLeases();
    await hb.drainActiveRunExecutions();
    expect(f.running()).toBe(false);
    expect((await f.read()).metadata?.speculativeResumeUnclaimedSuspensions).toBe(1);
    expect((await f.read()).metadata?.remoteExecutionTermination).toMatchObject({ state: "stopped" });
    await hb.sweepPendingCleanupLeases();
    expect((await f.read()).metadata?.speculativeResumeUnclaimedSuspensions).toBe(1);
    expect(f.call.mock.calls.filter(c => c[1] === "environmentStopLease")).toHaveLength(1);
    const saved = await f.read();
    if (process.env.PAPERCLIP_S4_TIMING_OUT) appendFileSync(process.env.PAPERCLIP_S4_TIMING_OUT, JSON.stringify({
      kind: "unclaimed-suspend", provider: "controlled-boat-peer", providerLeaseId: saved.providerLeaseId,
      deadline, proofAt: Date.now(), spans: f.spans, providerRunning: f.running(), status: saved.status,
      cleanupStatus: saved.cleanupStatus, stopReceipt: saved.metadata?.remoteExecutionTermination,
      unclaimedSuspensions: saved.metadata?.speculativeResumeUnclaimedSuspensions,
    }) + "\n");
  });

  it("concurrent ingress and two runtime instances cannot double-resume an allocation", async () => {
    const f = await fixture(70);
    const other = environmentRuntimeService(db, { pluginWorkerManager: f.worker });
    const starts = Promise.all([f.start(), other.speculateCommentResume(f.input)]);
    await f.whenResumeStarted;
    const runId = await f.newRun();
    // The claimant is a different runtime instance; its journal, not a local
    // promise cache, prevents a second provider call.
    const environment = { ...(await db.select().from(environments).where(eq(environments.id, f.input.environmentId!)))[0], envVars: {} } as Environment;
    await other.acquireRunLease({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, environment,
      heartbeatRunId: runId, adapterType: "paperclip_runner", persistedExecutionWorkspace: null,
      warmRunnerIdleTimeoutMs: resolveWarmRunnerIdleTimeoutMsForRun(environment, "paperclip_runner", {}, undefined, { reusableLeaseSupported: true }),
      runnerReconnectGraceMs: resolveRunnerReconnectGraceMsForRun(environment, "paperclip_runner") });
    await starts;
    expect(f.call.mock.calls.filter(c => c[1] === "environmentResumeLease")).toHaveLength(1);
    await f.runtime.releaseRunLeases(runId, "released", undefined, "stop_and_retain");
  });

  it("starts from real comment admission before its remaining 0.9s completes", async () => {
    const f = await fixture(900);
    const ingress = await f.ingressQueue(900);
    const at = Date.now();
    const admitted = await ingress.send();
    f.spans.push({ name: "admission.end", at: Date.now() });
    expect(admitted).not.toBeNull();
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, admitted!.id));
    await f.acquire(admitted!.id);
    await ingress.drain();
    const timing = { kind: "comment-admission", spans: f.spans.map(s => ({ ...s, offsetMs: s.at - at })), elapsedMs: Date.now() - at };
    if (process.env.PAPERCLIP_S4_TIMING_OUT) appendFileSync(process.env.PAPERCLIP_S4_TIMING_OUT, `${JSON.stringify(timing)}\n`);
    expect(f.spans.find(s => s.name === "boat.resume.start")!.at).toBeLessThan(f.spans.find(s => s.name === "admission.end")!.at);
    expect(timing.elapsedMs).toBeLessThan(1_500);
    expect(f.call.mock.calls.filter(c => c[1] === "environmentResumeLease")).toHaveLength(1);
    await f.runtime.releaseRunLeases(admitted!.id, "released", undefined, "stop_and_retain");
  });

  it("qualifies provider-auto-suspended retained leases with an exact fresh observation", async () => {
    const f = await fixture();
    const original = await f.read();
    const { remoteExecutionTermination: _stop, sandboxStopAndRetainReceipt: _receipt, ...metadata } = original.metadata!;
    await db.update(environmentLeases).set({ status: "retained", metadata }).where(eq(environmentLeases.id, original.id));
    await f.start();
    expect(f.running()).toBe(true);
    expect(f.call.mock.calls.map(c => c[1])).toEqual(["environmentInspectLease", "environmentResumeLease"]);
    const runId = await f.newRun();
    await f.acquire(runId);
    await f.runtime.releaseRunLeases(runId, "released", undefined, "stop_and_retain");
  });

  it("does not treat a preparing run as a claim that extends the money bound", async () => {
    vi.stubEnv("PAPERCLIP_SPECULATIVE_RESUME_TTL_MS", "80");
    const f = await fixture();
    await f.start();
    await f.newRun(); // running preparation, but no authoritative resume claim
    const deadline = await nextWarmSandboxStopAt(db);
    expect(deadline).not.toBeNull();
    await delay(Math.max(0, deadline! - Date.now()) + 5);
    const restarted = heartbeatService(db, { environmentRuntime: f.runtime });
    await restarted.sweepPendingCleanupLeases();
    await restarted.drainActiveRunExecutions();
    expect(f.running()).toBe(false);
    expect((await f.read()).metadata?.speculativeResumeUnclaimedSuspensions).toBe(1);
  });

  it("does not stop a claimed live allocation when the speculative deadline passes", async () => {
    vi.stubEnv("PAPERCLIP_SPECULATIVE_RESUME_TTL_MS", "150");
    const f = await fixture();
    await f.start();
    const runId = await f.newRun();
    await f.acquire(runId);
    await delay(160);
    const hb = heartbeatService(db, { environmentRuntime: f.runtime });
    await hb.sweepPendingCleanupLeases();
    await hb.drainActiveRunExecutions();
    expect(f.running()).toBe(true);
    expect(f.call.mock.calls.filter(c => c[1] === "environmentStopLease")).toHaveLength(0);
    await f.runtime.releaseRunLeases(runId, "released", undefined, "stop_and_retain");
  });

  it("persists an unconfirmed stop for retry without counting it as suspended", async () => {
    vi.stubEnv("PAPERCLIP_SPECULATIVE_RESUME_TTL_MS", "80");
    const f = await fixture();
    await f.start();
    const deadline = (await nextWarmSandboxStopAt(db))!;
    await delay(Math.max(0, deadline - Date.now()) + 5);
    const workingProvider = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (...args) => {
      if (args[1] === "environmentStopLease") throw new Error("controlled stop failure");
      return workingProvider(...args);
    });
    const hb = heartbeatService(db, { environmentRuntime: f.runtime });
    await hb.sweepPendingCleanupLeases();
    expect(f.running()).toBe(true);
    expect(await f.read()).toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed" });
    expect((await f.read()).metadata?.speculativeResumeUnclaimedSuspensions).toBeUndefined();
    f.call.mockImplementation(workingProvider);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3_600_000);
    await hb.sweepPendingCleanupLeases({ backoffMs: 0 });
    await hb.drainActiveRunExecutions();
    expect(f.running()).toBe(false);
    expect((await f.read()).metadata?.speculativeResumeUnclaimedSuspensions).toBe(1);
  });

  it.each(["no-sandbox", "other-company"] as const)("never resumes for %s scope", async mode => {
    const f = await fixture();
    await f.runtime.speculateCommentResume({ ...f.input, ...(mode === "no-sandbox" ? { issueId: randomUUID() } : { companyId: randomUUID() }) });
    expect(f.running()).toBe(false);
    expect(f.call.mock.calls.filter(c => c[1] === "environmentResumeLease")).toHaveLength(0);
  });

  it.each(["budget", "paused", "wake-disabled", "closed", "coalesced", "responsible-user"] as const)("does not resume an ineligible %s comment", async gate => {
    const f = await fixture();
    const ingress = await f.ingressQueue();
    if (gate === "responsible-user") ingress.deps.resolveResponsibleUserIdForRunSeed = async () => { throw new Error("responsible_user_unresolved"); };
    if (gate === "budget") ingress.deps.budgets.getInvocationBlock.mockResolvedValue({ reason: "budget hard stop", scopeType: "agent", scopeId: f.agentId } as never);
    if (gate === "paused") ingress.deps.getAgentInvokability.mockResolvedValue({ invokable: false, reason: "paused", message: "Paused" } as never);
    if (gate === "wake-disabled") {
      const [agent] = await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } }).where(eq(agents.id, f.agentId)).returning();
      ingress.deps.getAgent.mockResolvedValue(agent);
    }
    if (gate === "closed") await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    if (gate === "coalesced") {
      const id = await f.newRun();
      await db.update(issues).set({ executionRunId: id }).where(eq(issues.id, f.issueId));
      ingress.deps.liveRunExecutions.has.mockReturnValue(true);
    }
    await ingress.send().catch(() => null);
    await ingress.drain();
    expect(f.running()).toBe(false);
    expect(f.call.mock.calls.filter(c => c[1] === "environmentResumeLease")).toHaveLength(0);
    expect(await nextWarmSandboxStopAt(db)).toBeNull();
  });
});
