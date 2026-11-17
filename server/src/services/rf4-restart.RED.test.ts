import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { environmentRuntimeService } from "./environment-runtime.js";
import { environmentService } from "./environments.js";
import { prepareNativeWorkspaceSync } from "./native-runtime/native-workspace-sync.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, environmentLeases, heartbeatRuns,
  issueComments, issueRecoveryActions, issues, nativeRunFinalizations, environments, executionWorkspaces, projects, plugins,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";

// Independent RF4 row 12 RED. No mocked warm-owner/proof/admission/stop functions.
// Durable rows model the completed Stop's warm handoff, exactly as the adjacent
// explicit-native-send-after-stop test. Resetting modules recreates the actual
// executor and loses its process-local map, while the PostgreSQL connection lives.
const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) throw new Error(`RF4 requires embedded PostgreSQL: ${support.reason}`);

describe("RF4 row 12: restart between warm Stop and the person's Send", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("rf4-restart-red-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });

  it("records exactly one immediate stop intent, then admits exactly one saved-message successor without a recovery hold", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const sourceRunId = randomUUID(), queueId = randomUUID(), occupiedRunId = randomUUID();
    const providerLeaseId = `bx_rf4_${randomUUID()}`;
    const stoppedAt = new Date(Date.now() - 1_000);
    const environmentId = randomUUID(), workspaceId = randomUUID(), projectId = randomUUID(), pluginId = randomUUID();
    const root = await mkdtemp(path.join(os.tmpdir(), "rf4-restart-workspace-")); roots.push(root);
    const host = path.join(root, "host"), remote = path.join(root, "remote");
    await mkdir(host); await mkdir(remote); await writeFile(path.join(host, "base.txt"), "last finalized workspace\n");
    const config = { provider: "boat", image: "rf4:unchanged", reuseLease: true, timeoutMs: 300000 };
    const pluginKey = `rf4.boat.${pluginId}`;
    await db.insert(environments).values({ id: environmentId, name: "RF4 Boat", driver: "sandbox", status: "active", config });
    await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: "@rf4/boat", version: "1.0.0", apiVersion: 1,
      categories: ["automation"], status: "ready", manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0",
        displayName: "RF4 Boat boundary", description: "Provider I/O fixture", author: "RF4", categories: ["automation"],
        capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" }, environmentDrivers: [
          { driverKey: "boat", kind: "sandbox_provider", displayName: "Boat", supportsReusableLeases: true, configSchema: { type: "object" } },
        ] } } as typeof plugins.$inferInsert);
    const providerCalls: string[] = [];
    let initialAcquire = true;
    const worker = { isRunning: () => true, getWorker: () => ({ supportedMethods: ["environmentAcquireLease", "environmentResumeLease", "environmentStopLease", "environmentReleaseLease", "environmentDestroyLease"] }),
      call: async (_pluginId: string, method: string) => { providerCalls.push(method);
        if (method === "environmentAcquireLease" && initialAcquire) { initialAcquire = false; return { providerLeaseId, metadata: { ...config, remoteCwd: remote } }; }
        if (method === "environmentStopLease") return { providerLeaseId, state: "stopped" };
        if (method === "environmentResumeLease") return { providerLeaseId, metadata: { ...config, remoteCwd: remote } };
        throw new Error(`No new box or destroy allowed: ${method}`);
      } } as unknown as PluginWorkerManager;
    const environment = (await environmentService(db).getById(environmentId))!;
    let runtime = environmentRuntimeService(db, { pluginWorkerManager: worker });
    await db.insert(companies).values({ id: companyId, name: "RF4 restart", defaultResponsibleUserId: "board", issuePrefix: `R${companyId.replaceAll("-", "")}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Native", role: "engineer", adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Existing daily-chat Stop shape", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "running", contextSnapshot: { issueId },
      runnerProfileJson: { nativeResourceDisposition: "keep_running" },
      resultJson: { stopReason: "cancelled", nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: sourceRunId,
        companyId, issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
        intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), recordedAt: stoppedAt.toISOString() } } });
    await db.insert(projects).values({ id: projectId, companyId, name: "Existing project", status: "active" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId, mode: "shared_workspace", strategyType: "project_primary", name: "Daily workspace", status: "active", providerType: "local_fs" });
    // Use the runtime's real warm release to produce the durable handoff; only
    // provider RPC/command I/O is a fixture, not the release or admission proof.
    const originalLease = (await runtime.acquireRunLease({ companyId, environment, issueId, agentId, adapterType: "paperclip_runner",
      heartbeatRunId: sourceRunId, persistedExecutionWorkspace: { id: workspaceId, mode: "shared_workspace" } })).lease;
    expect(providerCalls).toEqual(["environmentAcquireLease"]);
    providerCalls.length = 0;
    // acquireLease generates the actual source-row ID; retain it below.
    const sourceLeaseId = originalLease.id;
    const runner: CommandManagedRuntimeRunner = { execute: input => new Promise((resolve, reject) => {
      const child = execFile(input.command, input.args ?? [], { cwd: input.cwd, env: { ...process.env, ...input.env }, timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => resolve({ exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          signal: error?.signal ?? null, timedOut: error?.killed ?? false, stdout, stderr, pid: null, startedAt: null }));
      child.stdin?.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") reject(error); }); child.stdin?.end(input.stdin ?? "");
    }) };
    const target: AdapterSandboxExecutionTarget = { kind: "remote", transport: "sandbox", providerKey: "boat", leaseId: sourceLeaseId,
      remoteCwd: remote, runner, timeoutMs: 30000, sandboxLeaseAcquisition: { outcome: "created", providerLeaseId } };
    const prepared = (await prepareNativeWorkspaceSync({ db, companyId, runId: sourceRunId, workspaceId, workspaceLocalDir: host, lease: originalLease, target }))!;
    try { await prepared.restoreWorkspace(); } finally { await prepared.cleanup(); }
    const unsynced = `task-workspace edit after finalize ${randomUUID()}\n`;
    await writeFile(path.join(remote, "unsynced.txt"), unsynced);
    const fileSha = createHash("sha256").update(unsynced).digest("hex");
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled", finishedAt: stoppedAt }).where(eq(heartbeatRuns.id, sourceRunId));
    await db.insert(nativeRunFinalizations).values({ runId: sourceRunId, companyId, issueId, phase: "terminal_failure", failureCode: "native_retry_cancelled" });
    await runtime.releaseRunLeases(sourceRunId, "released", undefined, "keep_running");
    expect((await environmentService(db).getLeaseById(sourceLeaseId))?.status).toBe("retained");
    expect(providerCalls).toEqual([]);
    const comments = ["A", "B", "C"].map((body, index) => ({ id: randomUUID(), companyId, issueId, authorType: "user" as const,
      authorUserId: "board", body, createdAt: new Date(stoppedAt.getTime() - 3_000 + index) }));
    await db.insert(issueComments).values(comments);
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId, agentId, source: "on_demand", reason: "issue_commented",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId, _paperclipWakeContext: { wakeCommentIds: comments.map(c => c.id) },
        queuedCommentInterrupt: { actorId: "board", requestedAt: new Date().toISOString() } } });

    const oldExecutor = await import("./native-runtime/native-session-executor.js");
    vi.resetModules(); // Controller boot boundary, NOT a mocked false proof.
    const restartedExecutor = await import("./native-runtime/native-session-executor.js");
    expect(restartedExecutor.handedOffWarmOwnerRunnerExited).not.toBe(oldExecutor.handedOffWarmOwnerRunnerExited);
    expect(await restartedExecutor.handedOffWarmOwnerRunnerExited({ runId: sourceRunId, providerLeaseId })).toBe(false);
    runtime = environmentRuntimeService(db, { pluginWorkerManager: worker });
    const { heartbeatService } = await import("./heartbeat.js");
    const { settleStopOnlyCleanup } = await import("./sandbox-stop-and-retain.js");
    const { buildExecutionContinuation } = await import("./execution-continuation.js");
    const lease = async () => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, sourceLeaseId)))[0]!;
    const wake = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId)))[0]!;
    const runs = async () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const sendAt = Date.now();
    await heartbeatService(db).resumeQueuedCommentInterrupt(companyId, queueId);
    const stopping = await lease();
    const firstWake = await wake();
    const observed = { sourceRunId, leaseId: sourceLeaseId, providerLeaseId, sendAt,
      elapsedMs: Date.now() - sendAt, leaseStatus: stopping.status, metadata: stopping.metadata, wake: firstWake };
    console.log("RF4_RESTART_BASE", JSON.stringify(observed));
    if (process.env.RF4_EVIDENCE_PATH) await writeFile(process.env.RF4_EVIDENCE_PATH, JSON.stringify(observed, null, 2));
    expect(firstWake).toMatchObject({ status: "deferred_issue_execution", runId: null,
      payload: { executionWait: { reason: "remote_cleanup" } } });
    expect(Date.now() - sendAt).toBeLessThan(10_000);
    // THE RED: at base this remains retained, with NO stop intent, indefinitely
    // until warm expiry. A fix must schedule the real stop-only cleanup owner.
    expect(stopping, "restart must request stop now, not wait for warm expiry").toMatchObject({ status: "pending_cleanup", providerLeaseId });
    const intent = stopping.metadata?.sandboxStopAndRetain as Record<string, unknown>;
    expect(intent).toMatchObject({ schema: "paperclip.sandbox-stop-and-retain.v1", runId: sourceRunId, leaseId: sourceLeaseId, providerLeaseId });
    expect(intent.requestId).toEqual(expect.any(String));
    await heartbeatService(db).resumeQueuedCommentInterrupt(companyId, queueId);
    expect((await lease()).metadata?.sandboxStopAndRetain).toEqual(intent);
    expect((await runs()).map(run => run.id)).toEqual([sourceRunId]);
    const stopReceipt = await runtime.retryPendingSandboxTeardown({ environment, lease: stopping });
    const settled = await settleStopOnlyCleanup(db, stopping, { attemptId: String(stopping.metadata?.pendingCleanupAttemptId), receipt: stopReceipt });
    expect(settled).toMatchObject({ status: "released", providerLeaseId });
    // Occupy the agent's one scheduler slot on another task: admission/queueing
    // remain real, but there is no unawaited model execution racing this test's
    // explicit acquisition/workspace service calls or its database teardown.
    await db.insert(heartbeatRuns).values({ id: occupiedRunId, companyId, agentId, status: "running", runtimeMode: "native", contextSnapshot: {} });
    await heartbeatService(db).resumeRemoteStopComments((await runs()).find(run => run.id === sourceRunId)!);
    await heartbeatService(db).resumeQueuedCommentInterrupt(companyId, queueId);
    const receipt = await wake();
    expect(receipt).toMatchObject({ status: "coalesced" });
    const successors = (await runs()).filter(run => run.id !== sourceRunId && run.id !== occupiedRunId);
    expect(successors).toHaveLength(1);
    expect(successors[0].id).toBe(receipt.runId);
    expect(successors[0].contextSnapshot).toMatchObject({ previousRunId: sourceRunId });
    const envelope = await buildExecutionContinuation({ db, companyId, issueId, agentId, runId: successors[0].id,
      context: successors[0].contextSnapshot!, summary: null, exposeLowTrustRaw: false });
    expect(envelope.messages.filter(message => comments.some(c => c.id === message.id)).map(message => message.body)).toEqual(["A", "B", "C"]);
    const holds = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(holds, "Stop fallback must not create a preserve/reconciliation dead chat").toEqual([]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, sourceRunId)))[0].status).toBe("cancelled");
    const acquired = await runtime.acquireRunLease({ companyId, environment, issueId, agentId, adapterType: "paperclip_runner",
      heartbeatRunId: successors[0].id, persistedExecutionWorkspace: { id: workspaceId, mode: "shared_workspace" } });
    expect(acquired.lease.providerLeaseId).toBe(providerLeaseId);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed" });
    const next = (await prepareNativeWorkspaceSync({ db, companyId, runId: successors[0].id, workspaceId, workspaceLocalDir: host,
      lease: acquired.lease, target: { ...target, leaseId: acquired.lease.id, sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId } } }))!;
    try {
      expect(next.mode).toBe("adopt_remote");
      expect(createHash("sha256").update(await readFile(path.join(remote, "unsynced.txt"))).digest("hex")).toBe(fileSha);
      await next.restoreWorkspace();
      expect(createHash("sha256").update(await readFile(path.join(host, "unsynced.txt"))).digest("hex")).toBe(fileSha);
    } finally { await next.cleanup(); }
    expect(providerCalls).toEqual(["environmentStopLease", "environmentResumeLease"]);
    expect(Date.now() - sendAt).toBeLessThan(60_000);
    const success = { sourceRunId, successorRunId: successors[0].id, sourceLeaseId,
      successorLeaseId: acquired.lease.id, providerLeaseId, mode: next.mode, fileSha, providerCalls, elapsedMs: Date.now() - sendAt, holdCount: holds.length };
    console.log("RF4_RESTART_SUCCESSOR", JSON.stringify(success));
    if (process.env.RF4_EVIDENCE_PATH) await writeFile(process.env.RF4_EVIDENCE_PATH, JSON.stringify({ observed, success }, null, 2));
  }, 120_000);
});
