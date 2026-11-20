import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { environmentLeases, environments, executionWorkspaces, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import type { EnvironmentRuntimeService } from "../environment-runtime.js";
import { environmentService } from "../environments.js";
import { resolveEnvironmentExecutionTarget } from "../environment-execution-target.js";
import { workspaceOperationService } from "../workspace-operations.js";
import { logger } from "../../middleware/logger.js";
import { withNativeWorkspaceFinalizationOwnership } from "./native-workspace-finalization-ownership.js";
import { readNativeWorkspaceSyncReference, resumeNativeWorkspaceSync } from "./native-workspace-sync.js";

export const TERMINAL_WORKSPACE_EXPORT_RECHECK_MS = 30_000;
export const TERMINAL_WORKSPACE_EXPORT_STATUSES = ["failed", "cancelled", "timed_out", "interrupted", "succeeded"];

/** File-only suffix of a terminal run. No accepted result, retry wake, provider
 * turn or task disposition is fabricated. The existing preservation queue owns
 * the retry deadline; the existing finalization owner fences physical copyback. */
export async function exportTerminalNativeWorkspace(input: {
  db: Db; companyId: string; runId: string; environmentRuntime: EnvironmentRuntimeService;
  isRunActive?: (runId: string) => boolean;
}): Promise<"settled" | "pending"> {
  const { db } = input;
  const scope = and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId));
  const current = async () => {
    const [run] = await db.select().from(heartbeatRuns).where(scope);
    if (!run || run.runtimeMode !== "native" || !TERMINAL_WORKSPACE_EXPORT_STATUSES.includes(run.status)) return null;
    const reference = readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync);
    if (!reference || reference.state !== "prepared") return null;
    return { run, reference };
  };
  if (!await current()) return "settled";
  // Result commit is not workspace-suffix completion. The existing accepted-
  // result finalizer must retain its callback/retention work, rather than have
  // this file-only owner manufacture its workspace_finalize success row.
  const [acceptedOwner] = await db.select({ resultId: nativeRunFinalizations.resultId, phase: nativeRunFinalizations.phase })
    .from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, input.companyId),
      eq(nativeRunFinalizations.runId, input.runId)));
  if (acceptedOwner?.resultId && acceptedOwner.phase !== "terminal_failure") return "pending";
  const owned = await withNativeWorkspaceFinalizationOwnership({ db, companyId: input.companyId, runId: input.runId }, async ownership => {
    const selected = await current();
    if (!selected) return "settled" as const;
    const { run, reference } = selected;
    const [lease] = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.id, reference.leaseId),
      eq(environmentLeases.heartbeatRunId, run.id), eq(environmentLeases.providerLeaseId, reference.providerLeaseId)));
    if (!lease || !lease.environmentId || !["active", "retained", "pending_cleanup", "released", "expired", "failed"].includes(lease.status)
      || lease.metadata?.pendingCleanupInFlight === true) return "pending" as const;
    const [environment] = await db.select().from(environments).where(eq(environments.id, lease.environmentId));
    if (!environment) return "pending" as const;
    const assertSource = async () => {
      await ownership.assertHeld();
      const selected = await current();
      if (!selected || selected.reference.descriptorSha256 !== reference.descriptorSha256
        || selected.reference.leaseId !== lease.id || selected.reference.providerLeaseId !== reference.providerLeaseId
        || input.isRunActive?.(run.id)
        || selected.run.controllerLeaseExpiresAt && selected.run.controllerLeaseExpiresAt.getTime() > Date.now())
        throw new Error("native_terminal_workspace_source_active");
      const [coordinator] = await db.select({ leaseOwner: nativeRunFinalizations.leaseOwner, resultId: nativeRunFinalizations.resultId,
        phase: nativeRunFinalizations.phase }).from(nativeRunFinalizations).where(and(
        eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id)));
      if (coordinator?.leaseOwner || coordinator?.resultId && coordinator.phase !== "terminal_failure")
        throw new Error("native_terminal_workspace_source_active");
      // A handoff may leave the old descriptor prepared. Never export an
      // allocation a live successor adopted, even through another lease row.
      const [adopter] = await db.select({ id: environmentLeases.id }).from(environmentLeases)
        .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, environmentLeases.heartbeatRunId),
          eq(heartbeatRuns.companyId, environmentLeases.companyId)))
        .where(and(eq(environmentLeases.provider, lease.provider!), eq(environmentLeases.providerLeaseId, lease.providerLeaseId!),
          ne(heartbeatRuns.id, run.id), inArray(heartbeatRuns.status, ["queued", "scheduled_retry", "running"])));
      if (adopter) throw new Error("native_terminal_workspace_source_adopted");
      const [source] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
        eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, run.companyId),
        eq(environmentLeases.heartbeatRunId, run.id), eq(environmentLeases.providerLeaseId, reference.providerLeaseId),
        sql`coalesce(${environmentLeases.metadata}->>'pendingCleanupInFlight', 'false') != 'true'`));
      if (!source) throw new Error("native_terminal_workspace_source_changed");
    };
    try {
      await assertSource();
      // Old releases may predate the shared fence. Re-establish file custody
      // before any maintenance I/O; ended lease status is not proof of export.
      if (["released", "expired", "failed"].includes(lease.status))
        await environmentService(db).releaseLease(lease.id, "released", { cleanupStatus: "success" });
    } catch { return "pending" as const; }
    const [workspace] = await db.select({ id: executionWorkspaces.id }).from(executionWorkspaces).where(and(
      eq(executionWorkspaces.companyId, run.companyId), eq(executionWorkspaces.id, reference.workspaceId)));
    const recorder = workspaceOperationService(db).createRecorder({ companyId: run.companyId,
      heartbeatRunId: run.id, issueId: run.nativeIssueId ?? run.issueId,
      executionWorkspaceId: workspace?.id ?? null });
    const operation = await recorder.recordOperation({ phase: "workspace_finalize",
      metadata: { owningService: "native_terminal_workspace_export", leaseId: lease.id },
      run: async () => {
        try {
          await assertSource();
          // Historical stopped sources are resumed only to read their files,
          // through the exact-allocation maintenance API, never a new turn.
          if ((lease.metadata?.remoteExecutionTermination as { state?: string } | undefined)?.state === "stopped") {
            const resumed = await input.environmentRuntime.resumeRunLease({ environment: environment as unknown as Environment,
              lease: (await environmentService(db).getLeaseById(lease.id))!, requestedCwd: reference.remoteCwd });
            if (resumed?.providerLeaseId !== reference.providerLeaseId) throw new Error("native_terminal_workspace_source_changed");
            await assertSource();
            await db.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} - 'remoteExecutionTermination' - 'sandboxStopAndRetainReceipt'` })
              .where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, run.companyId)));
          }
          const target = await resolveEnvironmentExecutionTarget({ db, companyId: run.companyId, adapterType: "paperclip_runner",
            environment: environment as unknown as Environment, leaseId: lease.id, leaseMetadata: lease.metadata,
            lease: lease as EnvironmentLease, environmentRuntime: input.environmentRuntime });
          if (!target || !await resumeNativeWorkspaceSync({ db, runId: run.id, target, assertOwnership: assertSource }))
            throw new Error("native_terminal_workspace_export_unavailable");
          const [saved] = await db.select({ profile: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns).where(scope);
          const result = readNativeWorkspaceSyncReference(saved?.profile?.nativeWorkspaceSync);
          if (result?.state !== "finalized" || !result.finalHostSha256) throw new Error("native_terminal_workspace_export_unverified");
          return { status: "succeeded", exitCode: 0, metadata: { finalHostSha256: result.finalHostSha256 } };
        } catch (error) {
          // Transport errors can contain credentials. Keep only a closed set
          // of local safety refusals, never an arbitrary provider exception.
          const code = error instanceof Error && ["native_workspace_sync_snapshot_superseded",
            "native_workspace_sync_snapshot_order_unverified"].includes(error.message)
            ? error.message : "native_terminal_workspace_export_failed";
          return { status: "failed", exitCode: 1, stderr: `${code}\n` };
        }
      },
    });
    if (operation.status === "succeeded") return "settled" as const;
    const [first] = await db.update(heartbeatRuns).set({ runnerProfileJson:
      sql`jsonb_set(coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb), '{nativeTerminalWorkspaceExportFailure}', ${JSON.stringify({ code: "native_terminal_workspace_export_failed", at: new Date().toISOString() })}::jsonb)` })
      .where(and(scope, sql`${heartbeatRuns.runnerProfileJson}->'nativeTerminalWorkspaceExportFailure' is null`)).returning({ id: heartbeatRuns.id });
    if (first) logger.warn({ runId: run.id, leaseId: lease.id, code: "native_terminal_workspace_export_failed" },
      "Terminal native workspace export failed; source retained for retry");
    return "pending" as const;
  });
  return owned.acquired ? owned.value : "pending";
}
