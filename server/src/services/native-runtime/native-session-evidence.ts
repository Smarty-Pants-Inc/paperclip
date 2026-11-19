// Evidence-only copy of a warm native session's provider trace (READ.md §4,
// "a separately identified evidence-only session/trace snapshot").
//
// A succeeded warm run keeps its box (keep_running) and its provider session;
// the resumable harness backup is written only when the session is closed and
// suspended. This module copies the same provider persistence directories off
// the live box right after the turn settles, without suspending it and without
// writing on it, so a lost warm box loses no trace. The copy is stored through
// the existing harness-backup persister (encrypt, insert pending, upload, read
// back and hash, then mark current) under a distinct manifest kind and a
// per-run scope digest. Restore and destroy/retire decisions never read it
// (native-harness-backup-storage.ts `resumableNativeHarnessBackupRow`).
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { logger } from "../../middleware/logger.js";
import { getStorageService } from "../../storage/index.js";
import type { StorageService } from "../../storage/types.js";
import { durableNativeHarnessStorage, NATIVE_SESSION_EVIDENCE_KIND, persistNativeHarnessBackup } from "./native-harness-backup-storage.js";

export { NATIVE_SESSION_EVIDENCE_KIND };

export type NativeSessionEvidenceSource = {
  runner: CommandManagedRuntimeRunner;
  /** sha256(sessionScopeId), the scope digest the resumable backup uses. */
  sessionScopeDigest: string;
  normalizedSessionId: string;
  /** The box: the sandbox provider's allocation id. */
  providerLeaseId: string;
  environmentId: string | null;
  /** The environment_leases row admitted for this backend's run. */
  environmentLeaseId: string | null;
  /** The configured provider persistence directories the close capture copies. */
  directories: Array<{ name: string; sourcePath: string; excludeEntries: readonly string[] }>;
};

export type NativeSessionEvidenceRequest = {
  db: Db; source: NativeSessionEvidenceSource;
  companyId: string; issueId: string; runId: string;
};

/** Bounded in-process retry; tests shorten the delay. */
export const nativeSessionEvidenceRetry = { attempts: 3, delayMs: 2_000, deadlineMs: 300_000 };
/** Test seam only: production resolves the configured storage service. */
export const nativeSessionEvidenceStorage: { override: StorageService | null } = { override: null };
/** Copies in flight, for idle probes and tests; never awaited by the turn path. */
export const nativeSessionEvidenceCopies = new Map<string, Promise<NativeSessionEvidenceOutcome>>();

export type NativeSessionEvidenceOutcome =
  | { status: "complete"; attempts: number; scopeDigest: string; sourceSha256: string; bytes: number; fileCount: number }
  | { status: "pending"; attempts: number; reason: string };

export function nativeSessionEvidenceScopeDigest(sessionScopeDigest: string, runId: string): string {
  return createHash("sha256").update(JSON.stringify([NATIVE_SESSION_EVIDENCE_KIND, sessionScopeDigest, runId])).digest("hex");
}

function evidenceStorage(): StorageService {
  // S3 when configured; otherwise the server's own configured storage (local
  // disk on the controller), which is still off the execution box.
  return nativeSessionEvidenceStorage.override ?? durableNativeHarnessStorage() ?? getStorageService();
}

function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
function excludedEntries(entries: readonly string[]): readonly string[] {
  for (const entry of entries) {
    if (!entry || entry.startsWith("/") || entry.split("/").some(part => !/^[A-Za-z0-9._-]+$/.test(part) || part === "." || part === "..")) {
      throw new Error("native_session_evidence_exclusion_invalid");
    }
  }
  return entries;
}

/** Read-only inventory of regular files: "sha256 bytes ./path" sorted bytewise.
 * Writes nothing on the box (no mktemp, no snapshot). */
async function remoteInventory(runner: CommandManagedRuntimeRunner, sourcePath: string, excluded: readonly string[]): Promise<string | null> {
  const prune = excluded.length ? `\\( ${excluded.map(entry => `-path ${quote(`./${entry}`)}`).join(" -o ")} \\) -prune -o ` : "";
  const result = await runner.execute({
    command: "sh",
    args: ["-c", `export LC_ALL=C; [ -d ${quote(sourcePath)} ] || { echo PAPERCLIP_ABSENT; exit 0; }; cd ${quote(sourcePath)} || exit 3; ` +
      `find . ${prune}-type f -print | sort | while IFS= read -r f; do ` +
      `b=$(wc -c < "$f" | tr -d ' ') || exit 4; h=$(sha256sum < "$f") || exit 4; printf '%s %s %s\\n' "\${h%% *}" "$b" "$f"; done`],
    bypassSession: true,
    timeoutMs: 120_000,
  });
  if (result.exitCode !== 0 || result.timedOut) throw new Error("native_session_evidence_inventory_failed");
  if (result.stdout.trim() === "PAPERCLIP_ABSENT") return null;
  return result.stdout;
}

async function localInventory(root: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (directory: string, prefix: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), relative = `${prefix}/${entry.name}`;
      const metadata = await lstat(path);
      if (metadata.isDirectory()) await walk(path, relative);
      else if (metadata.isFile()) {
        const bytes = await readFile(path);
        lines.push(`${createHash("sha256").update(bytes).digest("hex")} ${bytes.length} ${relative}`);
      } else await unlink(path); // links/devices are not trace evidence and are never followed
    }
  };
  await walk(root, ".");
  return lines.sort((a, b) => Buffer.compare(Buffer.from(a.split(" ").slice(2).join(" ")), Buffer.from(b.split(" ").slice(2).join(" "))))
    .map(line => `${line}\n`).join("");
}

function inventoryTotals(inventory: string) {
  let bytes = 0, fileCount = 0;
  for (const line of inventory.split("\n")) if (line) { fileCount++; bytes += Number(line.split(" ")[1]); }
  return { bytes, fileCount, sha256: createHash("sha256").update(inventory).digest("hex") };
}

function extract(archive: Buffer, target: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("tar", ["--no-same-owner", "--no-same-permissions", "-xzf", "-", "-C", target], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += String(chunk).slice(0, 512); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolvePromise() : reject(new Error(`native_session_evidence_extract_failed: ${stderr.trim()}`)));
    child.stdin.end(archive);
  });
}

/** Copy one directory off the box: inventory before, stream a tar (the pipe's
 * status goes to stderr, not a file), inventory after. Any difference is a
 * changed source and the whole attempt is retried. */
async function copyDirectory(runner: CommandManagedRuntimeRunner, directory: NativeSessionEvidenceSource["directories"][number], target: string) {
  const excluded = excludedEntries(directory.excludeEntries);
  const before = await remoteInventory(runner, directory.sourcePath, excluded);
  if (before === null) return null;
  const result = await runner.execute({
    command: "sh",
    args: ["-c", `{ tar ${excluded.map(entry => quote(`--exclude=./${entry}`)).join(" ")} -czf - -C ${quote(directory.sourcePath)} .; ` +
      `printf 'paperclip_tar_status=%s\\n' "$?" >&2; } | base64`],
    bypassSession: true,
    timeoutMs: 120_000,
  });
  if (result.exitCode !== 0 || result.timedOut || !/paperclip_tar_status=0\b/.test(result.stderr)) {
    // tar exits 1 for "file changed as we read it": a moving source, retried.
    throw new Error("native_session_evidence_source_changed");
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  await extract(Buffer.from(result.stdout.replace(/\s+/g, ""), "base64"), target);
  const copied = await localInventory(target);
  const after = await remoteInventory(runner, directory.sourcePath, excluded);
  if (copied !== before || after !== before) throw new Error("native_session_evidence_source_changed");
  return { name: directory.name, before: inventoryTotals(before), after: inventoryTotals(after), copied: inventoryTotals(copied) };
}

async function captureAndPersist(request: NativeSessionEvidenceRequest, storage: StorageService) {
  const root = await mkdtemp(join(tmpdir(), "pc-session-evidence-"));
  try {
    const directories = [];
    for (const directory of request.source.directories) {
      const copied = await copyDirectory(request.source.runner, directory, join(root, directory.name));
      if (copied) directories.push(copied);
    }
    if (!directories.length) throw new Error("native_session_evidence_source_absent");
    const sourceSha256 = createHash("sha256").update(directories.map(entry => `${entry.name} ${entry.before.sha256}`).join("\n")).digest("hex");
    const manifest = { schema: NATIVE_SESSION_EVIDENCE_KIND, kind: NATIVE_SESSION_EVIDENCE_KIND,
      restorable: false, companyId: request.companyId, issueId: request.issueId, runId: request.runId,
      normalizedSessionId: request.source.normalizedSessionId, sessionScopeDigest: request.source.sessionScopeDigest,
      providerLeaseId: request.source.providerLeaseId, sourceSha256,
      directories: directories.map(entry => ({ name: entry.name, sha256: entry.before.sha256, bytes: entry.before.bytes,
        fileCount: entry.before.fileCount, afterSha256: entry.after.sha256, copiedSha256: entry.copied.sha256 })),
      capturedAt: new Date().toISOString() };
    await writeFile(join(root, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    const scopeDigest = nativeSessionEvidenceScopeDigest(request.source.sessionScopeDigest, request.runId);
    // The existing persister reads the uploaded object back and checks its
    // hash before it marks the row current; a failure leaves no current row.
    await persistNativeHarnessBackup({ db: request.db, storage, scopeDigest, root,
      owner: { kind: "session_evidence", companyId: request.companyId, issueId: request.issueId, runId: request.runId },
      signal: AbortSignal.timeout(nativeSessionEvidenceRetry.deadlineMs) });
    return { scopeDigest, sourceSha256, bytes: directories.reduce((total, entry) => total + entry.before.bytes, 0),
      fileCount: directories.reduce((total, entry) => total + entry.before.fileCount, 0) };
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** Durable, observable "evidence copy pending" marker on the admitted lease
 * row. It is not the backup-missing custody marker and grants or blocks no
 * destroy decision. */
async function writePendingMarker(request: NativeSessionEvidenceRequest, value: Record<string, unknown> | null) {
  const leaseId = request.source.environmentLeaseId;
  if (!leaseId) return false;
  const rows = await request.db.update(environmentLeases).set({
    metadata: value ? sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ nativeSessionEvidencePending: value })}::jsonb`
      : sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) - 'nativeSessionEvidencePending'`,
    updatedAt: new Date(),
  }).where(and(eq(environmentLeases.id, leaseId), eq(environmentLeases.companyId, request.companyId),
    value ? undefined : sql`${environmentLeases.metadata}->'nativeSessionEvidencePending'->>'runId' = ${request.runId}`))
    .returning({ id: environmentLeases.id });
  return rows.length > 0;
}

async function runEvidenceCopy(request: NativeSessionEvidenceRequest): Promise<NativeSessionEvidenceOutcome> {
  const marker = { runId: request.runId, sessionId: request.source.normalizedSessionId,
    providerLeaseId: request.source.providerLeaseId, since: new Date().toISOString() };
  await writePendingMarker(request, { ...marker, attempts: 0 }).catch(() => false);
  let reason = "unknown";
  for (let attempt = 1; attempt <= nativeSessionEvidenceRetry.attempts; attempt++) {
    try {
      const stored = await captureAndPersist(request, evidenceStorage());
      await writePendingMarker(request, null).catch(() => false);
      return { status: "complete", attempts: attempt, ...stored };
    } catch (error) {
      reason = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 256);
      await writePendingMarker(request, { ...marker, attempts: attempt, lastError: reason, updatedAt: new Date().toISOString() }).catch(() => false);
      if (attempt < nativeSessionEvidenceRetry.attempts) await new Promise(resolve => setTimeout(resolve, nativeSessionEvidenceRetry.delayMs * attempt));
    }
  }
  // One structured line a journald watcher can match; the marker stays.
  logger.error({ boxId: request.source.providerLeaseId, providerLeaseId: request.source.providerLeaseId,
    companyId: request.companyId, runId: request.runId, environmentId: request.source.environmentId,
    attempts: nativeSessionEvidenceRetry.attempts, reason },
  `custody_evidence_pending_alarm: native session evidence copy did not complete after ${nativeSessionEvidenceRetry.attempts} attempts`);
  return { status: "pending", attempts: nativeSessionEvidenceRetry.attempts, reason };
}

/** Start the copy off the turn path. Returns synchronously; never throws. */
export function scheduleNativeSessionEvidenceCopy(request: NativeSessionEvidenceRequest): Promise<NativeSessionEvidenceOutcome> {
  const key = `${request.companyId}:${request.runId}`;
  const existing = nativeSessionEvidenceCopies.get(key);
  if (existing) return existing;
  const copy = new Promise<void>(resolve => setImmediate(resolve)).then(() => runEvidenceCopy(request))
    .catch((error: unknown): NativeSessionEvidenceOutcome => ({ status: "pending", attempts: 0,
      reason: error instanceof Error ? error.message : String(error) }))
    .finally(() => { nativeSessionEvidenceCopies.delete(key); });
  nativeSessionEvidenceCopies.set(key, copy);
  return copy;
}
