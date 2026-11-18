import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { retainNativePiConversationEvidence, retainNativeRuntimeEvidence, summarizeNativeRuntimeTree } from "./native-pi-conversation-evidence.js";
import { logger } from "../../middleware/logger.js";

// Only the creator may retire setup scratch. A scope-shaped name is evidence
// attribution, not authority to move a live/durable session (or a replaced root).
const setupRuntimeOwners = new Map<string, { dev: number; ino: number }>();

export function nativeSetupScopeDigest(companyId: string): string {
  return createHash("sha256").update(JSON.stringify([companyId, "setup-probe"])).digest("hex");
}

/** Setup has no agent/conversation yet. Bind its private evidence to the company
 * and purpose instead, on the same filesystem as the permanent evidence move. */
export async function createNativeSetupRuntime(companyId: string): Promise<string> {
  const base = resolve(process.env.PAPERCLIP_RUNNER_STATE_DIR ?? join(resolvePaperclipInstanceRoot(), "runtime", "paperclip-runner", "durable-sessions"));
  await mkdir(base, { recursive: true, mode: 0o700 });
  const scope = nativeSetupScopeDigest(companyId);
  const directory = join(base, scope);
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
    || process.geteuid && metadata.uid !== process.geteuid()) throw new Error("native_setup_evidence_scope_unsafe");
  const root = await mkdtemp(join(directory, "paperclip-native-setup-"));
  const { dev, ino } = await lstat(root);
  setupRuntimeOwners.set(resolve(root), { dev, ino });
  return root;
}

/** Called only after physical retirement. A failed move leaves the source and
 * blocks cleanup. All providers' metadata/failure diagnostics are evidence too.
 * piProbe is the historical name for whole-tree retention, not a provider gate.
 * Unknown/replaced roots stay intact; only this process's created scratch can move. */
export async function cleanupNativeSetupRuntime(root: string, piProbe = false): Promise<void> {
  const key = resolve(root);
  const source = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!source) {
    setupRuntimeOwners.delete(key);
    return; // A repeated confirmed cleanup has nothing left to remove.
  }
  const owner = setupRuntimeOwners.get(key);
  if (!owner || !source.isDirectory() || source.isSymbolicLink() || source.dev !== owner.dev || source.ino !== owner.ino) {
    throw new Error("native_setup_evidence_not_owned");
  }
  if (piProbe ? await retainNativeRuntimeEvidence(root) : await retainNativePiConversationEvidence(root)) {
    setupRuntimeOwners.delete(key);
    return;
  }
  if (piProbe) throw new Error("native_setup_evidence_not_retained");
  const inventory = await summarizeNativeRuntimeTree(root);
  await rm(root, { recursive: true, force: true });
  setupRuntimeOwners.delete(key);
  logger.info({ event: "native_scratch_removed", path: root, ...inventory });
}
