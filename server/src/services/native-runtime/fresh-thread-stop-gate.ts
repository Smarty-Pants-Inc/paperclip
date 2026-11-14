import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { agents, environmentLeases, heartbeatRunEvents, heartbeatRuns, issueComments, type Db } from "@paperclipai/db";
import { hasRemoteTerminationReceipt, resolveRemoteTerminationLease } from "../remote-execution-termination.js";
import { hasConfirmedSandboxStopAndRetain, prepareUnconfirmedSourceSandboxStop, readStopOnlyCleanup, retryUnconfirmedSourceSandboxStop, SANDBOX_ALLOCATION_HOLDER_STATUSES } from "../sandbox-stop-and-retain.js";
import { noLocalRunnerProcessesForRuns, proveRunProcessGone } from "../run-process-owner.js";
import { writePiSessionHistoryLossNotice } from "./pi-session-recovery-notice.js";
import { retiredReusableLeasePredecessors } from "../environment-lease-handoff.js";
import { freshThreadRefusalCode, FRESH_THREAD_STOP_STATE_KEY } from "./runner-reconciliation-refusal.js";
import { PENDING_CLEANUP_SWEEP_ATTEMPT_CAP } from "../environment-cleanup-state.js";
import { isBuiltinSandboxProvider } from "../sandbox-provider-runtime.js";
import { currentProcessSpaceHash } from "../controller-process-identity.js";
import { hostname } from "node:os";

export const FRESH_THREAD_STARTED_NOTE = "The earlier provider thread could not be safely restored. Starting a fresh thread in this conversation from its saved history. Earlier actions with unknown outcomes are not confirmed or replayed.";
export const FRESH_THREAD_STOP_UNAVAILABLE_NOTE = "Paperclip cannot confirm that the earlier attempt stopped, so it has not started another thread. Your message and saved work are kept. Retry checks again and starts fresh only after the earlier attempt is confirmed stopped.";
export const FRESH_THREAD_STOPPING_NOTE = "I'm stopping the earlier attempt before starting fresh. Your message is saved; the fresh thread will read this conversation's history.";
export const FRESH_THREAD_TURN_NOTE = "Your message is saved; the current step must finish before starting a fresh thread from this conversation's history.";

/** Only the typed instruction/skill refresh may claim the change took effect.
 * Environment loss and launch mismatch retain the generic truthful notice. */
export async function freshThreadStartedNote(db: Pick<Db, "select">, run: typeof heartbeatRuns.$inferSelect): Promise<string> {
  const refusal = run.resultJson?.nativeFreshContinuationRefusal as { code?: unknown } | undefined;
  const code = freshThreadRefusalCode({ code: run.errorCode }) ?? freshThreadRefusalCode(refusal);
  if (code !== "native_runner_refresh_required") return FRESH_THREAD_STARTED_NOTE;
  const [agent] = await db.select({ name: agents.name }).from(agents).where(and(
    eq(agents.companyId, run.companyId), eq(agents.id, run.agentId))).limit(1);
  return `your skill change is in effect; ${agent?.name ?? "the agent"} restarted its working thread to pick it up. The fresh thread in this conversation reads its saved history. Earlier actions with unknown outcomes are not confirmed or replayed.`;
}

function turnWaitingNote(run: typeof heartbeatRuns.$inferSelect): string {
  const refusal = run.resultJson?.nativeFreshContinuationRefusal as { code?: unknown } | undefined;
  const code = freshThreadRefusalCode({ code: run.errorCode }) ?? freshThreadRefusalCode(refusal);
  const reason = code === "runner_remote_state_unavailable" ? "The earlier environment is unavailable."
    : code === "native_controller_recovery_missing_evidence:snapshot_binding"
      || code === "native_controller_recovery_unsupported:metadata_format" ? "The saved thread cannot be restored."
    : code === "native_runner_refresh_required" || code === "native_runner_launch_profile_mismatch"
      ? "The working configuration has changed." : "The earlier thread must be replaced.";
  return `${reason} ${FRESH_THREAD_TURN_NOTE}`;
}

/** One current notice across stop waiting, turn waiting, and admitted fresh
 * history; older notices remain immutable, marked superseded. Caller holds
 * the same task/run locks as the continuation owner. */
export async function writeFreshThreadNotice(tx: Db, run: typeof heartbeatRuns.$inferSelect, issueId: string, body: string) {
  const sessionId = run.nativeSessionId;
  const reason = `fresh_provider_thread_pending:${sessionId ?? run.id}`;
  await writePiSessionHistoryLossNotice(tx, tx as never, { companyId: run.companyId,
    issueId, runId: run.id, agentId: run.agentId, authorizationReason: reason, body, replaceExisting: true });
  if (!sessionId) return;
  const [current] = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, run.companyId), eq(issueComments.issueId, issueId),
    eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt),
    sql`${issueComments.metadata}->>'authorizationReason' = ${reason}`,
    sql`${issueComments.metadata}->>'supersededByCommentId' is null`)).limit(1);
  // Supersede a held note without taking its authorizationReason or wording
  // away from its owner. Standing-notice projection excludes superseded rows.
  if (current) await tx.update(issueComments).set({ metadata: sql`jsonb_set(${issueComments.metadata},
    '{supersededByCommentId}', to_jsonb(${current.id}::text))` }).where(and(
    eq(issueComments.companyId, run.companyId), eq(issueComments.issueId, issueId),
    eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt),
    sql`${issueComments.metadata}->>'authorizationReason' = ${`native_prior_owner_held:${sessionId}`}`,
    sql`${issueComments.metadata}->>'supersededByCommentId' is null`));
}

type ProofReader = Pick<Db, "select" | "selectDistinctOn">;
type StopGateEffects = {
  notice(body: string): Promise<unknown>;
  requestStop(lease: typeof environmentLeases.$inferSelect): Promise<unknown>;
  record(state: "waiting" | "unavailable" | "gone"): Promise<unknown>;
};

/** The proof predicate has only read capabilities. Session-boundary consumers
 * cannot narrate a restart, enqueue cleanup, or alter a lease while reading. */
export function readFreshThreadStopProof(db: ProofReader, run: typeof heartbeatRuns.$inferSelect, issueId: string) {
  return inspectFreshThreadStopProof(db, run, issueId);
}

/** Strict admission gate for impossible reconciliation. Unlike the generic
 * isolated-workspace fallback, elapsed time can NEVER authorize this boundary.
 * Only this transaction-owning fallback requests stop and writes the notice. */
export function freshThreadStopGate(tx: Db, run: typeof heartbeatRuns.$inferSelect, issueId: string, retryStop = false) {
  return inspectFreshThreadStopProof(tx, run, issueId, {
    notice: body => writeFreshThreadNotice(tx, run, issueId, body),
    requestStop: lease => retryStop ? retryUnconfirmedSourceSandboxStop(tx, lease) : prepareUnconfirmedSourceSandboxStop(tx, lease),
    record: state => tx.update(heartbeatRuns).set({ resultJson: sql`jsonb_set(coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb),
      ${`{${FRESH_THREAD_STOP_STATE_KEY}}`}, ${JSON.stringify({ schema: "paperclip.fresh-thread-stop.v1", state })}::jsonb)` })
      .where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id))),
  }, retryStop);
}

async function inspectFreshThreadStopProof(tx: ProofReader, run: typeof heartbeatRuns.$inferSelect,
  issueId: string, effects?: StopGateEffects, retryStop = false) {
  const sessionId = run.nativeSessionId;
  const noticeAuthorizationReason = `fresh_provider_thread_pending:${sessionId ?? run.id}`;
  const owners = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.agentId, run.agentId),
    or(eq(heartbeatRuns.nativeIssueId, issueId), eq(heartbeatRuns.issueId, issueId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`),
    sessionId ? eq(heartbeatRuns.nativeSessionId, sessionId) : undefined,
    sql`${heartbeatRuns.createdAt} <= (select created_at from ${heartbeatRuns} where id = ${run.id})`));
  // Legacy rows may bind their issue only through issueId/contextSnapshot.
  // Never lose the contender's recorded local process from the owner proof.
  if (!owners.some(owner => owner.id === run.id)) owners.push(run);
  // A live earlier turn owns the conversation. Do not even request its stop.
  if (owners.some(owner => owner.id !== run.id && ["running", "queued", "scheduled_retry"].includes(owner.status))) {
    await effects?.record("waiting");
    await effects?.notice(turnWaitingNote(run));
    return { gone: false as const, reason: "active_provider_turn", noticeAuthorizationReason };
  }
  const turnRefusal = run.resultJson?.nativeFreshContinuationRefusal as { waitForTurn?: unknown } | undefined;
  const waitingTurn = turnRefusal?.waitForTurn === true && !owners.some(owner => owner.id !== run.id
    && owner.finishedAt && run.finishedAt && owner.finishedAt > run.finishedAt);
  const leases = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, run.companyId),
    inArray(environmentLeases.heartbeatRunId, owners.map(owner => owner.id).concat(run.id))));
  // Missing rows are not proof. Allocations require bound provider receipts;
  // local owners require either exact process proof or a positive process-
  // table read below, including launches whose PID was never persisted.
  let gone = true, unavailable = false;
  const checked = new Set<string>();
  for (const original of leases) {
    let lease = await resolveRemoteTerminationLease(tx, original);
    if (!lease.provider || lease.provider === "local") continue;
    if (!lease.providerLeaseId) { gone = false; unavailable = true; continue; }
    if (original.status === "expired" && original.leasePolicy === "reuse_by_environment"
      && Object.hasOwn(original.metadata ?? {}, "reusableLeaseSuccessor")) {
      const history = await tx.select().from(environmentLeases).where(and(
        eq(environmentLeases.provider, original.provider!), eq(environmentLeases.providerLeaseId, original.providerLeaseId!)));
      const tips = history.filter(row => !Object.hasOwn(row.metadata ?? {}, "reusableLeaseSuccessor"));
      const tip = tips.length === 1 ? tips[0] : undefined;
      const predecessors = tip ? retiredReusableLeasePredecessors(tip, history.filter(row => row.id !== tip.id)) : null;
      // Only this conversation's ended owner can request the chain tip's stop.
      // An expired predecessor is immutable history, never pending_cleanup.
      if (!tip || !predecessors?.some(row => row.id === original.id)
        || !owners.some(owner => owner.id === tip.heartbeatRunId)) { gone = false; unavailable = true; continue; }
      lease = tip;
    }
    if (checked.has(lease.id)) continue;
    checked.add(lease.id);
    // Reuse by a different holder may have restarted a formerly stopped box.
    // Never stop that holder or borrow its old stop receipt.
    const peers = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      eq(environmentLeases.provider, lease.provider!), eq(environmentLeases.providerLeaseId, lease.providerLeaseId!),
      sql`${environmentLeases.id} <> ${lease.id}`, inArray(environmentLeases.status, [...SANDBOX_ALLOCATION_HOLDER_STATUSES]))).limit(1);
    if (peers.length) { gone = false; unavailable = true; continue; }
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
    const exhausted = Number(lease.metadata?.pendingCleanupRetryAttempts ?? 0) >= PENDING_CLEANUP_SWEEP_ATTEMPT_CAP;
    // Cleanup retains ownership, including after its automatic budget. A
    // deliberate Retry may re-arm that SAME stop-only intent, never execute.
    if (!readStopOnlyCleanup(lease) && lease.metadata?.pendingCleanupInFlight !== true
      && lease.metadata?.pluginId == null && !isBuiltinSandboxProvider(lease.provider!)) unavailable = true;
    const requested = !waitingTurn ? await effects?.requestStop(lease) : undefined;
    if (exhausted && (!retryStop || !requested)) unavailable = true;
  }
  // Remote execution has its allocation-bound proof above; process stamps for
  // owners with no remote allocation cannot be skipped just because a local
  // lease row exists (or belongs to an earlier stranded attempt).
  const unidentifiedLocalOwners: string[] = [];
  for (const owner of owners) {
    const hasRemoteAllocation = leases.some(lease => lease.heartbeatRunId === owner.id
      && lease.provider && lease.provider !== "local" && lease.providerLeaseId);
    if (hasRemoteAllocation) continue;
    if (owner.processPid !== null || owner.processGroupId !== null) {
      const proof = await proveRunProcessGone(owner, owner.id);
      if (proof?.verdict !== "gone") gone = false;
      if (!proof || proof.verdict === "unprovable") unavailable = true;
    } else {
      unidentifiedLocalOwners.push(owner.id);
    }
  }
  if (unidentifiedLocalOwners.length) {
    const launches = await tx.selectDistinctOn([heartbeatRunEvents.runId], { payload: heartbeatRunEvents.payload })
      .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, run.companyId),
        inArray(heartbeatRunEvents.runId, unidentifiedLocalOwners), isNull(heartbeatRunEvents.sourceEventId),
        inArray(heartbeatRunEvents.eventType, ["native.process_start_requested", "native.process_identity_recorded"])))
      .orderBy(heartbeatRunEvents.runId, desc(heartbeatRunEvents.seq));
    // A local OS read cannot establish absence on another host/allocation.
    const foreignOwner = owners.some(owner => unidentifiedLocalOwners.includes(owner.id)
      && owner.processHostHash && owner.processHostHash !== currentProcessSpaceHash())
      || launches.some(event => event.payload?.targetKind === "remote"
        || (event.payload?.hostname && event.payload.hostname !== hostname()));
    if (foreignOwner || !await noLocalRunnerProcessesForRuns(unidentifiedLocalOwners)) { gone = false; unavailable = true; }
  }
  // Only the settlement owner can say it is starting fresh: a newer run or a
  // person-owned gate may still make a positive physical proof inapplicable.
  await effects?.record(gone ? "gone" : !waitingTurn && unavailable ? "unavailable" : "waiting");
  if (!gone) await effects?.notice(waitingTurn ? turnWaitingNote(run)
    : unavailable ? FRESH_THREAD_STOP_UNAVAILABLE_NOTE : FRESH_THREAD_STOPPING_NOTE);
  return { gone, reason: gone ? "previous_execution_gone" : waitingTurn ? "active_provider_turn" : "previous_execution_stop_unconfirmed", noticeAuthorizationReason };
}
