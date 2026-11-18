import type { Db } from "@paperclipai/db";
import { notifyDeferredExecutionWork } from "../deferred-execution-notifications.js";
import { notifyQueuedRunDispatch } from "../run-dispatch-notifications.js";
import { stampQueuedRunsStartable } from "../heartbeat/startable-since.js";
import { onNativeSessionCleanupQuarantined, onNativeSessionCleanupSettled } from "../../vendor/paperclip-runner/index.js";

/**
 * A retained native session close holds task input in the runner's process
 * memory. When the runner releases it, wake deferred execution for that company
 * so a held Retry or message re-evaluates its gate. The wake is a hint only:
 * dispatch repeats every admission check under its own locks.
 */
export function registerNativeCleanupReleaseWake(db: Db, onError: (error: unknown, companyId: string) => void): () => void {
  const unsubscribeSettled = onNativeSessionCleanupSettled(({ companyId, issueIds }) => {
    if (!companyId) return;
    void db.transaction(async tx => {
      // RFL 01:00Z (a): the native session cleanup hold clears; the task's queued runs are startable from now.
      await stampQueuedRunsStartable(tx, { companyId, issueIds });
      await notifyDeferredExecutionWork(tx, { companyId });
      await notifyQueuedRunDispatch(tx, { companyId });
    }).catch((error: unknown) => onError(error, companyId));
  });
  const unsubscribeQuarantined = onNativeSessionCleanupQuarantined(({ companyId, operatorRecoveryRequired }) => {
    if (!companyId || !operatorRecoveryRequired) return;
    void db.transaction(async tx => notifyQueuedRunDispatch(tx, { companyId }))
      .catch((error: unknown) => onError(error, companyId));
  });
  return () => { unsubscribeSettled(); unsubscribeQuarantined(); };
}
