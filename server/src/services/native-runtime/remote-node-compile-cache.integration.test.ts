// Keep reason: REG-12 fresh Boat lease bootstrap crossed the root/user cache boundary.
// Exercise the central environment runtime with real Node grandchildren, not just an env mock.
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import type { CommandManagedDuplexChannel } from "@paperclipai/adapter-utils/command-managed-runtime";
import { classifyEnvironmentCapabilities, environmentRuntimeService, type EnvironmentRuntimeDriver } from "../environment-runtime.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(join(root, "node-compile-cache"), 0o700);
    await rm(root, { recursive: true, force: true });
  }
});
const environment = { id: "reg12-environment", driver: "sandbox" } as Environment;
const lease = { id: "reg12-lease", environmentId: environment.id, metadata: {} } as EnvironmentLease;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "remote-node-cache-"));
  roots.push(root);
  const shared = join(root, "node-compile-cache");
  await mkdir(shared, { mode: 0o555 });
  await expect(writeFile(join(shared, "must-not-write"), "no")).rejects.toMatchObject({ code: "EACCES" });
  const payload = join(root, "payload.cjs");
  await writeFile(payload, "module.exports = 'MODULE_OK';\n");
  const script = `const {enableCompileCache}=require('node:module'); const result=enableCompileCache(); const value=require(${JSON.stringify(payload)}); console.log(JSON.stringify({disabled:process.env.NODE_DISABLE_COMPILE_CACHE, cache:process.env.NODE_COMPILE_CACHE, status:result.status, value, uid:process.getuid?.()}));`;
  const shim = join(root, "node-shim");
  await writeFile(shim, `#!${process.execPath}\n${script}\n`, { mode: 0o700 });
  // A stdio MCP/CLI descendant inherits the policy from its launch parent.
  const childScript = `require('node:child_process').execFileSync(process.execPath,['-e',${JSON.stringify(script)}],{stdio:'inherit'});`;
  const baseline = { PATH: process.env.PATH!, HOME: root, TMPDIR: root, NODE_COMPILE_CACHE: shared };
  return { root, shared, script, shim, childScript, baseline };
}

const paths = ["archive-probe", "pack-verifier", "setup-probe", "runner-launcher", "bin-shim", "github-or-mcp-descendant"] as const;
describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("remote command Node compile-cache policy", () => {
  it.each(paths)("protects %s before Pi's private-cache builder exists", async path => {
    const f = await fixture();
    let observed: Record<string, string> | undefined;
    const driver: EnvironmentRuntimeDriver = {
      driver: "sandbox",
      async acquireRunLease() { return lease; },
      async releaseRunLease() { return lease; },
      async resolveCapabilities() { return classifyEnvironmentCapabilities({ supportedCapabilities: new Set() }); },
      async execute(input) {
        observed = input.env;
        const result = await exec(input.command, input.args ?? [], { cwd: f.root, env: { ...f.baseline, ...input.env }, timeout: 5000 });
        return { exitCode: 0, timedOut: false, ...result };
      },
    };
    const runtime = environmentRuntimeService({} as Db, { drivers: [driver] });
    const command = path === "bin-shim" ? { command: f.shim }
      : path === "pack-verifier" ? { command: process.execPath, args: ["-e", f.script] }
      : path === "github-or-mcp-descendant" ? { command: process.execPath, args: ["-e", f.childScript] }
      : { command: "sh", args: ["-c", `exec ${quote(process.execPath)} -e ${quote(f.script)}`] };
    const configured = path === "archive-probe" ? undefined : { ...(path === "setup-probe" ? { NODE_DISABLE_COMPILE_CACHE: "" } : {}), NODE_COMPILE_CACHE: f.shared, CUSTOM: "preserved" };
    const before = configured && { ...configured };
    const result = await runtime.execute({ environment, lease, ...command, env: configured, bypassSession: true });
    expect(JSON.parse(result.stdout!)).toMatchObject({ disabled: "1", status: 3, value: "MODULE_OK", uid: process.getuid?.() });
    expect(observed?.NODE_DISABLE_COMPILE_CACHE).toBe("1");
    if (configured) {
      expect(configured).toEqual(before);
      expect(observed?.CUSTOM).toBe("preserved");
    }
    expect(await readdir(f.shared)).toEqual([]);
  });

  it("also protects the duplex argv launch without an env field", async () => {
    const f = await fixture();
    let stdout = "";
    const channel: CommandManagedDuplexChannel = { write() {}, onData() {}, onExit() {}, stop() {}, async close() {} };
    const driver: EnvironmentRuntimeDriver = {
      driver: "sandbox",
      async acquireRunLease() { return lease; },
      async releaseRunLease() { return lease; },
      async resolveCapabilities() { return classifyEnvironmentCapabilities({ verifiedMethods: ["duplexChannelOpen"], declared: { duplexCommandStream: true } }); },
      async openDuplexChannel(input) {
        const [command, ...args] = input.command;
        stdout = (await exec(command!, [...args], { env: f.baseline, timeout: 5000 })).stdout;
        return channel;
      },
    };
    const runtime = environmentRuntimeService({} as Db, { drivers: [driver] });
    const command = [process.execPath, "-e", f.childScript];
    expect(await runtime.openDuplexChannel({ environment, lease, command })).toBe(channel);
    expect(command[0]).toBe(process.execPath);
    expect(JSON.parse(stdout)).toMatchObject({ disabled: "1", status: 3, value: "MODULE_OK" });
    expect(await readdir(f.shared)).toEqual([]);
  });
});
