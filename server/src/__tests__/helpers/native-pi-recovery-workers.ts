import type { Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../../services/delivery-work-notifications.js";
import { environmentRuntimeService } from "../../services/environment-runtime.js";
import { heartbeatService } from "../../services/heartbeat.js";
import { registerWorkspaceRecoveryWork } from "../../services/workspace-recovery-work.js";
import { executionControlSchedule, registerExecutionControlWork } from "../../services/execution-control-work.js";
import { reconcileAbandonedExecutionControl } from "../../services/execution-control-reconciliation.js";
import { deliverExecutionStatuses } from "../../services/execution-status-delivery.js";
import { deliverReconciledExecutions, settleUnrecoverableExecutions } from "../../services/execution-recovery-resolution.js";
import { reconcileSafeNativeReplacements } from "../../services/native-runtime/native-safe-replacement.js";
import { verifyStoppedNativeSessionForAutomaticReplacement } from "../../services/native-runtime/native-session-executor.js";
import { acknowledgeNativeStartupCleanup } from "../../services/native-runtime/native-startup-cleanup.js";
import { registerNativeCleanupReleaseWake } from "../../services/native-runtime/native-cleanup-release-wake.js";

/** createApp does not install index.ts's recovery registrations. Use those
 * production queues and deadlines, not a test poller or a direct recovery call. */
export async function nativePiRecoveryWorkers(db: Db, delivery: ReturnType<typeof createDeliveryWorkCoordinator>) {
  let stopped = false;
  const canRun = () => !stopped;
  const heartbeat = heartbeatService(db), schedule = executionControlSchedule(db);
  const workspace = registerWorkspaceRecoveryWork(db, delivery, environmentRuntimeService(db), heartbeat.resumeRemoteStopComments, canRun);
  const unsubscribe = registerNativeCleanupReleaseWake(db, error => console.error("Native cleanup wake", error));
  const execution = registerExecutionControlWork(delivery, [
    { queue: DELIVERY_QUEUES.executionFinalization, run: () => reconcileAbandonedExecutionControl(db, new Date(), {
      startupCleanup: async scope => { await heartbeat.cancelRun(scope.runId, "Native startup timed out; cancelling and verifying cleanup"); await acknowledgeNativeStartupCleanup(db, scope); },
    }), next: schedule.finalization },
    { queue: DELIVERY_QUEUES.executionStatus, run: () => deliverExecutionStatuses(db), next: schedule.status },
    { queue: DELIVERY_QUEUES.executionDisposition, run: () => settleUnrecoverableExecutions(db), next: schedule.disposition },
    { queue: DELIVERY_QUEUES.executionReplacement, run: () => reconcileSafeNativeReplacements(db, new Date(), {
      verifyStoppedSession: run => verifyStoppedNativeSessionForAutomaticReplacement(db, run),
    }), next: schedule.replacement },
    { queue: DELIVERY_QUEUES.executionContinuation, run: () => deliverReconciledExecutions(db, heartbeat.wakeup), next: schedule.continuation },
  ], canRun);
  const workers = [
    heartbeat.registerResidualRecoveryWork(delivery, canRun), heartbeat.registerIssueStateRecoveryWork(delivery, canRun),
    heartbeat.registerDeferredReceiptWork(delivery, canRun), heartbeat.registerRunDispatchWork(delivery, canRun),
    heartbeat.registerNativeWorkspaceFinalizationWork(delivery, canRun), heartbeat.registerRetainedNativeSessionCleanupWork(delivery, canRun),
    heartbeat.registerNativeRecoveryNoticeWork(delivery, canRun), heartbeat.registerNativeEnvironmentSettlementWork(delivery, canRun),
    heartbeat.registerNativeRunProjectionWork(delivery, canRun), heartbeat.registerNativeResultCommitWork(delivery, canRun),
    heartbeat.registerNativeStatusReassessmentWork(delivery, canRun), heartbeat.registerNativeResponsePresentationWork(delivery, canRun),
    heartbeat.registerCancelledWorkspacePreservationWork(delivery, canRun),
  ];
  await Promise.all([workspace.ready, execution.ready, ...workers.map(worker => worker.ready)]);
  return async () => {
    stopped = true; unsubscribe();
    for (const worker of workers) if ("stop" in worker && typeof worker.stop === "function") await worker.stop();
    await workspace.stop();
  };
}
