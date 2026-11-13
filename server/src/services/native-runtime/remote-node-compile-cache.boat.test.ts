// Keep reason: REG-12 made fresh Boat bootstrap fail before runnerd/Pi by
// inventing an env map, which requires a private out-of-workspace env-file dir.
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import type { CommandManagedDuplexChannel } from "@paperclipai/adapter-utils/command-managed-runtime";
import {
  classifyEnvironmentCapabilities,
  environmentRuntimeService,
  type EnvironmentDriverExecuteInput,
  type EnvironmentRuntimeDriver,
} from "../environment-runtime.js";

const exec = promisify(execFile);
const roots: string[] = [];
const environment = { id: "reg12b-environment", driver: "sandbox" } as Environment;
const lease = { id: "reg12b-lease", environmentId: environment.id, metadata: {} } as EnvironmentLease;
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(join(root, "node-compile-cache"), 0o700);
    await rm(root, { recursive: true, force: true });
  }
});

async function boatFixture(privateEnvDirectory = false) {
  const root = await mkdtemp(join(tmpdir(), "reg12b-boat-"));
  roots.push(root);
  const shared = join(root, "node-compile-cache");
  const workspace = join(root, "workspace");
  await mkdir(shared, { mode: 0o555 });
  await mkdir(workspace);
  const privateEnvDir = privateEnvDirectory ? join(root, "private-env") : undefined;
  if (privateEnvDir) await mkdir(privateEnvDir, { mode: 0o700 });
  if (process.getuid?.() !== 0) {
    await expect(writeFile(join(shared, "permission-probe"), "no")).rejects.toMatchObject({ code: "EACCES" });
  }
  const payload = join(workspace, "payload with spaces.cjs");
  await writeFile(payload, "module.exports = 'MODULE_OK';\n");
  const script = `const result=require('node:module').enableCompileCache(); console.log(JSON.stringify({disabled:process.env.NODE_DISABLE_COMPILE_CACHE,status:result.status,value:require(${JSON.stringify(payload)}),uid:process.getuid?.(),custom:process.env.CUSTOM}));`;
  const baseline = { PATH: process.env.PATH!, HOME: root, TMPDIR: root, NODE_COMPILE_CACHE: shared };
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
      // Boat creates an env file only for a nonempty env. Bootstrap has no
      // private env-file directory yet; an argv-only command does not need one.
      if (Object.keys(input.env ?? {}).length && !privateEnvDir) {
        throw new Error("Boat env file requires a private directory outside the workspace");
      }
      const result = await exec(input.command, input.args ?? [], {
        cwd: workspace, env: { ...baseline, ...input.env }, timeout: 5000,
      });
      return { exitCode: 0, timedOut: false, ...result };
    },
  };
  const runtime = environmentRuntimeService({} as Db, { drivers: [driver] });
  return { root, shared, workspace, script, baseline, received, driver, runtime };
}

const posix = describe.skipIf(process.platform === "win32");
posix("Boat-safe remote compile-cache policy", () => {
  it.each(["bootstrap", "probe", "descendant"])("runs %s without inventing an env file", async path => {
    const f = await boatFixture();
    const script = path === "descendant"
      ? `require('node:child_process').execFileSync(process.execPath,['-e',${JSON.stringify(f.script)}],{stdio:'inherit'});`
      : f.script;
    const input = { environment, lease, command: process.execPath, args: ["-e", script], bypassSession: true };
    const result = await f.runtime.execute(input);
    const received = f.received[0]!;
    expect(received).not.toHaveProperty("env");
    expect(received).toMatchObject({ command: "env", args: ["NODE_DISABLE_COMPILE_CACHE=1", input.command, ...input.args], bypassSession: true });
    expect(input).toMatchObject({ command: process.execPath, args: ["-e", script] });
    const actual = JSON.parse(result.stdout);
    expect(actual).toMatchObject({ disabled: "1", status: 3, value: "MODULE_OK", uid: process.getuid?.() });
    expect(await readdir(f.shared)).toEqual([]);
    process.stdout.write(`REG12B_REAL_NODE ${JSON.stringify({ path, ...actual, envFile: false })}\n`);
  });

  it("also preserves an explicitly undefined env without creating an env object", async () => {
    const f = await boatFixture();
    const result = await f.runtime.execute({ environment, lease, command: process.execPath, args: ["-e", f.script], env: undefined });
    expect(f.received[0]!.env).toBeUndefined();
    expect(JSON.parse(result.stdout)).toMatchObject({ disabled: "1", status: 3 });
  });

  const callerEnvironments: Record<string, string>[] = [
    {}, { CUSTOM: "preserved" },
    { CUSTOM: "preserved", NODE_DISABLE_COMPILE_CACHE: "" },
    { CUSTOM: "preserved", NODE_DISABLE_COMPILE_CACHE: "0" },
  ];
  it.each(callerEnvironments)("merges the policy only into caller-provided env %j", async env => {
    const f = await boatFixture(true);
    const before = { ...env };
    const input = { environment, lease, command: process.execPath, args: ["-e", f.script], env };
    const result = await f.runtime.execute(input);
    expect(f.received[0]).toMatchObject({ command: process.execPath, args: input.args, env: { ...env, NODE_DISABLE_COMPILE_CACHE: "1" } });
    expect(env).toEqual(before);
    expect(JSON.parse(result.stdout)).toMatchObject({ disabled: "1", status: 3, ...(env.CUSTOM ? { custom: env.CUSTOM } : {}) });
    expect(await readdir(f.shared)).toEqual([]);
  });

  it("does not bypass Boat's real restriction for caller env without a private directory", async () => {
    const f = await boatFixture();
    await expect(f.runtime.execute({ environment, lease, command: "true", env: { CUSTOM: "preserved" } }))
      .rejects.toThrow("Boat env file requires a private directory outside the workspace");
  });

  it("carries the policy in duplex argv without adding an env field", async () => {
    const f = await boatFixture();
    let stdout = "";
    const channel: CommandManagedDuplexChannel = { write() {}, onData() {}, onExit() {}, stop() {}, async close() {} };
    f.driver.openDuplexChannel = async input => {
      expect(input).not.toHaveProperty("env");
      expect(input.command.slice(0, 2)).toEqual(["env", "NODE_DISABLE_COMPILE_CACHE=1"]);
      const [command, ...args] = input.command;
      stdout = (await exec(command!, args, { cwd: f.workspace, env: f.baseline, timeout: 5000 })).stdout;
      return channel;
    };
    expect(await f.runtime.openDuplexChannel({ environment, lease, command: [process.execPath, "-e", f.script] })).toBe(channel);
    expect(JSON.parse(stdout)).toMatchObject({ disabled: "1", status: 3, value: "MODULE_OK", uid: process.getuid?.() });
    expect(await readdir(f.shared)).toEqual([]);
  });
});
