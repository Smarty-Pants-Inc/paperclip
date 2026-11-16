import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { agents, environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { nativeStartupNeverConnectedExhausted, nativeStartupNeverConnectedFreshRunNote } from "../continuation-cause.js";
import { hasBoundRemoteStopReceipt, hasRemoteTerminationReceipt, resolveRemoteTerminationLease } from "../remote-execution-termination.js";
import { hasConfirmedSandboxStopAndRetain, hasRestoredEndedLeaseStopReceipt, readStopOnlyCleanup, SANDBOX_ALLOCATION_HOLDER_STATUSES } from "../sandbox-stop-and-retain.js";
import { noLocalRunnerProcessesForRuns, proveRunProcessGone } from "../run-process-owner.js";
import { retiredReusableLeasePredecessors } from "../environment-lease-handoff.js";
import { freshThreadRefusalCode, FRESH_THREAD_STOP_STATE_KEY } from "./runner-reconciliation-refusal.js";
import { PENDING_CLEANUP_SWEEP_ATTEMPT_CAP } from "../environment-cleanup-state.js";
import { isBuiltinSandboxProvider } from "../sandbox-provider-runtime.js";
import { currentProcessSpaceHash } from "../controller-process-identity.js";
import { hostname } from "node:os";
import { isInstructionRefreshPrepareCode } from "../../vendor/paperclip-runner/index.js";

export const FRESH_THREAD_STARTED_NOTE = "The earlier provider thread could not be safely restored. Starting a fresh thread in this conversation from its saved history. Earlier actions with unknown outcomes are not confirmed or replayed.";

/** Only the typed instruction/skill refresh may claim the change took effect.
 * Environment loss and launch mismatch retain the generic truthful notice. */
export async function freshThreadStartedNote(db: Pick<Db, "select">, run: typeof heartbeatRuns.$inferSelect): Promise<string> {
  const refusal = run.resultJson?.nativeFreshContinuationRefusal as { code?: unknown; prepareRefusalCode?: unknown } | undefined;
  const code = freshThreadRefusalCode({ code: run.errorCode }) ?? freshThreadRefusalCode(refusal);
  // Only the Runner's typed instruction-refresh channel proves a skill change.
  // Generic prepare refusal and unrelated specific prepare refusals stay neutral.
  if (code !== "native_runner_refresh_required"
    || (refusal?.prepareRefusalCode != null
      && !isInstructionRefreshPrepareCode(refusal.prepareRefusalCode))) {
    // A first start whose Runner never connected had no provider thread: its
    // continuation says so plainly instead of narrating a restore (r104c).
    const [coordinator] = await db.select({ phase: nativeRunFinalizations.phase, attempt: nativeRunFinalizations.attempt,
      failureCode: nativeRunFinalizations.failureCode, failureDetail: nativeRunFinalizations.failureDetail })
      .from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, run.companyId),
        eq(nativeRunFinalizations.runId, run.id))).limit(1);
    return nativeStartupNeverConnectedExhausted(coordinator)
      ? nativeStartupNeverConnectedFreshRunNote(coordinator!.attempt) : FRESH_THREAD_STARTED_NOTE;
  }
  const [agent] = await db.select({ name: agents.name }).from(agents).where(and(
    eq(agents.companyId, run.companyId), eq(agents.id, run.agentId))).limit(1);
  return `your skill change is in effect; ${agent?.name ?? "the agent"} restarted its working thread to pick it up. The fresh thread in this conversation reads its saved history. Earlier actions with unknown outcomes are not confirmed or replayed.`;
}

type ProofReader = Pick<Db, "select" | "selectDistinctOn">;
/** The proof predicate has only read capabilities. Session-boundary consumers
 * cannot narrate a restart, enqueue cleanup, or alter a lease while reading. */
export function readFreshThreadStopProof(db: ProofReader, run: typeof heartbeatRuns.$inferSelect, issueId: string) {
  return inspectFreshThreadStopProof(db, run, issueId);
}

async function inspectFreshThreadStopProof(tx: ProofReader, run: typeof heartbeatRuns.$inferSelect, issueId: string) {
  const sessionId = run.nativeSessionId;
  const owners = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.agentId, run.agentId),
    or(eq(heartbeatRuns.nativeIssueId, issueId), eq(heartbeatRuns.issueId, issueId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`),
    sessionId ? eq(heartbeatRuns.nativeSessionId, sessionId) : undefined,
    sql`${heartbeatRuns.createdAt} <= (select created_at from ${heartbeatRuns} where id = ${run.id})`));
  // Legacy rows may bind their issue only through issueId/contextSnapshot.
  // Never lose the contender's recorded local process from the owner proof.
  if (!owners.some(owner => owner.id === run.id)) owners.push(run);
  // Evaluate physical evidence even for an observed owner stranded as running.
  // Its settlement owner must still retire that claim; a genuinely live turn
  // keeps its authority and must never receive a stop request from this gate.
  const activeTurn = owners.some(owner => owner.id !== run.id && ["running", "queued", "scheduled_retry"].includes(owner.status));
  const turnRefusal = run.resultJson?.nativeFreshContinuationRefusal as { waitForTurn?: unknown } | undefined;
  const waitingTurn = activeTurn || (turnRefusal?.waitForTurn === true && !owners.some(owner => owner.id !== run.id
    && owner.finishedAt && run.finishedAt && owner.finishedAt > run.finishedAt));
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
    // The stop owner accepts legacy bound receipts without confirmedAt. A
    // retain-dispatch receipt is a stronger file-retention promise, not a
    // prerequisite for physical stop. Explicitly invalid dates still refuse.
    const confirmedRelease = hasRemoteTerminationReceipt(lease)
      && (termination?.confirmedAt === undefined || (Number.isFinite(confirmedAt)
        && confirmedAt >= lease.acquiredAt.getTime() && lease.releasedAt !== null && confirmedAt <= lease.releasedAt.getTime()))
      && lease.metadata?.pendingCleanupInFlight !== true;
    if (hasConfirmedSandboxStopAndRetain(lease) || confirmedRelease || hasRestoredEndedLeaseStopReceipt(lease)) continue;
    gone = false;
    // Even an inadmissible ended receipt is immutable evidence, not permission
    // to erase it and launch a new stop request.
    if (["released", "expired"].includes(lease.status)) {
      // Missing/unbound proof waits for the outside-lock provider read first.
      // A bound but inadmissible receipt (for example bad-time) stays immutable
      // and unavailable; never erase it to re-arm a stop.
      const previousState = owners.find(owner => owner.id === run.id)?.resultJson?.[FRESH_THREAD_STOP_STATE_KEY] as { state?: unknown } | undefined;
      if (hasBoundRemoteStopReceipt(lease) || previousState?.state === "unavailable"
        || lease.metadata?.pluginId == null && !isBuiltinSandboxProvider(lease.provider!)) unavailable = true;
      continue;
    }
    // Cleanup's plugin release contract supplies the independently bound
    // stopped/destroyed receipt. A void release, 'stopping', expired lease, or
    // successful RPC is NOT evidence. This reader never requests a stop.
    const exhausted = Number(lease.metadata?.pendingCleanupRetryAttempts ?? 0) >= PENDING_CLEANUP_SWEEP_ATTEMPT_CAP;
    if (!readStopOnlyCleanup(lease) && lease.metadata?.pendingCleanupInFlight !== true
      && lease.metadata?.pluginId == null && !isBuiltinSandboxProvider(lease.provider!)) unavailable = true;
    if (exhausted) unavailable = true;
  }
  // Classify from durable execution evidence before consulting this host's
  // process table. A persisted remote target with a missing/mismatched lease is
  // still unproven; controller-local absence says nothing about that allocation.
  // Read EVERY launch/identity event: a later identity-only event must never
  // erase an earlier remote target. Location is classified before PID proof.
  const launches = await tx.select({ runId: heartbeatRunEvents.runId, payload: heartbeatRunEvents.payload })
    .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, run.companyId),
      inArray(heartbeatRunEvents.runId, owners.map(owner => owner.id)), isNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, ["native.process_start_requested", "native.process_identity_recorded"])));
  const unidentifiedLocalOwners: string[] = [];
  for (const owner of owners) {
    const remoteWorkspace = owner.runnerProfileJson?.remoteWorkspace as Record<string, unknown> | undefined;
    const remoteProviderLeaseId = typeof remoteWorkspace?.providerLeaseId === "string"
      ? remoteWorkspace.providerLeaseId : null;
    // Any present remote workspace (complete or not, any schema) or any remote
    // target event means NOT local: only allocation-bound proof may apply.
    const hasRemoteProfile = remoteWorkspace != null || launches.some(event => event.runId === owner.id
      && event.payload?.targetKind === "remote");
    const hasRemoteAllocation = leases.some(lease => lease.heartbeatRunId === owner.id
      && lease.provider && lease.provider !== "local" && lease.providerLeaseId
      && (!remoteProviderLeaseId || lease.providerLeaseId === remoteProviderLeaseId));
    if (hasRemoteProfile && !hasRemoteAllocation) { gone = false; unavailable = true; continue; }
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
    // A local OS read cannot establish absence on another host/allocation.
    const foreignOwner = owners.some(owner => unidentifiedLocalOwners.includes(owner.id)
      && owner.processHostHash && owner.processHostHash !== currentProcessSpaceHash())
      || launches.some(event => unidentifiedLocalOwners.includes(event.runId)
        && event.payload?.hostname && event.payload.hostname !== hostname());
    if (foreignOwner || !await noLocalRunnerProcessesForRuns(unidentifiedLocalOwners)) { gone = false; unavailable = true; }
  }
  if (activeTurn) gone = false; // settlement, not a read, retires the old claim
  return { gone, reason: gone ? "previous_execution_gone" : waitingTurn ? "active_provider_turn" : "previous_execution_stop_unconfirmed", unavailable };
}
