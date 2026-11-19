import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { environmentLeases, environments, executionWorkspaces, heartbeatRuns } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import { acceptedRemoteExport, useWorkspaceRecoveryFixture, db, run, action } from "./__tests__/workspace-recovery-fixture.js";
import { prepareSandboxStopAndRetain, settleStopOnlyCleanup } from "./sandbox-stop-and-retain.js";
import { preserveLegacyWorkspaceRestoreSources } from "./legacy-workspace-restore-recovery.js";
import { recoverRetainedWorkspace } from "./workspace-recovery.js";
import { settleRecoveredWorkspaceRestoreHolds } from "./workspace-restore-hold-settlement.js";
import { readSystemRecovery } from "./system-recovery-state.js";
import { createSavedWorkspaceLoader, readRemoteWorkspaceAuthority } from "./remote-workspaces.js";
import { environmentRuntimeService } from "./environment-runtime.js";
import * as providers from "./sandbox-provider-runtime.js";

const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

describe("stopped reusable restore source settlement (embedded PostgreSQL and filesystem runner)", () => {
  useWorkspaceRecoveryFixture(targets);
  async function heldSource(policy: string) {
    const f = await acceptedRemoteExport();
    const source = await run(f.runId);
    await db.update(heartbeatRuns).set({ resultJson: { workspaceRestoreFailure: "restore_failed",
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [f.lease.id] } },
      runnerProfileJson: { ...source.runnerProfileJson, nativeResourceDisposition: "keep_running" },
    }).where(eq(heartbeatRuns.id, f.runId));
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    const metadata = { ...lease.metadata }; delete metadata.remoteExecutionTermination;
    const [active] = await db.update(environmentLeases).set({ status: "active", leasePolicy: policy, metadata })
      .where(eq(environmentLeases.id, lease.id)).returning();
    const pending = (await prepareSandboxStopAndRetain(db, active))!;
    const stopped = (await settleStopOnlyCleanup(db, pending, { attemptId: String(pending.metadata!.pendingCleanupAttemptId),
      receipt: { providerLeaseId: f.providerLeaseId, state: "stopped" } }))!;
    expect(await preserveLegacyWorkspaceRestoreSources(db, await run(f.runId), stopped)).toEqual([lease.id]);
    const [held] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
    expect(held.metadata?.workspaceRestoreRecovery).toEqual({ schema: "paperclip.workspace-restore-recovery.v1",
      runId: f.runId, originalLeasePolicy: policy });
    return { ...f, held };
  }

  it.each(["reuse_by_environment", "reuse_by_execution_workspace"])(
    "U22B releases verified-recovered %s without losing warm policy or stop receipt", async policy => {
      const f = await heldSource(policy);
      // Neither a queued recovery nor its source marker proves saved bytes.
      expect(await settleRecoveredWorkspaceRestoreHolds(db, f)).toEqual([]);
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0]).toEqual(f.held);
      await recoverRetainedWorkspace(f.input);
      expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
      const authority = readRemoteWorkspaceAuthority(workspace.metadata)!;
      expect(authority.dirty).toBe(false); expect(authority.writerRunId).toBeNull();
      const saved = await createSavedWorkspaceLoader(db)({ companyId: f.companyId, workspaceId: f.workspaceId,
        snapshotId: authority.snapshotId! });
      try { expect(await readFile(path.join(saved.root, "saved.txt"), "utf8")).toBe("finished work\n"); }
      finally { await saved.cleanup(); }
      const [settled] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      expect.soft(settled.metadata?.workspaceRestoreRecovery).toBeUndefined();
      expect.soft(settled.leasePolicy).toBe(policy);
      // Recovery resumes and re-stops this allocation, refreshing only the
      // receipt timestamp. Its exact stopped-execution binding must survive.
      const { confirmedAt: _confirmedAt, ...stopBinding } = f.held.metadata!.remoteExecutionTermination as Record<string, unknown>;
      expect.soft(settled.metadata?.remoteExecutionTermination).toMatchObject(stopBinding);
      // Repeated settlement is idempotent. Normal explicit destruction is no
      // longer fenced after the saved bytes and completion receipt are durable.
      expect(await settleRecoveredWorkspaceRestoreHolds(db, f)).toEqual([]);
      const [environment] = await db.select().from(environments).where(eq(environments.id, settled.environmentId!));
      const config = { provider: "fake", image: "fake:test", reuseLease: true };
      await db.update(environments).set({ config }).where(eq(environments.id, environment.id));
      await db.update(environmentLeases).set({ provider: "fake", metadata: { ...settled.metadata,
        sandboxProviderPlugin: false, pluginId: null } }).where(eq(environmentLeases.id, settled.id));
      const [finalLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, settled.id));
      const destroy = vi.spyOn(providers, "destroySandboxProviderLease").mockResolvedValue(undefined);
      try {
        const result = await environmentRuntimeService(db).getDriver("sandbox")!.destroyRunLease!({
          environment: { ...environment, config } as unknown as Environment, lease: finalLease as unknown as EnvironmentLease });
        expect.soft(result).not.toBeNull(); expect.soft(destroy).toHaveBeenCalledOnce();
      } finally { destroy.mockRestore(); }
    }, 120_000);

  it.each(["reuse_by_environment", "reuse_by_execution_workspace"])(
    "U22B keeps the %s hold when recovery cannot verify saved files", async policy => {
      const f = await heldSource(policy);
      f.runtime.resumeRunLease.mockRejectedValueOnce(new Error("source unavailable before file verification"));
      await recoverRetainedWorkspace(f.input);
      expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).not.toBe("complete");
      expect(await settleRecoveredWorkspaceRestoreHolds(db, f)).toEqual([]);
      const [held] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      expect(held.metadata?.workspaceRestoreRecovery).toEqual(f.held.metadata?.workspaceRestoreRecovery);
      expect(held.leasePolicy).toBe(policy);
    }, 120_000);

  it.each(["runId", "originalLeasePolicy"])("U22B does not clear a mismatched %s marker", async field => {
    const f = await heldSource("reuse_by_execution_workspace");
    const marker = { ...(f.held.metadata!.workspaceRestoreRecovery as Record<string, unknown>),
      [field]: field === "runId" ? "another-run" : "reuse_by_environment" };
    await db.update(environmentLeases).set({ metadata: { ...f.held.metadata, workspaceRestoreRecovery: marker } })
      .where(eq(environmentLeases.id, f.lease.id));
    await recoverRetainedWorkspace(f.input);
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    const [held] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    expect(held.metadata?.workspaceRestoreRecovery).toEqual(marker);
    expect(held.leasePolicy).toBe("reuse_by_execution_workspace");
  }, 120_000);
});
