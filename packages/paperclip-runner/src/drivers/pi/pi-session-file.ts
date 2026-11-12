import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { PersistedHarnessSession } from "../../contracts/harness-driver.js";
import { PiNativeAdmissionError } from "./pi-native-config.js";

export function piSessionFileInvalid(): PiNativeAdmissionError {
  return new PiNativeAdmissionError("pi_session_file_invalid", "Saved Pi session file is corrupt, foreign, or has a different identity; refusing replacement.");
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
}): Promise<string> {
  const { snapshot, signal } = input;
  signal.throwIfAborted();
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
      for await (const line of handle.readLines()) {
        signal.throwIfAborted();
        if (!line.trim()) continue;
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
      }
      if (header) throw piSessionFileInvalid();
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
