import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

type CheckpointManifest = { fileCount: number; totalBytes: number };

/** Inventory the original source, not a possibly incomplete transfer/snapshot.
 * Exclusions are validated literal relative paths by archiveExcludeArgs before
 * this helper is called. A full-disk provider fallback uses unanchored tar
 * exclusions; ordinary snapshots and streaming pulls use root-anchored ones.
 */
export async function readRemoteCheckpointManifest(input: {
  runner: CommandManagedRuntimeRunner;
  sourcePath: string;
  excluded: readonly string[];
  unanchored?: boolean;
}): Promise<CheckpointManifest> {
  const escapedSource = input.sourcePath.replaceAll("'", "'\\''");
  const prune = input.excluded.length === 0 ? "" :
    `\\( ${input.excluded.map(entry => `-path '${input.unanchored ? "*/" : "./"}${entry}'`).join(" -o ")} \\) -prune -o `;
  // Keep numbers, not filenames: filenames may contain newlines. Redirection
  // tests actual readability. The nonnumeric sentinel also propagates failed
  // -exec on find implementations which do not propagate its exit status.
  // No remote disk is needed: the provider's full-disk fallback must still work.
  const result = await input.runner.execute({
    command: "sh",
    args: ["-c", `set -e; export LC_ALL=C; cd '${escapedSource}'; ` +
      `paperclip_sizes=$(find . ${prune}-type f -exec sh -c '` +
      `for file do wc -c < "$file" || { printf "UNREADABLE\\n"; exit 1; }; done` +
      `' sh {} +); ` +
      `printf '%s\\n' "$paperclip_sizes" | awk '` +
      `NF { if (NF != 1 || $1 !~ /^[0-9]+$/) exit 2; count++; bytes += $1 } ` +
      `END { printf "%.0f %.0f\\n", count, bytes }'`],
    bypassSession: true,
    timeoutMs: 120_000,
  });
  const match = /^(\d+) (\d+)\s*$/.exec(result.stdout);
  if (result.exitCode !== 0 || result.timedOut || !match) {
    throw new Error("runner_remote_checkpoint_manifest_failed");
  }
  const fileCount = Number(match[1]);
  const totalBytes = Number(match[2]);
  if (!Number.isSafeInteger(fileCount) || !Number.isSafeInteger(totalBytes)) {
    throw new Error("runner_remote_checkpoint_manifest_failed");
  }
  return { fileCount, totalBytes };
}

/** Reject missing/extra regular files and truncation before a caller may remove
 * the remote source. Walk asynchronously, without following retained links.
 * This is a completeness check, not a new archive format or content digest.
 */
export async function verifyLocalCheckpointManifest(root: string, expected: CheckpointManifest): Promise<void> {
  let fileCount = 0;
  let totalBytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isDirectory()) pending.push(path);
      else if (metadata.isFile()) { fileCount++; totalBytes += metadata.size; }
    }
  }
  if (fileCount !== expected.fileCount || totalBytes !== expected.totalBytes) {
    throw new Error("runner_remote_checkpoint_manifest_mismatch");
  }
}
