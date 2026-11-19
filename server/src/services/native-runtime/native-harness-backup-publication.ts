import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../../middleware/logger.js";
import { noteNativeHarnessBackupChange } from "../native-harness-backup-expiration-notifications.js";
import { removeNativeHarnessBackup } from "./native-harness-backup-cleanup.js";

/**
 * BRIEF rotation-keep (RFL 11-19 03:00Z, R-keep-all-traces, never-OK): a
 * superseded backup is a trace unless shown byte-identical to, or a byte-prefix
 * of, the newer copy. Neither holds in general: Pi 1.5.2 rewrites its session
 * file in place when it loads an older-version file (session-manager.js
 * _loadEntries -> _rewriteFile, open "w") and drops malformed lines, and the
 * control-plane journal is a whole-file snapshot that evicts old events.
 * Rotation therefore MOVES the superseded copy into
 * `failover-backups/superseded/<ms>-<uuid>` (inside the session's
 * durable-sessions scope root, so a continuity break archives it with the rest
 * of failover-backups) and never deletes it. Restore reads only current and
 * previous; retention never touches this directory.
 */
export const NATIVE_HARNESS_BACKUP_SUPERSEDED_DIRECTORY = "superseded";

function present(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

/** Atomic rename within the backup root: no copy, no delete. A failure leaves
 * `root` where it is. */
function keepSupersededNativeHarnessBackup(backupRoot: string, root: string): string | null {
  if (!present(root)) return null;
  const kept = resolve(backupRoot, NATIVE_HARNESS_BACKUP_SUPERSEDED_DIRECTORY);
  mkdirSync(kept, { recursive: true, mode: 0o700 });
  const destination = resolve(kept, `${Date.now()}-${randomUUID()}`);
  renameSync(root, destination);
  syncDirectory(kept);
  syncDirectory(backupRoot);
  return destination;
}

export async function publishNativeHarnessBackup(input: {
  db: object; companyId: string; scopeDigest: string; backupRoot: string; pendingRoot: string;
  stamp?: (currentRoot: string) => Promise<void>;
}) {
  const currentRoot = resolve(input.backupRoot, "current");
  const previousRoot = resolve(input.backupRoot, "previous");
  // A leftover 'previous' (interrupted publish) is kept; failing to move it
  // fails this publish before anything changes.
  keepSupersededNativeHarnessBackup(input.backupRoot, previousRoot);
  let movedCurrent = false;
  if (existsSync(currentRoot)) {
    renameSync(currentRoot, previousRoot);
    movedCurrent = true;
  }
  try {
    renameSync(input.pendingRoot, currentRoot);
    await input.stamp?.(currentRoot);
  } catch (error) {
    if (existsSync(currentRoot)) await removeNativeHarnessBackup(currentRoot);
    if (movedCurrent && existsSync(previousRoot) && !existsSync(currentRoot)) renameSync(previousRoot, currentRoot);
    throw error;
  }
  try {
    keepSupersededNativeHarnessBackup(input.backupRoot, previousRoot);
  } catch (error) {
    // The new copy is published. The superseded one stays as 'previous'
    // (still kept); the next publish moves it or fails closed first.
    logger.warn({ event: "native_backup_superseded_keep_deferred", backupRoot: input.backupRoot,
      code: (error as NodeJS.ErrnoException).code }, "superseded native harness backup left in place");
  }
  noteNativeHarnessBackupChange(input.db, { companyId: input.companyId, scopeDigest: input.scopeDigest });
}
