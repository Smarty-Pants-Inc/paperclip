import { and, eq, inArray, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issueComments, type Db } from "@paperclipai/db";
import { hasRemoteTerminationReceipt, resolveRemoteTerminationLease } from "../remote-execution-termination.js";
import { hasConfirmedSandboxStopAndRetain, prepareUnconfirmedSourceSandboxStop, SANDBOX_ALLOCATION_HOLDER_STATUSES } from "../sandbox-stop-and-retain.js";
import { proveRunProcessGone } from "../run-process-owner.js";
import { writePiSessionHistoryLossNotice } from "./pi-session-recovery-notice.js";

export const FRESH_THREAD_STARTED_NOTE = "The earlier provider thread could not be safely restored. Starting a fresh thread in this conversation from its saved history. Earlier actions with unknown outcomes are not confirmed or replayed.";
export const FRESH_THREAD_STOPPING_NOTE = "I'm stopping the earlier attempt before starting fresh. Your message is saved; the fresh thread will read this conversation's history.";
export const FRESH_THREAD_TURN_NOTE = "Your message is saved; your skill change takes effect after the current step. Then a fresh thread will read this conversation's history.";

/** One stable notice across stop waiting, turn waiting, and admitted fresh
 * history. Caller holds the same task/run locks as the continuation owner. */
export async function writeFreshThreadNotice(tx: Db, run: typeof heartbeatRuns.$inferSelect, issueId: string, body: string) {
  const sessionId = run.nativeSessionId;
  const reason = `fresh_provider_thread_pending:${sessionId ?? run.id}`;
  const [heldNotice] = sessionId ? await tx.select({ id: issueComments.id })
    .from(issueComments).where(and(eq(issueComments.companyId, run.companyId), eq(issueComments.issueId, issueId),
      eq(issueComments.authorType, "system"), sql`${issueComments.metadata}->>'authorizationReason' = ${`native_prior_owner_held:${sessionId}`}`)).limit(1) : [];
  if (heldNotice) await tx.update(issueComments).set({ metadata: sql`jsonb_set(${issueComments.metadata},
    '{authorizationReason}', to_jsonb(${reason}::text))` })
    .where(and(eq(issueComments.companyId, run.companyId), eq(issueComments.id, heldNotice.id)));
  // The same visible row now belongs to the automatic boundary. Leaving the
  // old held prefix would make its projection survive even a successful fresh
  // session (whose normalized id intentionally differs from the old one).
  await writePiSessionHistoryLossNotice(tx, tx as never, { companyId: run.companyId,
    issueId, runId: run.id, agentId: run.agentId, authorizationReason: reason, body, replaceExisting: true });
}

/** Strict admission gate for impossible reconciliation. Unlike the generic
 * isolated-workspace fallback, elapsed time can NEVER authorize this boundary.
 * Called under the existing issue -> coordinator -> run -> recovery locks. */
export async function freshThreadStopGate(tx: Db, run: typeof heartbeatRuns.$inferSelect, issueId: string) {
  const sessionId = run.nativeSessionId;
  const noticeAuthorizationReason = `fresh_provider_thread_pending:${sessionId ?? run.id}`;
  const notice = (body: string) => writeFreshThreadNotice(tx, run, issueId, body);
  const owners = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.nativeIssueId, issueId),
    sessionId ? eq(heartbeatRuns.nativeSessionId, sessionId) : eq(heartbeatRuns.id, run.id),
    sql`${heartbeatRuns.createdAt} <= (select created_at from ${heartbeatRuns} where id = ${run.id})`));
  // A live earlier turn owns the conversation. Do not even request its stop.
  if (owners.some(owner => owner.id !== run.id && ["running", "queued", "scheduled_retry"].includes(owner.status))) {
    await notice(FRESH_THREAD_TURN_NOTE);
    return { gone: false as const, reason: "active_provider_turn", noticeAuthorizationReason };
  }
  const turnRefusal = run.resultJson?.nativeFreshContinuationRefusal as { waitForTurn?: unknown } | undefined;
  const waitingTurn = turnRefusal?.waitForTurn === true && !owners.some(owner => owner.id !== run.id
    && owner.finishedAt && run.finishedAt && owner.finishedAt > run.finishedAt);
  const leases = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, run.companyId),
    inArray(environmentLeases.heartbeatRunId, owners.map(owner => owner.id).concat(run.id))));
  let gone = leases.length > 0;
  for (const original of leases) {
    const lease = await resolveRemoteTerminationLease(tx, original);
    if (!lease.provider || lease.provider === "local" || !lease.providerLeaseId) { gone = false; continue; }
    // Reuse by a different holder may have restarted a formerly stopped box.
    // Never stop that holder or borrow its old stop receipt.
    const peers = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      eq(environmentLeases.provider, lease.provider), eq(environmentLeases.providerLeaseId, lease.providerLeaseId),
      sql`${environmentLeases.id} <> ${lease.id}`, inArray(environmentLeases.status, [...SANDBOX_ALLOCATION_HOLDER_STATUSES]))).limit(1);
    if (peers.length) { gone = false; continue; }
    const termination = lease.metadata?.remoteExecutionTermination as { confirmedAt?: unknown } | undefined;
    const confirmedAt = typeof termination?.confirmedAt === "string" ? Date.parse(termination.confirmedAt) : NaN;
    const confirmedRelease = hasRemoteTerminationReceipt(lease) && Number.isFinite(confirmedAt)
      && confirmedAt >= lease.acquiredAt.getTime() && lease.releasedAt !== null && confirmedAt <= lease.releasedAt.getTime()
      && lease.metadata?.pendingCleanupInFlight !== true;
    if (hasConfirmedSandboxStopAndRetain(lease) || confirmedRelease) continue;
    gone = false;
    // Persist the existing stop-only intent; cleanup's plugin release contract
    // supplies the independently bound stopped/destroyed receipt. A void
    // release, 'stopping', expired lease, or successful RPC is NOT evidence.
    if (!waitingTurn) await prepareUnconfirmedSourceSandboxStop(tx, original);
  }
  if (!leases.length && (run.processPid !== null || run.processGroupId !== null)) {
    const proof = await proveRunProcessGone(run, run.id);
    gone = proof?.verdict === "gone";
  }
  // Only the settlement owner can say it is starting fresh: a newer run or a
  // person-owned gate may still make a positive physical proof inapplicable.
  if (!gone) await notice(waitingTurn ? FRESH_THREAD_TURN_NOTE : FRESH_THREAD_STOPPING_NOTE);
  return { gone, reason: gone ? "previous_execution_gone" : waitingTurn ? "active_provider_turn" : "previous_execution_stop_unconfirmed", noticeAuthorizationReason };
}
