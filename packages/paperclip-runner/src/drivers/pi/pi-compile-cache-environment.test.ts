import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { piCompileCacheEnvironment } from "./pi-compile-cache-environment.js";

// Keep reason: the recorded production cache-replication incident and the
// existing Boat EACCES failure. Cache placement must not weaken launch safety.
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-cache-environment-")));
  roots.push(root);
  vi.stubEnv(process.platform === "win32" ? "TEMP" : "TMPDIR", root);
  const runtime = join(root, "durable-sessions", "scope", "pi");
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const privateRoot = join(root, `paperclip-pi-cache-${process.getuid?.() ?? process.pid}`);
  return { root, runtime, privateRoot, cache: join(privateRoot, "node-compile-cache") };
}
it("reuses a private owner-checked cache outside the durable-session tree", async () => {
  const f = await fixture();
  const first = await piCompileCacheEnvironment(f.runtime);
  expect(first).toEqual({ NODE_COMPILE_CACHE: f.cache, NODE_DISABLE_COMPILE_CACHE: undefined });
  expect((await lstat(f.privateRoot)).mode & 0o777).toBe(0o700);
  expect((await lstat(f.cache)).mode & 0o777).toBe(0o700);
  expect((await lstat(f.cache)).uid).toBe(process.getuid?.() ?? (await lstat(f.root)).uid);
  await writeFile(join(f.cache, "compiled"), "derived code");
  expect(await piCompileCacheEnvironment(f.runtime)).toEqual(first);
  expect(await readdir(f.cache)).toEqual(["compiled"]);
  expect(await readdir(f.runtime)).toEqual([]);
});
it.each(["public-root", "root-file", "root-symlink", "unwritable-cache", "cache-file", "cache-symlink"])(
  "disables without repairing or trusting an unsafe %s", async kind => {
    const f = await fixture();
    const outside = join(f.root, "outside");
    await mkdir(outside, { mode: 0o700 });
    if (kind === "root-file") await writeFile(f.privateRoot, "not a directory");
    else if (kind === "root-symlink") await symlink(outside, f.privateRoot);
    else {
      await mkdir(f.privateRoot, { mode: kind === "public-root" ? 0o755 : 0o700 });
      if (kind === "unwritable-cache") await mkdir(f.cache, { mode: 0o500 });
      if (kind === "cache-file") await writeFile(f.cache, "not a directory");
      if (kind === "cache-symlink") await symlink(outside, f.cache);
    }
    try {
      expect((await piCompileCacheEnvironment(f.runtime)).NODE_DISABLE_COMPILE_CACHE).toBe("1");
      expect(await readdir(outside)).toEqual([]);
      if (kind === "public-root") expect((await lstat(f.privateRoot)).mode & 0o777).toBe(0o755);
    } finally {
      if (kind === "unwritable-cache") await chmod(f.cache, 0o700);
    }
  },
);
it("disables when custom TMPDIR would put the cache inside the session runtime", async () => {
  const f = await fixture();
  vi.stubEnv(process.platform === "win32" ? "TEMP" : "TMPDIR", f.runtime);
  expect(await piCompileCacheEnvironment(f.runtime)).toEqual({ NODE_COMPILE_CACHE: undefined, NODE_DISABLE_COMPILE_CACHE: "1" });
  expect(await readdir(f.runtime)).toEqual([]);
});
it("disables when the runtime itself is the cache root", async () => {
  const f = await fixture();
  await mkdir(f.privateRoot, { mode: 0o700 });
  expect(await piCompileCacheEnvironment(f.privateRoot)).toEqual({ NODE_COMPILE_CACHE: undefined, NODE_DISABLE_COMPILE_CACHE: "1" });
  expect(await readdir(f.privateRoot)).toEqual([]);
});
it("disables rather than failing admission when the temporary root is unavailable", async () => {
  const f = await fixture();
  vi.stubEnv(process.platform === "win32" ? "TEMP" : "TMPDIR", join(f.root, "missing"));
  expect(await piCompileCacheEnvironment(f.runtime)).toEqual({ NODE_COMPILE_CACHE: undefined, NODE_DISABLE_COMPILE_CACHE: "1" });
});
