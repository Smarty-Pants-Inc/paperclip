import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, openSync, closeSync, fsyncSync } from "node:fs";
import { lstat, mkdir, opendir, open, rename } from "node:fs/promises";
import path from "node:path";
import { logger } from "../../middleware/logger.js";

/** Metadata only: never open file contents or follow symlinks. Bound both work
 * and directory depth; an incomplete inventory blocks destructive cleanup. */
export async function summarizeNativeRuntimeTree(root: string): Promise<{ totalBytes: number; fileCount: number }> {
  let totalBytes = 0, fileCount = 0, entries = 0;
  async function visit(filename: string, depth: number): Promise<void> {
    if (++entries > 100_000 || depth > 128) throw new Error("native_evidence_inventory_limit");
    const metadata = await lstat(filename);
    if (metadata.isDirectory()) {
      for await (const entry of await opendir(filename)) await visit(path.join(filename, entry.name), depth + 1);
    } else {
      totalBytes += metadata.size;
      fileCount++;
    }
  }
  await visit(root, 0);
  return { totalBytes, fileCount };
}

export const NATIVE_PI_CONVERSATION_EVIDENCE_DIRECTORY = "conversation-evidence";
const SCOPE = /^[a-f0-9]{64}$/;
const QUARANTINE_SCOPE = /^([a-f0-9]{64})\.identity_(?:indeterminate|mismatch)\./;
const PI_HISTORY_DIRECTORIES = new Set(["pi", "pi-agent", "pi-home", ".pi"]);

export function isNativePiConversationDirectoryName(name: string): boolean {
  return PI_HISTORY_DIRECTORIES.has(name);
}

/** Pi writes one JSON record per line; session-manager.ts creates the first
 * record with `type: "session"` (see the installed pi runtime source). */
const MAX_EVIDENCE_ENTRIES = 100_000;
const MAX_EVIDENCE_DEPTH = 128;
const MAX_EVIDENCE_HEADER_BYTES = 4 * 1024;
const MAX_EVIDENCE_MANIFEST_BYTES = 1024 * 1024;
const PI_SESSION_RECORD_PREFIX = /^\s*\{\s*"type"\s*:\s*"session"/;

/** Read up to `cap` bytes, looping over legal short reads. Returns null when
 * the file could not be read up to min(size, cap): the caller then keeps. */
async function readPrefix(file: import("node:fs/promises").FileHandle, size: number, cap: number): Promise<Buffer | null> {
  const want = Math.min(size, cap);
  const buffer = Buffer.alloc(want);
  let total = 0;
  while (total < want) {
    const { bytesRead } = await file.read(buffer, total, want - total, total);
    if (bytesRead <= 0) break;
    total += bytesRead;
  }
  return total === want ? buffer : null;
}

/** A leading UTF-8 BOM is not part of the record. */
const withoutBom = (text: string) => text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

async function hasPiSessionHeader(filename: string): Promise<boolean> {
  let file;
  try {
    file = await open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile()) return true;
    const bytes = await readPrefix(file, stat.size, MAX_EVIDENCE_HEADER_BYTES);
    if (bytes === null) return true; // incomplete read: undecidable, keep.
    const newline = bytes.indexOf(0x0a);
    const firstLine = withoutBom(bytes.subarray(0, newline < 0 ? bytes.length : newline).toString("utf8"));
    // A first line cut by the read cap is undecidable only if it starts as a
    // Pi session record; keep that. Ordinary readable files (binaries, logs,
    // locks, empty files, other JSON) are not Pi history.
    if (newline < 0 && stat.size > MAX_EVIDENCE_HEADER_BYTES) return PI_SESSION_RECORD_PREFIX.test(firstLine);
    try {
      return (JSON.parse(firstLine) as { type?: unknown })?.type === "session";
    } catch {
      return false;
    }
  } catch {
    // Only an I/O failure (EACCES, EIO, ELOOP, ...) is undecidable: keep.
    return true;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

/** Keep existing name/manifest rules and also recognize renamed raw Pi sessions.
 * Bound traversal and reads; never follow symlinks. Incomplete scans fail closed. */
export async function hasNativePiConversationEvidence(root: string): Promise<boolean> {
  const stat = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
  let entriesSeen = 0;
  async function visit(directory: string, depth: number): Promise<boolean> {
    if (depth > MAX_EVIDENCE_DEPTH) return true;
    try {
      for await (const entry of await opendir(directory)) {
        if (++entriesSeen > MAX_EVIDENCE_ENTRIES) return true;
        if (isNativePiConversationDirectoryName(entry.name)) return true;
        const filename = path.join(directory, entry.name);
        if (entry.name === "manifest.json" && entry.isFile()) {
          let manifestFile;
          try {
            manifestFile = await open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
            const manifestStat = await manifestFile.stat();
            if (!manifestStat.isFile() || manifestStat.size > MAX_EVIDENCE_MANIFEST_BYTES) return true;
            const buffer = await readPrefix(manifestFile, manifestStat.size, MAX_EVIDENCE_MANIFEST_BYTES);
            if (buffer === null) return true; // incomplete read: undecidable, keep.
            let manifest: { providerKind?: unknown; driverKind?: unknown; directories?: unknown } | null = null;
            // A readable manifest that is not JSON is not a Pi manifest.
            try { manifest = JSON.parse(withoutBom(buffer.toString("utf8"))); } catch { manifest = null; }
            if (manifest?.providerKind === "pi_rpc" || manifest?.driverKind === "pi_rpc"
              || (Array.isArray(manifest?.directories) && manifest.directories.some((child: { name?: unknown }) => isNativePiConversationDirectoryName(String(child?.name))))) return true;
          } catch {
            // I/O failure on the manifest is undecidable: keep.
            return true;
          } finally {
            await manifestFile?.close().catch(() => undefined);
          }
        }
        if (entry.isDirectory()) {
          if (await visit(filename, depth + 1)) return true;
        } else if (entry.isFile() && await hasPiSessionHeader(filename)) {
          return true;
        }
      }
      return false;
    } catch {
      return true;
    }
  }
  return visit(root, 0);
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

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}


async function privateDirectory(directory: string) {
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  // Persist the new namespace/scope entry before publishing evidence beneath it.
  syncDirectory(path.dirname(directory));
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
  if (!stateBase && !sourceScope(root)) return false;
  if (!await hasNativePiConversationEvidence(root)) return false;
  return retainNativeRuntimeEvidence(root, stateBase);
}

/** Setup probes may contain only raw diagnostics (including failed admission).
 * Their owner retains the complete tree without a provider/history filter. */
export async function retainNativeRuntimeEvidence(root: string, stateBase?: string): Promise<boolean> {
  if (path.resolve(root).split(path.sep).includes(NATIVE_PI_CONVERSATION_EVIDENCE_DIRECTORY)) {
    throw new Error("native_pi_evidence_not_expirable");
  }
  const binding = sourceScope(root);
  const base = stateBase ?? binding?.base;
  // Upload/restore scratch trees have a verified source/object elsewhere, not
  // a controller session scope. Their cleanup is not retirement of that source.
  if (!base) return false;
  const evidence = path.join(path.resolve(base), NATIVE_PI_CONVERSATION_EVIDENCE_DIRECTORY);
  const source = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!source) return false;
  if (!source.isDirectory() || source.isSymbolicLink()) throw new Error("native_pi_evidence_source_unsafe");
  const scope = binding?.scope ?? `unattributed-${createHash("sha256").update(path.resolve(root)).digest("hex")}`;
  await privateDirectory(evidence);
  const scoped = path.join(evidence, scope);
  await privateDirectory(scoped);
  const destination = path.join(scoped, randomUUID());
  const inventory = await summarizeNativeRuntimeTree(root);
  await rename(root, destination); // EXDEV also fails closed: never copy then unlink.
  // Both names changed; persist both directory entries before the caller may
  // remove or report success for the original scratch.
  syncDirectory(path.dirname(path.resolve(root)));
  syncDirectory(scoped);
  logger.info({ event: "native_evidence_retained", source: root, destination, scope, ...inventory });
  return true;
}
