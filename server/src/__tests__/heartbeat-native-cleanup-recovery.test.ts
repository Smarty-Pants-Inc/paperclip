import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues, plugins } from "@paperclipai/db";
import { executeNativeSession, nativeSessionCleanupBlock, type NativeSession, type PrpStructuredRunResult } from "../vendor/paperclip-runner/index.js";
import { parseNativeExecutionInput } from "../vendor/paperclip-runner/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { logNativeCleanupQuarantines } from "../services/native-runtime/native-cleanup-quarantine-log.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Keep the remote-owner and trace safety guards. Admission now uses upstream's
// read/retire-only path; it must not stop a remote allocation or lose its files.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("operator-required remote cleanup safety", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("cleanup-recovery-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true });
    root = await mkdtemp(join(tmpdir(), "cleanup-recovery-traces-"));
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); if (root) await rm(root, { recursive: true, force: true }); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), ownerId = randomUUID();
    const pluginId = randomUUID(), provider = `cleanup-${pluginId}`, providerLeaseId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cleanup recovery", defaultResponsibleUserId: "creator",
      issuePrefix: `CR${companyId.slice(0, 6)}` });
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
    const trace = join(root, `${ownerId}.jsonl`);
    await writeFile(trace, '{"retained":"original session evidence"}\n');
    const call = vi.fn(async (_plugin: string, method: string, input: Record<string, unknown>) => {
      expect(input.providerLeaseId).toBe(providerLeaseId);
      if (method === "environmentInspectLease") return { providerLeaseId, state: "running" };
      if (method !== "environmentStopLease") throw new Error(`Destructive/unexpected provider call: ${method}`);
      return undefined;
    });
    const worker = { isRunning: (id: string) => id === pluginId, call,
      getWorker: (id: string) => id === pluginId ? { supportedMethods: ["environmentStopLease", "environmentInspectLease"] } : undefined } as unknown as PluginWorkerManager;
    const heartbeat = heartbeatService(db, { environmentRuntime: environmentRuntimeService(db, { pluginWorkerManager: worker }) });
    return { companyId, agentId, issueId, owner: owner!, lease: lease!, trace, call, heartbeat };
  }

  async function quarantine(f: Awaited<ReturnType<typeof seed>>) {
    const identity = { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, runId: f.owner.id, sessionId: randomUUID() };
    const result: PrpStructuredRunResult = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Saved work",
      completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [{ criterionId: "done", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
      evidence: [], verification: [], attentionRequests: [], artifacts: [] };
    const terminal = { schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "done" } as const;
    const capabilities = { resume: true, typedEvents: true, steering: false, interruption: false, structuredResult: true };
    const close = vi.fn(async () => { throw new Error("Durable recovery runner timed out."); });
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
      expect(close).toHaveBeenCalledTimes(13);
      expect(nativeSessionCleanupBlock(f)).toBe("operator_required");
    } finally { vi.useRealTimers(); }
  }

  async function enqueue(f: Awaited<ReturnType<typeof seed>>) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "queued",
      invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId: f.issueId, wakeReason: "issue_assigned" } }).returning();
    return run!;
  }
  const retire = (runId: string) => db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
    .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "queued")));

  it("announces automatic recovery exhaustion exactly once, with its succeeded owner's identity", async () => {
    const f = await seed();
    const warn = vi.fn();
    const unsubscribe = logNativeCleanupQuarantines({ warn });
    try {
      await quarantine(f);
      nativeSessionCleanupBlock(f); nativeSessionCleanupBlock(f);
      expect(warn.mock.calls.filter(([details]) => details.operatorRecoveryRequired === true)).toEqual([
        [expect.objectContaining({ runId: f.owner.id, issueId: f.issueId, cause: expect.stringContaining("native_session_cleanup_recovery_exhausted") }), expect.any(String)],
      ]);
    } finally { unsubscribe(); }
  });

  it("J2-13 an unconfirmed remote owner keeps the gate, the queued run and the Runner", async () => {
    const f = await seed();
    await quarantine(f);
    const run = await enqueue(f);
    try {
      await f.heartbeat.resumeQueuedRuns();
      await f.heartbeat.sweepPendingCleanupLeases();
      expect(nativeSessionCleanupBlock(f)).toBe("operator_required");
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0])
        .toMatchObject({ status: "queued", startedAt: null });
      expect(f.call.mock.calls.filter(call => call[1] === "environmentStopLease")).toHaveLength(0);
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      expect(lease!.metadata?.remoteExecutionTermination).toBeUndefined();
      expect(await readFile(f.trace, "utf8")).toBe('{"retained":"original session evidence"}\n');
    } finally { await retire(run.id); }
  });

  it("J2-4 never stops a sandbox a later run of the task is still running in: no stop, the gate and the held run stay", async () => {
    const f = await seed();
    await quarantine(f);
    const [later] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      nativeIssueId: f.issueId, runtimeMode: "native", runnerInstanceId: randomUUID(), status: "running", startedAt: new Date() }).returning();
    const [successor] = await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: f.lease.environmentId,
      heartbeatRunId: later!.id, issueId: f.issueId, provider: f.lease.provider, providerLeaseId: f.lease.providerLeaseId,
      leasePolicy: "reuse_by_environment", status: "active", cleanupStatus: "success",
      metadata: f.lease.metadata, createdAt: new Date(Date.now() + 1_000) }).returning();
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(),
      metadata: { ...f.lease.metadata, reusableLeaseSuccessor: successor!.id } }).where(eq(environmentLeases.id, f.lease.id));
    const run = await enqueue(f);
    try {
      await f.heartbeat.resumeQueuedRuns();
      await f.heartbeat.sweepPendingCleanupLeases();
      expect(f.call.mock.calls.filter(call => call[1] === "environmentStopLease")).toHaveLength(0);
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, successor!.id)))[0])
        .toMatchObject({ status: "active" });
      expect(nativeSessionCleanupBlock(f)).toBe("operator_required");
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0])
        .toMatchObject({ status: "queued", startedAt: null });
      expect(await readFile(f.trace, "utf8")).toBe('{"retained":"original session evidence"}\n');
    } finally { await retire(run.id); }
  });
});
