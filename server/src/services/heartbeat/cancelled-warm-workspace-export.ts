import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { hasAcknowledgedNativeStopIntent } from "../acknowledged-native-stop.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { admittedNativeResourceDisposition } from "../native-runtime/native-failed-workspace-recovery.js";
import {
  NativeWorkspaceFinalizationOwnershipLostError,
  withNativeWorkspaceFinalizationOwnership,
} from "../native-runtime/native-workspace-finalization-ownership.js";

/** pl/cancel-finalize: the longest a Stop's cancellation boundary waits for the
 * stopped turn's workspace export. The box's stop_and_retain release runs only
 * after the boundary returns, and the held message / Send wait for that
 * release's stop receipt, so this is also the longest the +0 successor waits. */
export const CANCELLED_WARM_EXPORT_TIMEOUT_MS = 30_000;

type PreparedSync = {
  readonly reference: { state: string };
  restoreWorkspace: (assertOwnership?: () => Promise<void>, options?: { signal?: AbortSignal }) => Promise<void>;
};

export type CancelledWarmExportOutcome =
  | { outcome: "not_applicable" }
  | { outcome: "not_settled" }
  | { outcome: "finalized" }
  | { outcome: "unproven"; reason: string };

function deferredLine(reason: string): string {
  // pl/cancel-finalize4 (rf-4 02:16Z Q2): say only what is known and name no
  // action that does not exist. The export was not CONFIRMED in time (the host
  // may already hold some or all of the files); the descriptor stays `prepared`,
  // so the box stays a protected export source (nativeWorkspaceExportPendingForResource).
  // This state creates NO recovery action (issue_recovery_actions: none), so
  // WorkspaceExportRecovery renders no "Recover saved files" button for it:
  // the line names no button.
  return `Stopped turn's workspace export could not be confirmed in time (${reason}); its files may or may not be on the host yet. The box is kept, so nothing on it is lost.`;
}

/** adopt-stopu (U1): the settled person's Stop. NSE settles an acknowledged
 * Stop by moving the run's coordinator to terminal_failure /
 * native_retry_cancelled (native-session-executor.ts, the cancellation settle
 * transaction). Under stop_and_retain no retained idle receipt is written, so
 * that settle (not nativeRetainedIdleCheckpoint) is the trigger. */
async function hasSettledPersonStop(db: Db, run: typeof heartbeatRuns.$inferSelect): Promise<boolean> {
  if (!hasAcknowledgedNativeStopIntent(run)) return false;
  const [settled] = await db.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.runId, run.id), eq(nativeRunFinalizations.companyId, run.companyId),
    eq(nativeRunFinalizations.phase, "terminal_failure"),
    eq(nativeRunFinalizations.failureCode, "native_retry_cancelled"))).limit(1);
  return Boolean(settled);
}

/**
 * At the cancellation boundary of a person's Stop of a warm (keep_running)
 * turn, finish the run's own prepared native-workspace export under the run's
 * workspace-finalization ownership, BEFORE the box's stop_and_retain release
 * (adopt-stopu): copy the box's files back to the host, write the finalized
 * descriptor and the remote/lease stamps. The run stays cancelled; no result is
 * invented and nothing is replayed. With the descriptor finalized, no preserve
 * hold is written and the existing reuse filter (environment-runtime.ts
 * nativeWorkspaceExportPendingForResource) passes for the stopped box.
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
  if (!await hasSettledPersonStop(input.db, run)) return { outcome: "not_settled" };

  const timeoutMs = input.timeoutMs ?? CANCELLED_WARM_EXPORT_TIMEOUT_MS;
  // pl/cancel-finalize2: ONE aggregate bound for the whole export. At the
  // deadline the signal aborts: the ownership callback returns at once (so the
  // finalization lock session is released at the deadline, not when a held
  // command joins), and every later step of the export re-checks the signal
  // after its remote call, so nothing (no remote stamp, no finalized
  // descriptor, no lease stamp) is written after the deadline.
  const controller = new AbortController();
  const timedOut = new Error("cancelled_warm_export_timed_out");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(
      controller.signal.reason instanceof NativeWorkspaceFinalizationOwnershipLostError ? controller.signal.reason : timedOut,
    ), { once: true });
  });
  aborted.catch(() => undefined);
  const work = withNativeWorkspaceFinalizationOwnership({ db: input.db, companyId: input.companyId, runId: input.runId },
    async (ownership) => {
      // pl/lockloss: losing the lock session aborts the same controller, so the
      // cancel-finalize3 fence stops the copyback's late host writes too.
      const onLost = () => controller.abort(ownership.lost.reason);
      // adopt-drain: at the deadline (or lock loss) no new host mutation
      // starts; the ownership release then drains the in-flight host calls.
      const closeHostMutations = () => ownership.hostMutations.close(controller.signal.reason);
      if (controller.signal.aborted) closeHostMutations();
      else controller.signal.addEventListener("abort", closeHostMutations, { once: true });
      if (ownership.lost.aborted) onLost();
      else ownership.lost.addEventListener("abort", onLost, { once: true });
      const assertHeld = async () => {
        if (controller.signal.aborted) throw controller.signal.reason;
        await ownership.assertHeld();
      };
      const export_ = sync.restoreWorkspace(assertHeld, { signal: controller.signal });
      export_.catch(() => undefined);
      await Promise.race([export_, aborted]);
    });
  work.catch(() => undefined);
  const deadline = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => { controller.abort(timedOut); resolve("timed_out"); }, timeoutMs);
    timer.unref?.();
  });
  let reason: string | null = null;
  let detail: string | null = null;
  try {
    const result = await Promise.race([work, deadline]);
    if (result === "timed_out") reason = "timed_out";
    else if (!result.acquired) reason = `ownership_${result.reason}`;
  } catch (error) {
    reason = controller.signal.reason instanceof NativeWorkspaceFinalizationOwnershipLostError
      || error instanceof NativeWorkspaceFinalizationOwnershipLostError ? "ownership_lost"
      : error instanceof Error && error.message === "cancelled_warm_export_timed_out" ? "timed_out" : "export_failed";
    detail = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  } finally {
    if (timer) clearTimeout(timer);
    // Whatever the outcome, the export may not continue past this point.
    if (!controller.signal.aborted) controller.abort(timedOut);
  }
  if (reason === "timed_out") {
    // Wait (briefly, bounded) for the ownership session to be released.
    await Promise.race([work.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 1_000).unref?.())]);
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
        ? deferredLine(reason)
        : "Stopped turn's workspace exported to the host; the stopped box stays reusable for the next message.",
      payload: { reason, detail, timeoutMs },
    });
    if (reason) {
      // The person must see this line: the native transcript consumer
      // (ui native-run-events.ts nativeRunEventsToTranscript) renders only
      // PRP-shaped events, so the warning is ALSO written as one provider
      // notice in that schema (one transcript row).
      await appendHeartbeatRunEvent(input.db, {
        companyId: run.companyId, agentId: run.agentId, runId: run.id,
        eventType: "provider.notice.recorded", stream: "system", level: "warn",
        message: deferredLine(reason),
        payload: { prpEvent: {
          schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "control_plane",
          runId: run.id, eventType: "provider.notice.recorded", emittedAt: new Date().toISOString(),
          payload: { schema: "paperclip.provider.notice.v1", severity: "warning", category: "workspace_export_deferred",
            summary: deferredLine(reason), message: deferredLine(reason) },
        } },
      });
    }
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
