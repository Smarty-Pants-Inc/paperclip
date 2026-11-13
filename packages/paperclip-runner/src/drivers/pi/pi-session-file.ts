import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { PersistedHarnessSession } from "../../contracts/harness-driver.js";
import { PiNativeAdmissionError } from "./pi-native-config.js";

export function piSessionFileInvalid(): PiNativeAdmissionError {
  return new PiNativeAdmissionError("pi_session_file_invalid", "Saved Pi session file is corrupt, foreign, or has a different identity; refusing replacement.");
}

/** Quarantine only the server-named entry in the execution-host runtime root.
 * Rename, never unlink/truncate/copy through a symlink. Failure is fail-closed:
 * the caller must not launch fresh until the original entry is safely aside. */
export async function quarantineInvalidPiSessionFile(runtimeDirectory: string, normalizedSessionId: string): Promise<string> {
  const directory = await realpath(runtimeDirectory);
  const filename = piSessionName(normalizedSessionId) + ".jsonl";
  const file = join(directory, filename);
  const before = await lstat(file);
  if (!before.isFile() && !before.isSymbolicLink()) throw piSessionFileInvalid();
  return preservePiSessionFile(file, before);
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
    || process.geteuid && metadata.uid !== process.geteuid()) throw piSessionFileInvalid();
}

async function preservePiSessionFile(file: string, before: Stats, permanent = false): Promise<string> {
  let directory = dirname(file);
  if (permanent) {
    // Same non-expiring scoped namespace as native-runtime retirement (J3).
    // Standalone drivers have no controller scope; keep their path digest private.
    const owner = dirname(directory);
    const scoped = /^[a-f0-9]{64}$/u.test(basename(owner));
    const evidence = join(scoped ? dirname(owner) : owner, "conversation-evidence");
    const scope = join(evidence, scoped ? basename(owner) : createHash("sha256").update(directory).digest("hex"));
    await privateDirectory(evidence); await privateDirectory(scope);
    const retained = join(scope, randomUUID()); await privateDirectory(retained);
    directory = join(retained, "pi"); await privateDirectory(directory);
  }
  const preserved = join(directory, `${basename(file)}.invalid-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`);
  await rename(file, preserved);
  const after = await lstat(preserved);
  if (after.dev !== before.dev || after.ino !== before.ino) throw piSessionFileInvalid();
  return basename(preserved);
}

/** Publish only a verified complete prefix, under the same Runner ownership
 * fence as cold recovery. Stage before renaming so a failed write cannot
 * truncate history; the original inode and every byte remain in the aside. */
async function restorePiSessionPrefix(file: string, original: FileHandle, before: Stats, length: number, signal: AbortSignal): Promise<string> {
  const temporary = `${file}.recover-${randomUUID()}`;
  try {
    const replacement = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const buffer = Buffer.alloc(64 * 1024);
      for (let position = 0; position < length;) {
        signal.throwIfAborted();
        const { bytesRead } = await original.read(buffer, 0, Math.min(buffer.length, length - position), position);
        if (!bytesRead) throw piSessionFileInvalid();
        await replacement.writeFile(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      await replacement.sync();
    } finally { await replacement.close(); }
    signal.throwIfAborted();
    const current = await original.stat();
    const named = await lstat(file);
    if (named.dev !== before.dev || named.ino !== before.ino || current.size !== before.size
      || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) throw piSessionFileInvalid();
    const preservedFile = await preservePiSessionFile(file, before, true);
    await rename(temporary, file);
    return preservedFile;
  } finally {
    await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
}

/** Use the runtime's JSON grammar, not a permissive JSONL parser or a repair
 * heuristic. Only a syntax error at EOF can be completed by appending bytes.
 * Unknown runtime diagnostics fail closed through the invalid-file ladder. */
export function isInterruptedPiJson(text: string): boolean {
  try { JSON.parse(text); return false; } catch (error) {
    if (!(error instanceof SyntaxError)) return false;
    if (error.message === "Unexpected end of JSON input") return true;
    const position = / in JSON at position (\d+)(?: |$)/u.exec(error.message);
    return position !== null && Number(position[1]) === text.length
      && ["Unterminated string", "Bad Unicode escape", "Unterminated fractional number", "Exponent part is missing a number",
        "No number after minus sign", "Expected property name or '}'", "Expected double-quoted property name",
        "Expected ':' after property name", "Expected ',' or '}' after property value",
        "Expected ',' or ']' after array element"].some(prefix => error.message.startsWith(prefix));
  }
}

/** Incomplete message records may already have been streamed before Pi's
 * append. Unknown prefixes are conservative; only identified non-message
 * metadata can be silently dropped. Tool results are visible evidence too. */
export function piTailMayHaveVisibleContent(text: string): boolean {
  const type = /^\s*\{\s*"type"\s*:\s*"([^"\\]*)"/u.exec(text)?.[1];
  return type !== "thinking_level_change" && type !== "model_change";
}

export interface PiSessionPrefixRepair {
  reason: "pi_session_file_partial";
  previousSessionId: string;
  normalizedSessionId: string;
  preservedFile: string;
  historyLost: boolean;
}

export function piSessionName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_").replace(/^\.+/u, "").slice(0, 160) || "pi-session";
}

/** Validate before Pi sees --session: Pi may otherwise silently create a new
 * conversation for an unreadable/corrupt file. This runs on the execution host,
 * under the ordinary Runner ownership fence, never on the controller's copy. */
export async function verifyPiSessionFile(input: {
  snapshot: PersistedHarnessSession;
  runtimeDirectory: string;
  filename: string;
  workingDirectory: string;
  signal: AbortSignal;
  onRepair?: (receipt: PiSessionPrefixRepair) => void;
}): Promise<string> {
  const { snapshot, signal } = input;
  signal.throwIfAborted();
  const normalizedSessionId = snapshot.normalizedSessionId;
  if (!normalizedSessionId) throw piSessionFileInvalid();
  try {
    const directory = await realpath(input.runtimeDirectory);
    const file = join(directory, input.filename);
    // Older facade snapshots contain only native/normalized ids. New direct
    // snapshots also carry the file; neither may select another owner's file.
    const savedFile = (snapshot as PersistedHarnessSession & { sessionFile?: unknown }).sessionFile;
    if (savedFile !== undefined && (typeof savedFile !== "string" || !isAbsolute(savedFile) || resolve(savedFile) !== file)) throw piSessionFileInvalid();
    const metadata = await lstat(file);
    if (!metadata.isFile() || (process.geteuid && metadata.uid !== process.geteuid())) throw piSessionFileInvalid();
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (opened.dev !== metadata.dev || opened.ino !== metadata.ino) throw piSessionFileInvalid();
      let header = true;
      const entryIds = new Set<string>();
      const verifyLine = async (line: string) => {
        signal.throwIfAborted();
        if (!line.trim()) return;
        const entry: unknown = JSON.parse(line);
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw piSessionFileInvalid();
        const row = entry as Record<string, unknown>;
        if (header) {
          if (row.type !== "session" || row.id !== snapshot.driverSessionId
            || (snapshot.providerSessionId != null && row.id !== snapshot.providerSessionId)
            || !Number.isInteger(row.version) || (row.version as number) < 1 || (row.version as number) > 3
            || typeof row.timestamp !== "string" || !Number.isFinite(Date.parse(row.timestamp))
            || typeof row.cwd !== "string" || !isAbsolute(row.cwd)
            || await realpath(row.cwd).catch(() => { throw piSessionFileInvalid(); }) !== input.workingDirectory) throw piSessionFileInvalid();
          header = false;
        } else {
          if (typeof row.type !== "string" || row.type === "session" || typeof row.id !== "string" || !row.id
            || entryIds.has(row.id) || (row.parentId !== null && typeof row.parentId !== "string")
            || typeof row.timestamp !== "string" || !Number.isFinite(Date.parse(row.timestamp))) throw piSessionFileInvalid();
          // Do not replicate Pi's evolving entry union, but reject malformed
          // message records rather than allowing a successful empty readback.
          if (row.type === "message") {
            const message = row.message;
            if (!message || typeof message !== "object" || Array.isArray(message)
              || typeof (message as Record<string, unknown>).role !== "string") throw piSessionFileInvalid();
          }
          entryIds.add(row.id);
        }
      };
      // readLines() hides whether EOF terminated the last record. Preserve the
      // byte boundary (including CRLF/UTF-8) instead of reserializing history.
      const buffer = Buffer.alloc(64 * 1024);
      let pending = Buffer.alloc(0), position = 0, completeBytes = 0;
      while (true) {
        signal.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        position += bytesRead;
        pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
        let start = 0;
        for (let end = pending.indexOf(10, start); end !== -1; end = pending.indexOf(10, start)) {
          await verifyLine(pending.subarray(start, end).toString("utf8"));
          start = end + 1;
        }
        completeBytes = position - pending.length + start;
        pending = pending.subarray(start);
      }
      let interrupted = false;
      const finalLine = pending.toString("utf8");
      if (finalLine.trim()) {
        interrupted = isInterruptedPiJson(finalLine);
        if (!interrupted) await verifyLine(finalLine);
      }
      if (header) throw piSessionFileInvalid();
      if (interrupted) {
        try {
          const preservedFile = await restorePiSessionPrefix(file, handle, opened, completeBytes, signal);
          input.onRepair?.({ reason: "pi_session_file_partial", previousSessionId: snapshot.driverSessionId,
            normalizedSessionId, preservedFile, historyLost: piTailMayHaveVisibleContent(finalLine) });
        } catch {
          signal.throwIfAborted();
          // I/O/race failures, including staging cleanup, are not invalid
          // history and must never authorize G-5's fresh-thread fallback.
          throw new PiNativeAdmissionError("pi_session_file_repair_failed", "Interrupted Pi history could not be safely restored; refusing a fresh thread.");
        }
      }
    } finally { await handle.close(); }
    return file;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof PiNativeAdmissionError) throw error;
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new PiNativeAdmissionError("pi_session_file_missing", "Saved Pi session file is missing on the execution host; recovery cannot create a replacement implicitly.");
    }
    throw piSessionFileInvalid();
  }
}
