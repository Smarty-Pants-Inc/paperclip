import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { hasAcknowledgedNativeRunStopRequest, hasAcknowledgedNativeStopIntent } from "../acknowledged-native-stop.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { noStoppedTurnProcessRemains, type StoppedTurnBox } from "./stopped-turn-process-check.js";
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const STOPPED_SESSION_CLOSE_SCHEMA = "paperclip.native-stopped-session-close.v1";
const TOOLS_NOT_PROVEN_STOPPED = "tools_not_proven_stopped";
const TOOLS_NOT_PROVEN_LINE = "Stopped, but the box's tools could not be proven stopped, so the workspace was not copied back. The box is kept.";

/** pl/r4-work3 (rf-3): in the CLOSED case (no idle receipt) the coordinator
 * settle alone does not prove the stopped turn's tools are gone. NSE records
 * the close of that session (native-session-executor.ts releaseWarmNativeSession
 * onStoppedSessionClose); clean = closeWarmNativeSession did not throw (Pi's
 * transport ladder completed; on the Boat path the Runner's suspension proof was
 * accepted). Without it, nothing is copied from the box. */
export function hasCleanStoppedSessionClose(run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "nativeIssueId" | "runnerProfileJson">): boolean {
  const proof = record(record(run.runnerProfileJson).nativeStoppedSessionClose);
  return proof.schema === STOPPED_SESSION_CLOSE_SCHEMA && proof.runId === run.id
    && proof.companyId === run.companyId && proof.issueId === run.nativeIssueId && proof.clean === true;
}

const RETAINED_IDLE_SCHEMA = "paperclip.native-retained-idle-checkpoint.v1";
/** adopt-stopu-proof: how often the boundary re-reads the run row while it
 * waits (inside the export's one bound) for NSE's retained/closed decision. */
export const STOPPED_TURN_DECISION_POLL_MS = 250;

/** adopt-stopu-proof: NSE's RETAINED decision for THIS run (the person's Stop
 * returned the warm session to idle: activeTurnId null, no pending requests,
 * clean cancellation; native-session-executor.ts retainCancelledSession, the
 * receipt written in the cancellation settle transaction). */
export function hasRetainedIdleReceipt(run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "nativeIssueId" | "runnerProfileJson">): boolean {
  const receipt = record(record(run.runnerProfileJson).nativeRetainedIdleCheckpoint);
  return receipt.schema === RETAINED_IDLE_SCHEMA && receipt.runId === run.id
    && receipt.companyId === run.companyId && receipt.issueId === run.nativeIssueId
    && typeof receipt.sessionId === "string" && receipt.sessionId.length > 0;
}

/** NSE's CLOSED decision for THIS run, clean or not (any close record). */
function closeRecord(run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "nativeIssueId" | "runnerProfileJson">) {
  const proof = record(record(run.runnerProfileJson).nativeStoppedSessionClose);
  return proof.schema === STOPPED_SESSION_CLOSE_SCHEMA && proof.runId === run.id
    && proof.companyId === run.companyId && proof.issueId === run.nativeIssueId ? proof : null;
}

export type StoppedTurnSessionDecision = "retained" | "closed_clean" | "closed_unclean" | null;
/** Which way NSE decided the stopped session, from the run row (null: not yet). */
export function stoppedTurnSessionDecision(run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "nativeIssueId" | "runnerProfileJson">): StoppedTurnSessionDecision {
  if (hasRetainedIdleReceipt(run)) return "retained";
  const close = closeRecord(run);
  if (!close) return null;
  return close.clean === true ? "closed_clean" : "closed_unclean";
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
  /** adopt-stopu-xpaths: at the release site the run is already terminal
   * `cancelled` by an acknowledged run-only Stop; that, not the NSE settle
   * row, is the trigger there (the Stop may have surfaced as another error). */
  settledBy?: "nse_settle" | "terminal_cancelled_run";
  /** adopt-stopu-proof: the stopped turn's box (its command path), for
   * noStoppedTurnProcessRemains; absent/unresolvable -> not proven. */
  box?: StoppedTurnBox | (() => Promise<StoppedTurnBox | null>) | null;
}): Promise<CancelledWarmExportOutcome> {
  const sync = input.nativeWorkspaceSync;
  if (!sync || sync.reference.state !== "prepared") return { outcome: "not_applicable" };
  const [run] = await input.db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
  )).limit(1);
  if (!run || run.runtimeMode !== "native"
    || admittedNativeResourceDisposition(run.runnerProfileJson) !== "keep_running") return { outcome: "not_applicable" };
  if (input.settledBy === "terminal_cancelled_run"
    ? !(run.status === "cancelled" && hasAcknowledgedNativeRunStopRequest(run))
    : !await hasSettledPersonStop(input.db, run)) return { outcome: "not_settled" };
  // adopt-stopu-proof (rf-3 + rf-4 + RFL 01:08-01:10Z): U DOES retain. NSE's
  // retainCancelledSession (native-session-executor.ts) keeps the warm session
  // after a clean Stop and writes nativeRetainedIdleCheckpoint in the settle
  // transaction; only a CLOSED session writes nativeStoppedSessionClose (after
  // releaseWarmNativeSession's close ladder). So branch on the executor's own
  // decision. If neither record exists yet at this boundary (the release site
  // can run before NSE settles, as on run 4f211436), WAIT for one of them by
  // re-reading the run row, inside this export's one bound. Either way the
  // turn's processes must ALSO be proven gone on the box
  // (noStoppedTurnProcessRemains): the receipt/close ladder says nothing about
  // the turn's foreground command or a writer that escaped Pi.
  const timeoutMs = input.timeoutMs ?? CANCELLED_WARM_EXPORT_TIMEOUT_MS;
  const boundStartedAt = Date.now();
  let decided = stoppedTurnSessionDecision(run);
  let current = run;
  while (decided === null && Date.now() - boundStartedAt + STOPPED_TURN_DECISION_POLL_MS < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, STOPPED_TURN_DECISION_POLL_MS));
    const [again] = await input.db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId))).limit(1);
    if (!again) break;
    current = again;
    decided = stoppedTurnSessionDecision(current);
  }
  let processesGone = false;
  if (decided === "retained" || decided === "closed_clean") {
    const box = typeof input.box === "function" ? await input.box().catch(() => null) : input.box;
    const remaining = timeoutMs - (Date.now() - boundStartedAt);
    processesGone = remaining > 0 && await noStoppedTurnProcessRemains(box, current.startedAt,
      { retainedSession: decided === "retained", timeoutMs: Math.min(remaining, 10_000) });
  }
  if (!processesGone) {
    // No export, no box command: the descriptor stays `prepared`, so the box
    // stays a protected export source, and the person reads the true line.
    await recordCancelledWarmExportOutcome(input.db, run, {
      reason: TOOLS_NOT_PROVEN_STOPPED, detail: null, timeoutMs: null, line: TOOLS_NOT_PROVEN_LINE });
    logger.warn({ runId: input.runId, reason: TOOLS_NOT_PROVEN_STOPPED, decided },
      "Stopped warm turn's tools are not proven stopped; its workspace is not exported and the box is kept");
    return { outcome: "unproven", reason: TOOLS_NOT_PROVEN_STOPPED };
  }

  // The export gets what is left of the one bound (the wait above shares it).
  const exportTimeoutMs = Math.max(1, timeoutMs - (Date.now() - boundStartedAt));
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
    timer = setTimeout(() => { controller.abort(timedOut); resolve("timed_out"); }, exportTimeoutMs);
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

  await recordCancelledWarmExportOutcome(input.db, run, reason
    ? { reason, detail, timeoutMs, line: deferredLine(reason) } : { reason: null, detail, timeoutMs, line: null });
  if (reason) {
    logger.warn({ runId: input.runId, reason, detail, timeoutMs },
      "Stopped warm turn's workspace export unproven; the box stays a protected export source");
    return { outcome: "unproven", reason };
  }
  return { outcome: "finalized" };
}

async function recordCancelledWarmExportOutcome(db: Db, run: typeof heartbeatRuns.$inferSelect, outcome: {
  reason: string | null; detail: string | null; timeoutMs: number | null; line: string | null;
}): Promise<void> {
  const { reason, detail, timeoutMs } = outcome;
  const line = outcome.line ?? "";
  const input = { db, runId: run.id, companyId: run.companyId };
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
        ? line
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
        message: line,
        payload: { prpEvent: {
          schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "control_plane",
          runId: run.id, eventType: "provider.notice.recorded", emittedAt: new Date().toISOString(),
          payload: { schema: "paperclip.provider.notice.v1", severity: "warning", category: "workspace_export_deferred",
            summary: line, message: line },
        } },
      });
    }
  } catch (error) {
    logger.warn({ err: error, runId: input.runId }, "cancelled warm workspace export outcome could not be recorded");
  }
}
