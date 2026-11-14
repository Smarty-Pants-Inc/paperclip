import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { piCompileCacheEnvironment } from "./pi-compile-cache-environment.js";
import { PiRpcDriver } from "./pi-rpc-driver.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(remote = true, stateDirectory = "durable-sessions") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-cache-migration-"))); roots.push(root);
  const session = join(root, stateDirectory, "scope");
  const runtime = remote ? join(session, "filesystem", "pi") : join(session, "pi");
  const home = remote ? join(session, "filesystem", "pi-agent") : join(session, "pi-agent");
  const hostTmp = join(root, "tmp");
  for (const path of [runtime, home, hostTmp, join(session, "runner")]) await mkdir(path, { recursive: true, mode: 0o700 });
  vi.stubEnv("TMPDIR", hostTmp); vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "operator-home-not-used"));
  return { root, session, runtime, home, hostTmp, legacy: join(runtime, "node-compile-cache"), cache: join(hostTmp, `paperclip-pi-cache-${process.getuid!()}`, "node-compile-cache") };
}
async function launch(f: Awaited<ReturnType<typeof fixture>>) {
  const captured = new Error("captured launch"); let env: NodeJS.ProcessEnv | undefined;
  await expect(new PiRpcDriver({ runtimeDirectory: f.runtime, model: "neutral/model", piRpcThinkingLevel: "off",
    environment: { PI_CODING_AGENT_DIR: f.home }, transportFactory: options => { env = options.env; throw captured; },
  }).openSession({ runId: "migration", normalizedSessionId: "migration", workingDirectory: f.root })).rejects.toBe(captured);
  return env!;
}
it("preserves the entire legacy cache before launching, including nested symlinks", async () => {
  const f = await fixture(); const outside = join(f.root, "outside"); await mkdir(outside);
  await writeFile(join(outside, "keep"), "not cache");
  await mkdir(join(f.legacy, "v24-old"), { recursive: true, mode: 0o700 });
  await writeFile(join(f.legacy, "v24-old", "bytecode"), "derived");
  await symlink(outside, join(f.legacy, "linked"));
  await writeFile(join(f.runtime, "session.jsonl"), "conversation");
  await launch(f);
  expect((await lstat(f.legacy)).isDirectory()).toBe(true);
  expect(await readFile(join(f.legacy, "v24-old", "bytecode"), "utf8")).toBe("derived");
  expect((await lstat(join(f.legacy, "linked"))).isSymbolicLink()).toBe(true);
  expect(await readFile(join(outside, "keep"), "utf8")).toBe("not cache");
  expect(await readFile(join(f.runtime, "session.jsonl"), "utf8")).toBe("conversation");
});
it.each(["symlink", "file", "foreign-owner"])("does not delete a legacy %s", async kind => {
  const f = await fixture(); const target = join(f.root, "target"); await mkdir(target); await writeFile(join(target, "keep"), "keep");
  if (kind === "symlink") await symlink(target, f.legacy);
  else if (kind === "file") await writeFile(f.legacy, "keep");
  else { await mkdir(f.legacy); await writeFile(join(f.legacy, "keep"), "keep"); vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1); }
  await launch(f);
  expect(await lstat(f.legacy)).toBeDefined();
  expect(await readFile(join(target, "keep"), "utf8")).toBe("keep");
});
it.each(["runner", "filesystem/pi-agent", ".", "filesystem", "failover-backups/current", "../conversation-evidence/retired", "../quarantine/retired"])("disables for TMPDIR under persisted %s", async path => {
  const f = await fixture(); const tmp = join(f.session, path); await mkdir(tmp, { recursive: true, mode: 0o700 }); vi.stubEnv("TMPDIR", tmp);
  const env = await launch(f);
  expect(env.NODE_DISABLE_COMPILE_CACHE).toBe("1");
  expect(env.NODE_COMPILE_CACHE).toBeUndefined();
  expect(await readdir(tmp)).not.toContain(`paperclip-pi-cache-${process.getuid!()}`);
});
it("checks local session siblings and physical aliases of a persisted root", async () => {
  const f = await fixture(false); const alias = join(f.root, "tmp-alias"); await symlink(join(f.session, "runner"), alias); vi.stubEnv("TMPDIR", alias);
  expect((await launch(f)).NODE_DISABLE_COMPILE_CACHE).toBe("1");
});
it("keeps the declared session boundary when pi/ is a symlink to an external runtime", async () => {
  const f = await fixture(); const external = join(f.root, "external-runtime"); await mkdir(external);
  await rm(f.runtime, { recursive: true }); await symlink(external, f.runtime);
  vi.stubEnv("TMPDIR", join(f.session, "runner"));
  expect((await launch(f)).NODE_DISABLE_COMPILE_CACHE).toBe("1");
});
it("seeds a compatible legacy runtime cache without modifying its source", async () => {
  const f = await fixture(); await mkdir(join(f.legacy, "v24"), { recursive: true, mode: 0o700 });
  await writeFile(join(f.legacy, "v24", "compiled"), "snapshot warm code");
  expect((await launch(f)).NODE_COMPILE_CACHE).toBe(f.cache);
  expect(await readFile(join(f.cache, "v24", "compiled"), "utf8")).toBe("snapshot warm code");
  expect(await readFile(join(f.legacy, "v24", "compiled"), "utf8")).toBe("snapshot warm code");
});
it.each([true, false])("covers a custom session's siblings without relying on a named state base (remote=%s)", async remote => {
  const f = await fixture(remote, "custom-state"); vi.stubEnv("TMPDIR", join(f.session, "runner"));
  expect((await launch(f)).NODE_DISABLE_COMPILE_CACHE).toBe("1");
});
it("checks a separately persisted agent home and explicit custom state base", async () => {
  const f = await fixture(); const outside = join(f.root, "separate-state"); await mkdir(outside);
  vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", outside); vi.stubEnv("TMPDIR", outside);
  expect((await launch(f)).NODE_DISABLE_COMPILE_CACHE).toBe("1");
  vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", "");
  f.home = join(f.root, "external-agent-home"); await mkdir(f.home);
  vi.stubEnv("TMPDIR", f.home);
  expect((await launch(f)).NODE_DISABLE_COMPILE_CACHE).toBe("1");
});
it("covers remote runtime evidence outside the current session", async () => {
  const f = await fixture(true, ".paperclip-runtime"); const retired = join(f.root, ".paperclip-runtime", "conversation-evidence"); await mkdir(retired); vi.stubEnv("TMPDIR", retired);
  expect((await launch(f)).NODE_DISABLE_COMPILE_CACHE).toBe("1");
});
it("seeds an empty new cache once from the OS/image cache without altering the source", async () => {
  const f = await fixture(); const source = join(f.hostTmp, "node-compile-cache", "v24");
  await mkdir(source, { recursive: true, mode: 0o755 }); await writeFile(join(source, "compiled"), "warm code", { mode: 0o644 });
  await piCompileCacheEnvironment(f.runtime);
  expect(await readFile(join(f.cache, "v24", "compiled"), "utf8")).toBe("warm code");
  expect((await lstat(join(f.cache, "v24"))).mode & 0o777).toBe(0o700);
  expect((await lstat(join(f.cache, "v24", "compiled"))).mode & 0o777).toBe(0o600);
  await writeFile(join(source, "compiled"), "changed source");
  await piCompileCacheEnvironment(f.runtime);
  expect(await readFile(join(f.cache, "v24", "compiled"), "utf8")).toBe("warm code");
  expect(await readFile(join(source, "compiled"), "utf8")).toBe("changed source");
});
it("accepts Node's umask-created version directories protected by a private source root", async () => {
  const f = await fixture(); const source = join(f.hostTmp, "node-compile-cache");
  await mkdir(source, { mode: 0o700 }); await mkdir(join(source, "v24")); await chmod(join(source, "v24"), 0o775);
  await writeFile(join(source, "v24", "compiled"), "warm code"); await chmod(join(source, "v24", "compiled"), 0o664);
  await piCompileCacheEnvironment(f.runtime);
  expect(await readFile(join(f.cache, "v24", "compiled"), "utf8")).toBe("warm code");
});
it("publishes one complete private seed under concurrent launches", async () => {
  const f = await fixture(); const source = join(f.hostTmp, "node-compile-cache", "v24"); await mkdir(source, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 10; i++) await writeFile(join(source, String(i)), Buffer.alloc(64 * 1024, i));
  const launches = await Promise.all(Array.from({ length: 4 }, () => piCompileCacheEnvironment(f.runtime)));
  expect(launches.every(env => env.NODE_COMPILE_CACHE === f.cache && !env.NODE_DISABLE_COMPILE_CACHE)).toBe(true);
  for (let i = 0; i < 10; i++) expect(await readFile(join(f.cache, "v24", String(i)))).toEqual(Buffer.alloc(64 * 1024, i));
  expect((await readdir(join(f.hostTmp, `paperclip-pi-cache-${process.getuid!()}`))).filter(name => name.startsWith(".image-seed-"))).toEqual([]);
});
it.each(["symlink", "public-writable", "nested-symlink"])("ignores an unsafe %s image cache and still launches with a private cache", async kind => {
  const f = await fixture(); const source = join(f.hostTmp, "node-compile-cache"), outside = join(f.root, "outside");
  await mkdir(outside); await writeFile(join(outside, "keep"), "keep");
  if (kind === "symlink") await symlink(outside, source);
  else { await mkdir(source, { mode: 0o700 }); if (kind === "public-writable") await chmod(source, 0o777); else await symlink(outside, join(source, "linked")); }
  expect((await piCompileCacheEnvironment(f.runtime)).NODE_DISABLE_COMPILE_CACHE).toBeUndefined();
  expect(await readdir(f.cache)).toEqual([]);
  expect(await readFile(join(outside, "keep"), "utf8")).toBe("keep");
});
