import { and, inArray } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { recordedUserStopRequestSql } from "./acknowledged-native-stop.js";

/**
 * org purple (2), 2026-11-18: a box whose run a PERSON stopped is never
 * selected by another run.
 *
 * On tB2 a person's Stop (errorCode "cancelled") keeps the box WARM
 * (runner-environment-lifecycle.ts providerResourceDispositionForTerminalRun):
 * the lease is retained with no termination receipt. So the rule keys on the
 * lease's run P (`lease.heartbeatRunId`): the cancelled-by-user record the
 * real Stop route writes (run-control.ts cancelRun: cancelledByActorType
 * "user" with executionCancellation or startupCancellation; read by
 * hasRecordedUserStopRequest / recordedUserStopRequestSql). It applies
 * whatever the lease status is (active, retained or released) and has no time
 * window. Only P's own run is exempt.
 *
 * `personStoppedRunIds` is the set loadPersonStoppedRunIds read for the
 * candidates (one query, not one per candidate). Every path that hands a
 * reusable box to a run uses this one predicate: the reusable sandbox lease
 * selection (environment-runtime reusableLeaseCanBeResumed, both call sites),
 * the warm plugin-task resume, and the handoff mirror (environments
 * acquireLease replacesReusableLeaseId).
 */
export function personStoppedBoxRefusedToOtherRun(input: {
  lease: { heartbeatRunId: string | null };
  heartbeatRunId: string | null;
  personStoppedRunIds: ReadonlySet<string>;
}): boolean {
  const owner = input.lease.heartbeatRunId;
  if (!owner) return false;
  if (input.heartbeatRunId !== null && owner === input.heartbeatRunId) return false;
  return input.personStoppedRunIds.has(owner);
}

/** The ids, among the candidate leases' runs, of runs a person stopped. */
export async function loadPersonStoppedRunIds(
  db: Pick<Db, "select">,
  leases: ReadonlyArray<{ heartbeatRunId: string | null }>,
): Promise<Set<string>> {
  const runIds = [...new Set(leases.flatMap(lease => lease.heartbeatRunId ? [lease.heartbeatRunId] : []))];
  if (runIds.length === 0) return new Set();
  const rows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .where(and(inArray(heartbeatRuns.id, runIds), recordedUserStopRequestSql()));
  return new Set(rows.map(row => row.id));
}
