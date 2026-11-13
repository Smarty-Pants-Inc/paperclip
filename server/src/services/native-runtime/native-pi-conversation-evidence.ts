import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";

export const NATIVE_PI_CONVERSATION_EVIDENCE_DIRECTORY = "conversation-evidence";
const SCOPE = /^[a-f0-9]{64}$/;
const QUARANTINE_SCOPE = /^([a-f0-9]{64})\.identity_(?:indeterminate|mismatch)\./;
const PI_HISTORY_DIRECTORIES = new Set(["pi", "pi-agent", "pi-home", ".pi"]);

export function isNativePiConversationDirectoryName(name: string): boolean {
  return PI_HISTORY_DIRECTORIES.has(name);
}

/** Identify the provider-owned history, not its contents. Invalid, unreadable,
 * foreign and symlink asides are evidence too; never parse or follow them. */
export async function hasNativePiConversationEvidence(root: string): Promise<boolean> {
  const stat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (isNativePiConversationDirectoryName(entry.name)) return true;
    if (entry.name === "manifest.json" && entry.isFile()) {
      // A failed/partial transfer may have a Pi manifest but no history directory.
      const manifest = JSON.parse(await readFile(path.join(root, entry.name), "utf8"));
      if (manifest?.providerKind === "pi_rpc" || manifest?.driverKind === "pi_rpc"
        || manifest?.directories?.some((directory: { name?: unknown }) => isNativePiConversationDirectoryName(String(directory?.name)))) return true;
    }
    if (entry.isDirectory() && await hasNativePiConversationEvidence(path.join(root, entry.name))) return true;
  }
  return false;
}

function sourceScope(root: string): { base: string; scope: string } | null {
  for (let current = path.resolve(root); path.dirname(current) !== current; current = path.dirname(current)) {
    const name = path.basename(current);
    const scope = SCOPE.test(name) ? name : QUARANTINE_SCOPE.exec(name)?.[1];
    if (scope) {
      const parent = path.dirname(current);
      return { base: path.basename(parent) === "quarantine" ? path.dirname(parent) : parent, scope };
    }
  }
  return null;
}

async function privateDirectory(directory: string) {
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || process.geteuid && stat.uid !== process.geteuid()) throw new Error("native_pi_evidence_directory_unsafe");
}

/** Atomically retain an entire retired Pi-bearing tree before ANY recursive
 * removal. The containing source scope binds company/agent/conversation; this
 * namespace has no expiry consumer and is not a resume or public download path.
 * No hard links, reads of conversation bytes, permission changes or overwrites.
 * Any inspection/rename failure leaves the source intact and blocks deletion.
 * Unattributed pre-upgrade quarantine tombstones stay private and unadmitted. */
export async function retainNativePiConversationEvidence(root: string, stateBase?: string): Promise<boolean> {
  if (path.resolve(root).split(path.sep).includes(NATIVE_PI_CONVERSATION_EVIDENCE_DIRECTORY)) {
    throw new Error("native_pi_evidence_not_expirable");
  }
  const binding = sourceScope(root);
  const base = stateBase ?? binding?.base;
  // Upload/restore scratch trees have a verified source/object elsewhere, not
  // a controller session scope. Their cleanup is not retirement of that source.
  if (!base) return false;
  const evidence = path.join(path.resolve(base), NATIVE_PI_CONVERSATION_EVIDENCE_DIRECTORY);
  if (!await hasNativePiConversationEvidence(root)) return false;
  const scope = binding?.scope ?? `unattributed-${createHash("sha256").update(path.resolve(root)).digest("hex")}`;
  await privateDirectory(evidence);
  const scoped = path.join(evidence, scope);
  await privateDirectory(scoped);
  const destination = path.join(scoped, randomUUID());
  await rename(root, destination); // EXDEV also fails closed: never copy then unlink.
  return true;
}
