import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRunEvents, heartbeatRuns,
  issueRecoveryActions, issues, nativeRunFinalizations, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { prepareNativeWorkspaceSync, nativeWorkspaceSyncInternals } from "../services/native-runtime/native-workspace-sync.js";
import * as recovery from "../services/native-runtime/native-failed-workspace-recovery.js";
import { nativeWorkspaceExportPendingForLease } from "../services/native-runtime/native-workspace-finalization-state.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { RECOVERING_SAVED_WORK_NEXT_ACTION } from "../services/legacy-execution-recovery.js";
import { prepareSandboxStopAndRetain, prepareSupersededWarmSandboxStop, settleStopOnlyCleanup } from "../services/sandbox-stop-and-retain.js";

// KEEP: CR6 never-OK stopped source. Real production prepareNativeWorkspaceSync,
// descriptor, actual shell-backed fake remote /work, real DB and stop settlement.
// Not an assertion about a test-host file unrelated to the remote source.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("JUDGE CR6 real prepared native-sync stopped source", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  const oldHome = process.env.PAPERCLIP_HOME, oldInstance = process.env.PAPERCLIP_INSTANCE_ID;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("judge-real-source-");
    db = createDb(database.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "judge-real-source-"));
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "judge";
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (oldInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = oldInstance;
    await db?.$client.end({ timeout: 1 }); await database?.cleanup();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  // variant: "owed" = remote-only changed bytes still owed (CR6: exactly one hold);
  // "exported" = the v3 export already finished (nothing owed: no hold);
  // "foreign-lease" = the v3 reference names another lease (no hold);
  // "running" = the warm box was never stopped (handoff: no hold).
  type Variant = "owed" | "exported" | "foreign-lease" | "running";
  const cases: Array<readonly [boolean, "worker" | "startup-scan", Variant]> = [];
  for (const kind of ["worker", "startup-scan"] as const) {
    cases.push([true, kind, "owed"], [false, kind, "owed"], [true, kind, "exported"], [true, kind, "foreign-lease"], [true, kind, "running"]);
  }
  it.each(cases)("REAL native-sync source after the box stops (warm=%s, %s, %s)", async (warm, kind, variant) => {
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
    if (variant === "exported" || variant === "foreign-lease") {
      const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const sync = current.runnerProfileJson!.nativeWorkspaceSync as Record<string, unknown>;
      expect(sync).toMatchObject({ leaseId, providerLeaseId, finalHostSha256: null });
      const changed = variant === "exported" ? { ...sync, state: "finalized", finalHostSha256: sync.baselineSha256 } : { ...sync, leaseId: randomUUID() };
      await db.update(heartbeatRuns).set({ runnerProfileJson: { ...current.runnerProfileJson, nativeWorkspaceSync: changed } }).where(eq(heartbeatRuns.id, runId));
    }
    if (variant === "running") {
      // An ordinary Stop on a warm box that keeps running: a handoff, never a hold.
      await db.update(environmentLeases).set({ status: "active" }).where(eq(environmentLeases.id, leaseId));
      const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      try {
        if (kind === "startup-scan") for (let pass = 0; pass < 3; pass++) await recovery.preserveCancelledNativeWorkspaces(db);
        else await recovery.registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
        const [running] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
        expect(recovery.nativeStopWorkspaceOutcome({ admittedDisposition, stopped: true, source: running })).toBe("handoff");
        expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId))).toHaveLength(0);
        const remoteSha = createHash("sha256").update(await fs.readFile(path.join(remote, "notes.md"))).digest("hex");
        expect(remoteSha).toBe(createHash("sha256").update(bytes).digest("hex"));
      } finally { await worker.stop(); await prepared!.cleanup(); }
      return;
    }
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
      if (kind === "startup-scan") for (let pass = 0; pass < 3; pass++) await recovery.preserveCancelledNativeWorkspaces(db);
      else await recovery.registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId));
      const remoteSha = createHash("sha256").update(await fs.readFile(path.join(remote, "notes.md"))).digest("hex");
      const exportPending = await nativeWorkspaceExportPendingForLease(db, stopped!);
      console.log("REAL_SOURCE_PROOF", JSON.stringify({ warm, kind, runId, reference: prepared!.reference, outcome, exportPending,
        actionCount: actions.length, nextWakeAt: worker.nextWakeAt(), remoteSha, expectedSha: createHash("sha256").update(bytes).digest("hex") }));
      expect(remoteSha).toBe(createHash("sha256").update(bytes).digest("hex"));
      if (variant === "owed") expect(exportPending).toBe(true);
      // Keep inspectable exact prepared authority and bytes outside test cleanup.
      const evidenceDir = path.join(process.env.TASK_OUT ?? root, `real-source-${variant}-${runId}`);
      await fs.mkdir(evidenceDir, { recursive: true });
      await fs.copyFile(nativeWorkspaceSyncInternals.descriptorPath(runId, prepared!.reference.descriptorSha256), path.join(evidenceDir, "descriptor.json"));
      await fs.copyFile(path.join(remote, "notes.md"), path.join(evidenceDir, "remote-notes.md"));
      await fs.copyFile(path.join(local, "notes.md"), path.join(evidenceDir, "host-baseline-notes.md"));
      await fs.writeFile(path.join(evidenceDir, "stopped-source.json"), JSON.stringify({ reference: prepared!.reference, lease: stopped, run, actionCount: actions.length, exportPending }, null, 2));
      if (variant !== "owed") {
        expect(actions).toHaveLength(0);
        expect(run.resultJson).not.toHaveProperty("workspaceRestoreRecovery");
        return;
      }
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ fingerprint: `native-workspace:${runId}`, nextAction: RECOVERING_SAVED_WORK_NEXT_ACTION });
      expect(run.resultJson).toHaveProperty("workspaceRestoreRecovery");
    } finally { await worker.stop(); await prepared!.cleanup(); }
  }, 120000);
});
