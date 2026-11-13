// Keep reason: REG-12 made fresh Boat bootstrap fail by inventing an env map,
// then disabled caching on every Node start. Cross the real sh/Node/uid boundary.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import type { CommandManagedDuplexChannel } from "@paperclipai/adapter-utils/command-managed-runtime";
import { remoteCommandArgv } from "@paperclipai/adapter-utils/remote-command-environment";
import {
  classifyEnvironmentCapabilities, environmentRuntimeService,
  type EnvironmentDriverExecuteInput, type EnvironmentRuntimeDriver,
} from "../environment-runtime.js";

const exec = promisify(execFile);
const roots: string[] = [];
const environment = { id: "reg12c-environment", driver: "sandbox" } as Environment;
const lease = { id: "reg12c-lease", environmentId: environment.id, metadata: {} } as EnvironmentLease;
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function boatFixture(privateEnvDirectory = false) {
  const root = await mkdtemp(join(tmpdir(), "reg12c-boat-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const payload = join(workspace, "payload with spaces.cjs");
  await writeFile(payload, "module.exports = 'MODULE_OK';\n");
  const cache = join(root, ".cache", "node-compile-cache");
  const script = `console.log(JSON.stringify({disabled:process.env.NODE_DISABLE_COMPILE_CACHE,cache:process.env.NODE_COMPILE_CACHE,cacheDir:require('node:module').getCompileCacheDir(),value:require(${JSON.stringify(payload)}),uid:process.getuid(),custom:process.env.CUSTOM}));`;
  // No inherited controller cache, XDG directory, or disable flag. Model a fresh box.
  const baseline = { PATH: process.env.PATH!, HOME: root, TMPDIR: root };
  const received: EnvironmentDriverExecuteInput[] = [];
  const driver: EnvironmentRuntimeDriver = {
    driver: "sandbox",
    async acquireRunLease() { return lease; },
    async releaseRunLease() { return lease; },
    async resolveCapabilities() {
      return classifyEnvironmentCapabilities({ verifiedMethods: ["duplexChannelOpen"], declared: { duplexCommandStream: true } });
    },
    async execute(input) {
      received.push(input);
      if (Object.keys(input.env ?? {}).length && !privateEnvDirectory) {
        throw new Error("Boat env file requires a private directory outside the workspace");
      }
      const result = await exec(input.command, input.args ?? [], {
        cwd: workspace, env: { ...baseline, ...input.env }, timeout: 5000,
      });
      return { exitCode: 0, timedOut: false, ...result };
    },
  };
  const runtime = environmentRuntimeService({} as Db, { drivers: [driver] });
  return { root, cache, workspace, script, baseline, received, driver, runtime };
}

type Fixture = Awaited<ReturnType<typeof boatFixture>>;
async function expectCache(f: Fixture, stdout: string) {
  const actual = JSON.parse(stdout);
  expect(actual).toMatchObject({ cache: f.cache, value: "MODULE_OK", uid: process.getuid?.() });
  expect(actual.disabled).toBeUndefined();
  // Node returns the version/architecture/uid-specific subdirectory, not its base.
  expect(actual.cacheDir.startsWith(`${f.cache}/`)).toBe(true);
  expect((await stat(f.cache)).uid).toBe(process.getuid?.());
  expect((await stat(actual.cacheDir)).uid).toBe(process.getuid?.());
  expect((await readdir(actual.cacheDir)).length).toBeGreaterThan(0);
  return actual;
}

const posix = describe.skipIf(process.platform === "win32");
posix("Boat-safe uid-owned remote compile-cache policy", () => {
  it.each(["bootstrap", "probe", "descendant"])("runs %s with an owned, reused cache and no env file", async path => {
    const f = await boatFixture();
    const script = path === "descendant"
      ? `require('node:child_process').execFileSync(process.execPath,['-e',${JSON.stringify(f.script)}],{stdio:'inherit'});`
      : f.script;
    const input = { environment, lease, command: process.execPath, args: ["-e", script], bypassSession: true };
    const first = await f.runtime.execute(input);
    const received = f.received[0]!;
    expect(received).not.toHaveProperty("env");
    const [command, ...args] = remoteCommandArgv([input.command, ...input.args]);
    expect(received).toMatchObject({ command, args, bypassSession: true });
    expect(input.command).toBe(process.execPath);
    const actual = await expectCache(f, first.stdout);
    const files = await readdir(actual.cacheDir);
    const second = await expectCache(f, (await f.runtime.execute(input)).stdout);
    expect(second.cacheDir).toBe(actual.cacheDir);
    expect(await readdir(second.cacheDir)).toEqual(files);
    process.stdout.write(`REG12C_REAL_NODE ${JSON.stringify({ path, ...actual, owner: (await stat(f.cache)).uid, cacheFiles: files.length, reused: true, envFile: false })}\n`);
  });

  it("preserves explicitly undefined env without creating an env object", async () => {
    const f = await boatFixture();
    const result = await f.runtime.execute({ environment, lease, command: process.execPath, args: ["-e", f.script], env: undefined });
    expect(f.received[0]!.env).toBeUndefined();
    await expectCache(f, result.stdout);
  });

  const callerEnvironments: Record<string, string>[] = [{}, { CUSTOM: "preserved" }, { CUSTOM: "preserved", NODE_DISABLE_COMPILE_CACHE: "0" }];
  it.each(callerEnvironments)("passes caller env %j through unchanged", async env => {
    const f = await boatFixture(true);
    const before = { ...env };
    const result = await f.runtime.execute({ environment, lease, command: process.execPath, args: ["-e", f.script], env });
    expect(f.received[0]!.env).toBe(env);
    expect(env).toEqual(before);
    expect(f.received[0]!.command).toBe("sh");
    await expectCache(f, result.stdout);
    if ("CUSTOM" in env) expect(JSON.parse(result.stdout).custom).toBe("preserved");
  });

  it("lets a caller's private cache win without changing the env object", async () => {
    const f = await boatFixture(true);
    const cache = join(f.root, "private-pi-cache");
    const env = { NODE_COMPILE_CACHE: cache };
    const result = await f.runtime.execute({ environment, lease, command: process.execPath, args: ["-e", f.script], env });
    expect(f.received[0]!.env).toBe(env);
    expect(JSON.parse(result.stdout).cache).toBe(cache);
    expect(JSON.parse(result.stdout).cacheDir.startsWith(`${cache}/`)).toBe(true);
  });

  it("falls back to disabled caching and still runs when HOME cannot be written (also as root)", async () => {
    const f = await boatFixture();
    f.baseline.HOME = "/proc/paperclip-reg12c-unwritable";
    const actual = JSON.parse((await f.runtime.execute({ environment, lease, command: process.execPath, args: ["-e", f.script] })).stdout);
    expect(actual).toMatchObject({ disabled: "1", value: "MODULE_OK", uid: process.getuid?.() });
    expect(actual.cacheDir).toBeUndefined();
    expect(f.received[0]).not.toHaveProperty("env");
    process.stdout.write(`REG12C_FALLBACK ${JSON.stringify(actual)}\n`);
  });

  // The proof harness bind-mounts a root-owned cache in a private mount namespace;
  // never chown or otherwise change the host's shared cache to prepare this test.
  it.skipIf(process.getuid?.() !== 1000 || process.env.REG12C_ROOT_SHARED !== "1")("does not use an existing root-owned /tmp/node-compile-cache as uid 1000", async () => {
    const shared = "/tmp/node-compile-cache";
    expect((await stat(shared)).uid).toBe(0);
    await expect(writeFile(join(shared, "reg12c-permission-probe"), "no")).rejects.toMatchObject({ code: "EACCES" });
    const f = await boatFixture();
    const actual = await expectCache(f, (await f.runtime.execute({ environment, lease, command: process.execPath, args: ["-e", f.script] })).stdout);
    expect(actual.cache.startsWith(shared)).toBe(false);
    process.stdout.write(`REG12C_SHARED_EACCES ${JSON.stringify({ uid: process.getuid?.(), sharedOwner: 0, selected: actual.cache })}\n`);
  });

  it("passes literal arguments without shell expansion", async () => {
    const f = await boatFixture();
    const result = await f.runtime.execute({ environment, lease, command: "printf", args: ["%s|", "a b", "c'd", "$HOME"] });
    expect(result.stdout).toBe("a b|c'd|$HOME|");
    expect(f.received[0]).not.toHaveProperty("env");
  });

  it("does not bypass Boat's restriction for actual caller env", async () => {
    const f = await boatFixture();
    await expect(f.runtime.execute({ environment, lease, command: "true", env: { CUSTOM: "preserved" } }))
      .rejects.toThrow("Boat env file requires a private directory outside the workspace");
  });

  it("uses the same wrapper for duplex without adding env", async () => {
    const f = await boatFixture();
    let stdout = "";
    const channel: CommandManagedDuplexChannel = { write() {}, onData() {}, onExit() {}, stop() {}, async close() {} };
    f.driver.openDuplexChannel = async input => {
      expect(input).not.toHaveProperty("env");
      expect(input.command).toEqual(remoteCommandArgv([process.execPath, "-e", f.script]));
      const [command, ...args] = input.command;
      stdout = (await exec(command!, args, { cwd: f.workspace, env: f.baseline, timeout: 5000 })).stdout;
      return channel;
    };
    expect(await f.runtime.openDuplexChannel({ environment, lease, command: [process.execPath, "-e", f.script] })).toBe(channel);
    await expectCache(f, stdout);
  });
});
