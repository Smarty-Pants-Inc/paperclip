import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { nativeWorkspaceExportPendingForLease } from "./native-runtime/native-workspace-finalization-state.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { currentControllerBootId } from "./controller-process-identity.js";
import { wakeStoppingAgentLifecycleInTransaction } from "../modules/agent-lifecycle/index.js";
import type { ProviderResourceDisposition } from "./environment-runtime.js";
import { executionStartedEventPredicate } from "./pre-dispatch-execution-evidence.js";

export const LEASE_RELEASE_DEFERRAL_KEY = "releaseDeferral";
const LEASE_RELEASE_RETRY_BASE_MS = 30_000;
const LEASE_RELEASE_RETRY_MAX_MS = 15 * 60_000;
export const LEASE_RELEASE_FAST_ATTEMPTS = 6;
export const LEASE_RELEASE_SLOW_RETRY_MS = 60 * 60_000;

export type LeaseReleaseDeferral = {
  reason: string;
  attempts: number;
  retryAt: string;
  failingSince: string;
  triggers?: string[];
  attemptedByBootIds?: string[];
  providerResourceDisposition: ProviderResourceDisposition | null;
};

const LEASE_RELEASE_TRIGGER_LIMIT = 20;

const LEASE_RELEASE_BOOT_LIMIT = 10;

export function leaseReleaseAttemptedByThisBoot(deferral: LeaseReleaseDeferral | null) {
  return Boolean(deferral?.attemptedByBootIds?.includes(currentControllerBootId()));
}

export function leaseReleaseRetryDueAt(deferral: LeaseReleaseDeferral, now = Date.now()) {
  if (!leaseReleaseAttemptedByThisBoot(deferral)) return now;
  const retryAt = Date.parse(deferral.retryAt);
  return Number.isFinite(retryAt) ? retryAt : now;
}

export function nextLeaseReleaseBootIds(previous: LeaseReleaseDeferral | null) {
  const current = currentControllerBootId();
  const bootIds = (previous?.attemptedByBootIds ?? []).filter(bootId => bootId !== current);
  return [...bootIds, current].slice(-LEASE_RELEASE_BOOT_LIMIT);
}

export function nextLeaseReleaseRetryAt(previous: LeaseReleaseDeferral | null, attempts: number, now = Date.now()) {
  const scheduled = now + leaseReleaseRetryDelayMs(attempts);
  const saved = previous ? Date.parse(previous.retryAt) : Number.NaN;
  return new Date(Number.isFinite(saved) && saved > scheduled ? saved : scheduled).toISOString();
}

export function nextLeaseReleaseTriggers(previous: LeaseReleaseDeferral | null, trigger: string | undefined) {
  const triggers = [...(previous?.triggers ?? [])];
  if (trigger && !triggers.includes(trigger)) triggers.push(trigger);
  return triggers.slice(-LEASE_RELEASE_TRIGGER_LIMIT);
}

export function readLeaseReleaseDeferral(metadata: Record<string, unknown> | null | undefined): LeaseReleaseDeferral | null {
  const value = metadata?.[LEASE_RELEASE_DEFERRAL_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const deferral = value as Record<string, unknown>;
  if (typeof deferral.reason !== "string" || typeof deferral.retryAt !== "string" || typeof deferral.attempts !== "number") return null;
  return deferral as LeaseReleaseDeferral;
}

/** One readiness decision for orphan release and replacement. Terminal status
 * alone never proves a holder idle: controller/finalizer ownership, a release
 * deferral, and pending workspace export all retain the allocation. Callers
 * supply their local execution census; durable checks also work cross-process. */
export async function terminalRunLeaseReleaseReadiness(db: Db,
  lease: Pick<typeof environmentLeases.$inferSelect,
    "id" | "companyId" | "heartbeatRunId" | "provider" | "providerLeaseId" | "metadata" | "environmentId" | "issueId" | "executionWorkspaceId">,
  localRuns?: { has(runId: string): boolean }, now = Date.now()) {
  if (!lease.heartbeatRunId || localRuns?.has(lease.heartbeatRunId)) return { ready: false as const };
  const deferral = readLeaseReleaseDeferral(lease.metadata);
  const dueAt = deferral ? leaseReleaseRetryDueAt(deferral, now) : Number.NaN;
  if (dueAt > now) return { ready: false as const, retryAt: dueAt };
  const [run] = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
    status: heartbeatRuns.status, error: heartbeatRuns.error, runtimeMode: heartbeatRuns.runtimeMode,
    controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, lease.heartbeatRunId), eq(heartbeatRuns.companyId, lease.companyId)));
  if (!run || !["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status)) {
    return { ready: false as const };
  }
  const [owner] = await db.select({ leaseOwner: nativeRunFinalizations.leaseOwner, leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt })
    .from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, run.id), eq(nativeRunFinalizations.companyId, run.companyId)));
  if (owner?.leaseOwner && !owner.leaseExpiresAt) return { ready: false as const };
  const heldUntil = Math.max(run.controllerLeaseExpiresAt?.getTime() ?? 0,
    owner?.leaseOwner ? owner.leaseExpiresAt?.getTime() ?? 0 : 0);
  if (heldUntil > now) return { ready: false as const, retryAt: heldUntil };
  if (await nativeWorkspaceExportPendingForLease(db, lease)) return { ready: false as const };
  return { ready: true as const, run, deferral };
}

export function leaseReleaseRetryDelayMs(attempts: number) {
  if (attempts > LEASE_RELEASE_FAST_ATTEMPTS) return LEASE_RELEASE_SLOW_RETRY_MS;
  return Math.min(LEASE_RELEASE_RETRY_MAX_MS, LEASE_RELEASE_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export function wakeStoppingAgentLifecycle(tx: Db, agentId: string) {
  return wakeStoppingAgentLifecycleInTransaction(tx, agentId, () => notifyDeliveryWork(tx, DELIVERY_QUEUES.agentLifecycle));
}

export async function settleUnchangedNativeWorkspace(db: Db, runId: string, companyId: string): Promise<boolean> {
  const settled = await db.update(heartbeatRuns).set({
    runnerProfileJson: sql`(${heartbeatRuns.runnerProfileJson} - 'nativeWorkspaceSync')
      || jsonb_build_object('nativeWorkspaceSyncReleasedUnchanged', ${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync')`,
  }).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "cancelled"),
    sql`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'->>'state' = 'prepared'`,
    sql`coalesce(${heartbeatRuns.runnerProfileJson}->'remoteWorkspace', 'null'::jsonb) = 'null'::jsonb`,
    sql`not exists (select 1 from ${environmentLeases} where ${environmentLeases.companyId} = ${companyId}
      and ${environmentLeases.heartbeatRunId} = ${runId} and (${environmentLeases.status} in ('active', 'pending_cleanup', 'retained')
        or coalesce(${environmentLeases.metadata}, '{}'::jsonb) ? 'sandboxStopAndRetainReceipt'))`))
    .returning({ id: heartbeatRuns.id });
  return settled.length > 0;
}

export async function nativeRunNeverLaunchedRunner(db: Db, runId: string, companyId: string): Promise<boolean> {
  const [run] = await db.select({ processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)));
  if (!run || run.processPid || run.processGroupId) return false;
  const [started] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, runId), executionStartedEventPredicate(),
  )).limit(1);
  return !started;
}
