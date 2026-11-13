import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, opendir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Metadata-only inventory, bounded independently of trace file sizes. An
 * incomplete walk fails closed before rename; symlink targets are never read. */
async function runtimeInventory(root: string): Promise<{ totalBytes: number; fileCount: number }> {
  let totalBytes = 0, fileCount = 0, entries = 0;
  async function visit(filename: string, depth: number): Promise<void> {
    if (++entries > 100_000 || depth > 128) throw new Error("live_eval_evidence_inventory_limit");
    const metadata = await lstat(filename);
    if (metadata.isDirectory()) {
      for await (const entry of await opendir(filename)) await visit(join(filename, entry.name), depth + 1);
    } else {
      totalBytes += metadata.size;
      fileCount++;
    }
  }
  await visit(root, 0);
  return { totalBytes, fileCount };
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
    || process.geteuid && metadata.uid !== process.geteuid()) throw new Error("live_eval_evidence_directory_unsafe");
}

/** Allocate on the evidence filesystem, never in an expiring OS temp root.
 * Pending trees are evidence too: crashes/failed retirement cannot lose bytes. */
export async function createLiveWorkflowRuntime(executionId: string): Promise<string> {
  const base = resolve(process.env.PAPERCLIP_RUNNER_EVAL_EVIDENCE_DIR ?? join(homedir(), ".paperclip", "runner", "eval-evidence"));
  await mkdir(dirname(base), { recursive: true, mode: 0o700 });
  await privateDirectory(base);
  const scope = join(base, createHash("sha256").update(executionId).digest("hex"));
  await privateDirectory(scope);
  return mkdtemp(join(scope, "pending-"));
}

/** Retain the whole runtime, not a parsed/re-encoded trace or digest. This
 * namespace has no expiry consumer. Rename failures leave the source intact. */
export async function retainLiveWorkflowRuntime(root: string): Promise<void> {
  await privateDirectory(dirname(root));
  const destination = join(dirname(root), randomUUID());
  const inventory = await runtimeInventory(root);
  await rename(root, destination);
  // The executor has no diagnostic sink. Use the package's structured stderr
  // convention (also used by the scenario-chat loopback proxy), never console.
  process.stderr.write(`${JSON.stringify({ level: "info", event: "native_evidence_retained",
    source: root, destination, scope: basename(dirname(root)), ...inventory })}\n`);
}
