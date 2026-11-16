import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { SANDBOX_BACKUP_SOURCE_SUPERSEDED_KEY } from "../../agent-run-cancellation.js";
import { retiredReusableLeasePredecessors } from "../environment-lease-handoff.js";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";
import { sandboxLeaseSourceMatches } from "../sandbox-lease-config-compatibility.js";
import { hasConfirmedSandboxStopAndRetain, hasStopOnlyCleanup, readStopOnlyCleanup } from "../sandbox-stop-and-retain.js";
import { LEGACY_WORKSPACE_RECOVERY_KEY, LEGACY_WORKSPACE_RECOVERY_SCHEMA } from "../workspace-restore-recovery-state.js";
import { readNativeHarnessBackupStamp } from "./native-harness-backup-stamp.js";
import { nativeWorkspaceExportPendingForLease, nativeWorkspaceExportPendingForResource } from "./native-workspace-finalization-state.js";

import { NATIVE_PROVIDER_DURABLE_EVENT_TYPES } from "./native-provider-work-proof.js";
export { NATIVE_PROVIDER_DURABLE_EVENT_TYPES } from "./native-provider-work-proof.js";

export function nativeHarnessBackupManifestSha256(manifestBytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
}

/** J3-22 primary (RFL): the longest one run waits for its backup's source to
 * finish stopping before it falls to the same-run fresh thread. */
export const NATIVE_BACKUP_SOURCE_STOP_WAIT_MS = 60_000;
const NATIVE_BACKUP_SOURCE_STOP_POLL_MS = 500;

/**
 * The backup's source allocation is being STOPPED (never destroyed) under the
 * stop-only contract: its configuration no longer matched (an env, skill or
 * instructions write), so this run's own acquisition armed the stop seconds
 * earlier (environment-runtime cleanupObsoleteReusableSandboxLeases ->
 * prepareSupersededWarmSandboxStop: pending_cleanup with a stop-only intent).
 * While it is stopping, no retired-source class matches and nothing may be
 * restored: the source may still run. Wait, bounded, until that one stop
 * settles (SSR settleStopOnlyCleanup: released + a stopped receipt); the caller
 * then asks retiredSourceAuthorizesNativeBackupRestore AGAIN, whose existing
 * classes and supersede claim decide. No new authorization class.
 *
 * Returns true only when the source WAS stopping and its single tip is no
 * longer pending_cleanup. Any other state returns false at once (no wait).
 */
export async function waitForStoppingBackupSource(db: Db, input: {
  companyId: string; sourceProviderLeaseId: string; deadlineAtMs: number; pollMs?: number;
}): Promise<boolean> {
  let waited = false;
  for (;;) {
    const rows = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, input.companyId),
      eq(environmentLeases.providerLeaseId, input.sourceProviderLeaseId)));
    const tips = rows.filter(row => row.companyId === input.companyId && row.providerLeaseId === input.sourceProviderLeaseId
      && !Object.hasOwn(row.metadata ?? {}, "reusableLeaseSuccessor"));
    if (tips.length !== 1) return false;
    const tip = tips[0]!;
    if (!backupSourceIsStopping(tip)) return waited && tip.status !== "pending_cleanup";
    if (Date.now() >= input.deadlineAtMs) return false;
    waited = true;
    await new Promise(resolve => setTimeout(resolve, input.pollMs ?? NATIVE_BACKUP_SOURCE_STOP_POLL_MS));
  }
}

/** A reusable source whose stop-only stop is in flight (claimed and dispatched
 * by its stop owner) and not confirmed yet. An armed stop that no owner has
 * claimed is not waited for: nothing here drives it, so the run does not block
 * on it (the refusal and the same-run fresh thread stand). */
function backupSourceIsStopping(lease: Pick<typeof environmentLeases.$inferSelect, "status" | "leasePolicy" | "metadata">): boolean {
  return lease.status === "pending_cleanup" && lease.leasePolicy === "reuse_by_environment" && hasStopOnlyCleanup(lease)
    && lease.metadata?.pendingCleanupInFlight === true;
}

/**
 * A created sandbox normally refuses a per-turn backup that has no recorded
 * reusable lease, because the backup's source sandbox may still hold newer
 * provider state. That ambiguity is absent when Paperclip itself destroyed the
 * source sandbox: the provider confirmed the termination, a stamp on the source
 * allocation's verified lease chain names this backup, and no provider work for
 * the session was recorded after the backup completed. This is the same proof a
 * confirmed replacement relies on, reached through a lease that was retired first.
 *
 * A settled workspace-restore hold is the other retired source. The hold
 * changed the lease to `retain_on_failure`, which reuse never selects, and
 * stopped the sandbox under a stop-only receipt that permits no provider work.
 * Releases before the hold settlement restored warm reuse left such rows
 * stranded, so this also unsticks state saved by those releases.
 *
 * An idle warm source is the third. Its own run is terminal, no run holds the
 * lease, and no workspace export is pending on the sandbox, so nothing can do
 * provider work there. Reuse skips such a lease while the previous run's
 * workspace export is still in flight, and the next run then gets a new lease.
 * With no provider work after the backup, the idle sandbox holds exactly the
 * checkpointed state, so restoring the backup continues the same session. The
 * source is claimed as superseded first, so it is never resumed with that
 * older state after the restored lease moves on. An expired native reusable
 * source with a bound stopped receipt is the fourth class: the same idle proof
 * applies, and the runtime start fence keeps its stopped allocation retired.
 *
 * A source Paperclip stopped because the environment's boot source (image)
 * changed is the fifth (`bootSourceChangeRetiresSource`). Each class is one
 * predicate in `RETIRED_SOURCE_CLASSES`; a class whose sandbox could otherwise
 * be resumed again is also claimed as superseded.
 */
export async function retiredSourceAuthorizesNativeBackupRestore(db: Db, input: {
  companyId: string;
  currentRunId: string;
  normalizedSessionId: string;
  manifest: { sourceProviderLeaseId: string; runnerInstanceId: string; normalizedSessionId: string };
  manifestSha256: string;
  /** The allocation the backup restores into. Its own missing state never proves a retired source. */
  targetProviderLeaseId?: string | null;
  /** J3-22: told when every proof but the retired class holds and the source is
   * still stopping (stop-only, pending_cleanup), so asking again after that stop
   * settles may succeed. Grants nothing: the answer here stays false. */
  onSourceStopping?: () => void;
}): Promise<boolean> {
  if (!input.manifest.sourceProviderLeaseId || input.manifest.normalizedSessionId !== input.normalizedSessionId
    || input.manifest.sourceProviderLeaseId === input.targetProviderLeaseId) return false;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, input.companyId),
    eq(environmentLeases.providerLeaseId, input.manifest.sourceProviderLeaseId),
  ));
  const source = leases.filter(lease => lease.companyId === input.companyId
    && lease.providerLeaseId === input.manifest.sourceProviderLeaseId);
  const tips = source.filter(lease => !Object.hasOwn(lease.metadata ?? {}, "reusableLeaseSuccessor"));
  if (tips.length !== 1) return false;
  const lease = tips[0]!;
  const predecessors = retiredReusableLeasePredecessors(lease, source.filter(row => row.id !== lease.id));
  if (!predecessors) return false;
  // Warm handoffs leave stamps on their original owner rows, but owner order
  // does not establish checkpoint chronology. Select by completion time before
  // matching the manifest; conflicting latest-time stamps are ambiguous.
  // Retirement and the supersession claim still belong exclusively to the tip.
  const stamps = [lease, ...predecessors]
    .map(row => readNativeHarnessBackupStamp(row.metadata?.nativeHarnessBackup, lease.providerLeaseId!))
    .filter(candidate => candidate !== null)
    .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt));
  const stamp = stamps[0];
  if (!stamp || stamps.some(candidate => Date.parse(candidate.completedAt) === Date.parse(stamp.completedAt)
    && !isDeepStrictEqual(candidate, stamp))) return false;
  if (stamp.manifestSha256 !== input.manifestSha256
    || stamp.normalizedSessionId !== input.normalizedSessionId
    || stamp.runnerInstanceId !== input.manifest.runnerInstanceId) return false;
  // A released lease can still be selected for resume; only a retired one is final.
  const retired = await retiredSourceClass(db, lease, input);
  if (!retired) {
    if (input.onSourceStopping && backupSourceIsStopping(lease)
      && !await nativeHarnessBackupHasLaterProviderWork(db, { ...input, completedAt: stamp.completedAt })) input.onSourceStopping();
    return false;
  }
  // Provider work recorded after the checkpoint means the destroyed sandbox
  // held newer state than this backup. Restoring would silently rewind it.
  if (await nativeHarnessBackupHasLaterProviderWork(db, { ...input, completedAt: stamp.completedAt })) return false;
  return !retired.claim || await supersedeIdleWarmSource(db, lease, input);
}

type SourceLease = typeof environmentLeases.$inferSelect;
type RetiredSourceInput = { companyId: string; currentRunId: string; targetProviderLeaseId?: string | null };

/**
 * The retired-source classes, in proof order. One predicate each; the caller's
 * stamp, later-work and claim proofs still decide. `claim` marks a class whose
 * sandbox still exists and could be resumed later (for example after the image
 * is switched back): it is claimed as superseded before the restore.
 */
const RETIRED_SOURCE_CLASSES: ReadonlyArray<{
  name: "destroyed" | "settled_restore_hold" | "boot_source_changed" | "idle_warm";
  claim: boolean;
  retires: (db: Db, lease: SourceLease, input: RetiredSourceInput) => Promise<boolean>;
}> = [
  { name: "destroyed", claim: false, retires: async (_db, lease) => destroyedSource(lease) },
  { name: "settled_restore_hold", claim: false, retires: (db, lease) => settledRestoreHoldRetiresSource(db, lease) },
  { name: "boot_source_changed", claim: true, retires: bootSourceChangeRetiresSource },
  { name: "idle_warm", claim: true, retires: (db, lease, input) => idleWarmSourceRetiresBackup(db, lease, input.currentRunId) },
];

async function retiredSourceClass(db: Db, lease: SourceLease, input: RetiredSourceInput) {
  for (const retiredClass of RETIRED_SOURCE_CLASSES) if (await retiredClass.retires(db, lease, input)) return retiredClass;
  return null;
}

function destroyedSource(lease: SourceLease): boolean {
  const termination = lease.metadata?.remoteExecutionTermination as { state?: unknown } | undefined;
  return ["expired", "failed"].includes(lease.status) && hasRemoteTerminationReceipt(lease)
    && termination?.state === "destroyed";
}

/** Shared by backup restore and compatible environment draining: a valid old
 * archive is not a checkpoint of provider work that happened after it. */
export async function nativeHarnessBackupHasLaterProviderWork(db: Db, input: {
  companyId: string; currentRunId: string; normalizedSessionId: string; completedAt: string;
}): Promise<boolean> {
  const later = await db.select({ runId: heartbeatRunEvents.runId }).from(heartbeatRunEvents)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, heartbeatRunEvents.runId))
    .where(and(
      eq(heartbeatRunEvents.companyId, input.companyId),
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.nativeSessionId, input.normalizedSessionId),
      ne(heartbeatRuns.id, input.currentRunId),
      inArray(heartbeatRunEvents.eventType, [...NATIVE_PROVIDER_DURABLE_EVENT_TYPES]),
      gt(heartbeatRunEvents.createdAt, new Date(input.completedAt)),
    )).limit(1);
  return later.length > 0;
}

export const SUPERSEDED_REUSABLE_SANDBOX_KEY = "reusableSandboxLeaseSuperseded";

/**
 * Claims an idle warm source before its backup is restored elsewhere. The
 * source still holds the checkpointed session, and the restored lease will
 * move past it, so the source must never be resumed again. Removing its reuse
 * scope makes the next acquisition for this workspace treat it as obsolete and
 * clean it up through the existing obsolete-lease path. The write is a
 * compare-and-swap on the checked row: a run that resumed or changed the lease
 * in the meantime wins, and the restore does not happen.
 */
async function supersedeIdleWarmSource(db: Db, lease: typeof environmentLeases.$inferSelect, input: {
  companyId: string; currentRunId: string; manifestSha256: string; targetProviderLeaseId?: string | null;
}) {
  const { reusableSandboxLease: scope, ...metadata } = lease.metadata ?? {};
  const prior = metadata[SUPERSEDED_REUSABLE_SANDBOX_KEY] as { reusableSandboxLease?: unknown } | undefined;
  return db.transaction(async tx => {
  const [claimed] = await tx.update(environmentLeases).set({
    metadata: { ...metadata, [SUPERSEDED_REUSABLE_SANDBOX_KEY]: {
      schema: "paperclip.reusable-sandbox-lease-superseded.v1", reason: "harness_backup_restored_elsewhere",
      supersededByRunId: input.currentRunId, supersededByProviderLeaseId: input.targetProviderLeaseId ?? null,
      manifestSha256: input.manifestSha256, reusableSandboxLease: scope ?? prior?.reusableSandboxLease ?? null, supersededAt: new Date().toISOString(),
    } },
    updatedAt: new Date(),
  }).where(and(
    eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.id, lease.id),
    eq(environmentLeases.status, lease.status), eq(environmentLeases.leasePolicy, "reuse_by_environment"),
    eq(environmentLeases.heartbeatRunId, lease.heartbeatRunId!),
    sql`${environmentLeases.metadata} = ${JSON.stringify(lease.metadata)}::jsonb`,
    sql`(not (coalesce(${environmentLeases.metadata}, '{}'::jsonb) ? ${SUPERSEDED_REUSABLE_SANDBOX_KEY})
      or (${environmentLeases.metadata}->${SUPERSEDED_REUSABLE_SANDBOX_KEY}->>'supersededByProviderLeaseId' = ${input.targetProviderLeaseId ?? null}
        and ${environmentLeases.metadata}->${SUPERSEDED_REUSABLE_SANDBOX_KEY}->>'manifestSha256' = ${input.manifestSha256}))`,
  )).returning({ id: environmentLeases.id });
  if (!claimed) return false;
  await tx.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb)
    || ${JSON.stringify({ [SANDBOX_BACKUP_SOURCE_SUPERSEDED_KEY]: new Date().toISOString() })}::jsonb`, updatedAt: new Date() })
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, lease.heartbeatRunId!)));
  return true;
  });
}

const TERMINAL_SOURCE_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

/**
 * A warm reusable lease whose run has ended and that no run holds. Its sandbox
 * may still be running, but only a run does provider work there, and the
 * caller's later-work check proves none did after the backup. A pending
 * workspace export or cleanup on the allocation keeps it ambiguous.
 */
async function idleWarmSourceRetiresBackup(db: Db, lease: typeof environmentLeases.$inferSelect, currentRunId: string) {
  const superseded = lease.metadata?.[SUPERSEDED_REUSABLE_SANDBOX_KEY] as { reusableSandboxLease?: unknown } | undefined;
  const scope = (lease.metadata?.reusableSandboxLease ?? superseded?.reusableSandboxLease) as { adapterType?: unknown } | undefined;
  const stoppedNative = lease.status === "expired" && scope?.adapterType === "paperclip_runner"
    && hasRemoteTerminationReceipt(lease)
    && (lease.metadata?.remoteExecutionTermination as { state?: unknown } | undefined)?.state === "stopped";
  if (lease.leasePolicy !== "reuse_by_environment" || (!stoppedNative && !["released", "retained"].includes(lease.status))
    || !lease.heartbeatRunId || lease.heartbeatRunId === currentRunId
    || lease.metadata?.pendingCleanupInFlight === true || sourceFilesHeld(lease)) return false;
  if (!await sourceRunEnded(db, lease)) return false;
  return !await nativeWorkspaceExportPendingForResource(db, lease, currentRunId);
}

/** A restore hold or a pending shutdown settlement still protects the files; reuse skips these too. */
function sourceFilesHeld(lease: SourceLease): boolean {
  return Object.hasOwn(lease.metadata ?? {}, LEGACY_WORKSPACE_RECOVERY_KEY)
    || (lease.metadata?.legacyShutdownWorkspaceSettlement as { state?: unknown } | undefined)?.state === "pending";
}

/** Only a run does provider work in a sandbox; the source lease's own run has ended. */
async function sourceRunEnded(db: Db, lease: SourceLease): Promise<boolean> {
  if (!lease.heartbeatRunId) return false;
  const [run] = await db.select({ sourceRunStatus: heartbeatRuns.status }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, lease.companyId), eq(heartbeatRuns.id, lease.heartbeatRunId))).limit(1);
  return !!run && TERMINAL_SOURCE_RUN_STATUSES.has(run.sourceRunStatus);
}

/**
 * The environment's boot source (image, snapshot, rootfs) changed after this
 * reusable source was admitted, so acquisition never selects it again
 * (`sandboxLeaseSourceMatches`) and Paperclip stopped it under the stop-only
 * contract instead of destroying it (Cut A). It is retired when:
 * - its stop is CONFIRMED: released with the bound stop-and-retain receipt
 *   (`hasConfirmedSandboxStopAndRetain`). The receipt carries no reason, so the
 *   source change is read from the leases themselves. This also covers rows
 *   stopped before any reason was recorded. Primary path.
 * - or its stop is REQUESTED: `pending_cleanup` with the bound stop intent that
 *   cleanup recorded for this source (`sandbox_source_changed`). The box may
 *   still be running until the sweep confirms the stop, so this also needs the
 *   source run to have ended (only a run does provider work) and the caller's
 *   superseded claim, as an idle warm source does.
 * Both need the CURRENT run's lease in the same environment to have booted a
 * different source; a source that still matches is not retired by this class.
 * Both also need no restore hold on the files and no pending workspace export.
 * The caller's stamp and later-work proofs still decide.
 */
async function bootSourceChangeRetiresSource(db: Db, lease: SourceLease, input: RetiredSourceInput): Promise<boolean> {
  if (lease.leasePolicy !== "reuse_by_environment" || !lease.heartbeatRunId || lease.heartbeatRunId === input.currentRunId
    || !lease.environmentId || !input.targetProviderLeaseId || sourceFilesHeld(lease)) return false;
  const stopConfirmed = hasConfirmedSandboxStopAndRetain(lease);
  const stopRequested = lease.status === "pending_cleanup"
    && (readStopOnlyCleanup(lease) as { reason?: unknown } | null)?.reason === "sandbox_source_changed";
  if (!stopConfirmed && !stopRequested) return false;
  if (!await bootSourceChangedSince(db, lease, input)) return false;
  if (!await sourceRunEnded(db, lease)) return false;
  return !await nativeWorkspaceExportPendingForLease(db, lease)
    && !await nativeWorkspaceExportPendingForResource(db, lease, input.currentRunId);
}

/** The current run's lease records the boot source that the environment's
 * current configuration resolved to (the same keys acquisition compares). Every
 * such lease in the source's environment must differ from the source's. */
async function bootSourceChangedSince(db: Db, lease: SourceLease, input: RetiredSourceInput): Promise<boolean> {
  const targets = (await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, input.companyId),
    eq(environmentLeases.providerLeaseId, input.targetProviderLeaseId!),
    eq(environmentLeases.heartbeatRunId, input.currentRunId),
  ))).filter(row => row.companyId === input.companyId && row.providerLeaseId === input.targetProviderLeaseId
    && row.heartbeatRunId === input.currentRunId && row.environmentId === lease.environmentId);
  return targets.length > 0 && targets.every(row => !sandboxLeaseSourceMatches(row.metadata ?? {}, lease.metadata ?? {}));
}

/**
 * A stopped, released lease is retired only when it is a workspace-restore hold
 * that nothing can select for resume: `retain_on_failure` with the hold's own
 * marker, a confirmed stop-and-retain receipt whose state is `stopped`, and no
 * unsaved writer or pending native workspace export bound to the allocation.
 * A stopped `reuse_by_environment` lease stays ambiguous and fails closed.
 */
async function settledRestoreHoldRetiresSource(db: Db, lease: typeof environmentLeases.$inferSelect): Promise<boolean> {
  const marker = lease.metadata?.workspaceRestoreRecovery as { schema?: unknown; runId?: unknown } | undefined;
  if (lease.leasePolicy !== "retain_on_failure" || lease.status !== "released" || !lease.heartbeatRunId
    || marker?.schema !== LEGACY_WORKSPACE_RECOVERY_SCHEMA || marker.runId !== lease.heartbeatRunId) return false;
  // Provider expiry cannot revive the allocation; it only makes the source
  // more final. Every other stop-and-retain receipt check stays strict.
  if (!hasConfirmedSandboxStopAndRetain({ ...lease, expiresAt: null })) return false;
  // Includes the dirty remote writer source (`preparedRemoteWorkspaceSource`).
  return !await nativeWorkspaceExportPendingForLease(db, lease);
}
