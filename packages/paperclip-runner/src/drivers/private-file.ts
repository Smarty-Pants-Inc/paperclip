import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

const PRIVATE_FILE_MODE = 0o600;

/**
 * A private file could not be proven complete after the EXDEV in-place
 * fallback. The caller fails closed: the attach (and so the turn) does not
 * proceed, and the person sees the server's existing failure note and Retry.
 */
export class PrivateFileVerificationError extends Error {
  override readonly name = "PrivateFileVerificationError";
  constructor() { super("Private runtime file could not be verified after an in-place write"); }
}

/** Test seam only. Production always uses the node:fs/promises defaults. */
export interface PrivateFileOperations {
  rename(from: string, to: string): Promise<void>;
  readBack(filePath: string): Promise<Buffer>;
}

const defaultOperations: PrivateFileOperations = { rename, readBack: readPrivateFile };

/**
 * Atomically replace a bounded private file without following a symlink.
 *
 * rename(2) is the normal path. On EXDEV only (a box still hydrating from a
 * snapshot keeps a not-yet-local existing file on its lazy backing store while
 * the new temporary file is local; Boat does not document this), the content
 * is written in place, fsynced, read back and verified by length and sha256
 * before this returns. Callers await it before the turn starts, so Pi never
 * reads a partial file. The temporary file is removed on every path.
 */
export async function writePrivateFile(filePath: string, value: string, operations: Partial<PrivateFileOperations> = {}): Promise<void> {
  const { rename: renameFile, readBack } = { ...defaultOperations, ...operations };
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length < 1 || bytes.length > 64 * 1024) throw new Error("Private runtime file exceeds its bounded size");
  const temporaryPath = `${filePath}.tmp-${randomBytes(12).toString("hex")}`;
  let handle: FileHandle;
  try {
    handle = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), PRIVATE_FILE_MODE);
  } catch {
    bytes.fill(0);
    throw new Error("Private runtime file could not be opened without links");
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("Private runtime path is not a file");
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    try {
      await renameFile(temporaryPath, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "EXDEV") throw error;
      await writeInPlaceVerified(filePath, bytes, readBack);
    }
    await syncDirectory(dirname(filePath));
  } finally {
    bytes.fill(0);
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

/** EXDEV fallback: open the existing target O_WRONLY|O_TRUNC, write, fsync, then verify. */
async function writeInPlaceVerified(filePath: string, bytes: Buffer, readBack: PrivateFileOperations["readBack"]): Promise<void> {
  const intended = createHash("sha256").update(bytes).digest("hex");
  const handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), PRIVATE_FILE_MODE)
    .catch(() => { throw new Error("Private runtime file could not be opened without links"); });
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Private runtime path is not a file");
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const written = await readBack(filePath).catch(() => Buffer.alloc(0));
  try {
    if (written.length !== bytes.length || createHash("sha256").update(written).digest("hex") !== intended) {
      throw new PrivateFileVerificationError();
    }
  } finally {
    written.fill(0);
  }
}

async function readPrivateFile(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { return await handle.readFile(); }
  finally { await handle.close(); }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { await handle.sync(); }
  finally { await handle.close(); }
}
