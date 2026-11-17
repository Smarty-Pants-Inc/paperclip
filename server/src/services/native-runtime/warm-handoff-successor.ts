import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { and, eq, gt, lt, ne } from "drizzle-orm";
import { handedOffWarmLeaseSettled } from "./handed-off-warm-lease.js";

/**
 * pl/warm-reuse-owed: a person's mid-turn Stop of a warm (keep_running) turn
 * hands its still-running box off to the next message. The stopped run's v3
 * export stays PREPARED, which made its own retained lease read as "export
 * pending" at the next acquisition, so the next message got a NEW box and a
 * fresh provider thread. That pending export is owed to the DIRECT successor,
 * which resumes the same lease and adopts the box workspace as is.
 *
 * True only for the predecessor's own retained lease (the acquisition
 * candidate) when: the successor is a run of the same company and agent (the
 * caller already matched the chat's execution workspace / issue and the
 * lease's agent), created after the predecessor, with no other run of that
 * agent in between; and the ONE predicate handedOffWarmLeaseSettled holds
 * (handoff per the warm-stop helper, no stop in flight, Runner proven exited).
 */
export async function handedOffWarmLeaseOwedToSuccessor(db: Db, input: {
  companyId: string; leaseId: string; successorRunId: string;
}): Promise<boolean> {
  const [lease] = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.id, input.leaseId))).limit(1);
  if (!lease?.heartbeatRunId || lease.heartbeatRunId === input.successorRunId) return false;
  const [predecessor] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, lease.heartbeatRunId))).limit(1);
  const [successor] = await db.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, createdAt: heartbeatRuns.createdAt })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.successorRunId))).limit(1);
  if (!predecessor || !successor || predecessor.agentId !== successor.agentId
    || successor.createdAt.getTime() <= predecessor.createdAt.getTime()) return false;
  if (lease.metadata?.agentId !== predecessor.agentId) return false;
  // DIRECT successor: no other run of this agent between the Stop and this run.
  const [between] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, predecessor.agentId),
    gt(heartbeatRuns.createdAt, predecessor.createdAt), lt(heartbeatRuns.createdAt, successor.createdAt),
    ne(heartbeatRuns.id, predecessor.id), ne(heartbeatRuns.id, successor.id))).limit(1);
  if (between) return false;
  return await handedOffWarmLeaseSettled(predecessor, lease);
}
