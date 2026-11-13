import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const getSandbox = vi.hoisted(() => vi.fn());
vi.mock("@daytonaio/sdk", () => ({
  Daytona: class { get = getSandbox; },
  DaytonaNotFoundError: class extends Error {},
  DaytonaTimeoutError: class extends Error {},
}));
import plugin, { __resetDaytonaSandboxHandleCacheForTest } from "./plugin.js";
const exec = promisify(execFile);
afterEach(() => { __resetDaytonaSandboxHandleCacheForTest(); vi.clearAllMocks(); });

// REG-12: command env applied only after sourcing profiles is too late for Node in a profile.
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("carries controller cache policy before profile children and into the command", async () => {
  const root = await mkdtemp(join(tmpdir(), "daytona-node-policy-"));
  const shared = join(root, "node-compile-cache"), marker = join(root, "profile.json");
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  await mkdir(shared, { mode: 0o555 });
  try {
    await expect(writeFile(join(shared, "permission-probe"), "no")).rejects.toMatchObject({ code: "EACCES" });
    const probe = "const result=require('node:module').enableCompileCache(); console.log(JSON.stringify({disabled:process.env.NODE_DISABLE_COMPILE_CACHE,status:result.status}));";
    await writeFile(join(root, ".profile"), `${quote(process.execPath)} -e ${quote(probe)} > ${quote(marker)}\n`);
    getSandbox.mockResolvedValue({ id: "cache-sandbox", state: "started", process: {
      async executeCommand(command: string) {
        const result = await exec("sh", ["-c", command], { env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, NODE_COMPILE_CACHE: shared }, timeout: 5000 });
        return { exitCode: 0, result: result.stdout };
      },
    } });
    const result = await plugin.definition.onEnvironmentExecute!({
      driverKey: "daytona", companyId: "cache-company", environmentId: "cache-environment",
      config: { apiKey: "fixture-not-a-key" }, bypassSession: true,
      lease: { providerLeaseId: "cache-sandbox", metadata: {} },
      command: process.execPath, args: ["-e", probe], env: { NODE_DISABLE_COMPILE_CACHE: "1" }, timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({ disabled: "1", status: 3 });
    expect(JSON.parse(result.stdout!)).toEqual({ disabled: "1", status: 3 });
    expect(await readdir(shared)).toEqual([]);
  } finally {
    await chmod(shared, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});
