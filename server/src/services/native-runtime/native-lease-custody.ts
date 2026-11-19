import { and, desc, eq, inArray } from "drizzle-orm";
import {
  environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeHarnessBackups, type Db,
} from "@paperclipai/db";
import { getStorageService } from "../../storage/index.js";
import { executionStartedEventPredicate } from "../pre-dispatch-execution-evidence.js";
import {
  durableNativeHarnessStorage, NATIVE_HARNESS_DOWNLOAD_IDLE_TIMEOUT_MS, verifyDurableNativeHarnessBackup,
  verifyRecoverableNativeHarnessBackup,
} from "./native-harness-backup-storage.js";
import { loadNativeHarnessBackupLeaseChain, loadNativeHarnessBackupLeaseRows, nativeHarnessBackupHasLaterProviderWork,
  nativeSessionOfLeaseRun, newestNativeHarnessBackupStampOnChain } from "./native-retired-backup-source.js";

type CustodyLease = Pick<typeof environmentLeases.$inferSelect, "id" | "companyId" | "providerLeaseId">;

/** The lease's custody stamp across its warm-handoff lease CHAIN (the stop's
 * close can stamp the admission row): the newest stamp of the session the tip
 * served, with no provider work after it. Null when none. */
export async function nativeLeaseChainCustodyStamp(db: Db, lease: CustodyLease): Promise<unknown> {
  if (!lease.providerLeaseId) return null;
  const allocation = { companyId: lease.companyId, providerLeaseId: lease.providerLeaseId };
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

/** Names a native box kept (stopped, not destroyed) because no verified saved
 * harness copy exists. Set on the orphan-recovery marker of the stop intent;
 * the retained-orphan settle owns it, counts its custody attempts and
 * escalates after the cleanup cap. */
export const NATIVE_CUSTODY_UNVERIFIED_KEY = "nativeCustodyUnverified";
export const NATIVE_CUSTODY_UNVERIFIED_REASON = "native_custody_unverified";

/**
 * THE custody check before any destructive cleanup of a native lease,
 * ephemeral included (RFL 05:59Z): true when the lease's box may hold a native
 * harness session trace (a native run with ANY native session identity on
 * this provider allocation) and no VERIFIED saved copy exists. Verified means the
 * existing helpers read the bytes: the lease's own or lease-chain backup stamp
 * verified by `verifyRecoverableNativeHarnessBackup`, or a `native_harness_backups` row of
 * the run whose stored object `verifyDurableNativeHarnessBackup` downloads and
 * digests against its reference. A row whose bytes are missing is not custody.
 * Any read failure fails closed (custody missing).
 */
export async function nativeLeaseCustodyMissing(db: Db, leaseId: string): Promise<boolean> {
  if (typeof (db as Partial<Db>)?.select !== "function") return false;
  try {
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId));
    if (!lease?.heartbeatRunId || !lease.providerLeaseId) return false;
    if (!(await nativeRunSessionIdentity(db, lease, lease.heartbeatRunId))) return false;
    for (const stamp of [lease.metadata?.nativeHarnessBackup, await nativeLeaseChainCustodyStamp(db, lease).catch(() => null)]) {
      if (stamp && await verifyRecoverableNativeHarnessBackup({ db, companyId: lease.companyId,
        stamp, providerLeaseId: lease.providerLeaseId }).catch(() => false)) return false;
    }
    const copies = await db.select().from(nativeHarnessBackups).where(and(
      eq(nativeHarnessBackups.companyId, lease.companyId), eq(nativeHarnessBackups.runId, lease.heartbeatRunId),
      inArray(nativeHarnessBackups.status, ["current", "superseded"]))).orderBy(desc(nativeHarnessBackups.createdAt)).limit(5);
    if (copies.length === 0) return true;
    let storage;
    try { storage = durableNativeHarnessStorage() ?? getStorageService(); } catch { return true; }
    for (const copy of copies) {
      const verified = await verifyDurableNativeHarnessBackup({ db, storage, companyId: copy.companyId,
        scopeDigest: copy.scopeDigest, manifestSha256: copy.manifestSha256, backupId: copy.id,
        downloadIdleTimeoutMs: NATIVE_HARNESS_DOWNLOAD_IDLE_TIMEOUT_MS }).catch(() => false);
      if (verified) return false;
    }
    return true;
  } catch {
    return true;
  }
}

/** Native for custody = ANY native session identity of the run (rf-3 F3), not
 * only a persisted start event: a lost event is not proof that no harness
 * session ran in the box. Identity: a start event, or a native session id,
 * resumed session id or recorded runner process. Without a start event, a
 * runner-task lease the task was never dispatched to (`runnerTaskDispatched`,
 * written at submit) is affirmative proof that this box ran no session. The
 * resolved native mode, native issue id and coordinator row are written at
 * claim, before any launch, so alone they are not a session: a pre-launch box
 * is released as the never-launched proof (`nativeRunNeverLaunchedRunner`) allows. */
async function nativeRunSessionIdentity(db: Db, lease: typeof environmentLeases.$inferSelect, runId: string): Promise<boolean> {
  const [run] = await db.select({ runtimeMode: heartbeatRuns.runtimeMode, nativeSessionId: heartbeatRuns.nativeSessionId,
    sessionIdAfter: heartbeatRuns.sessionIdAfter, processPid: heartbeatRuns.processPid,
    processGroupId: heartbeatRuns.processGroupId, processStartedAt: heartbeatRuns.processStartedAt }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, lease.companyId)));
  if (run?.runtimeMode !== "native") return false;
  const [started] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.runId, runId), executionStartedEventPredicate())).limit(1);
  if (started) return true;
  if (lease.metadata?.runnerTaskLease === true && lease.metadata?.runnerTaskDispatched !== true) return false;
  return !!(run.nativeSessionId || run.sessionIdAfter || run.processPid || run.processGroupId || run.processStartedAt);
}

/** Recovery marker for the stop intent of a kept unsaved native box. */
export function nativeCustodyKeptRecovery(): Record<string, unknown> {
  return { recoveredOrphanedRunLease: true, [NATIVE_CUSTODY_UNVERIFIED_KEY]: true,
    ownerProof: NATIVE_CUSTODY_UNVERIFIED_REASON };
}
