import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../../middleware/logger.js";

/**
 * Host-side staging for a native session state read through `syncOut`.
 *
 * The plugin syncOut contract can only deliver to a host path
 * (`PluginSyncFileMapping.targetPath`; the result carries byte counts only),
 * and the plugin RPC has no cancel: the host's call rejects on its own timer
 * while the plugin worker keeps running, then runs `mkdir -p` on the target's
 * parent and renames the file in. So an unsuccessful transfer's staging path is
 * fenced (replaced by an empty file) rather than only removed: the worker's
 * late `mkdir -p` then fails, and no state bytes can land after the host gave up.
 */
export const NATIVE_STATE_STAGING_PREFIX = "paperclip-native-state-";

/**
 * The longest a plugin worker can still write into a staging entry after the
 * transfer started: the kubernetes provider streams a syncOut for at most
 * `podActivityDeadlineSec` (default 3600 s), then only extracts and renames.
 * Ten minutes covers that reassembly. Age rule: an entry whose own mtime is
 * older than this is swept. Every entry's mtime is no earlier than the start
 * of the transfer that made it, so such an entry has no live writer.
 */
export const NATIVE_STATE_STAGING_MAX_AGE_MS = 3_600_000 + 600_000;

export function createNativeStateStaging(): { staging: string; targetPath: string } {
  const staging = mkdtempSync(join(tmpdir(), NATIVE_STATE_STAGING_PREFIX));
  try {
    chmodSync(staging, 0o700);
    // The target sits one level down, so a fence at `staging` makes the
    // worker's `mkdir -p dirname(target)` fail instead of recreating it.
    const transfer = join(staging, "transfer");
    mkdirSync(transfer, { mode: 0o700 });
    chmodSync(transfer, 0o700);
    return { staging, targetPath: join(transfer, "state.json") };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Removes a staging directory whose transfer completed; no writer is left. */
export function removeNativeStateStaging(staging: string): void {
  rmSync(staging, { recursive: true, force: true });
}

/**
 * Removes a staging directory whose transfer failed or was abandoned and puts
 * an empty file at its path, so a worker still running cannot recreate the
 * directory and land state bytes. A worker that recreates it between the
 * removal and the fence is removed again. The startup and read sweeps remove
 * the empty fence once it is older than the age rule.
 */
export function fenceNativeStateStaging(staging: string): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    try {
      rmSync(staging, { recursive: true, force: true });
      writeFileSync(staging, "", { flag: "wx", mode: 0o600 });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function fenceNativeStateStagingQuietly(staging: string): void {
  try { fenceNativeStateStaging(staging); } catch (error) {
    logger.warn({ err: error }, "native session state staging fence failed");
  }
}

/**
 * Sweeps staging entries a crashed server left behind: every
 * `paperclip-native-state-*` entry in the temp directory whose mtime is older
 * than {@link NATIVE_STATE_STAGING_MAX_AGE_MS}. Runs at server startup and on
 * each native state read.
 */
export function sweepNativeStateStaging(now = Date.now()): number {
  let removed = 0;
  let names: string[];
  try { names = readdirSync(tmpdir()); } catch (error) {
    logger.warn({ err: error }, "native session state staging sweep could not list the temp directory");
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(NATIVE_STATE_STAGING_PREFIX)) continue;
    const entry = join(tmpdir(), name);
    try {
      const stat = lstatSync(entry, { throwIfNoEntry: false });
      if (!stat || now - stat.mtimeMs <= NATIVE_STATE_STAGING_MAX_AGE_MS) continue;
      rmSync(entry, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      logger.warn({ err: error }, "native session state staging sweep could not remove an entry");
    }
  }
  return removed;
}
