import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRunEvents, heartbeatRuns,
  issueRecoveryActions, issues, plugins, nativeRunFinalizations, workspaceOperations, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { prepareNativeWorkspaceSync, nativeWorkspaceSyncInternals } from "../services/native-runtime/native-workspace-sync.js";
import * as recovery from "../services/native-runtime/native-failed-workspace-recovery.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { prepareSupersededWarmSandboxStop, prepareSandboxStopAndRetain, settleStopOnlyCleanup } from "../services/sandbox-stop-and-retain.js";
import { settleRecoveredWorkspaceRestoreHolds } from "../services/workspace-restore-hold-settlement.js";

// KEEP: never-OK "every resource has an expiry". The same real stopped warm v3
// source as warmpolicy-judge-real-native-source (real prepareNativeWorkspaceSync,
// shell-backed remote /work, real DB, stop settlement and preservation worker).
// Once recovery records the saved files, the v3 lease hold must settle so the
// released reusable box expires again; while the save is unrecorded it must not.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("v3 stopped warm source: the restore hold settles once the files are saved", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  const oldHome = process.env.PAPERCLIP_HOME, oldInstance = process.env.PAPERCLIP_INSTANCE_ID;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("v3-settle-");
    db = createDb(database.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "v3-settle-"));
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "v3-settle";
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (oldInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = oldInstance;
    await db?.$client.end({ timeout: 1 }); await database?.cleanup();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  // "saved-expiry": recovery recorded the save, then the box expires (destroyed once).
  // "owed-expiry": nothing recorded; expiry stays refused and the bytes stay.
  // "saved-delete" / "owed-delete": consented environment delete releases only the saved source.
  type Variant = "saved-expiry" | "owed-expiry" | "saved-delete" | "owed-delete";
  it.each(["saved-expiry", "owed-expiry", "saved-delete", "owed-delete"] as Variant[])("%s", async (variant) => {
    const warm = true;
    const admittedDisposition = warm ? "keep_running" as const : "destroy" as const;
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const workspaceId = randomUUID(), leaseId = randomUUID(), providerLeaseId = randomUUID(), environmentId = randomUUID();
    const local = path.join(root, runId, "host"), remote = path.join(root, runId, "remote", "work");
    await fs.mkdir(local, { recursive: true }); await fs.mkdir(remote, { recursive: true });
    await fs.writeFile(path.join(local, "notes.md"), "baseline checkpoint\n");
    await db.insert(companies).values({ id: companyId, name: "CR6 real source", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Stopped worker", adapterType: "paperclip_runner", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Real source", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(environments).values({ id: environmentId, name: `CR6 ${runId}`, driver: "sandbox" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId, name: "Real native source", mode: "isolated", strategyType: "scratch", metadata: {} });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", status: "running", nativePhase: "observed", startedAt: new Date(), runtimeModeResolvedAt: new Date(),
      contextSnapshot: { issueId }, runnerProfileJson: { nativeResourceDisposition: admittedDisposition } });
    const [lease] = await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, heartbeatRunId: runId,
      environmentId, executionWorkspaceId: workspaceId, provider: "daytona", providerLeaseId, status: "active", leasePolicy: warm ? "reuse_by_environment" : "ephemeral",
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work" } }).returning();
    // The fixture's remote /work lives below root/run/remote/work. All provider
    // shell operations are mapped to it, including upload/extract and stamp IO.
    const map = (s: string) => s.replace(/\/work(?=\/|'|"|\s|$)/g, remote);
    const runner = { execute: (input: any) => new Promise<any>((resolve, reject) => {
      const child = execFile(input.command, (input.args ?? []).map(map), { cwd: input.cwd ? map(input.cwd) : undefined,
        env: { ...process.env, ...Object.fromEntries(Object.entries(input.env ?? {}).map(([k, v]) => [k, map(String(v))])) },
        timeout: input.timeoutMs ?? 30000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => resolve({
        exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0, signal: error?.signal ?? null,
        timedOut: error?.killed ?? false, stdout: stdout.replaceAll(remote, "/work"), stderr: stderr.replaceAll(remote, "/work"), pid: null, startedAt: null }));
      child.stdin?.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
      child.stdin?.end(input.stdin ?? "");
    }) };
    const prepared = await prepareNativeWorkspaceSync({ db, runId, companyId, workspaceId, workspaceLocalDir: local,
      lease: lease as never, resourceDisposition: admittedDisposition, target: { kind: "remote", transport: "sandbox", providerKey: "test",
        leaseId, remoteCwd: "/work", runner, timeoutMs: 30000, sandboxLeaseAcquisition: { outcome: "created", providerLeaseId } } as never });
    expect(prepared).not.toBeNull();
    expect(prepared!.reference).toMatchObject({ schema: "paperclip.native-workspace-sync/v3", state: "prepared", remoteCwd: "/work", resourceDisposition: admittedDisposition });
    const descriptor = await nativeWorkspaceSyncInternals.readDescriptor({ runId, reference: prepared!.reference });
    expect(descriptor.descriptor.binding).toMatchObject({ runId, companyId, workspaceId, leaseId, providerLeaseId, remoteCwd: "/work" });
    const bytes = "unsynced write from the stopped tool\n";
    await fs.writeFile(path.join(remote, "notes.md"), bytes);
    expect(await fs.readFile(path.join(local, "notes.md"), "utf8")).toBe("baseline checkpoint\n");
    await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 1, eventType: "tool.execution.started", payload: { path: "/work/notes.md" } });
    const nativeCancellation = { schema: "paperclip.native-cancellation.v1", companyId, issueId, runId, scope: "run",
      reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true, intentAuditId: randomUUID(),
      acknowledgementAuditId: randomUUID(), acknowledgedAt: new Date().toISOString(), effects: ["release_run_resources"] };
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled", finishedAt: new Date(),
      resultJson: { nativeCancellation, cancelledByActorType: "user", cancelledByUserId: "operator" } }).where(eq(heartbeatRuns.id, runId));
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure", failureCode: "native_retry_cancelled" });
    // The warm release returned its live allocation for reuse. Seed that lease
    // state; the prepared descriptor and all provider /work bytes remain real.
    const [sourceLease] = warm ? await db.update(environmentLeases).set({ status: "retained", cleanupStatus: "success" })
      .where(eq(environmentLeases.id, leaseId)).returning() : await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
    const stopping = warm ? await prepareSupersededWarmSandboxStop(db, sourceLease, { reason: "sandbox_source_changed" })
      : await prepareSandboxStopAndRetain(db, sourceLease, { reason: "box_stopped" });
    expect(stopping).not.toBeNull();
    const stopped = await settleStopOnlyCleanup(db, stopping!, { attemptId: String(stopping!.metadata!.pendingCleanupAttemptId),
      receipt: { providerLeaseId, state: "stopped" } });
    expect(stopped).toMatchObject({ status: "released", cleanupStatus: "success", leasePolicy: warm ? "reuse_by_environment" : "ephemeral",
      metadata: { remoteExecutionTermination: { state: "stopped" }, sandboxStopAndRetainReceipt: expect.any(Object) } });
    const outcome = (recovery as Record<string, any>).nativeStopWorkspaceOutcome?.({ admittedDisposition, stopped: true, source: stopped });
    if (outcome !== undefined) expect(outcome).toBe("preserve");
    const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    try {
      await recovery.registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId));
      expect(actions).toHaveLength(1);
      const remoteSha = createHash("sha256").update(await fs.readFile(path.join(remote, "notes.md"))).digest("hex");
      expect(remoteSha).toBe(createHash("sha256").update(bytes).digest("hex"));
      const [marked] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
      expect(marked).toMatchObject({ status: "released", leasePolicy: "reuse_by_environment",
        metadata: { workspaceRestoreRecovery: { runId, originalLeasePolicy: "reuse_by_environment" } } });
      const pluginId = String(stopped!.metadata!.pluginId);
      await db.insert(plugins).values({ id: pluginId, pluginKey: `v3-settle-${pluginId}`, packageName: "judge-provider",
        version: "1.0.0", apiVersion: 1, categories: ["automation"], status: "ready",
        manifestJson: { id: `v3-settle-${pluginId}`, apiVersion: 1, version: "1.0.0", displayName: "Judge",
          description: "Destroy boundary", author: "Judge", categories: ["automation"],
          capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
          environmentDrivers: [{ driverKey: "daytona", kind: "sandbox_provider", displayName: "Judge",
            supportsReusableLeases: true, configSchema: { type: "object" } }] } });
      const [environment] = await db.update(environments).set({ config: { provider: "daytona", image: "judge:test", reuseLease: true } })
        .where(eq(environments.id, environmentId)).returning();
      await db.update(environmentLeases).set({ metadata: { ...marked.metadata,
        provider: "daytona", image: "judge:test", reuseLease: true } }).where(eq(environmentLeases.id, leaseId));
      const saved = variant.startsWith("saved");
      let settled: string[] = [];
      if (saved) {
        // Recorded the way the recovery worker records a completed save: its
        // copy-back finalizes the v3 reference, a succeeded snapshot operation
        // on this exact allocation, a workspace_finalize receipt listing it, the
        // action's complete state, then the completion transaction's settle call.
        const sync = run.runnerProfileJson!.nativeWorkspaceSync as Record<string, unknown>;
        await db.update(heartbeatRuns).set({ runnerProfileJson: { ...run.runnerProfileJson,
          nativeWorkspaceSync: { ...sync, state: "finalized", finalHostSha256: remoteSha } } }).where(eq(heartbeatRuns.id, runId));
        const action = actions[0];
        const [snapshot] = await db.insert(workspaceOperations).values({ companyId, issueId, heartbeatRunId: runId,
          phase: "workspace_recovery_snapshot", status: "succeeded", finishedAt: new Date(),
          metadata: { recoveryActionId: action.id, leaseId, providerLeaseId } }).returning();
        const preservationOperationIds = [snapshot.id];
        await db.insert(workspaceOperations).values({ companyId, issueId, heartbeatRunId: runId, phase: "workspace_finalize",
          status: "succeeded", finishedAt: new Date(), metadata: { owningService: "workspace_recovery", preservationOperationIds } });
        const evidence = action.evidence as Record<string, any>;
        await db.update(issueRecoveryActions).set({ evidence: { ...evidence,
          systemRecovery: { ...(evidence.systemRecovery ?? {}), schema: "paperclip.system-recovery.v1", policyVersion: 1,
            sourceRunId: runId, state: "complete", preservationOperationIds },
          workspaceRecovery: { ...(evidence.workspaceRecovery ?? {}), schema: "paperclip.workspace-recovery.v1", runId,
            status: "recovered", stage: "saving_receipts", attempt: 1, requestIds: [] } } })
          .where(eq(issueRecoveryActions.id, action.id));
        settled = await settleRecoveredWorkspaceRestoreHolds(db, { companyId, issueId, runId, actionId: action.id });
      }
      // Then the box's reusable window runs out.
      const [held] = await db.update(environmentLeases).set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(environmentLeases.id, leaseId)).returning();
      const providerCalls: string[] = [];
      const call = vi.fn(async (_id: string, method: string) => {
        providerCalls.push(method);
        if (method === "environmentDestroyLease") await fs.rm(path.join(remote, "notes.md"));
        return { providerLeaseId, state: "destroyed" };
      });
      const runtime = environmentRuntimeService(db, { pluginWorkerManager: { isRunning: () => true, call,
        getWorker: () => ({ supportedMethods: ["environmentDestroyLease"] }) } as never });
      if (variant.endsWith("expiry")) {
        const expired = await runtime.getDriver("sandbox")!.releaseRunLease({ environment, lease: held, status: "expired" } as never);
        const remaining = await fs.readFile(path.join(remote, "notes.md")).catch(() => null);
        const proof = { variant, settled, marker: held.metadata?.workspaceRestoreRecovery ?? null, leasePolicy: held.leasePolicy,
          settledHold: held.metadata?.workspaceRestoreRecoverySettled ?? null, expired: expired?.status ?? null, providerCalls,
          bytesIntact: remaining !== null && createHash("sha256").update(remaining).digest("hex") === remoteSha };
        console.log("V3_SETTLE_PROOF", JSON.stringify(proof));
        if (saved) {
          expect.soft(settled).toEqual([leaseId]);
          expect.soft(proof.marker).toBeNull();
          expect.soft(held.leasePolicy).toBe("reuse_by_environment");
          expect.soft(proof.settledHold).toMatchObject({ runId, restoredLeasePolicy: "reuse_by_environment" });
          expect(providerCalls).toEqual(["environmentDestroyLease"]);
          expect(expired).not.toBeNull();
        } else {
          expect(proof.marker).toMatchObject({ runId });
          expect(expired).toBeNull();
          expect(providerCalls).toEqual([]);
          expect(proof.bytesIntact).toBe(true);
        }
        return;
      }
      // Environment delete: a settle that already ran leaves nothing to release;
      // restore the marker so only the delete selector decides.
      if (saved) await db.update(environmentLeases).set({ metadata: marked.metadata }).where(eq(environmentLeases.id, leaseId));
      const released = await runtime.releaseRestoreSourcesForEnvironmentDelete({ environmentId, consentedBy: "operator" });
      const [after] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
      const proof = { variant, released, marker: after.metadata?.workspaceRestoreRecovery ?? null,
        releasedBy: after.metadata?.restoreSourceReleasedByEnvironmentDelete ?? null };
      console.log("V3_SETTLE_PROOF", JSON.stringify(proof));
      if (saved) {
        expect(released).toBe(1);
        expect(proof.marker).toBeNull();
        expect(proof.releasedBy).toMatchObject({ consentedBy: "operator" });
      } else {
        expect(released).toBe(0);
        expect(proof.marker).toMatchObject({ runId });
      }
      expect(providerCalls).toEqual([]);
    } finally { await worker.stop(); await prepared!.cleanup(); }
  }, 120000);
});
