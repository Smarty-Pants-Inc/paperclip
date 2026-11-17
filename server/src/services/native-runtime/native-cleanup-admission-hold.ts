import { and, desc, eq, inArray } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { issueService } from "../issues.js";
import { NATIVE_CLEANUP_SETTLING_MESSAGE } from "./completed-turn-cleanup.js";
import { completeTerminatedRemoteNativeSessionCleanup, completeTerminatedRemoteNativeSessionCleanupForTask,
  nativeSessionCleanupBlock, nativeSessionCleanupGateOwners, nativeSessionCleanupRemoteScopes }
  from "../../vendor/paperclip-runner/index.js";
import { logger } from "../../middleware/logger.js";
import { hasBoundRemoteStopReceipt, remoteLeaseCleanupScope, stoppedRemoteCleanupScopes, terminatedRemoteCleanupScope } from "../remote-execution-termination.js";
import { prepareCleanupGateOwnerStop, SANDBOX_ALLOCATION_HOLDER_STATUSES } from "../sandbox-stop-and-retain.js";

type CleanupGateOwner = ReturnType<typeof nativeSessionCleanupGateOwners>[number];
const ENDED_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

/** Cause of a queued run held by its task's previous native session cleanup:
 * the run event, the admission log reason and the execution projection. */
export const NATIVE_CLEANUP_HOLD_CAUSE = "native_session_cleanup_settling";
/** The held run's next action. Only a confirmed stop releases the hold. */
export const NATIVE_CLEANUP_HOLD_NEXT_ACTION =
  "This turn starts when the old Runner is confirmed stopped. Paperclip is stopping it and keeps its files.";

/**
 * The first time admission holds this queued run behind its task's cleanup
 * gate, append one named run event and one plain system comment on the task
 * thread, which every requester (person, agent, manager) reads with the
 * task's comments. Both are written once, together. The comment goes through
 * the issue service directly, not the comment route, so it wakes nobody
 * (only the route wakes the assignee); it creates no run. The run stays
 * queued and admission still decides when it starts. Later holds add nothing.
 */
export async function recordNativeCleanupHold(db: Db, input: {
  run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId">;
  issueId: string;
  cleanupBlock: "pending" | "operator_required";
}): Promise<boolean> {
  const { run, issueId, cleanupBlock } = input;
  return db.transaction(async tx => {
    const [current] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.status, "queued"),
    )).for("update");
    if (!current) return false;
    const [recorded] = await tx.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, NATIVE_CLEANUP_HOLD_CAUSE),
    )).limit(1);
    if (recorded) return false;
    await appendHeartbeatRunEvent(tx as unknown as Db, {
      companyId: run.companyId, runId: run.id, agentId: run.agentId,
      eventType: NATIVE_CLEANUP_HOLD_CAUSE, stream: "system", level: "warn",
      message: NATIVE_CLEANUP_HOLD_NEXT_ACTION,
      payload: { reason: NATIVE_CLEANUP_HOLD_CAUSE, cleanupBlock, issueId },
    });
    await issueService(db).addComment(issueId, `${NATIVE_CLEANUP_SETTLING_MESSAGE} ${NATIVE_CLEANUP_HOLD_NEXT_ACTION}`, {},
      { authorType: "system", metadata: { version: 1, sourceRunId: run.id,
        authorizationReason: `${NATIVE_CLEANUP_HOLD_CAUSE}:${run.id}`,
        sections: [{ rows: [{ type: "run_link", runId: run.id, agentId: run.agentId, title: "Held turn" }] }] } }, tx);
    return true;
  });
}

/**
 * Admission's own predicate, read-only: the task's in-process session cleanup
 * gate exactly as queue admission reads it. Readers such as the execution
 * projection use this; it never retires a gate or requests a stop.
 */
export function nativeCleanupAdmissionBlock(input: { companyId: string; issueId: string }) {
  return nativeSessionCleanupBlock(input);
}

async function retireTerminatedRemoteCleanup(db: Db, input: { companyId: string; issueId: string }) {
  for (const remoteCleanupScope of nativeSessionCleanupRemoteScopes(input)) {
    const lease = await terminatedRemoteCleanupScope(db, input.companyId, remoteCleanupScope).catch(() => null);
    if (!lease) continue;
    const retired = completeTerminatedRemoteNativeSessionCleanupForTask({ ...input, remoteCleanupScope });
    if (retired === 0) continue;
    logger.warn({ companyId: input.companyId, issueId: input.issueId, leaseId: lease.id, runId: lease.heartbeatRunId,
      provider: lease.provider, providerLeaseId: lease.providerLeaseId, retired },
    "native session cleanup retired because its sandbox is confirmed terminated");
    if (!lease.heartbeatRunId) continue;
    const [run] = await db.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, lease.heartbeatRunId)))
      .limit(1).catch(() => []);
    if (!run) continue;
    await appendHeartbeatRunEvent(db, {
      companyId: input.companyId, runId: lease.heartbeatRunId, agentId: run.agentId,
      eventType: "native.session_cleanup_gate_retired", stream: "system", level: "info",
      message: "The task's previous sandbox is confirmed terminated, so its session cleanup gate was retired.",
      payload: { leaseId: lease.id, provider: lease.provider, providerLeaseId: lease.providerLeaseId,
        termination: lease.metadata?.remoteExecutionTermination ?? null, retired },
    }).catch(() => undefined);
  }
}

export async function nativeCleanupHoldsAdmission(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<"pending" | "operator_required" | null> {
  let block = nativeSessionCleanupBlock(input);
  if (block === null) return null;
  await retireTerminatedRemoteCleanup(db, input);
  block = nativeSessionCleanupBlock(input);
  if (block === "operator_required") {
    const { retireStoppedSessionCleanupGates } = await import("./native-session-executor.js");
    await retireStoppedSessionCleanupGates(db, input).catch(() => false);
    for (const owner of nativeSessionCleanupGateOwners(input)) {
      if (nativeSessionCleanupBlock(input) !== "operator_required") break;
      await settleRemoteCleanupGateOwner(db, input, owner).catch((err: unknown) =>
        logger.warn({ err, companyId: input.companyId, issueId: input.issueId, ownerRunId: owner.runId },
          "could not request the stop of a native session cleanup gate owner; the next admission retries"));
    }
    block = nativeSessionCleanupBlock(input);
  }
  return block;
}

/**
 * An operator-required gate whose owner ran on a remote Runner cannot be
 * proven stopped from host process IDs, and waiting never settles it (#20806).
 * Bind the gate's exact owner to its ended run on the same company and task,
 * and to the provider allocation (sandbox) its session ran in. The allocation
 * is held by the owner's own lease, or, after a warm reuse, by the newest
 * lease of the same allocation for a later run of the same task. Then:
 * - retire the owner only when that allocation carries a confirmed provider
 *   stop: the owner's own leases (the Stop path's stoppedRemoteCleanupScopes
 *   + completeTerminatedRemoteNativeSessionCleanup), or the bound stop
 *   receipt of the allocation's newest lease. Never on elapsed time.
 * - otherwise hand that sandbox to the existing stop-and-retain cleanup, whose
 *   sweep dispatches the provider stop outside admission, retries it and
 *   records the bound receipt. The sandbox and its files are kept, never
 *   destroyed; the settle's cleanup write re-dispatches the held run, whose
 *   admission then reads the receipt here.
 * A sandbox held by more than one lease, by another company or task, or by a
 * run that has not ended is never stopped from here, and a release or stop
 * already in progress keeps its owner.
 */
async function settleRemoteCleanupGateOwner(
  db: Db,
  input: { companyId: string; issueId: string },
  owner: CleanupGateOwner,
): Promise<void> {
  if (!owner.remoteCleanupScope || owner.companyId !== input.companyId || owner.issueId !== input.issueId) return;
  if (!await endedRunOfTask(db, owner.companyId, owner.runId, input.issueId)) return;

  const scopes = await stoppedRemoteCleanupScopes(db, owner.companyId, owner.runId);
  if (scopes?.includes(owner.remoteCleanupScope)) {
    completeTerminatedRemoteNativeSessionCleanup({ companyId: owner.companyId, runId: owner.runId,
      remoteCleanupScope: owner.remoteCleanupScope });
    return;
  }

  let provider: unknown, providerLeaseId: unknown;
  try {
    [provider, providerLeaseId] = JSON.parse(owner.remoteCleanupScope) as unknown[];
  } catch {
    return;
  }
  if (typeof provider !== "string" || provider === "local" || typeof providerLeaseId !== "string") return;
  const allocation = and(eq(environmentLeases.provider, provider), eq(environmentLeases.providerLeaseId, providerLeaseId));
  const rows = await db.select().from(environmentLeases).where(allocation)
    .orderBy(desc(environmentLeases.createdAt), desc(environmentLeases.id));
  const ownRows = rows.filter(row => row.heartbeatRunId === owner.runId);
  const tip = rows[0];
  // The owner must have run in this allocation, and every row of it must be
  // this company's: a foreign or unknown allocation is never touched.
  if (!tip || ownRows.length === 0 || rows.some(row => row.companyId !== owner.companyId)
    || remoteLeaseCleanupScope(tip) !== owner.remoteCleanupScope || !tip.heartbeatRunId
    || tip.createdAt < ownRows[ownRows.length - 1]!.createdAt) return;
  const successor = tip.heartbeatRunId !== owner.runId;
  if (successor && !await endedRunOfTask(db, owner.companyId, tip.heartbeatRunId, input.issueId)) return;
  if (successor) {
    // The allocation's newest lease, for a later ended run of the same task,
    // carries the provider's stop of this exact sandbox.
    const tipScopes = await stoppedRemoteCleanupScopes(db, owner.companyId, tip.heartbeatRunId);
    if (tipScopes?.includes(owner.remoteCleanupScope) && hasBoundRemoteStopReceipt(tip)) {
      completeTerminatedRemoteNativeSessionCleanup({ companyId: owner.companyId, runId: owner.runId,
        remoteCleanupScope: owner.remoteCleanupScope });
      return;
    }
  }
  await db.transaction(async tx => {
    const holders = await tx.select().from(environmentLeases).where(and(allocation,
      inArray(environmentLeases.status, [...SANDBOX_ALLOCATION_HOLDER_STATUSES]))).for("update");
    const lease = holders[0];
    if (holders.length !== 1 || !lease || lease.id !== tip.id || lease.companyId !== owner.companyId
      || lease.heartbeatRunId !== tip.heartbeatRunId) return;
    await prepareCleanupGateOwnerStop(tx as unknown as Db, lease);
  });
}

/** The run exists in this company, is native, has ended and belongs to the task. */
async function endedRunOfTask(db: Db, companyId: string, runId: string, issueId: string): Promise<boolean> {
  const [run] = await db.select({ status: heartbeatRuns.status, runtimeMode: heartbeatRuns.runtimeMode,
    issueId: heartbeatRuns.issueId, nativeIssueId: heartbeatRuns.nativeIssueId, contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
  const runIssueId = run?.nativeIssueId ?? run?.issueId ?? (run?.contextSnapshot as Record<string, unknown> | null)?.issueId;
  return Boolean(run && run.runtimeMode === "native" && ENDED_RUN_STATUSES.has(run.status) && runIssueId === issueId);
}
