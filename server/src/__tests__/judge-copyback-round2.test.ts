// Independent Round-2 checks. Keep reasons: data safety, and the SMAA-1431
// committed-result/workspace-only failure incident. No provider or external calls.
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, completionContracts, createDb, environmentLeases, environments,
  executionWorkspaces, heartbeatRuns, issues, issueComments, nativeRunFinalizations,
  nativeRunResults, workspaceOperations } from "@paperclipai/db";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { finalizeNativeRun, recordNativeFinalizationFailure } from "../services/native-runtime/native-run-finalizer.js";
import { nativeWorkspaceFinalizationWork } from "../services/native-runtime/native-workspace-finalization-work.js";
import { REMOTE_WORKSPACE_SANDBOX_DISK_FULL } from "../services/remote-workspace-transport.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("RFL round 2 independent copy-back judgment", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  const companyId = randomUUID(), agentId = randomUUID();
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "rfl-copyback-round2-"));
    temporary = await startEmbeddedPostgresTestDatabase("rfl-copyback-round2-db-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Independent copyback judge", issuePrefix: "JCB" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Accepted-result worker", adapterType: "paperclip_runner" });
  }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); await rm(root, { recursive: true, force: true }); });

  async function seed() {
    const runId = randomUUID(), issueId = randomUUID(), contractId = randomUUID(), sourceInstanceId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Saved result with unfinished files", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "rfl-copyback-v1", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "rfl-copyback-v1", objective: "Finish", criteria: [{ id: "objective", requirement: "Complete the task" }] },
      canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, runtimeMode: "native", status: "running",
      nativeIssueId: issueId, nativeSessionId: runId, runnerInstanceId: sourceInstanceId,
      completionContractId: contractId, completionContractSha256: contractId, contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const binding = { companyId, issueId, runId, agentId, sessionId: runId, completionContractId: contractId,
      completionContractSha256: contractId, sourceInstanceId, controlPlaneSourceInstanceId: "rfl-copyback-v2" };
    await new PaperclipControlPlanePort(db, binding).completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT,
      terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, callerResultId: `${runId}:result` });
    return binding;
  }
  async function committed(f: Awaited<ReturnType<typeof seed>>) {
    await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const [c] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const [r] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(c.phase).toBe("committed"); expect(r.resultJson?.finalizationPhase).toBe("committed");
  }
  const failure = (runId: string, disk = false) => recordNativeFinalizationFailure({ db, runId,
    error: new Error("native_workspace_sync_out_failed"), failureScope: "workspace", projectRunStatus: true,
    ...(disk ? { failureCause: REMOTE_WORKSPACE_SANDBOX_DISK_FULL } : {}) });
  const notices = (f: Awaited<ReturnType<typeof seed>>, reader = db) => reader.select().from(issueComments).where(and(
    eq(issueComments.issueId, f.issueId), eq(issueComments.createdByRunId, f.runId), eq(issueComments.authorType, "system")));

  it("a real recorded workspace failure after status commit still saves the retry deadline (SMAA-1431 shape)", async () => {
    const f = await seed();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, sourceIssueId: f.issueId,
      mode: "isolated", strategyType: "directory", name: "Pending physical copyback", providerType: "local_fs",
      cwd: join(root, "missing-after-status-commit") }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, f.issueId));
    await committed(f);
    const accepted = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId));
    const service = nativeWorkspaceFinalizationWork(db, { onWorkspaceSettled: vi.fn() });
    const entries = await service.load({ companyId, runId: f.runId }); expect(entries).toHaveLength(1);
    const next = await service.check(entries[0]);
    const [row] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const ops = await db.select().from(workspaceOperations).where(eq(workspaceOperations.heartbeatRunId, f.runId));
    console.log("RFL2_REAL_RECORDED_FAILURE", JSON.stringify({ phase: row.phase, nextAttemptAt: row.nextAttemptAt, operationStatuses: ops.map(o => o.status) }));
    expect(ops).toHaveLength(1); expect(ops[0].status).toBe("failed");
    expect(row).toMatchObject({ phase: "retryable_failure", failureDetail: { workspaceFinalizeAttempt: 1 } });
    expect(row.nextAttemptAt!.getTime() - row.updatedAt.getTime()).toBe(30_000);
    expect(next?.dueAt).toBe(row.nextAttemptAt!.getTime());
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId))).toEqual(accepted);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, f.issueId))).toHaveLength(1);
  });

  it("a real workspace preflight failure without an operation receipt must not be fenced or rescheduled immediately forever", async () => {
    const f = await seed();
    // The worker's production preflight catches missing plugin ownership before
    // it creates an operation row. It returns kind=failed, not a stale callback.
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, sourceIssueId: f.issueId,
      mode: "isolated", strategyType: "directory", name: "Unresolved plugin workspace", providerType: "plugin",
      cwd: root, metadata: {} }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, f.issueId));
    await committed(f);
    const service = nativeWorkspaceFinalizationWork(db, { onWorkspaceSettled: vi.fn() });
    const [entry] = await service.load({ companyId, runId: f.runId }); expect(entry).toBeDefined();
    const next = await service.check(entry);
    const [row] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    const ops = await db.select().from(workspaceOperations).where(eq(workspaceOperations.heartbeatRunId, f.runId));
    console.log("RFL2_PREFLIGHT_FAILURE", JSON.stringify({ phase: row.phase, nextAttemptAt: row.nextAttemptAt,
      operationCount: ops.length, returnedDueInMs: next ? next.dueAt - Date.now() : null }));
    expect(ops).toHaveLength(0);
    expect(row.phase).toBe("retryable_failure");
    expect(row.nextAttemptAt!.getTime() - row.updatedAt.getTime()).toBe(30_000);
    expect(next?.dueAt).toBe(row.nextAttemptAt!.getTime());
  });

  it.each([1, 3])("notice counts %i failures and names exact-box export recovery", async count => {
    const f = await seed();
    for (let i = 0; i < count; i++) await failure(f.runId, count === 1);
    const comments = await notices(f);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain(`after ${count} failed ${count === 1 ? "attempt;" : "attempts;"}`);
    expect(comments[0].body).toContain("files");
    expect(comments[0].body).toContain("exact box");
    expect(comments[0].body).toContain("workspace export recovery action");
  });

  it("does not claim the box is already stopped when the same transaction only queued its stop", async () => {
    const f = await seed(), environmentId = randomUUID(), leaseId = randomUUID(), providerLeaseId = randomUUID();
    await db.insert(environments).values({ id: environmentId, name: "Retain this exact allocation", driver: "sandbox" });
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: {
      schema: "paperclip.native-workspace-sync/v1", state: "prepared", descriptorSha256: "a".repeat(64),
      baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: randomUUID(), leaseId, providerLeaseId,
      remoteCwd: "/work", resourceDisposition: "stop_and_retain" } } }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(environmentLeases).values({ id: leaseId, environmentId, companyId, issueId: f.issueId,
      heartbeatRunId: f.runId, status: "active", provider: "daytona", providerLeaseId,
      leasePolicy: "reuse_by_environment", metadata: { pluginId: "fixture-provider" } });
    for (let i = 0; i < 3; i++) await failure(f.runId);
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
    const comments = await notices(f);
    expect(lease.status).toBe("pending_cleanup");
    expect(lease.failureReason).toBe("workspace_export_stop_pending");
    expect(lease.metadata?.remoteExecutionTermination).toBeUndefined();
    expect(lease.metadata?.nativeWorkspaceExportResume).toBeDefined();
    expect(comments).toHaveLength(1);
    console.log("RFL2_STOP_NOTICE", JSON.stringify({ leaseStatus: lease.status, failureReason: lease.failureReason,
      hasStopReceipt: Boolean(lease.metadata?.remoteExecutionTermination), notice: comments[0].body }));
    expect(comments[0].body).not.toMatch(/(?:was|has been|is) stopped/i);
  });

  it("I4: a fresh process plus a fresh DB client and worker cannot duplicate the terminal notice or accepted result", async () => {
    const f = await seed();
    for (let i = 0; i < 3; i++) await failure(f.runId);
    const before = await notices(f);
    const accepted = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId));
    const child = await promisify(execFile)(process.execPath, [
      "--import", fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url)),
      fileURLToPath(new URL("./judge-copyback-restart-child.ts", import.meta.url)), companyId, f.issueId, f.runId,
    ], { env: { ...process.env, RFL_TEST_DATABASE_URL: temporary.connectionString }, timeout: 90_000 });
    const line = child.stdout.split("\n").find(line => line.startsWith("RFL2_FRESH_PROCESS "));
    expect(line).toBeDefined();
    const proof = JSON.parse(line!.slice("RFL2_FRESH_PROCESS ".length));
    expect(proof).toEqual({ pendingCount: 0, noticeIds: before.map(n => n.id), acceptedIds: accepted.map(r => r.id) });
    console.log("RFL2_RESTART_PROOF", JSON.stringify(proof));
    const fresh = createDb(temporary.connectionString);
    try {
      const service = nativeWorkspaceFinalizationWork(fresh, { onWorkspaceSettled: vi.fn() });
      expect(await service.load({ companyId, runId: f.runId })).toHaveLength(0);
      for (let i = 0; i < 2; i++) await recordNativeFinalizationFailure({ db: fresh, runId: f.runId,
        error: new Error("native_workspace_sync_out_failed"), projectRunStatus: true, failureScope: "workspace" });
      expect(before).toHaveLength(1); expect(await notices(f, fresh)).toEqual(before);
      expect(await fresh.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId))).toEqual(accepted);
      expect(await fresh.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, f.issueId))).toHaveLength(1);
    } finally { await fresh.$client.end({ timeout: 1 }); }
  }, 120_000);
});
