import { closeSync, constants, lstatSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

/**
 * Runner-owned policy, applied after provider env sanitizers. Pi explicitly
 * enables Node's compile cache; its default shared /tmp/node-compile-cache may
 * belong to the snapshot installer or another uid. Never require that cache.
 *
 * Structured/remote launches default to disabled: their paths must not be
 * probed on the controller. Only the process owner can opt into a private local
 * cache. Provisioning/permission errors disable this optional optimization,
 * never refuse a launch. Cursor and short-lived proxies keep it disabled.
 */
export function nodeCompileCacheEnvironment(
  privateRuntimeDirectory?: string,
  options: { enableLocalCache?: boolean } = {},
): NodeJS.ProcessEnv {
  const cache = privateRuntimeDirectory ? join(privateRuntimeDirectory, "node-compile-cache") : undefined;
  const disabled = { NODE_COMPILE_CACHE: cache, NODE_DISABLE_COMPILE_CACHE: "1" };
  if (!options.enableLocalCache || !privateRuntimeDirectory || !isAbsolute(privateRuntimeDirectory)) return disabled;
  try {
    const parent = lstatSync(privateRuntimeDirectory);
    const uid = process.getuid?.();
    if (!parent.isDirectory() || (uid !== undefined && parent.uid !== uid) || (parent.mode & 0o077) !== 0) return disabled;
    try { mkdirSync(cache!, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return disabled;
    }
    const directory = lstatSync(cache!);
    if (!directory.isDirectory() || (uid !== undefined && directory.uid !== uid) || (directory.mode & 0o777) !== 0o700) return disabled;
    // Check actual writeability, not just mode bits (ACLs/read-only mounts).
    const probe = join(cache!, `.write-probe-${randomUUID()}`);
    const fd = openSync(probe, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { closeSync(fd); } finally { unlinkSync(probe); }
    // Any nonempty value (even "0") disables Node's cache; explicitly clear an
    // inherited disable flag once this process owner's directory is verified.
    return { NODE_COMPILE_CACHE: cache, NODE_DISABLE_COMPILE_CACHE: undefined };
  } catch {
    return disabled;
  }
}
