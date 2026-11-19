import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { notifyNativeResponsePresentation } from "../native-response-presentation-notifications.js";
import { pendingNativeWithheldReply, WITHHELD_REPLY_TRIGGER } from "./native-withheld-reply-trigger.js";

type AcceptingTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The acceptance hook of the withheld-reply outbox: the ONE write of the
 * publish entry at acceptance. Every producer that accepts a native result
 * (NativeRunCoordinatorStore.completeRun, and the runner's own path,
 * PaperclipControlPlanePort.completeRun) calls it inside its own accepting
 * transaction, after its run update, so no result is accepted without its
 * entry and a crash cannot separate the two.
 *
 * Under WITHHELD_REPLY_TRIGGER = "acceptance" it merges the pending entry into
 * the run's resultJson and wakes the reply-presentation worker, which
 * publishes the answer now instead of after the copy-back. Under "terminal"
 * it writes nothing.
 */
export async function writeAcceptanceWithheldReplyEntry(
  tx: AcceptingTransaction,
  scope: { companyId: string; issueId: string; runId: string },
  resultId: string,
): Promise<void> {
  if (WITHHELD_REPLY_TRIGGER !== "acceptance") return;
  await tx.update(heartbeatRuns).set({
    resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb)
      || ${JSON.stringify(pendingNativeWithheldReply(resultId, null, "acceptance"))}::jsonb`,
  }).where(eq(heartbeatRuns.id, scope.runId));
  await notifyNativeResponsePresentation(tx, { companyId: scope.companyId, issueId: scope.issueId, runId: scope.runId });
}
