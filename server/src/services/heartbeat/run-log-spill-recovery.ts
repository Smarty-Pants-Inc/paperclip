import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import type { RunLogFinalizeSummary, RunLogStore } from "../run-log-store.js";

/**
 * A run whose object storage kept refusing its log settles with the refused
 * bytes in the kept local spill and `logBytes` NULL. Once storage takes writes
 * again, this puts the spill into the run's object log at the offset the bytes
 * were admitted at, closes the log and records its size and digest: the log
 * read then returns every admitted byte, in order.
 *
 * It never deletes or truncates the spill. A run that is running again is
 * left to its own writer, which stores the spill when it begins the log.
 * Native runs are left to the native log repair, whose own `begin` stores the
 * spill before it exports anything further.
 */
export interface RunLogSpillSettlement {
  /** The run is settled, its log is this object log, and its size is still unknown. */
  eligible(): Promise<boolean>;
  /** Record the recovered size and digest; false when the run changed meanwhile. */
  settle(summary: { bytes: number; sha256: string | null }): Promise<boolean>;
}

const LOG_REF = /^([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)$/;
const inFlight = new WeakMap<RunLogStore, Map<string, Promise<RunLogFinalizeSummary | null>>>();

export function runLogSpillSettlement(db: Db, logRef: string): RunLogSpillSettlement {
  const binding = LOG_REF.exec(logRef);
  if (!binding) throw new Error("invalid_run_log_reference");
  const eligible = () => and(
    eq(heartbeatRuns.id, binding[3]!),
    eq(heartbeatRuns.companyId, binding[1]!),
    eq(heartbeatRuns.agentId, binding[2]!),
    eq(heartbeatRuns.logStore, "s3_segments"),
    eq(heartbeatRuns.logRef, logRef),
    ne(heartbeatRuns.runtimeMode, "native"),
    inArray(heartbeatRuns.status, ["succeeded", "failed", "cancelled", "timed_out"]),
    isNull(heartbeatRuns.logBytes),
  );
  return {
    eligible: async () =>
      (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eligible())).length > 0,
    settle: async summary =>
      (await db.update(heartbeatRuns).set({ logBytes: summary.bytes, logSha256: summary.sha256 })
        .where(eligible()).returning({ id: heartbeatRuns.id })).length > 0,
  };
}

/** Recover one run's spill. Returns the settled summary, or null when nothing was recovered. */
export async function recoverSpilledRunLog(
  store: RunLogStore,
  logRef: string,
  settlement: RunLogSpillSettlement,
  signal?: AbortSignal,
): Promise<RunLogFinalizeSummary | null> {
  const binding = LOG_REF.exec(logRef);
  if (!binding || !store.recoverSpill) return null;
  let pending = inFlight.get(store);
  if (!pending) inFlight.set(store, pending = new Map());
  const existing = pending.get(logRef);
  if (existing) return existing;
  const work = (async () => {
    const summary = await store.recoverSpill!({
      companyId: binding[1]!, agentId: binding[2]!, runId: binding[3]!, previousStore: "s3_segments", signal,
      assertWriterAuthority: async () => {
        signal?.throwIfAborted();
        if (!(await settlement.eligible())) throw new Error("run_log_spill_recovery_authority_lost");
      },
    });
    if (!summary || summary.bytes === null) return null;
    if (!(await settlement.settle({ bytes: summary.bytes, sha256: summary.sha256 ?? null }))) return null;
    logger.info({ runId: binding[3], bytes: summary.bytes }, "Run log spill stored in the object log");
    return summary;
  })().finally(() => pending!.delete(logRef));
  pending.set(logRef, work);
  return work;
}

/** Startup / periodic reconcile: recover every settled run that still has an unstored spill. */
export async function recoverSpilledRunLogs(db: Db, store: RunLogStore, signal?: AbortSignal) {
  const logRefs = await store.listSpilledLogRefs?.() ?? [];
  let recovered = 0;
  for (const logRef of logRefs) {
    if (signal?.aborted) break;
    try {
      const settlement = runLogSpillSettlement(db, logRef);
      // Only settled runs: a spill of a run that is running, or unknown here, is left alone.
      if (!(await settlement.eligible())) continue;
      if (await recoverSpilledRunLog(store, logRef, settlement, signal)) recovered++;
    } catch (error) {
      logger.warn({ runId: logRef.split("/").at(-1), err: { name: (error as Error | null)?.name ?? "UnknownError" } },
        "Run log spill recovery is incomplete; the spill is kept");
    }
  }
  return { spilled: logRefs.length, recovered };
}
