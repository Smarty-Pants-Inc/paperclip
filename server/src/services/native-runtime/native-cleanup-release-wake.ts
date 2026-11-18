import type { Db } from "@paperclipai/db";
import { notifyDeferredExecutionWork, notifyDeferredWakesForIssue } from "../deferred-execution-notifications.js";
import { notifyQueuedRunDispatch } from "../run-dispatch-notifications.js";
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
      await notifyDeferredExecutionWork(tx, { companyId });
      // S8q: the end of a session close is the end of teardown. Exact hints
      // reach the held wakes without waiting out the company reconstruction.
      for (const issueId of issueIds ?? []) await notifyDeferredWakesForIssue(tx, { companyId, issueId });
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
