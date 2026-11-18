import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { retiredReusableLeasePredecessors } from "./environment-lease-handoff.js";
import { OWN_PROCESS_START_EVENT_TYPES } from "./native-process-start-events.js";
import { NEVER_REUSE_SCOPE } from "./never-reuse-scope.js";

type Lease = typeof environmentLeases.$inferSelect;

type LeaseIdentity = {
  id: string; companyId: string; heartbeatRunId: string | null;
  provider: string | null; providerLeaseId: string | null;
};

/** Bind a provider receipt to the exact host-owned lease and run. Old plugins
 * return void; that remains supported but grants no continuation authority. */
export function remoteTerminationReceipt(lease: LeaseIdentity, value: unknown, probeLeaseId?: string | null) {
  const receipt = value as { providerLeaseId?: unknown; state?: unknown } | null;
  // A setup probe's lease has no run. It binds only when the probe's holder
  // names that exact lease id; no run-keyed reader can ever select it.
  const probe = !lease.heartbeatRunId && !!probeLeaseId && probeLeaseId === lease.id;
  if ((!lease.heartbeatRunId && !probe) || !lease.provider || lease.provider === "local" ||
      !lease.providerLeaseId || receipt?.providerLeaseId !== lease.providerLeaseId ||
      !["stopped", "destroyed"].includes(String(receipt?.state))) return undefined;
  return {
    schema: "paperclip.remote-termination.v1", companyId: lease.companyId,
    runId: lease.heartbeatRunId, leaseId: lease.id, provider: lease.provider,
    providerLeaseId: lease.providerLeaseId, state: receipt!.state,
    confirmedAt: new Date().toISOString(),
  };
}

/** Boat (docs.boat.dev/snapshots/stop.md, "Resume within 10 minutes"): after
 * 10 minutes stopped, a resume always starts a new machine from the snapshot.
 * Core requires 15. (Re-exported by native-session-executor.ts.) */
export const PREDECESSOR_LONG_STOP_MS = 15 * 60_000;

/** P's run statuses that keep its box fenced (B): a person's Stop
 * (cancelled), a failure (failed, timed_out) or an interruption. A succeeded
 * run finished its work: its successor's ordinary warm reuse stays allowed. */
export const RESUME_FENCED_PREDECESSOR_RUN_STATUSES: ReadonlySet<string> =
  new Set(["cancelled", "failed", "timed_out", "interrupted"]);

/** P's run as the fence reads it: its status and who cancelled it. */
export type ResumeFencePredecessorRun = { status: string; cancelledByActorType: string | null };

/** Whether a PERSON stopped P: status 'cancelled' with the Stop route's
 * attribution. routes/agents.ts POST /heartbeat-runs/:runId/cancel passes
 * resultJson.cancelledByActorType "user" (a managing agent's Stop passes
 * "agent" with errorCode operator_interrupted); cancelRun merges it into the
 * run (run-control.ts runCancellationFenceSql). Recovery reads a person's Stop
 * the same way, "user" or "board" (recovery/service.ts). The errorCode alone
 * ('cancelled', run-control.ts cancelRun) is not a person's mark: the control
 * plane's own cancels write it too. */
export function personStoppedRun(run: ResumeFencePredecessorRun | null | undefined): boolean {
  return run?.status === "cancelled" && (run.cancelledByActorType === "user" || run.cancelledByActorType === "board");
}

/** Whether P's ending is inside NEVER_REUSE_SCOPE (never-reuse-scope.ts, the
 * one switch): no other run ever resumes its box, no window. */
export function neverReusedAfter(run: ResumeFencePredecessorRun | null | undefined): boolean {
  if (!run || !RESUME_FENCED_PREDECESSOR_RUN_STATUSES.has(run.status)) return false;
  return NEVER_REUSE_SCOPE === "not_succeeded" || personStoppedRun(run);
}

/** B1 (fence a, the judges' joint line, smarty-dev#4605 comment 6992985316):
 * a released lease whose typed termination receipt is "stopped" or
 * "destroyed" (alike, as ownLeaseTerminated reads them) may still hold its
 * run P's provider and tool processes in memory: a short-stopped box resumes
 * with memory and processes alive (environment-execution-target.ts, Boat's
 * memory window). When (B) P's run (the lease's heartbeatRunId) ended NOT
 * succeeded, NO other run may resume that box, whoever it is (the same
 * conversation's later run too):
 * - P's ending inside NEVER_REUSE_SCOPE (neverReusedAfter; default
 *   "person_stop": P stopped by a PERSON, personStoppedRun; "not_succeeded":
 *   every not-succeeded ending): never, no window (org purple cut (2),
 *   2026-11-18 23:11Z: never reuse the fenced box);
 * - any other not-succeeded ending: until PREDECESSOR_LONG_STOP_MS after the
 *   receipt was confirmed (RFL). Window-only: c1 records no typed,
 *   lease-bound proof that the Runner was gone before the box froze.
 * Only P's own run is exempt. `predecessorRun` is P's run as the caller read
 * it (selection reads all candidates' runs in one query:
 * loadResumeFencePredecessorRuns). Selection (reusableLeaseCanBeResumed) and
 * the handoff (environments acquireLease replacesReusableLeaseId) both use
 * this one predicate. */
export function stoppedReceiptFencesOtherRunResume(input: {
  lease: { heartbeatRunId: string | null; metadata: Record<string, unknown> | null };
  heartbeatRunId: string | null;
  predecessorRun: ResumeFencePredecessorRun | null | undefined;
  now?: number;
}): boolean {
  if (input.heartbeatRunId !== null && input.lease.heartbeatRunId === input.heartbeatRunId) return false;
  if (!hasResumeFenceReceipt(input.lease)) return false;
  // (B) only a run that did not succeed.
  if (!input.predecessorRun || !RESUME_FENCED_PREDECESSOR_RUN_STATUSES.has(input.predecessorRun.status)) return false;
  // Inside NEVER_REUSE_SCOPE (a person's Stop; under "not_succeeded" every
  // not-succeeded ending): never, at any age.
  if (neverReusedAfter(input.predecessorRun)) return true;
  const receipt = input.lease.metadata!.remoteExecutionTermination as { confirmedAt?: unknown };
  const confirmedAt = typeof receipt.confirmedAt === "string" ? Date.parse(receipt.confirmedAt) : Number.NaN;
  // A receipt without a readable confirmation time proves no window ended.
  if (!Number.isFinite(confirmedAt)) return true;
  return (input.now ?? Date.now()) < confirmedAt + PREDECESSOR_LONG_STOP_MS;
}

/** Whether a lease carries a receipt the B1 fence reads. */
export function hasResumeFenceReceipt(lease: { metadata: Record<string, unknown> | null }): boolean {
  const state = (lease.metadata?.remoteExecutionTermination as { state?: unknown } | undefined)?.state;
  return state === "stopped" || state === "destroyed";
}

/** The fence's columns of P's run: its status and only the attribution field
 * of resultJson (not the whole document). */
export const resumeFencePredecessorRunColumns = {
  status: heartbeatRuns.status,
  cancelledByActorType: sql<string | null>`${heartbeatRuns.resultJson}->>'cancelledByActorType'`,
};

/** P's run for every candidate lease that carries a fence receipt, in ONE
 * query (no round trip per candidate). Keyed by run id. */
export async function loadResumeFencePredecessorRuns(
  db: Db,
  leases: ReadonlyArray<{ companyId: string; heartbeatRunId: string | null; metadata: Record<string, unknown> | null }>,
): Promise<Map<string, ResumeFencePredecessorRun>> {
  const runIds = [...new Set(leases.filter(hasResumeFenceReceipt).flatMap(lease => lease.heartbeatRunId ? [lease.heartbeatRunId] : []))];
  if (runIds.length === 0) return new Map();
  const rows = await db.select({ id: heartbeatRuns.id, ...resumeFencePredecessorRunColumns }).from(heartbeatRuns)
    .where(inArray(heartbeatRuns.id, runIds));
  return new Map(rows.map(({ id, ...run }) => [id, run]));
}

type ReceiptLease = LeaseIdentity & {
  releasedAt: unknown; cleanupStatus: string | null; status: string;
  metadata: Record<string, unknown> | null;
};

/** The lease carries a provider stop receipt bound to its exact company, run,
 * lease, provider and physical task. It proves execution there stopped, not
 * that the lease's resources were released. */
export function hasBoundRemoteStopReceipt(lease: Pick<ReceiptLease, keyof LeaseIdentity | "metadata">): boolean {
  return boundStopReceipt(lease);
}
function boundStopReceipt(lease: Pick<ReceiptLease, keyof LeaseIdentity | "metadata">, probeLeaseId?: string): boolean {
  const receipt = lease.metadata?.remoteExecutionTermination as Record<string, unknown> | undefined;
  return Boolean(receipt && receipt.schema === "paperclip.remote-termination.v1" &&
    receipt.companyId === lease.companyId && receipt.runId === lease.heartbeatRunId &&
    receipt.leaseId === lease.id && receipt.provider === lease.provider &&
    remoteTerminationReceipt(lease, receipt, probeLeaseId));
}

/** The lease was released with successful cleanup and its bound stop receipt.
 * Resource cleanup gates use this; it never accepts an unreleased lease. */
export function hasRemoteTerminationReceipt(lease: ReceiptLease): boolean {
  return terminationReceipt(lease);
}
function terminationReceipt(lease: ReceiptLease, probeLeaseId?: string): boolean {
  return Boolean(lease.releasedAt && lease.cleanupStatus === "success" &&
    ["released", "expired", "failed"].includes(lease.status) && boundStopReceipt(lease, probeLeaseId));
}

/** The owner of a remote session: a run's lease (I, S), or a setup probe's
 * exact lease (H: no run, its leaseId held by the verifier). */
export type RemoteLeaseOwner = {
  companyId: string; environmentId: string | null | undefined; providerLeaseId: string | null | undefined;
  runId: string | null; leaseId?: string;
};

/** Boat's typed teardown receipt on the owner's lease: "destroyed" proves the
 * owner gone anywhere; "stopped" on the owner's own lease proves it only when
 * the successor is not on that same sandbox. With ownLeaseOnly (the retirement
 * path), "destroyed" too counts only on the owner's own lease: a destroy
 * receipt on another lease of the same box (an earlier lifecycle of a box
 * since resumed) never proves the current owner gone. "Own" is the owner run's
 * lease, or the probe's exact lease id. No error code or text is ever proof. */
export async function ownLeaseTerminated(db: Db, owner: RemoteLeaseOwner,
  scope: { successorOnOwnerSandbox?: boolean; ownLeaseOnly?: boolean } = {}): Promise<boolean> {
  if (!owner.providerLeaseId || !owner.environmentId) return false;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, owner.companyId),
    eq(environmentLeases.environmentId, owner.environmentId),
    eq(environmentLeases.providerLeaseId, owner.providerLeaseId),
  ));
  const resolved = await Promise.all(leases.map(lease => resolveRemoteTerminationLease(db, lease)));
  // Under ownLeaseOnly a run's EARLIER lease of this box (run -> other -> same
  // run) is an earlier lifecycle: only the run's latest lease here is its own.
  const ownRun = (lease: Lease) => owner.runId !== null && lease.heartbeatRunId === owner.runId;
  const runLeases = leases.filter(ownRun);
  const earlierOwn = (lease: Lease) => runLeases.length > 1 && runLeases.some(other => other.id !== lease.id &&
    other.acquiredAt.getTime() > lease.acquiredAt.getTime());
  // B1: a receipt says the box stopped at confirmedAt, not that it stayed
  // stopped. Another holder's lease on this box acquired at or after then, or
  // still open, may have resumed it (and the owner's runner with it). Boat's
  // driver is not in this tree, so nothing shows a destroyed allocation id is
  // never reused: the same rule holds for "destroyed".
  const otherHolder = (lease: Lease) => !ownRun(lease) && !(owner.leaseId !== undefined && lease.id === owner.leaseId);
  // The receipt's own lease is the one that stopped, never a resume of it.
  const resumedSince = (receiptLease: Lease, confirmedAt: unknown) => {
    const confirmed = typeof confirmedAt === "string" ? Date.parse(confirmedAt) : NaN;
    return leases.some(other => other.id !== receiptLease.id && otherHolder(other) && (!other.releasedAt
      || !Number.isFinite(confirmed) || other.acquiredAt.getTime() >= confirmed));
  };
  return resolved.some(lease => {
    if (!terminationReceipt(lease, owner.leaseId)) return false;
    const receipt = lease.metadata?.remoteExecutionTermination as { state?: unknown; confirmedAt?: unknown } | undefined;
    if (resumedSince(lease, receipt?.confirmedAt)) return false;
    const state = receipt?.state;
    const ownLease = (ownRun(lease) && !(scope.ownLeaseOnly === true && earlierOwn(lease)))
      || (owner.leaseId !== undefined && lease.id === owner.leaseId);
    return (state === "destroyed" && (ownLease || scope.ownLeaseOnly !== true))
      || (state === "stopped" && ownLease && scope.successorOnOwnerSandbox !== true);
  });
}

/** Release or destroy of this lease has started: plugin release and destroy
 * record their cleanup method first, and task settlement, startup cleanup and
 * interrupted-creation cleanup mark the task retiring. The provider can then be
 * releasing the task's resources while the lease row is still active. */
function leaseReleaseStarted(lease: Pick<ReceiptLease, "metadata">): boolean {
  return lease.metadata?.pluginLeaseCleanupMethod !== undefined || lease.metadata?.runnerTaskRetiring === true;
}

/** Execution on this lease has stopped: it was released with its termination
 * receipt, or it is still active, its release has not started, and its plugin
 * task recorded the provider's stop when it settled. Release can be held long
 * after that stop (for example by a pending workspace export); once release
 * starts, it owns the receipt until the lease is released. */
function remoteLeaseExecutionStopped(lease: ReceiptLease): boolean {
  return hasRemoteTerminationReceipt(lease) ||
    lease.status === "active" && !lease.releasedAt && !leaseReleaseStarted(lease) && hasBoundRemoteStopReceipt(lease);
}

/** Workspace recovery saved this run's files, re-stopped its sandbox, and then
 * queued the stopped sandbox for destroy. The destroy is resource cleanup: the
 * stop receipt it carried forward still proves no provider can run there. */
export function hasRecoveredCleanupStopReceipt(lease: LeaseIdentity & {
  releasedAt: unknown; status: string; metadata: Record<string, unknown> | null;
}): boolean {
  const cleanup = lease.metadata?.workspaceRecoveryCleanup as Record<string, unknown> | undefined;
  if (!cleanup || cleanup.runId !== lease.heartbeatRunId || !lease.releasedAt ||
      !["pending_cleanup", "released", "expired", "failed"].includes(lease.status)) return false;
  return hasRemoteTerminationReceipt({ ...lease, status: "released", cleanupStatus: "success",
    metadata: { remoteExecutionTermination: cleanup.stopReceipt } });
}

export function remoteLeaseCleanupScope(lease: Pick<LeaseIdentity, "provider" | "providerLeaseId">) {
  return lease.provider && lease.provider !== "local" && lease.providerLeaseId
    ? JSON.stringify([lease.provider, lease.providerLeaseId]) : undefined;
}

export async function resolveRemoteTerminationLease(db: Pick<Db, "select">, lease: Lease): Promise<Lease> {
  if (hasRemoteTerminationReceipt(lease) || lease.status !== "expired" ||
      lease.leasePolicy !== "reuse_by_environment" || !lease.provider || !lease.providerLeaseId) return lease;
  const history = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.provider, lease.provider), eq(environmentLeases.providerLeaseId, lease.providerLeaseId),
  ));
  const current = history.find(row => row.id === lease.id);
  if (!current || current.companyId !== lease.companyId || current.heartbeatRunId !== lease.heartbeatRunId) return lease;
  const tips = history.filter(row => !Object.hasOwn(row.metadata ?? {}, "reusableLeaseSuccessor"));
  if (tips.length !== 1) return current;
  const tip = tips[0]!;
  const receipt = tip.metadata?.remoteExecutionTermination as Record<string, unknown> | undefined;
  if (!hasRemoteTerminationReceipt(tip) || receipt?.state !== "destroyed") return current;
  const predecessors = retiredReusableLeasePredecessors(tip, history.filter(row => row.id !== tip.id));
  if (!predecessors?.some(row => row.id === current.id)) return current;
  const termination = remoteTerminationReceipt(current, { providerLeaseId: current.providerLeaseId, state: "destroyed" });
  if (!termination) return current;
  return { ...current, metadata: { ...current.metadata, remoteExecutionTermination: {
    ...termination, confirmedAt: receipt.confirmedAt,
  } } };
}

async function runRemoteLeases(db: Db, companyId: string, runId: string) {
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, runId),
  ));
  return Promise.all(leases.map(lease => resolveRemoteTerminationLease(db, lease)));
}

/** Cleanup scopes of a run whose every lease has stopped execution, or null. */
export async function stoppedRemoteCleanupScopes(db: Db, companyId: string, runId: string) {
  const leases = await runRemoteLeases(db, companyId, runId);
  if (leases.length === 0 || !leases.every(remoteLeaseExecutionStopped)) return null;
  return [...new Set(leases.map(lease => remoteLeaseCleanupScope(lease)!))];
}

/** Every lease of the run has stopped execution. Its resources can still be held. */
export async function remoteExecutionHasStopped(db: Db, companyId: string, runId: string, after?: Date) {
  if (!after) return await stoppedRemoteCleanupScopes(db, companyId, runId) !== null;
  const leases = await runRemoteLeases(db, companyId, runId);
  const [launch] = await db.select({ createdAt: heartbeatRunEvents.createdAt }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, runId),
    isNull(heartbeatRunEvents.sourceEventId), inArray(heartbeatRunEvents.eventType, [...OWN_PROCESS_START_EVENT_TYPES]),
  )).orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  // A bound receipt for an old lease/process generation cannot settle a later
  // failure or launch. Keep the normal cleanup contract unchanged for callers
  // that do not need this stronger admission proof.
  const now = Date.now();
  return leases.length > 0 && leases.every(lease => {
    // Workspace export may carry the same bound stop into pending destroy;
    // that cleanup is not a new running process.
    const recovered = hasRecoveredCleanupStopReceipt(lease);
    const receipt = (recovered
      ? (lease.metadata?.workspaceRecoveryCleanup as Record<string, unknown>).stopReceipt
      : lease.metadata?.remoteExecutionTermination) as { confirmedAt?: unknown } | undefined;
    const confirmedAt = typeof receipt?.confirmedAt === "string" ? Date.parse(receipt.confirmedAt) : NaN;
    return (remoteLeaseExecutionStopped(lease) || recovered) && Number.isFinite(confirmedAt) && confirmedAt > after.getTime()
      && confirmedAt >= lease.acquiredAt.getTime() && confirmedAt <= now
      && (!launch || confirmedAt > launch.createdAt.getTime());
  });
}

/** Every lease of the run was released with its termination receipt. */
export async function remoteExecutionHasReleased(db: Db, companyId: string, runId: string) {
  const leases = await runRemoteLeases(db, companyId, runId);
  return leases.length > 0 && leases.every(hasRemoteTerminationReceipt);
}
