import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { hasAcknowledgedNativeStopIntent } from "../acknowledged-native-stop.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { admittedNativeResourceDisposition } from "../native-runtime/native-failed-workspace-recovery.js";
import { withNativeWorkspaceFinalizationOwnership } from "../native-runtime/native-workspace-finalization-ownership.js";

/** pl/cancel-finalize: the longest a Stop's cancellation boundary waits for the
 * stopped turn's workspace export. The warm box's lease is only handed off
 * (status `retained`) after the boundary returns, and a queued Send / the
 * automatic resume wait for exactly that (handed-off-warm-lease.ts), so this
 * is also the longest the +0 successor waits behind the settlement. */
export const CANCELLED_WARM_EXPORT_TIMEOUT_MS = 30_000;

const RETAINED_IDLE_CHECKPOINT_SCHEMA = "paperclip.native-retained-idle-checkpoint.v1";

type PreparedSync = {
  readonly reference: { state: string };
  restoreWorkspace: (assertOwnership?: () => Promise<void>) => Promise<void>;
};

export type CancelledWarmExportOutcome =
  | { outcome: "not_applicable" }
  | { outcome: "not_settled" }
  | { outcome: "finalized" }
  | { outcome: "unproven"; reason: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The settled-cancellation proof: NSE writes this receipt only after Pi's
 * clean abort ladder, child cleanup, the acknowledged Stop and an idle
 * snapshot all succeeded, atomically with the coordinator's terminal settle
 * (native-session-executor.ts retainCancelledSession + the retained idle
 * receipt). Without it the cancellation is not settled: nothing is exported. */
function hasSettledCancellationReceipt(run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "nativeIssueId" | "runnerProfileJson">): boolean {
  const receipt = record(record(run.runnerProfileJson).nativeRetainedIdleCheckpoint);
  return receipt.schema === RETAINED_IDLE_CHECKPOINT_SCHEMA && receipt.runId === run.id
    && receipt.companyId === run.companyId && receipt.issueId === run.nativeIssueId;
}

/**
 * At the cancellation boundary of a person's Stop of a warm (keep_running)
 * turn, finish the run's own prepared native-workspace export under the run's
 * workspace-finalization ownership, BEFORE the warm box is handed off: copy the
 * box's files back to the host, write the finalized descriptor and the
 * remote/lease stamps. The run stays cancelled; no result is invented and
 * nothing is replayed. With the descriptor finalized, the existing reuse filter
 * (environment-runtime.ts nativeWorkspaceExportPendingForResource) passes and the
 * successor adopts the same box (adopt_remote): same files, same Pi thread.
 *
 * If the export cannot be proven within the bound, the descriptor stays
 * `prepared` (today's protection: the box remains a protected export source)
 * and the run records an honest warning line instead of a silent new box.
 */
export async function finishCancelledWarmWorkspaceExport(input: {
  db: Db;
  runId: string;
  companyId: string;
  nativeWorkspaceSync: PreparedSync | null | undefined;
  timeoutMs?: number;
}): Promise<CancelledWarmExportOutcome> {
  const sync = input.nativeWorkspaceSync;
  if (!sync || sync.reference.state !== "prepared") return { outcome: "not_applicable" };
  const [run] = await input.db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
  )).limit(1);
  if (!run || run.runtimeMode !== "native"
    || admittedNativeResourceDisposition(run.runnerProfileJson) !== "keep_running") return { outcome: "not_applicable" };
  if (!hasAcknowledgedNativeStopIntent(run) || !hasSettledCancellationReceipt(run)) return { outcome: "not_settled" };

  const timeoutMs = input.timeoutMs ?? CANCELLED_WARM_EXPORT_TIMEOUT_MS;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = withNativeWorkspaceFinalizationOwnership({ db: input.db, companyId: input.companyId, runId: input.runId },
    async (ownership) => {
      // After the bound no stamp or finalized descriptor may land: the box is
      // then handed off as a protected (still prepared) source.
      const assertHeld = async () => {
        if (expired) throw new Error("cancelled_warm_export_timed_out");
        await ownership.assertHeld();
      };
      await sync.restoreWorkspace(assertHeld);
    });
  work.catch(() => undefined);
  const deadline = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => { expired = true; resolve("timed_out"); }, timeoutMs);
    timer.unref?.();
  });
  let reason: string | null = null;
  let detail: string | null = null;
  try {
    const result = await Promise.race([work, deadline]);
    if (result === "timed_out") reason = "timed_out";
    else if (!result.acquired) reason = `ownership_${result.reason}`;
  } catch (error) {
    reason = error instanceof Error && error.message === "cancelled_warm_export_timed_out" ? "timed_out" : "export_failed";
    detail = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  } finally {
    if (timer) clearTimeout(timer);
  }
  // restoreWorkspace swaps the reference to the finalized one on success.
  if (!reason && (sync.reference as { state: string }).state !== "finalized") reason = "export_not_finalized";

  const mark = reason
    ? { state: "unproven", reason, detail, timeoutMs, at: new Date().toISOString() }
    : { state: "finalized", at: new Date().toISOString() };
  try {
    await input.db.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
      || ${JSON.stringify({ nativeCancelledWarmExport: mark })}::jsonb` }).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
    await appendHeartbeatRunEvent(input.db, {
      companyId: run.companyId, agentId: run.agentId, runId: run.id,
      eventType: reason ? "workspace_export_deferred" : "workspace_export_finalized",
      stream: "system", level: reason ? "warn" : "info",
      message: reason
        ? `Stopped turn's workspace export could not be proven (${reason}); the warm box stays protected and its files are not yet on the host.`
        : "Stopped turn's workspace exported to the host; the warm box stays reusable for the next message.",
      payload: { reason, detail, timeoutMs },
    });
  } catch (error) {
    logger.warn({ err: error, runId: input.runId }, "cancelled warm workspace export outcome could not be recorded");
  }
  if (reason) {
    logger.warn({ runId: input.runId, reason, detail, timeoutMs },
      "Stopped warm turn's workspace export unproven; the box stays a protected export source");
    return { outcome: "unproven", reason };
  }
  return { outcome: "finalized" };
}
