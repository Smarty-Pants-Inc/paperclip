import { and, desc, eq, isNotNull } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import type { PredecessorStart } from "./native-session-executor.js";

/** The predecessor run's own durable lease and recorded start, the inputs the
 * proven-gone predicate's provider branch needs. */
export type PredecessorRunnerLease = {
  /** The predecessor run's own environment lease row. */
  leaseId: string;
  /** That lease's provider sandbox id: the predecessor's own box. */
  providerLeaseId: string;
  /** The remote Runner process start when recorded, else the run's start; null when neither is. */
  start: PredecessorStart | null;
};

/**
 * Resolves the PREDECESSOR run's own durable lease (the lease row acquired for
 * that run, never the current run's) and its recorded start, within one
 * company. The start is the remote Runner process start recorded on the run
 * (processStartedAt with processHostHash "remote", source "process") or, failing
 * that, the run's startedAt (source "run"). Null when the run is not the
 * company's or has no lease with a provider sandbox id.
 */
export async function resolvePredecessorRunnerLease(db: Db, input: { companyId: string; runId: string }): Promise<PredecessorRunnerLease | null> {
  const [run] = await db.select({ startedAt: heartbeatRuns.startedAt, processStartedAt: heartbeatRuns.processStartedAt,
    processHostHash: heartbeatRuns.processHostHash }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).limit(1);
  if (!run) return null;
  const [lease] = await db.select({ id: environmentLeases.id, providerLeaseId: environmentLeases.providerLeaseId }).from(environmentLeases)
    .where(and(eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.heartbeatRunId, input.runId),
      isNotNull(environmentLeases.providerLeaseId)))
    .orderBy(desc(environmentLeases.acquiredAt), desc(environmentLeases.createdAt)).limit(1);
  if (!lease?.providerLeaseId) return null;
  const start: PredecessorStart | null = run.processHostHash === "remote" && run.processStartedAt
    ? { at: run.processStartedAt.toISOString(), source: "process" }
    : run.startedAt ? { at: run.startedAt.toISOString(), source: "run" } : null;
  return { leaseId: lease.id, providerLeaseId: lease.providerLeaseId, start };
}
