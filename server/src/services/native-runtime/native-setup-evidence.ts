import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { retainNativePiConversationEvidence, retainNativeRuntimeEvidence, summarizeNativeRuntimeTree } from "./native-pi-conversation-evidence.js";
import { logger } from "../../middleware/logger.js";

/** Setup has no agent/conversation yet. Bind its private evidence to the company
 * and purpose instead, on the same filesystem as the permanent evidence move. */
export async function createNativeSetupRuntime(companyId: string): Promise<string> {
  const base = resolve(process.env.PAPERCLIP_RUNNER_STATE_DIR ?? join(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner", "durable-sessions"));
  await mkdir(base, { recursive: true, mode: 0o700 });
  const scope = createHash("sha256").update(JSON.stringify([companyId, "setup-probe"])).digest("hex");
  const directory = join(base, scope);
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
    || process.geteuid && metadata.uid !== process.geteuid()) throw new Error("native_setup_evidence_scope_unsafe");
  return mkdtemp(join(directory, "paperclip-native-setup-"));
}

/** Called only after physical retirement. A failed move leaves the source and
 * blocks cleanup. All providers' metadata/failure diagnostics are evidence too.
 * piProbe is the historical name for whole-tree retention, not a provider gate. */
export async function cleanupNativeSetupRuntime(root: string, piProbe = false): Promise<void> {
  if (piProbe ? await retainNativeRuntimeEvidence(root) : await retainNativePiConversationEvidence(root)) return;
  const source = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!source) return; // A repeated confirmed cleanup has nothing left to remove.
  if (piProbe) throw new Error("native_setup_evidence_not_retained");
  const inventory = await summarizeNativeRuntimeTree(root);
  await rm(root, { recursive: true, force: true });
  logger.info({ event: "native_scratch_removed", path: root, ...inventory });
}
