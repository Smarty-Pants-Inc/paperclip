import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { classifyEnvironmentCapabilities, environmentRuntimeService } from "../services/environment-runtime.js";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRunEvents, heartbeatRuns,
  issueRecoveryActions, issues, nativeRunFinalizations, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { prepareNativeWorkspaceSync } from "../services/native-runtime/native-workspace-sync.js";
import * as recovery from "../services/native-runtime/native-failed-workspace-recovery.js";
import { prepareSupersededWarmSandboxStop, settleStopOnlyCleanup } from "../services/sandbox-stop-and-retain.js";
import { inspectWorkspaceRecoverySource } from "../services/workspace-recovery-source.js";
import { recoverRetainedWorkspace } from "../services/workspace-recovery.js";
import { readSystemRecovery } from "../services/system-recovery-state.js";

// KEEP: rf-4 R2. A preserved stopped warm v3 source (released reusable lease,
// lease restore marker, owed v3 reference) must be restorable by the real
// recovery worker. Same real-source setup as warmpolicy-judge-real-native-source.
const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("../services/environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("rf-4 R2: a preserved warm v3 source is restored by its own binding proof", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  const oldHome = process.env.PAPERCLIP_HOME, oldInstance = process.env.PAPERCLIP_INSTANCE_ID;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("v3-restore-");
    db = createDb(database.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "v3-restore-"));
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "v3restore";
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (oldInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = oldInstance;
    await db?.$client.end({ timeout: 1 }); await database?.cleanup();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  async function preservedWarmV3Source() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const workspaceId = randomUUID(), leaseId = randomUUID(), providerLeaseId = randomUUID(), environmentId = randomUUID();
    const local = path.join(root, runId, "host"), remote = path.join(root, runId, "remote", "work");
    await fs.mkdir(local, { recursive: true }); await fs.mkdir(remote, { recursive: true });
    await fs.writeFile(path.join(local, "notes.md"), "baseline checkpoint\n");
    await db.insert(companies).values({ id: companyId, name: "R2 real source", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Stopped worker", adapterType: "paperclip_runner", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Real source", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(environments).values({ id: environmentId, name: `R2 ${runId}`, driver: "sandbox" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId, name: "Real native source", mode: "isolated", strategyType: "scratch", metadata: {} });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", status: "running", nativePhase: "observed", startedAt: new Date(), runtimeModeResolvedAt: new Date(),
      contextSnapshot: { issueId }, runnerProfileJson: { nativeResourceDisposition: "keep_running" } });
    const [lease] = await db.insert(environmentLeases).values({ id: leaseId, companyId, issueId, heartbeatRunId: runId,
      environmentId, executionWorkspaceId: workspaceId, provider: "daytona", providerLeaseId, status: "active", leasePolicy: "reuse_by_environment",
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work" } }).returning();
    // Shell-backed fake remote: /work maps below root/run/remote/work.
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
    const target = { kind: "remote", transport: "sandbox", providerKey: "test", leaseId, remoteCwd: "/work", runner, timeoutMs: 30000,
      sandboxLeaseAcquisition: { outcome: "created", providerLeaseId } } as unknown as AdapterSandboxExecutionTarget;
    targets.set(leaseId, target);
    const prepared = await prepareNativeWorkspaceSync({ db, runId, companyId, workspaceId, workspaceLocalDir: local,
      lease: lease as never, resourceDisposition: "keep_running", target: target as never });
    expect(prepared!.reference).toMatchObject({ schema: "paperclip.native-workspace-sync/v3", state: "prepared", remoteCwd: "/work" });
    const bytes = "unsynced write from the stopped tool\n";
    await fs.writeFile(path.join(remote, "notes.md"), bytes);
    await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 1, eventType: "tool.execution.started", payload: { path: "/work/notes.md" } });
    const nativeCancellation = { schema: "paperclip.native-cancellation.v1", companyId, issueId, runId, scope: "run",
      reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true, intentAuditId: randomUUID(),
      acknowledgementAuditId: randomUUID(), acknowledgedAt: new Date().toISOString(), effects: ["release_run_resources"] };
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled", finishedAt: new Date(),
      resultJson: { nativeCancellation, cancelledByActorType: "user", cancelledByUserId: "operator" } }).where(eq(heartbeatRuns.id, runId));
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure", failureCode: "native_retry_cancelled" });
    const [sourceLease] = await db.update(environmentLeases).set({ status: "retained", cleanupStatus: "success" })
      .where(eq(environmentLeases.id, leaseId)).returning();
    const stopping = await prepareSupersededWarmSandboxStop(db, sourceLease, { reason: "sandbox_source_changed" });
    const stopped = await settleStopOnlyCleanup(db, stopping!, { attemptId: String(stopping!.metadata!.pendingCleanupAttemptId),
      receipt: { providerLeaseId, state: "stopped" } });
    expect(stopped).toMatchObject({ status: "released", leasePolicy: "reuse_by_environment" });
    for (let pass = 0; pass < 3; pass++) await recovery.preserveCancelledNativeWorkspaces(db);
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId));
    expect(actions).toHaveLength(1);
    const [held] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
    expect(held.metadata?.workspaceRestoreRecovery).toMatchObject({ runId, originalLeasePolicy: "reuse_by_environment" });
    const environmentRuntime = environmentRuntimeService(db, { drivers: [{ driver: "sandbox",
      acquireRunLease: vi.fn(), releaseRunLease: vi.fn(),
      resumeRunLease: vi.fn(async () => ({ providerLeaseId, metadata: { remoteCwd: "/work" } })),
      retryPendingSandboxTeardown: vi.fn(async () => ({ providerLeaseId, state: "stopped" })),
      resolveCapabilities: async () => classifyEnvironmentCapabilities({ verifiedMethods: [], declared: null, narrowing: null }),
    }] as never });
    const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
    return { companyId, issueId, runId, leaseId, local, remote, prepared: prepared!, environmentRuntime, actionId: actions[0].id,
      remoteSha: sha(await fs.readFile(path.join(remote, "notes.md"))), sha };
  }

  it("(1) the real recovery worker restores a preserved warm v3 source into the workspace", async () => {
    const f = await preservedWarmV3Source();
    const input = { db, companyId: f.companyId, issueId: f.issueId, runId: f.runId, actionId: f.actionId, environmentRuntime: f.environmentRuntime };
    try {
      await recoverRetainedWorkspace(input);
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
      const state = readSystemRecovery(action.evidence);
      const restored = await fs.readFile(path.join(f.local, "notes.md"));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const proof = { runId: f.runId, systemRecovery: { state: state?.state, failure: state?.failure ?? null },
        actionStatus: action.status, restoredSha: f.sha(restored), remoteSha: f.remoteSha,
        reference: run.runnerProfileJson?.nativeWorkspaceSync };
      console.log("V3_RESTORE_PROOF", JSON.stringify(proof));
      expect(state?.failure ?? null).toBeNull();
      expect(state?.state).toBe("complete");
      expect(proof.restoredSha).toBe(f.remoteSha);
      expect(run.runnerProfileJson?.nativeWorkspaceSync).toMatchObject({ state: "finalized" });
    } finally { await f.prepared.cleanup(); }
  }, 120000);

  it("(2) negatives: foreign marker, no stop receipt, foreign v3 lease, finished export are refused", async () => {
    const f = await preservedWarmV3Source();
    const input = { companyId: f.companyId, issueId: f.issueId, runId: f.runId, actionId: f.actionId };
    try {
      const [original] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const reasons: Record<string, unknown> = {};
      const refused = async (name: string) => {
        const error = await inspectWorkspaceRecoverySource(db, input).then(() => null, (e: unknown) => e as { code?: string; sourceVerification?: unknown });
        reasons[name] = error ? { code: error.code, sourceVerification: error.sourceVerification } : "ADMITTED";
        await db.update(environmentLeases).set({ metadata: original.metadata }).where(eq(environmentLeases.id, f.leaseId));
        await db.update(heartbeatRuns).set({ runnerProfileJson: run.runnerProfileJson }).where(eq(heartbeatRuns.id, f.runId));
      };
      await db.update(environmentLeases).set({ metadata: { ...original.metadata,
        workspaceRestoreRecovery: { ...(original.metadata!.workspaceRestoreRecovery as object), runId: randomUUID() } } }).where(eq(environmentLeases.id, f.leaseId));
      await refused("foreignMarker");
      const { sandboxStopAndRetainReceipt: _receipt, ...withoutReceipt } = original.metadata!;
      await db.update(environmentLeases).set({ metadata: withoutReceipt }).where(eq(environmentLeases.id, f.leaseId));
      await refused("noStopReceipt");
      const sync = run.runnerProfileJson!.nativeWorkspaceSync as Record<string, unknown>;
      await db.update(heartbeatRuns).set({ runnerProfileJson: { ...run.runnerProfileJson, nativeWorkspaceSync: { ...sync, leaseId: randomUUID() } } }).where(eq(heartbeatRuns.id, f.runId));
      await refused("foreignV3Lease");
      await db.update(heartbeatRuns).set({ runnerProfileJson: { ...run.runnerProfileJson,
        nativeWorkspaceSync: { ...sync, state: "finalized", finalHostSha256: sync.baselineSha256 } } }).where(eq(heartbeatRuns.id, f.runId));
      await refused("exportFinished");
      console.log("V3_RESTORE_NEGATIVES", JSON.stringify(reasons));
      for (const name of ["foreignMarker", "noStopReceipt", "foreignV3Lease", "exportFinished"])
        expect(reasons[name], name).toMatchObject({ code: "source_binding_invalid" });
      // The unmodified source is admitted by its own binding proof.
      const admitted = await inspectWorkspaceRecoverySource(db, input);
      expect(admitted.sources.map(item => item.lease.id)).toEqual([f.leaseId]);
    } finally { await f.prepared.cleanup(); }
  }, 120000);
});
