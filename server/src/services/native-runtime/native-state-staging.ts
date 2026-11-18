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
 * Ten minutes covers that reassembly. Age rule for a staging directory: one
 * whose own mtime is older than this is swept. Every entry's mtime is no
 * earlier than the start of the transfer that made it, so such an entry has no
 * live writer.
 */
export const NATIVE_STATE_STREAM_DEADLINE_DEFAULT_MS = 3_600_000;
export const NATIVE_STATE_STAGING_MAX_AGE_MS = NATIVE_STATE_STREAM_DEADLINE_DEFAULT_MS + 600_000;

/**
 * A fence is an empty file, so it is kept far longer than any worker can run:
 * at least 48 hours, and at least twice the stream deadline.
 */
export const NATIVE_STATE_FENCE_MIN_LIFE_MS = 48 * 3_600_000;

export interface NativeStateStagingSweepOptions {
  /** The provider's stream deadline; defaults to the kubernetes default of 3600 s. */
  streamDeadlineMs?: number;
}

export function nativeStateFenceLifeMs(streamDeadlineMs = NATIVE_STATE_STREAM_DEADLINE_DEFAULT_MS): number {
  return Math.max(NATIVE_STATE_FENCE_MIN_LIFE_MS, 2 * streamDeadlineMs);
}

function nativeStateStagingMaxAgeMs(streamDeadlineMs = NATIVE_STATE_STREAM_DEADLINE_DEFAULT_MS): number {
  return Math.max(NATIVE_STATE_STAGING_MAX_AGE_MS, streamDeadlineMs + 600_000);
}

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
 * the empty fence only once it is older than its fence life
 * ({@link nativeStateFenceLifeMs}).
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

function listNativeStateStaging(): string[] {
  try {
    return readdirSync(tmpdir()).filter(name => name.startsWith(NATIVE_STATE_STAGING_PREFIX)).map(name => join(tmpdir(), name));
  } catch (error) {
    logger.warn({ err: error }, "native session state staging could not list the temp directory");
    return [];
  }
}

/**
 * Fences every `paperclip-native-state-*` directory in the temp directory,
 * whatever its age. Runs at server startup, before any transfer of this
 * process exists: every staging directory then belongs to a server that
 * stopped mid-transfer, and its worker may still be running or may already
 * have landed state bytes. Never follows a symlink.
 */
export function fenceOrphanedNativeStateStaging(): number {
  let fenced = 0;
  for (const entry of listNativeStateStaging()) {
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(entry, { throwIfNoEntry: false }); } catch (error) {
      logger.warn({ err: error }, "native session state staging fence could not inspect an entry");
      continue;
    }
    if (!stat?.isDirectory()) continue;
    fenceNativeStateStagingQuietly(entry);
    fenced += 1;
  }
  return fenced;
}

/**
 * Sweeps staging entries in the temp directory, by age, never following a
 * symlink. An empty file is a fence: it is removed only once it is older than
 * its fence life. Any other entry is removed once it is older than the
 * directory age rule ({@link NATIVE_STATE_STAGING_MAX_AGE_MS}, or the stream
 * deadline plus ten minutes when that is longer). Runs at server startup,
 * after {@link fenceOrphanedNativeStateStaging}, and on each native state read.
 */
export function sweepNativeStateStaging(now = Date.now(), options: NativeStateStagingSweepOptions = {}): number {
  let removed = 0;
  const fenceLifeMs = nativeStateFenceLifeMs(options.streamDeadlineMs);
  const maxAgeMs = nativeStateStagingMaxAgeMs(options.streamDeadlineMs);
  for (const entry of listNativeStateStaging()) {
    try {
      const stat = lstatSync(entry, { throwIfNoEntry: false });
      if (!stat) continue;
      const fence = stat.isFile() && stat.size === 0;
      if (now - stat.mtimeMs <= (fence ? fenceLifeMs : maxAgeMs)) continue;
      rmSync(entry, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      logger.warn({ err: error }, "native session state staging sweep could not remove an entry");
    }
  }
  return removed;
}
