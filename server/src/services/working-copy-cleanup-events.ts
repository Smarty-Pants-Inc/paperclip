import { and, eq, sql } from "drizzle-orm";
import { agentInstructionWorkingCopies as copies, environmentLeases, type Db } from "@paperclipai/db";
import { notifyInstructionCollection } from "./instruction-collection-notifications.js";
import { notifyDirectoryCleanup } from "./directory-cleanup-notifications.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";

/** A real exact-lease destruction producer, not a sweep/notification, rearms
 * retained cleanup. Register wake intent before the update, in its transaction.
 * Terminal standing proofs are never cleared by an unrelated lease event. */
export async function rearmDestroyedWorkingCopyCleanup(tx: Db, scope: { companyId: string; runId?: string; leaseId?: string }) {
  if (!scope.runId && !scope.leaseId) return;
  const leases = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, scope.companyId),
    scope.leaseId ? eq(environmentLeases.id, scope.leaseId) : eq(environmentLeases.heartbeatRunId, scope.runId!)));
  for (const lease of leases) {
    if (!lease.heartbeatRunId || !hasRemoteTerminationReceipt(lease)
      || (lease.metadata?.remoteExecutionTermination as { state?: string })?.state !== "destroyed") continue;
    const hint = { companyId: scope.companyId, runId: lease.heartbeatRunId };
    await notifyInstructionCollection(tx, hint);
    await notifyDirectoryCleanup(tx, hint);
    await tx.update(copies).set({
      receipt: sql`(${copies.receipt} - 'cleanupParked') || '{"cleanupAttempts":0}'::jsonb`,
      nextAttemptAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(copies.companyId, scope.companyId), eq(copies.runId, lease.heartbeatRunId),
      sql`${copies.receipt}->>'schema' = 'paperclip.agent-files.v1'
        AND ${copies.receipt} ? 'cleanupParked'
        AND NOT (${copies.receipt} ? 'cleanupTerminal')
        AND ${copies.receipt}#>>'{cleanup,leaseId}' = ${lease.id}
        AND NOT (${copies.receipt} ? 'retainedByRunId')`));
  }
}
