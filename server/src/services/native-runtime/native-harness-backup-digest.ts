import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";

/** The manifest directory digest, streamed so backup work cannot block leases. */
export async function digestBackupDirectoryStreamed(directory: string): Promise<{ sha256: string; bytes: number }> {
  let hash = createHash("sha256");
  let bytes = 0;
  const visit = async (current: string, relative: string): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    if (entries.length === 0) hash.update(`directory:${relative}\0`);
    for (const entry of entries) {
      const entryPath = resolve(current, entry.name);
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const stats = await lstat(entryPath);
      if (entry.isDirectory()) {
        hash.update(`directory:${entryRelative}:${stats.mode & 0o777}\0`);
        await visit(entryPath, entryRelative);
      } else if (entry.isSymbolicLink()) {
        hash.update(`symlink:${entryRelative}:${await readlink(entryPath)}\0`);
      } else if (entry.isFile()) {
        const before = hash.copy();
        const header = (size: number) => `file:${entryRelative}:${stats.mode & 0o777}:${size}\0`;
        hash.update(header(stats.size));
        let fileBytes = 0;
        for await (const chunk of createReadStream(entryPath)) {
          fileBytes += (chunk as Buffer).byteLength;
          hash.update(chunk as Buffer);
        }
        if (fileBytes !== stats.size) {
          const contents = await readFile(entryPath);
          hash = before;
          hash.update(header(contents.byteLength));
          hash.update(contents);
          fileBytes = contents.byteLength;
        }
        bytes += fileBytes;
      } else {
        throw new Error(`runner_harness_backup_unsupported_entry:${entryRelative}`);
      }
    }
  };
  await visit(directory, "");
  return { sha256: `sha256:${hash.digest("hex")}`, bytes };
}
