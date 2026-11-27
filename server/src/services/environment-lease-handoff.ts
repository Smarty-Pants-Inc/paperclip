import { randomUUID } from "node:crypto";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issues, type Db } from "@paperclipai/db";

type Lease = typeof environmentLeases.$inferSelect;
type Binding = Pick<Lease, "id" | "companyId" | "environmentId" | "executionWorkspaceId" | "issueId" |
  "heartbeatRunId" | "provider" | "providerLeaseId" | "metadata" | "acquiredAt">;
const outgoingKey = "reusableLeaseSuccessor";
const incomingKey = "reusableLeasePredecessor";

export function withoutReusableLeaseHandoff(metadata: Record<string, unknown> | null | undefined) {
  if (metadata == null) return null;
  const result = { ...metadata };
  delete result[outgoingKey];
  delete result[incomingKey];
  return result;
}

export function preserveReusableLeaseHandoff(previous: Record<string, unknown> | null,
  metadata: Record<string, unknown> | null | undefined) {
  const result = withoutReusableLeaseHandoff(metadata);
  const proof = Object.fromEntries([outgoingKey, incomingKey]
    .filter(key => Object.hasOwn(previous ?? {}, key)).map(key => [key, previous![key]]));
  return Object.keys(proof).length ? { ...result, ...proof } : result;
}

function handoffBinding(previous: Binding, current: Binding) {
  return { schema: "paperclip.reusable-lease-handoff.v1",
    previousLeaseId: previous.id, successorLeaseId: current.id,
    previousRunId: previous.heartbeatRunId, successorRunId: current.heartbeatRunId,
    companyId: current.companyId, environmentId: current.environmentId,
    workspaceId: current.executionWorkspaceId, issueId: current.issueId,
    agentId: current.metadata?.agentId ?? null, provider: current.provider,
    providerLeaseId: current.providerLeaseId, recordedAt: current.acquiredAt.toISOString() };
}

export function createReusableLeaseHandoff(previous: Binding, current: Binding) {
  return { ...handoffBinding(previous, current), handoffId: randomUUID() };
}

/** Task deletion nulls the lease FK, not the native run's immutable issue ID.
 * Recover that deleted binding only for receipt validation; a live task or an
 * unbound run cannot repair a missing/mismatched receipt. One history query. */
export async function reusableLeaseHistoryWithDeletedTaskBindings(db: Db, companyId: string, providerLeaseId: string): Promise<Lease[]> {
  return db.select({ ...getTableColumns(environmentLeases),
    issueId: sql<string | null>`case when ${environmentLeases.issueId} is null and ${issues.id} is null
      then ${heartbeatRuns.nativeIssueId} else ${environmentLeases.issueId} end`,
  }).from(environmentLeases)
    .leftJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, environmentLeases.heartbeatRunId)))
    .leftJoin(issues, and(eq(issues.companyId, companyId), eq(issues.id, heartbeatRuns.nativeIssueId)))
    .where(and(eq(environmentLeases.companyId, companyId), eq(environmentLeases.providerLeaseId, providerLeaseId)));
}

export function retiredReusableLeasePredecessors(current: Lease, history: Lease[]): Lease[] | null {
  if (Object.hasOwn(current.metadata ?? {}, outgoingKey)) return null;
  const remaining = new Map(history.map(lease => [lease.id, lease]));
  if (remaining.size !== history.length) return null;
  const result: Lease[] = [];
  let successor = current;
  while (remaining.size) {
    const raw = successor.metadata?.[incomingKey];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const receipt = raw as Record<string, unknown>;
    const previous = remaining.get(String(receipt.previousLeaseId));
    if (!previous || previous.status !== "expired" || previous.cleanupStatus !== "success" ||
        previous.leasePolicy !== "reuse_by_environment" || !previous.heartbeatRunId ||
        !successor.heartbeatRunId || previous.heartbeatRunId === successor.heartbeatRunId ||
        typeof receipt.handoffId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receipt.handoffId)) return null;
    const expected = { ...handoffBinding(previous, successor), handoffId: receipt.handoffId };
    const outgoing = previous.metadata?.[outgoingKey];
    if (!outgoing || typeof outgoing !== "object" || Array.isArray(outgoing) ||
        Object.keys(receipt).length !== Object.keys(expected).length ||
        Object.keys(outgoing).length !== Object.keys(expected).length ||
        Object.entries(expected).some(([key, value]) => receipt[key] !== value ||
          (outgoing as Record<string, unknown>)[key] !== value) ||
        !previous.environmentId || !previous.issueId || typeof previous.metadata?.agentId !== "string" ||
        previous.companyId !== current.companyId || previous.environmentId !== current.environmentId ||
        previous.executionWorkspaceId !== current.executionWorkspaceId ||
        (current.executionWorkspaceId === null && previous.issueId !== current.issueId) ||
        previous.metadata.agentId !== current.metadata?.agentId ||
        previous.provider !== current.provider || previous.providerLeaseId !== current.providerLeaseId ||
        previous.releasedAt?.getTime() !== successor.acquiredAt.getTime() ||
        previous.acquiredAt.getTime() > successor.acquiredAt.getTime()) return null;
    result.push(previous);
    remaining.delete(previous.id);
    successor = previous;
  }
  return Object.hasOwn(successor.metadata ?? {}, incomingKey) ? null : result;
}
