import { createHash } from "node:crypto";
import { cp, lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { digestBackupDirectoryStreamed } from "./native-harness-backup-digest.js";

// Regenerable downloads only: never session.jsonl, identity, task/context,
// trailers, extensions or provider configuration. Shared by live snapshots,
// legacy-backup migration and cold restore staging.
export const PI_HOME_CHECKPOINT_EXCLUDED_ENTRIES = [
  "data/pnpm/store", "data/pnpm/.tools", "cache", "node-compile-cache",
] as const;

export function piRunnerCheckpointExclusions(sessionId: string): string[] {
  // Legacy Pi roots are hash-keyed; retain the literal-key compatibility root
  // only when it is already a safe single path component (no wildcard policy).
  const keys = new Set([createHash("sha256").update(sessionId).digest("hex"),
    ...(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(sessionId) ? [sessionId] : [])]);
  return [...keys].flatMap(key => PI_HOME_CHECKPOINT_EXCLUDED_ENTRIES.map(entry => `pi-sessions/${key}/pi-home/${entry}`));
}

async function directory(path: string): Promise<boolean> {
  try { const entry = await lstat(path); return entry.isDirectory() && !entry.isSymbolicLink(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Copy, never edit, an already verified legacy backup. Hash the filtered copy
 * before capturing it: final-tar-only exclusions would invalidate its manifest.
 * The caller retains the original manifest hash for source ownership fencing. */
export async function normalizePiHarnessBackupSnapshot(root: string, target: string, signal?: AbortSignal): Promise<{
  root: string; sourceManifestSha256?: string;
}> {
  signal?.throwIfAborted();
  const manifestBytes = await readFile(join(root, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.schema !== "paperclip.native-harness-backup.v1" ||
      !["pi_rpc", "acpx"].includes(manifest.providerKind)) return { root };
  const excluded = new Set<string>();
  for (const base of ["runner/pi-sessions", "acpx/acpx"]) {
    if (!await directory(join(root, base))) continue;
    for (const session of await readdir(join(root, base), { withFileTypes: true })) {
      if (!session.isDirectory() || session.isSymbolicLink()) continue;
      const home = join(base, session.name, "pi-home");
      if (!await directory(join(root, home))) continue;
      for (const cache of PI_HOME_CHECKPOINT_EXCLUDED_ENTRIES) {
        try { await lstat(join(root, home, cache)); excluded.add(join(home, cache)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
  }
  if (!excluded.size) return { root };
  await cp(root, target, { recursive: true, verbatimSymlinks: true, filter: source => {
    signal?.throwIfAborted();
    return !excluded.has(relative(resolve(root), resolve(source)));
  } });
  if (!Array.isArray(manifest.directories)) throw new Error("native_harness_archive_invalid");
  const directories = [];
  for (const entry of manifest.directories) {
    signal?.throwIfAborted();
    if (typeof entry.name !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(entry.name)) throw new Error("native_harness_archive_invalid");
    directories.push({ name: entry.name, ...await digestBackupDirectoryStreamed(join(target, entry.name)) });
  }
  const sourceManifestSha256 = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
  await writeFile(join(target, "manifest.json"), JSON.stringify({ ...manifest, directories, sourceManifestSha256 }), { mode: 0o600 });
  return { root: target, sourceManifestSha256 };
}
