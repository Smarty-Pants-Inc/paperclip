import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeHarnessBackups, workspaceOperations, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { claimedAdapterType, historicalAdapterType, isConversationAdapter } from "./conversation-continuation.js";
import { nativeRunNeverLaunchedRunner } from "./environment-lease-release-deferral.js";
import { hasNativeHarnessBackupMissing } from "./native-runtime/native-harness-backup-missing.js";
import { readNativeHarnessBackupStamp, verifyNativeHarnessBackupStamp } from "./native-runtime/native-harness-backup-stamp.js";
import { durableNativeHarnessStorage } from "./native-runtime/native-harness-backup-storage.js";
import { loadNativeHarnessBackupLeaseChain, loadNativeHarnessBackupLeaseRows, nativeHarnessBackupHasLaterProviderWork,
  nativeSessionOfLeaseRun, newestNativeHarnessBackupStampOnChain } from "./native-runtime/native-retired-backup-source.js";
import { hasStopOnlyCleanup, prepareSandboxStopAndRetain, prepareUnconfirmedSourceSandboxStop } from "./sandbox-stop-and-retain.js";

/**
 * Custody gate for a sandbox box that held a native turn (org 23:50Z rule).
 *
 * The box may be destroyed, or released in a way that erases it, ONLY when the
 * server already holds that turn:
 *  - backup: a native_harness_backups row whose scope + manifest_sha256 match
 *    the lease stamp (status current/superseded); without durable (S3)
 *    storage, the verified local copy named by the stamp;
 *  - copy-out: when the run has a workspace on this box, its
 *    workspace_finalize operation succeeded.
 * Otherwise the box is kept (stop-and-retain). Failed and cancelled runs are
 * gated the same way. One predicate; every destroy choke point calls it.
 */
export type NativeTurnCustody =
  | { destroy: true; basis: NativeTurnCustodyBasis }
  | { destroy: false; reason: NativeTurnCustodyKeepReason };

export type NativeTurnCustodyBasis =
  | "not_a_sandbox_box"
  | "no_turn_lease"
  | "runner_never_launched"
  | "non_native_no_box_session"
  | "backup_and_copy_out_held";

export type NativeTurnCustodyKeepReason =
  | "lease_unreadable"
  | "turn_run_unreadable"
  | "non_native_adapter_unknown"
  | "non_native_conversation_session_in_box"
  | "preconfigured_codex_home_not_backed_up"
  | "native_backup_missing_marker"
  | "native_backup_stamp_missing"
  | "native_backup_storage_unavailable"
  | "native_backup_row_missing"
  | "native_backup_manifest_mismatch"
  | "native_backup_local_copy_unverified"
  | "workspace_copy_out_not_succeeded";

export const NATIVE_TURN_CUSTODY_KEPT_KEY = "nativeTurnCustodyKept";
export const NATIVE_TURN_CUSTODY_KEPT_SCHEMA = "paperclip.native-turn-custody-kept.v1";
/** A kept box's expiry. Expiry ESCALATES (typed record + operator log); it never destroys. */
export const NATIVE_TURN_CUSTODY_ESCALATE_AFTER_MS = 24 * 60 * 60 * 1000;
export const NATIVE_TURN_CUSTODY_REFUSED_MESSAGE = "native_turn_custody_missing: the server does not hold this box's native turn; destructive cleanup is forbidden.";

type LeaseRow = typeof environmentLeases.$inferSelect;

export async function nativeTurnCustody(db: Db, ref: { id: string; companyId: string }): Promise<NativeTurnCustody> {
  if (typeof (db as Partial<Db>).select !== "function") return { destroy: false, reason: "lease_unreadable" };
  const [lease] = await db.select().from(environmentLeases)
    .where(and(eq(environmentLeases.id, ref.id), eq(environmentLeases.companyId, ref.companyId))).limit(1);
  if (!lease) return { destroy: false, reason: "lease_unreadable" };
  return nativeTurnCustodyForLease(db, lease);
}

export async function nativeTurnCustodyForLease(db: Db, lease: LeaseRow): Promise<NativeTurnCustody> {
  // No provider allocation, nothing a destroy could erase.
  if (!lease.provider || lease.provider === "local" || !lease.providerLeaseId) return { destroy: true, basis: "not_a_sandbox_box" };
  const metadata = lease.metadata ?? {};
  const stamped = metadata.nativeHarnessBackup !== undefined;
  const missingMarker = hasNativeHarnessBackupMissing(lease);
  // Probe / setup-test / failed-create leases carry no run (environment-probe.ts
  // heartbeatRunId: null). A box that ran a native turn carries its stamp.
  if (!lease.heartbeatRunId && !stamped && !missingMarker) return { destroy: true, basis: "no_turn_lease" };
  const [run] = lease.heartbeatRunId ? await db.select({
    id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, runtimeMode: heartbeatRuns.runtimeMode,
    runnerProfileJson: heartbeatRuns.runnerProfileJson,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, lease.heartbeatRunId), eq(heartbeatRuns.companyId, lease.companyId))).limit(1) : [];
  const reusable = metadata.reusableSandboxLease as Record<string, unknown> | undefined;
  const native = run?.runtimeMode === "native" || stamped || missingMarker
    || (reusable && typeof reusable === "object" && reusable.adapterType === "paperclip_runner");
  if (!native) {
    if (!run) return { destroy: false, reason: "turn_run_unreadable" };
    if (await nativeRunNeverLaunchedRunner(db, run.id, run.companyId)) return { destroy: true, basis: "runner_never_launched" };
    const adapterType = claimedAdapterType(run) ?? await historicalAdapterType(db, run);
    if (!adapterType) return { destroy: false, reason: "non_native_adapter_unknown" };
    // The CLI session of a conversation adapter lives in the box under
    // .paperclip-runtime, which workspace restore excludes.
    if (isConversationAdapter(adapterType)) return { destroy: false, reason: "non_native_conversation_session_in_box" };
    return { destroy: true, basis: "non_native_no_box_session" };
  }
  if (run && !stamped && !missingMarker && await nativeRunNeverLaunchedRunner(db, run.id, run.companyId)) {
    return { destroy: true, basis: "runner_never_launched" };
  }
  const input = run?.runnerProfileJson?.nativeExecutionInput as Record<string, unknown> | undefined;
  const provider = input?.provider as Record<string, unknown> | undefined;
  if (provider?.kind === "codex" && input?.homeMode === "preconfigured") return { destroy: false, reason: "preconfigured_codex_home_not_backed_up" };
  if (missingMarker) return { destroy: false, reason: "native_backup_missing_marker" };
  const stamp = readNativeHarnessBackupStamp(metadata.nativeHarnessBackup, lease.providerLeaseId) ?? await chainCustodyStamp(db, lease);
  if (!stamp) return { destroy: false, reason: "native_backup_stamp_missing" };
  let durable: boolean;
  try { durable = durableNativeHarnessStorage() !== null; } catch { return { destroy: false, reason: "native_backup_storage_unavailable" }; }
  if (durable) {
    const rows = await db.select({ manifestSha256: nativeHarnessBackups.manifestSha256 }).from(nativeHarnessBackups).where(and(
      eq(nativeHarnessBackups.companyId, lease.companyId), eq(nativeHarnessBackups.scopeDigest, stamp.sessionScopeSha256),
      inArray(nativeHarnessBackups.status, ["current", "superseded"])));
    if (!rows.length) return { destroy: false, reason: "native_backup_row_missing" };
    if (!rows.some(row => row.manifestSha256 === stamp.manifestSha256)) return { destroy: false, reason: "native_backup_manifest_mismatch" };
  } else if (!verifyNativeHarnessBackupStamp(stamp, lease.providerLeaseId)) {
    return { destroy: false, reason: "native_backup_local_copy_unverified" };
  }
  const sync = run?.runnerProfileJson?.nativeWorkspaceSync as Record<string, unknown> | undefined;
  if (run && sync && typeof sync === "object" && sync.leaseId === lease.id) {
    const [finalized] = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
      eq(workspaceOperations.companyId, lease.companyId), eq(workspaceOperations.heartbeatRunId, run.id),
      eq(workspaceOperations.phase, "workspace_finalize"), eq(workspaceOperations.status, "succeeded"))).limit(1);
    if (!finalized) return { destroy: false, reason: "workspace_copy_out_not_succeeded" };
  }
  return { destroy: true, basis: "backup_and_copy_out_held" };
}

/**
 * A warm box's stamp can sit on a retired predecessor row of the same
 * allocation (recordNativeHarnessBackupStampOnLeaseChain). Same selection as
 * obsolete-box custody (environment-runtime obsoleteLeaseCustodyStamp): the
 * newest stamp of the tip run's own session, refused when provider work
 * followed it.
 */
async function chainCustodyStamp(db: Db, lease: LeaseRow) {
  const allocation = { companyId: lease.companyId, providerLeaseId: lease.providerLeaseId! };
  let chain = await loadNativeHarnessBackupLeaseChain(db, allocation);
  if (!chain || chain.tip.id !== lease.id) {
    const rows = await loadNativeHarnessBackupLeaseRows(db, allocation);
    if (rows.length !== 1 || rows[0]!.id !== lease.id) return null;
    chain = { tip: rows[0]!, predecessors: [] };
  }
  const stamp = newestNativeHarnessBackupStampOnChain(chain, await nativeSessionOfLeaseRun(db, chain.tip), "cleanup");
  if (!stamp || await nativeHarnessBackupHasLaterProviderWork(db, { companyId: lease.companyId,
    normalizedSessionId: stamp.normalizedSessionId, completedAt: stamp.completedAt })) return null;
  return stamp;
}

function keptMarker(lease: LeaseRow, reason: NativeTurnCustodyKeepReason, now: Date) {
  return {
    schema: NATIVE_TURN_CUSTODY_KEPT_SCHEMA, reason,
    owner: { companyId: lease.companyId, runId: lease.heartbeatRunId, issueId: lease.issueId, environmentId: lease.environmentId,
      agentId: typeof lease.metadata?.agentId === "string" ? lease.metadata.agentId : null },
    provider: lease.provider, providerLeaseId: lease.providerLeaseId,
    keptAt: now.toISOString(),
    escalateAt: new Date(now.getTime() + NATIVE_TURN_CUSTODY_ESCALATE_AFTER_MS).toISOString(),
  };
}

/**
 * Keep a box the gate refused: record the typed kept marker (owner, expiry)
 * and, where the lease still holds a running box, convert it to the existing
 * stop-and-retain intent (prepareSandboxStopAndRetain). Never destroys.
 */
export async function keepNativeTurnBox(db: Db, leaseRef: Pick<LeaseRow, "id" | "companyId">, reason: NativeTurnCustodyKeepReason): Promise<LeaseRow | null> {
  const now = new Date();
  const [current] = await db.select().from(environmentLeases)
    .where(and(eq(environmentLeases.id, leaseRef.id), eq(environmentLeases.companyId, leaseRef.companyId))).limit(1);
  if (!current) return null;
  const marker = current.metadata?.[NATIVE_TURN_CUSTODY_KEPT_KEY] as Record<string, unknown> | undefined;
  const nextMarker = marker && marker.schema === NATIVE_TURN_CUSTODY_KEPT_SCHEMA ? { ...marker, reason } : keptMarker(current, reason, now);
  logger.warn({ event: "native_turn_custody_kept", leaseId: current.id, runId: current.heartbeatRunId, reason },
    "sandbox kept: the server does not hold this box's native turn");
  const stoppable = current.heartbeatRunId && current.metadata?.pendingCleanupInFlight !== true && !hasStopOnlyCleanup(current);
  if (stoppable && current.status === "active") {
    const prepared = await prepareSandboxStopAndRetain(db, current, undefined,
      { leasePolicy: current.leasePolicy, metadata: { [NATIVE_TURN_CUSTODY_KEPT_KEY]: nextMarker } });
    if (prepared) return prepared;
  }
  const [marked] = await db.update(environmentLeases).set({
    metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ [NATIVE_TURN_CUSTODY_KEPT_KEY]: nextMarker })}::jsonb`,
  }).where(and(eq(environmentLeases.id, current.id), eq(environmentLeases.companyId, current.companyId))).returning();
  if (!marked) return null;
  if (stoppable && ["retained", "pending_cleanup"].includes(marked.status)) {
    return (await prepareUnconfirmedSourceSandboxStop(db, marked)) ?? marked;
  }
  return marked;
}

/**
 * Money rule: a kept box whose expiry passed is ESCALATED once (typed
 * `escalatedAt` on the marker + one operator error log). It is never
 * destroyed here; only the custody gate can authorize a destroy.
 */
export async function escalateExpiredNativeTurnCustodyKeeps(db: Db, now = new Date()): Promise<number> {
  const rows = await db.update(environmentLeases).set({
    metadata: sql`jsonb_set(${environmentLeases.metadata}, ${`{${NATIVE_TURN_CUSTODY_KEPT_KEY},escalatedAt}`}::text[], to_jsonb(${now.toISOString()}::text))`,
  }).where(and(
    isNotNull(environmentLeases.metadata),
    sql`${environmentLeases.metadata}->${NATIVE_TURN_CUSTODY_KEPT_KEY}->>'schema' = ${NATIVE_TURN_CUSTODY_KEPT_SCHEMA}`,
    sql`not (${environmentLeases.metadata}->${NATIVE_TURN_CUSTODY_KEPT_KEY} ? 'escalatedAt')`,
    sql`(${environmentLeases.metadata}->${NATIVE_TURN_CUSTODY_KEPT_KEY}->>'escalateAt')::timestamptz <= ${now.toISOString()}::timestamptz`,
  )).returning({ id: environmentLeases.id, companyId: environmentLeases.companyId, heartbeatRunId: environmentLeases.heartbeatRunId,
    status: environmentLeases.status, metadata: environmentLeases.metadata });
  for (const row of rows) {
    logger.error({ event: "native_turn_custody_kept_box_expired", leaseId: row.id, companyId: row.companyId, runId: row.heartbeatRunId,
      status: row.status, kept: row.metadata?.[NATIVE_TURN_CUSTODY_KEPT_KEY] },
    "kept sandbox passed its expiry without a server-held backup; operator action required (it is NOT destroyed)");
  }
  return rows.length;
}
