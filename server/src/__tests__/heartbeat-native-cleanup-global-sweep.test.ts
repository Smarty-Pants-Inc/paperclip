import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRunEvents, heartbeatRuns,
  issueComments, issues, plugins } from "@paperclipai/db";
import { executeNativeSession, nativeSessionCleanupBlock, NativeSessionCloseUnrecoverableError,
  onNativeSessionCleanupSettled, parseNativeExecutionInput, type NativeSession,
  type PrpStructuredRunResult } from "../vendor/paperclip-runner/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../services/delivery-work-notifications.js";
import { registerNativeCleanupReleaseWake } from "../services/native-runtime/native-cleanup-release-wake.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Keep: #20806 / J2-8 production catch and exact-allocation data-safety boundary.
// Helpers follow heartbeat-native-cleanup-recovery.test.ts's stop-only case,
// but ALL THREE provider workers run in ONE manager and share ONE global sweep.
// PostgreSQL, quarantine, admission, cleanup and release wake are real; only the
// external providers are stateful fixtures. This is not live-provider proof.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("global cleanup sweep across three provider plugins (#20806, J2-8)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("cleanup-global-sweep-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true });
    root = await mkdtemp(join(tmpdir(), "cleanup-global-sweep-traces-"));
  }, 90_000);
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), ownerId = randomUUID();
    const pluginId: string = randomUUID(), provider = `cleanup-${pluginId}`, providerLeaseId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cleanup global sweep", defaultResponsibleUserId: "creator",
      issuePrefix: `CG${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "error" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue saved work", status: "todo",
      assigneeAgentId: agentId, createdByUserId: "creator" });
    const [owner] = await db.insert(heartbeatRuns).values({ id: ownerId, companyId, agentId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", runnerInstanceId: randomUUID(), status: "succeeded", finishedAt: new Date(),
      startedAt: new Date(Date.now() - 60_000) }).returning();
    await db.insert(plugins).values({ id: pluginId, pluginKey: provider, packageName: provider, version: "1.0.0",
      apiVersion: 1, categories: ["automation"], status: "ready", manifestJson: { id: provider, apiVersion: 1,
        version: "1.0.0", displayName: "Cleanup provider", description: "External boundary fixture", author: "Paperclip",
        categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: provider, kind: "sandbox_provider", displayName: "Cleanup provider",
          supportsReusableLeases: true, configSchema: { type: "object", properties: { image: { type: "string" } } } }] } });
    const config = { provider, image: "fixture:test", reuseLease: true };
    const [environment] = await db.insert(environments).values({ name: provider, driver: "sandbox", config }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId: environment!.id, heartbeatRunId: ownerId,
      issueId, provider, providerLeaseId, leasePolicy: "reuse_by_environment", status: "retained", cleanupStatus: "success",
      metadata: { driver: "sandbox", provider, pluginId, sandboxConfig: config } }).returning();
    const [message] = await db.insert(issueComments).values({ companyId, issueId, authorType: "agent",
      authorAgentId: agentId, body: "Please continue" }).returning();
    const trace = join(root, `${ownerId}.jsonl`);
    await writeFile(trace, '{"retained":"original session evidence"}\n');
    return { companyId, agentId, issueId, pluginId, providerLeaseId, owner: owner!, lease: lease!, message: message!, trace };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;

  async function quarantine(f: Fixture) {
    const identity = { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, runId: f.owner.id, sessionId: randomUUID() };
    const result: PrpStructuredRunResult = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Saved work",
      completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [{ criterionId: "done", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
      evidence: [], verification: [], attentionRequests: [], artifacts: [] };
    const terminal = { schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "done" } as const;
    const capabilities = { resume: true, typedEvents: true, steering: false, interruption: false, structuredResult: true };
    const close = vi.fn(async () => { throw new NativeSessionCloseUnrecoverableError({ runnerSuspended: false, providerDrained: false }); });
    const session: NativeSession = { identity: () => identity, capabilities: async () => capabilities,
      async *events() { yield { schema: "paperclip.prp.event.v1", sourceEventId: "done", sourceSeq: 1, sourceInstanceId: "runner", sourceKind: "runner",
        runId: identity.runId, normalizedSessionId: identity.sessionId, turnId: "turn", eventType: "turn.completed", schemaVersion: 1,
        priority: 0, emittedAt: new Date().toISOString(), payload: {} }; }, startTurn: async () => ({ turnId: "turn" }),
      result: async () => ({ result, terminal, turnId: "turn" }), close,
      snapshot: async () => ({ backendKind: "mock", sessionId: "driver", identity, providerSessionId: "provider", cursor: null,
        activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }) };
    vi.useFakeTimers();
    try {
      const completed = executeNativeSession({
        input: parseNativeExecutionInput({ schema: "paperclip.native-execution-input.v1", provider: { kind: "codex", model: null },
          binding: { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, runId: f.owner.id, executionWorkspaceId: f.owner.id },
          task: { identifier: "TEST", title: "Continue", description: null, prompt: "Continue", workMode: "standard" },
          workspace: { cwd: root, repoUrl: null, repoRef: null, branchName: null },
          session: { normalizedSessionId: identity.sessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
          completionContract: { id: "contract", sha256: "sha", schemaVersion: "paperclip.completion-contract.v1",
            contract: { revision: "1", objective: "Continue", criteria: [{ id: "done", requirement: "Save work" }] } }, interactionResponses: [], credentialBindings: [] }),
        backend: { descriptor: async () => ({ kind: "mock", name: "cleanup-provider", version: "1", capabilities }), openSession: async () => session },
        controlPlane: { openRun: async () => {}, checkpointSession: async () => {}, appendEvent: async () => ({ cursor: 1, highestContiguousSourceSeq: 1, disposition: "committed" }),
          replayEvents: async () => ({ events: [], highestContiguousSourceSeq: 0 }), completeRun: async () => {} },
        runnerInstanceId: f.owner.runnerInstanceId!, controlPlaneInstanceId: "control",
        remoteCleanupScope: JSON.stringify([f.lease.provider, f.lease.providerLeaseId]),
      });
      const checked = expect(completed).resolves.toMatchObject({ result });
      await vi.advanceTimersByTimeAsync(600_000);
      await checked;
      expect(close).toHaveBeenCalledTimes(1);
      expect(nativeSessionCleanupBlock(f)).toBe("operator_required");
    } finally { vi.useRealTimers(); }
  }

  async function enqueue(f: Fixture) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "queued",
      invocationSource: "assignment", triggerDetail: "system",
      contextSnapshot: { issueId: f.issueId, wakeReason: "issue_assigned", wakeCommentId: f.message.id } }).returning();
    return run!;
  }
  const readRun = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;

  it("one global sweep stops each allocation exactly once, releases only its own gate, and starts each held run exactly once", async () => {
    const fixtures = [await seed(), await seed(), await seed()];
    for (const f of fixtures) await quarantine(f);
    const runs = await Promise.all(fixtures.map(enqueue));
    const confirmed = new Set<string>();
    const releases: Array<{ pluginId: string; confirmed: boolean; gate: ReturnType<typeof nativeSessionCleanupBlock>;
      unconfirmedGates: Array<ReturnType<typeof nativeSessionCleanupBlock>> }> = [];

    // Separate stateful plugin workers, ALL visible to the same manager. Each
    // rejects calls for another allocation, not merely unexpected total counts.
    const workers = new Map(fixtures.map(f => [f.pluginId, {
      call: vi.fn(async (pluginId: string, method: string, input: Record<string, unknown>) => {
        expect(pluginId).toBe(f.pluginId);
        expect(input.providerLeaseId).toBe(f.providerLeaseId);
        if (method === "environmentInspectLease") return { providerLeaseId: f.providerLeaseId,
          state: confirmed.has(f.pluginId) ? "stopped" : "running" };
        if (method !== "environmentStopLease") throw new Error(`Destructive/unexpected provider call: ${method}`);
        // At EVERY stop boundary all not-yet-confirmed allocations must still
        // own their gates and their never-started runs, including other plugins.
        for (const [index, other] of fixtures.entries()) {
          if (confirmed.has(other.pluginId)) continue;
          expect(nativeSessionCleanupBlock(other)).toBe("operator_required");
          expect(await readRun(runs[index]!.id)).toMatchObject({ status: "queued", startedAt: null });
        }
        confirmed.add(f.pluginId);
        return { providerLeaseId: f.providerLeaseId, state: "stopped" };
      }),
    }]));
    const manager = {
      isRunning: (id: string) => workers.has(id),
      getWorker: (id: string) => workers.has(id)
        ? { supportedMethods: ["environmentStopLease", "environmentInspectLease"] } : undefined,
      call: (id: string, method: string, input: Record<string, unknown>) => {
        const worker = workers.get(id);
        if (!worker) throw new Error(`Unknown plugin: ${id}`);
        return worker.call(id, method, input);
      },
    } as unknown as PluginWorkerManager;
    const heartbeat = heartbeatService(db, { environmentRuntime: environmentRuntimeService(db, { pluginWorkerManager: manager }) });
    const active = new Set<Promise<unknown>>();
    const failures: unknown[] = [];
    let unsubscribeWake = () => {}, unsubscribeDispatch = () => {};
    const unsubscribeSettled = onNativeSessionCleanupSettled(scope => {
      for (const f of fixtures) {
        if (scope.companyId !== f.companyId || !scope.issueIds.includes(f.issueId)) continue;
        // Runtime observers swallow thrown errors, so record here and assert
        // outside the observer. A sibling's stop must never release this gate.
        releases.push({ pluginId: f.pluginId, confirmed: confirmed.has(f.pluginId), gate: nativeSessionCleanupBlock(f),
          unconfirmedGates: fixtures.filter(other => !confirmed.has(other.pluginId)).map(nativeSessionCleanupBlock) });
      }
    });
    try {
      await heartbeat.resumeQueuedRuns();
      for (const [index, f] of fixtures.entries()) {
        expect(manager.isRunning(f.pluginId)).toBe(true);
        expect(nativeSessionCleanupBlock(f)).toBe("operator_required");
        expect(await readRun(runs[index]!.id)).toMatchObject({ status: "queued", startedAt: null });
        expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0])
          .toMatchObject({ status: "pending_cleanup", metadata: { sandboxStopAndRetain: { nativeCleanupGateOwner: true } } });
      }
      expect([...workers.values()].flatMap(worker => worker.call.mock.calls)).toHaveLength(0);
      unsubscribeWake = registerNativeCleanupReleaseWake(db, error => failures.push(error));
      unsubscribeDispatch = subscribeDeliveryWork(db, DELIVERY_QUEUES.queuedRunDispatch, () => {
        const operation = heartbeat.resumeQueuedRuns();
        active.add(operation);
        void operation.catch(error => failures.push(error)).finally(() => active.delete(operation));
      });

      // The only sweep in this test: no per-plugin sweeps or provider filtering.
      await heartbeat.sweepPendingCleanupLeases();
      await expect.poll(async () => (await Promise.all(runs.map(run => readRun(run.id))))
        .every(run => run.startedAt !== null), { timeout: 10_000 }).toBe(true);
      await Promise.allSettled([...active]);
      await Promise.all(runs.map(run => heartbeat.waitForRunExecutionDrain(run.id, { timeoutMs: 15_000 })));
      const started = await Promise.all(runs.map(async run => (await readRun(run.id)).startedAt));
      await Promise.all([heartbeat.resumeQueuedRuns(), heartbeat.resumeQueuedRuns()]);

      const stopCounts = fixtures.map(f => workers.get(f.pluginId)!.call.mock.calls
        .filter(call => call[1] === "environmentStopLease").length);
      expect(stopCounts).toEqual([1, 1, 1]);
      expect(stopCounts.reduce((total, count) => total + count, 0)).toBe(3);
      expect(confirmed.size).toBe(3);
      expect(releases.map(release => release.pluginId).sort()).toEqual(fixtures.map(f => f.pluginId).sort());
      for (const release of releases) {
        expect(release.confirmed).toBe(true);
        expect(release.gate).toBeNull();
        expect(release.unconfirmedGates.every(gate => gate === "operator_required")).toBe(true);
      }
      for (const [index, f] of fixtures.entries()) {
        expect(nativeSessionCleanupBlock(f)).toBeNull();
        expect((await readRun(runs[index]!.id)).startedAt).toEqual(started[index]);
        expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
          sql`${heartbeatRuns.contextSnapshot}->>'wakeCommentId' = ${f.message.id}`))).toHaveLength(1);
        expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0])
          .toMatchObject({ status: "released", cleanupStatus: "success", metadata: { remoteExecutionTermination: {
            runId: f.owner.id, providerLeaseId: f.providerLeaseId, state: "stopped" } } });
        expect(await readFile(f.trace, "utf8")).toBe('{"retained":"original session evidence"}\n');
        expect((await readRun(f.owner.id)).status).toBe("succeeded");
      }
      expect(failures).toEqual([]);
    } finally {
      unsubscribeDispatch(); unsubscribeWake(); unsubscribeSettled();
      await Promise.allSettled([...active]);
      await Promise.all(runs.map(run => heartbeat.waitForRunExecutionDrain(run.id, { timeoutMs: 15_000 })));
    }
  });
});
