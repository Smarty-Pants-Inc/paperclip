import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
  await rename(root, join(dirname(root), randomUUID()));
}
