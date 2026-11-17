import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, unlink, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PrivateFileVerificationError, writePrivateFile, type PrivateFileOperations } from "./private-file.js";

// P1c5 (gate 3, run a12c9ff2, box bx_pfay2d8b): the warm attach refresh failed
// while the box was still hydrating from a snapshot. The existing
// instructions file was still on the lazy backing store, the new temporary
// file was local, and rename(2) returned EXDEV.
//
// This is a REAL cross-device layout, not a mocked rename: an unprivileged
// FUSE file system (test/fixtures/lazy-hydration-fuse.py, mounted through
// fusermount3) returns EXDEV from the kernel for a same-directory rename onto
// a not-yet-local file. It needs Linux, /dev/fuse and fusermount3.
const fixture = fileURLToPath(new URL("../../test/fixtures/lazy-hydration-fuse.py", import.meta.url));
const fuseAvailable = process.platform === "linux"
  && spawnSync("sh", ["-c", "test -c /dev/fuse && command -v fusermount3 && command -v python3"]).status === 0;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "private-file-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Mounts the hydrating box: `name` exists on the lazy backing store. */
async function hydratingMount(name: string, existing: string): Promise<string> {
  const scratch = await temporaryDirectory();
  const mountpoint = join(scratch, "mnt");
  await writeFile(join(scratch, "seed"), existing);
  await mkdir(mountpoint);
  const child: ChildProcess = spawn("python3", [fixture, mountpoint, `${name}=${join(scratch, "seed")}`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`FUSE fixture exited ${code}`)));
    child.stdout!.on("data", (chunk: Buffer) => { if (chunk.toString().includes("ready")) resolve(); });
  });
  cleanups.push(async () => {
    spawnSync("fusermount3", ["-u", mountpoint]);
    if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
  });
  return mountpoint;
}

const instructions = (bytes: number) => "Refreshed Paperclip host instructions.\n".repeat(Math.ceil(bytes / 39)).slice(0, bytes);

describe("writePrivateFile", () => {
  it("keeps the atomic rename as the normal path and leaves no temporary file", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "session-1.instructions.md");
    await writeFile(file, "old");
    await writePrivateFile(file, "new instructions");
    expect(await readFile(file, "utf8")).toBe("new instructions");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["session-1.instructions.md"]);
  });

  it.skipIf(!fuseAvailable)("the hydrating layout really returns EXDEV for a same-directory rename (control)", async () => {
    const name = "session-1-8b0f.instructions.md";
    const mountpoint = await hydratingMount(name, "old\n");
    await writeFile(join(mountpoint, `${name}.tmp-control`), "new\n");
    await expect(rename(join(mountpoint, `${name}.tmp-control`), join(mountpoint, name))).rejects.toMatchObject({ code: "EXDEV" });
    await unlink(join(mountpoint, `${name}.tmp-control`));
  });

  it.skipIf(!fuseAvailable)("completes a verified in-place write when rename returns EXDEV on a hydrating box (real FUSE layout)", async () => {
    const name = "session-1-8b0f.instructions.md";
    const mountpoint = await hydratingMount(name, "old instructions from the snapshot\n");
    const file = join(mountpoint, name);
    const content = instructions(9_000);
    // At ffbf1ef6 this rejected with the run's error text:
    // "EXDEV: cross-device link not permitted, rename '<file>.tmp-<random>' -> '<file>'".
    await writePrivateFile(file, content);
    const written = await readFile(file);
    expect(written.length).toBe(Buffer.byteLength(content));
    expect(createHash("sha256").update(written).digest("hex")).toBe(createHash("sha256").update(content).digest("hex"));
    expect(await readdir(mountpoint)).toEqual([name]); // every temporary file was removed
  });

  it("fails closed with a named error when the in-place read-back does not match (EXDEV injected at the fs seam)", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "session-1.instructions.md");
    await writeFile(file, "old");
    const exdev = Object.assign(new Error("EXDEV: cross-device link not permitted, rename"), { code: "EXDEV" });
    // INJECTED (not a real layout): rename reports EXDEV and the read-back
    // returns bytes other than those written (a lazy store serving stale data).
    const operations: Partial<PrivateFileOperations> = {
      rename: async () => { throw exdev; },
      readBack: async () => Buffer.from("old"),
    };
    await expect(writePrivateFile(file, "new instructions", operations)).rejects.toBeInstanceOf(PrivateFileVerificationError);
    await expect(writePrivateFile(file, "new instructions", operations)).rejects.toThrow("Private runtime file could not be verified after an in-place write");
    expect(await readdir(directory)).toEqual(["session-1.instructions.md"]);
  });

  it("does not take the in-place fallback for any error other than EXDEV", async () => {
    const directory = await temporaryDirectory();
    const file = join(directory, "session-1.instructions.md");
    await writeFile(file, "old");
    const busy = Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
    await expect(writePrivateFile(file, "new", { rename: async () => { throw busy; } })).rejects.toBe(busy);
    expect(await readFile(file, "utf8")).toBe("old");
    expect(await readdir(directory)).toEqual(["session-1.instructions.md"]);
  });
});
