import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRunEvents, heartbeatRuns,
  issueComments, issues, plugins } from "@paperclipai/db";
import { executeNativeSession, nativeSessionCleanupBlock, NativeSessionCloseUnrecoverableError,
  parseNativeExecutionInput, type NativeSession, type PrpStructuredRunResult } from "../vendor/paperclip-runner/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../services/delivery-work-notifications.js";
import { registerNativeCleanupReleaseWake } from "../services/native-runtime/native-cleanup-release-wake.js";
import { logNativeCleanupQuarantines } from "../services/native-runtime/native-cleanup-quarantine-log.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Keep: #20806 production catch, plus exact remote owner/data-safety boundary.
// PostgreSQL, runtime quarantine, queue, cleanup worker and release wake are real.
// Only the external provider is a stateful fixture; no live-provider claim.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("operator-required remote cleanup admission recovery (#20806)", () => {
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

  async function seed(authorType: "user" | "agent" | "system" = "system", ownerStatus = "succeeded") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), ownerId = randomUUID();
    const pluginId = randomUUID(), provider = `cleanup-${pluginId}`, providerLeaseId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cleanup recovery", defaultResponsibleUserId: "creator",
      issuePrefix: `CR${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "error" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue saved work", status: "todo",
      assigneeAgentId: agentId, createdByUserId: "creator" });
    const [owner] = await db.insert(heartbeatRuns).values({ id: ownerId, companyId, agentId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", runnerInstanceId: randomUUID(), status: ownerStatus, finishedAt: new Date(),
      startedAt: new Date(Date.now() - 60_000), errorCode: ownerStatus === "failed" ? "provider_transport_failed" : null }).returning();
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
    const [message] = await db.insert(issueComments).values({ companyId, issueId, authorType,
      authorUserId: authorType === "user" ? "creator" : null, authorAgentId: authorType === "agent" ? agentId : null,
      body: "Please continue" }).returning();
    const trace = join(root, `${ownerId}.jsonl`);
    await writeFile(trace, '{"retained":"original session evidence"}\n');
    let confirmation: "stopped" | "unconfirmed" | "foreign" = "unconfirmed";
    let running = true;
    const call = vi.fn(async (_plugin: string, method: string, input: Record<string, unknown>) => {
      expect(input.providerLeaseId).toBe(providerLeaseId);
      if (method === "environmentInspectLease") return { providerLeaseId, state: running ? "running" : "stopped" };
      if (method !== "environmentStopLease") throw new Error(`Destructive/unexpected provider call: ${method}`);
      if (confirmation === "unconfirmed") return undefined;
      if (confirmation === "foreign") return { providerLeaseId: "not-the-owner", state: "stopped" };
      running = false;
      return { providerLeaseId, state: "stopped" };
    });
    const worker = { isRunning: () => true, call, getWorker: () => ({ supportedMethods: ["environmentStopLease", "environmentInspectLease"] }) } as unknown as PluginWorkerManager;
    const heartbeat = heartbeatService(db, { environmentRuntime: environmentRuntimeService(db, { pluginWorkerManager: worker }) });
    return { companyId, agentId, issueId, owner: owner!, lease: lease!, message: message!, trace, call, heartbeat,
      confirm: (value: typeof confirmation) => { confirmation = value; }, running: () => running };
  }

  async function quarantine(f: Awaited<ReturnType<typeof seed>>, exhausted = true) {
    const identity = { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, runId: f.owner.id, sessionId: randomUUID() };
    const result: PrpStructuredRunResult = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Saved work",
      completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [{ criterionId: "done", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
      evidence: [], verification: [], attentionRequests: [], artifacts: [] };
    const terminal = { schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "done" } as const;
    const capabilities = { resume: true, typedEvents: true, steering: false, interruption: false, structuredResult: true };
    const close = vi.fn(async () => { throw exhausted ? new Error("Durable recovery runner timed out.")
      : new NativeSessionCloseUnrecoverableError({ runnerSuspended: false, providerDrained: false }); });
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
      expect(close).toHaveBeenCalledTimes(exhausted ? 13 : 1); // initial + 3 retained + 9 automatic
      expect(nativeSessionCleanupBlock(f)).toBe("operator_required");
    } finally { vi.useRealTimers(); }
  }

  async function enqueue(f: Awaited<ReturnType<typeof seed>>) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "queued",
      invocationSource: "assignment", triggerDetail: "system",
      contextSnapshot: { issueId: f.issueId, wakeReason: "issue_assigned", wakeCommentId: f.message.id } }).returning();
    return run!;
  }
  const readRun = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
  async function evidence(f: Awaited<ReturnType<typeof seed>>, runId: string) {
    const events = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.eventType, "native_session_cleanup_settling")));
    const notes = await db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "system"),
      sql`${issueComments.metadata}->>'authorizationReason' = ${`native_session_cleanup_settling:${runId}`}`));
    return { events, notes };
  }

  it.each(["user", "agent", "system"] as const)("notices an exhausted SUCCEEDED owner's hold for a %s requester within 60 seconds, without proof or restart", async author => {
    const f = await seed(author);
    await quarantine(f);
    const run = await enqueue(f);
    await f.heartbeat.resumeQueuedRuns();
    await f.heartbeat.resumeQueuedRuns();
    expect(await readRun(run.id)).toMatchObject({ status: "queued", startedAt: null });
    expect(nativeSessionCleanupBlock(f)).toBe("operator_required");
    const visible = await evidence(f, run.id);
    expect.soft(visible.events).toHaveLength(1);
    expect.soft(visible.notes).toHaveLength(1);
    if (visible.notes[0]) {
      expect(visible.notes[0].body).toContain("previous session");
      expect(visible.notes[0].createdAt.getTime() - run.createdAt.getTime()).toBeLessThanOrEqual(60_000);
    }
    expect(await readFile(f.trace, "utf8")).toBe('{"retained":"original session evidence"}\n');
  });

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

  it.each([true, false])("drives stop-only cleanup from the gate (exhausted=%s), holds on a foreign receipt, then starts exactly once after confirmed stop", async exhausted => {
    const f = await seed("agent", exhausted ? "succeeded" : "failed");
    await quarantine(f, exhausted);
    const run = await enqueue(f);
    await f.heartbeat.resumeQueuedRuns();
    f.confirm("foreign");
    await f.heartbeat.sweepPendingCleanupLeases();
    expect(nativeSessionCleanupBlock(f)).toBe("operator_required");
    expect(await readRun(run.id)).toMatchObject({ status: "queued", startedAt: null });
    expect.soft((await evidence(f, run.id)).notes).toHaveLength(1);
    expect(f.running()).toBe(true);

    // The existing durable cleanup retry is due after 30 s. Advance only the
    // clock, not stored rows; do not manually fabricate a stop receipt.
    const now = Date.now();
    const realNow = Date.now;
    Date.now = () => now + 31_000;
    const active = new Set<Promise<unknown>>();
    const failures: unknown[] = [];
    const unsubscribeWake = registerNativeCleanupReleaseWake(db, error => failures.push(error));
    const unsubscribeDispatch = subscribeDeliveryWork(db, DELIVERY_QUEUES.queuedRunDispatch, () => {
      const operation = f.heartbeat.resumeQueuedRuns();
      active.add(operation);
      void operation.catch(error => failures.push(error)).finally(() => active.delete(operation));
    });
    try {
      f.confirm("stopped");
      await f.heartbeat.sweepPendingCleanupLeases();
      await expect.poll(async () => (await readRun(run.id)).startedAt, { timeout: 10_000 }).not.toBeNull();
      expect(nativeSessionCleanupBlock(f)).toBeNull();
      expect(f.running()).toBe(false);
      const started = (await readRun(run.id)).startedAt!;
      await Promise.all([f.heartbeat.resumeQueuedRuns(), f.heartbeat.resumeQueuedRuns()]);
      expect((await readRun(run.id)).startedAt).toEqual(started);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'wakeCommentId' = ${f.message.id}`))).toHaveLength(1);
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0])
        .toMatchObject({ status: "released", metadata: { remoteExecutionTermination: { runId: f.owner.id, providerLeaseId: f.lease.providerLeaseId, state: "stopped" } } });
      expect(f.call.mock.calls.filter(call => call[1] === "environmentStopLease")).toHaveLength(2);
      expect(await readFile(f.trace, "utf8")).toBe('{"retained":"original session evidence"}\n');
      expect((await readRun(f.owner.id)).status).toBe(exhausted ? "succeeded" : "failed");
      expect(failures).toEqual([]);
    } finally {
      Date.now = realNow;
      unsubscribeDispatch(); unsubscribeWake();
      await Promise.allSettled([...active]);
      await f.heartbeat.waitForRunExecutionDrain(run.id, { timeoutMs: 15_000 });
    }
  });
});
