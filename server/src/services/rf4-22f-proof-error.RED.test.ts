import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, environmentLeases, heartbeatRuns,
  issueComments, issueRecoveryActions, issues, nativeRunFinalizations, environments, executionWorkspaces, projects, plugins,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase, getEmbeddedPostgresTestSupport } from "../__tests__/helpers/embedded-postgres.js";

// rf-4 row 22f: the stopped warm owner's IDLE entry is still held in this
// process (so sas3's 'proof unavailable' arm does not apply) and its Runner's
// exit proof answers an ERROR (the Runner ingress returns 502). Only the warm
// entry and the Runner's answer are stand-ins; the release, the Send, the
// stop_and_retain intent, the provider receipt (REAL settleStopOnlyCleanup over
// a fake provider), the resume and the admission are the real code.
const owner = vi.hoisted(() => ({ busy: false, calls: 0 }));
vi.mock("./native-runtime/native-session-executor.js", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  handedOffWarmOwnerRunnerExited: async () => { owner.calls += 1;
    throw Object.assign(new Error("runner_port_holder_inventory_unavailable: Runner ingress answered 502 Bad Gateway"), { status: 502 }); },
  handedOffWarmOwnerProofUnavailable: () => false,
  handedOffWarmOwnerBusy: () => owner.busy,
}));
const { environmentRuntimeService } = await import("./environment-runtime.js");
const { environmentService } = await import("./environments.js");
const { prepareNativeWorkspaceSync } = await import("./native-runtime/native-workspace-sync.js");
const { heartbeatService } = await import("./heartbeat.js");
const { settleStopOnlyCleanup, hasStopOnlyCleanup } = await import("./sandbox-stop-and-retain.js");
const { buildExecutionContinuation } = await import("./execution-continuation.js");
const handedOff = await import("./native-runtime/handed-off-warm-lease.js");

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) throw new Error(`rf-4 22f requires embedded PostgreSQL: ${support.reason}`);

describe("rf-4 row 22f: a runner-exit proof ERROR (502) takes the same bounded fallback as a timeout", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("rf4-22f-red-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });

  async function seed() {
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
    await db.insert(environments).values({ id: environmentId, name: `RF4 Boat ${environmentId.slice(0, 8)}`, driver: "sandbox", status: "active", config });
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
    void createHash; const unsynced = `task-workspace edit after finalize ${randomUUID()}\n`;
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

    const lease = async () => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, sourceLeaseId)))[0]!;
    const wake = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId)))[0]!;
    const runs = async () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    return { companyId, agentId, issueId, sourceRunId, queueId, sourceLeaseId, providerLeaseId, occupiedRunId, environment, workspaceId,
      comments, providerCalls, runtime, lease, wake, runs };
  }

  it("idle owner + 502 proof -> one stop_and_retain intent (proof_error) -> provider receipt -> ONE successor, A/B/C once in order, 0 recovery actions", async () => {
    owner.busy = false; owner.calls = 0;
    const f = await seed();
    const sendAt = Date.now();
    await heartbeatService(db).resumeQueuedCommentInterrupt(f.companyId, f.queueId);
    // The proof runs outside the transaction; give it its bound (inline wait 1 s) and read the persisted answer.
    const end = Date.now() + 10_000;
    while (!hasStopOnlyCleanup(await f.lease()) && Date.now() < end) await new Promise(r => setTimeout(r, 100));
    const stopping = await f.lease();
    console.log("RF4_22F_SEND", JSON.stringify({ elapsedMs: Date.now() - sendAt, proofCalls: owner.calls, status: stopping.status, metadata: stopping.metadata, wake: await f.wake() }));
    expect(owner.calls).toBeGreaterThan(0);
    // THE RED: at base the 502 becomes 'unproven', no intent, the wake stays deferred with runId null forever (dead chat).
    expect(stopping, "a proof error must request the stop now").toMatchObject({ status: "pending_cleanup", providerLeaseId: f.providerLeaseId });
    const intent = stopping.metadata?.sandboxStopAndRetain as Record<string, unknown>;
    expect(intent).toMatchObject({ schema: "paperclip.sandbox-stop-and-retain.v1", runId: f.sourceRunId, leaseId: f.sourceLeaseId, providerLeaseId: f.providerLeaseId });
    expect(JSON.stringify(stopping.metadata)).toContain(handedOff.HANDED_OFF_WARM_STOP_KEY);
    expect(JSON.stringify(stopping.metadata)).toContain('"proofFailure":"proof_error"');
    // A second Send never writes a second intent.
    await heartbeatService(db).resumeQueuedCommentInterrupt(f.companyId, f.queueId);
    expect((await f.lease()).metadata?.sandboxStopAndRetain).toEqual(intent);
    expect((await f.runs()).map(run => run.id)).toEqual([f.sourceRunId]);
    const stopReceipt = await f.runtime.retryPendingSandboxTeardown({ environment: f.environment,
      lease: stopping as Parameters<typeof f.runtime.retryPendingSandboxTeardown>[0]["lease"] });
    expect(await settleStopOnlyCleanup(db, stopping, { attemptId: String(stopping.metadata?.pendingCleanupAttemptId), receipt: stopReceipt }))
      .toMatchObject({ status: "released", providerLeaseId: f.providerLeaseId });
    await db.insert(heartbeatRuns).values({ id: f.occupiedRunId, companyId: f.companyId, agentId: f.agentId, status: "running", runtimeMode: "native", contextSnapshot: {} });
    await heartbeatService(db).resumeRemoteStopComments((await f.runs()).find(run => run.id === f.sourceRunId)!);
    await heartbeatService(db).resumeQueuedCommentInterrupt(f.companyId, f.queueId);
    const receipt = await f.wake();
    expect(receipt).toMatchObject({ status: "coalesced" });
    const successors = (await f.runs()).filter(run => run.id !== f.sourceRunId && run.id !== f.occupiedRunId);
    expect(successors).toHaveLength(1);
    expect(successors[0].id).toBe(receipt.runId);
    const envelope = await buildExecutionContinuation({ db, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, runId: successors[0].id,
      context: successors[0].contextSnapshot!, summary: null, exposeLowTrustRaw: false });
    expect(envelope.messages.filter(message => f.comments.some(c => c.id === message.id)).map(message => message.body)).toEqual(["A", "B", "C"]);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).toEqual([]);
    const acquired = await f.runtime.acquireRunLease({ companyId: f.companyId, environment: f.environment, issueId: f.issueId, agentId: f.agentId,
      adapterType: "paperclip_runner", heartbeatRunId: successors[0].id, persistedExecutionWorkspace: { id: f.workspaceId, mode: "shared_workspace" } });
    expect(acquired.lease.providerLeaseId).toBe(f.providerLeaseId);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed" });
    expect(f.providerCalls).toEqual(["environmentStopLease", "environmentResumeLease"]);
    expect(Date.now() - sendAt).toBeLessThan(60_000);
    console.log("RF4_22F_SUCCESSOR", JSON.stringify({ successorRunId: successors[0].id, elapsedMs: Date.now() - sendAt, providerCalls: f.providerCalls }));
  }, 120_000);

  it("NEGATIVE: a BUSY owner whose proof errors is NOT stopped; the messages stay held with the true line", async () => {
    owner.busy = true; owner.calls = 0;
    try {
      const f = await seed();
      await heartbeatService(db).resumeQueuedCommentInterrupt(f.companyId, f.queueId);
      await new Promise(r => setTimeout(r, 2_500));
      await heartbeatService(db).resumeQueuedCommentInterrupt(f.companyId, f.queueId);
      await new Promise(r => setTimeout(r, 1_500));
      const kept = await f.lease();
      expect(owner.calls).toBeGreaterThan(0);
      expect(hasStopOnlyCleanup(kept)).toBe(false);
      expect(kept.metadata?.sandboxStopAndRetain).toBeUndefined();
      expect(kept).toMatchObject({ status: "retained", releasedAt: null });
      expect(f.providerCalls).toEqual([]);
      const held = await f.wake();
      console.log("RF4_22F_BUSY", JSON.stringify({ proofCalls: owner.calls, lease: kept.status, wake: held }));
      expect(held).toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect((await f.runs()).map(run => run.id)).toEqual([f.sourceRunId]);
      // The held line is the existing wait (its wording is the separate SCREEN item, not changed here).
      expect(["interrupt_handoff", "remote_cleanup"]).toContain((held.payload?.executionWait as { reason?: string })?.reason);
    } finally { owner.busy = false; }
  }, 120_000);
});
