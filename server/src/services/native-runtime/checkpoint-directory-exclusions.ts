import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

/** Literal root-relative paths, not basenames/globs. Shared with archive flags. */
export function validateCheckpointExclusions(entries: readonly string[]): void {
  for (const entry of entries) {
    if (!entry || entry.startsWith("/") || entry.split("/").some(segment =>
      !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment))) {
      throw new Error("runner_remote_checkpoint_exclusion_invalid");
    }
  }
}

function prefixes(entry: string): string[] {
  const parts = entry.split("/");
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

/** Never traverse a symlink to decide whether a path is an excluded directory. */
export async function localCheckpointDirectoryExclusions(source: string, entries: readonly string[]): Promise<string[]> {
  validateCheckpointExclusions(entries);
  if (!entries.length) return [];
  const root = await lstat(source);
  if (!root.isDirectory() || root.isSymbolicLink()) return [];
  const selected: string[] = [];
  for (const entry of entries) {
    let directory = true;
    for (const prefix of prefixes(entry)) {
      const metadata = await lstat(join(source, prefix)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
      });
      if (!metadata?.isDirectory() || metadata.isSymbolicLink()) { directory = false; break; }
    }
    if (directory) selected.push(entry);
  }
  return selected;
}

/** Select the identical real-directory projection on the source host. Only
 * fixed numeric indexes cross this boundary; filenames cannot become commands.
 * This is a read-only selection, never a cleanup or a recursive remove. */
export async function remoteCheckpointDirectoryExclusions(input: {
  runner: CommandManagedRuntimeRunner;
  sourcePath: string;
  entries: readonly string[];
}): Promise<string[]> {
  validateCheckpointExclusions(input.entries);
  if (!input.entries.length) return [];
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const tests = input.entries.map((entry, index) => {
    const checks = ["", ...prefixes(entry)].map(prefix => {
      const path = quote(prefix ? `${input.sourcePath}/${prefix}` : input.sourcePath);
      return `[ ! -L ${path} ] && [ -d ${path} ]`;
    }).join(" && ");
    return `if ${checks}; then printf '%s\\n' '${index}'; fi;`;
  }).join(" ");
  const result = await input.runner.execute({ command: "sh", args: ["-c", `set -e; ${tests}`],
    bypassSession: true, timeoutMs: 30_000 });
  if (result.exitCode !== 0 || result.timedOut || !/^(?:\d+\n)*$/.test(result.stdout)) {
    throw new Error("runner_remote_checkpoint_exclusion_inspection_failed");
  }
  const indexes = result.stdout.trim() ? result.stdout.trim().split("\n").map(Number) : [];
  if (indexes.some(index => !Number.isSafeInteger(index) || index >= input.entries.length)) {
    throw new Error("runner_remote_checkpoint_exclusion_inspection_failed");
  }
  return indexes.map(index => input.entries[index]!);
}
