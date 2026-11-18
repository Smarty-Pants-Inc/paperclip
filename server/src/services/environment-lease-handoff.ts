import { randomUUID } from "node:crypto";
import type { environmentLeases } from "@paperclipai/db";

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

/** Carry only successful, token-free preparation receipts after a validated
 * same-allocation handoff/reacquisition. Never use providerLeaseId alone as
 * authority: unrelated rows and a recreated allocation must prepare normally.
 */
export function carryReusableLeasePreparation(previous: Binding, current: Binding) {
  const metadata = { ...current.metadata };
  if (!previous.providerLeaseId || previous.providerLeaseId !== current.providerLeaseId ||
      previous.provider !== current.provider || previous.companyId !== current.companyId ||
      previous.environmentId !== current.environmentId || previous.issueId !== current.issueId ||
      previous.executionWorkspaceId !== current.executionWorkspaceId ||
      typeof previous.metadata?.agentId !== "string" || !previous.metadata.agentId ||
      previous.metadata.agentId !== current.metadata?.agentId) return metadata;
  for (const name of ["anonymousGitHubLaunchers", "nativeWorkspaceRealizationPreparation"]) {
    const raw = previous.metadata?.[name];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const receipt = raw as Record<string, unknown>;
    if (receipt.leaseId !== previous.id || typeof receipt.key !== "string" ||
        !/^[a-f0-9]{64}$/.test(receipt.key)) continue;
    if (name === "nativeWorkspaceRealizationPreparation") {
      const rawRealization = receipt.realization;
      if (!rawRealization || typeof rawRealization !== "object" || Array.isArray(rawRealization)) continue;
      const realization = { ...rawRealization } as Record<string, unknown>;
      if (realization.leaseId !== undefined && realization.leaseId !== previous.id) continue;
      if (realization.leaseId === previous.id) realization.leaseId = current.id;
      // The provider's fresh metadata takes precedence over a cached layout.
      if (metadata.workspaceRealization !== undefined &&
          JSON.stringify(metadata.workspaceRealization) !== JSON.stringify(realization)) continue;
      metadata.workspaceRealization = realization;
      metadata[name] = { ...receipt, leaseId: current.id, realization };
    } else {
      metadata[name] = { ...receipt, leaseId: current.id };
    }
  }
  return metadata;
}
