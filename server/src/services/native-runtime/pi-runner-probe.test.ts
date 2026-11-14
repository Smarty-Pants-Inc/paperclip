import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

const mocks = vi.hoisted(() => ({ probe: vi.fn(), resolveBinary: vi.fn(), launch: vi.fn(),
  syncOut: vi.fn(), cleanupErrors: [] as string[], archives: [] as { regular: boolean; bytes: string }[] }));
vi.mock("../../vendor/paperclip-runner/index.js", async original => ({
  ...await original<object>(), probeNativeRunnerEnvironment: mocks.probe,
}));
vi.mock("./native-codex-runner.js", async original => ({
  ...await original<object>(), resolveRemotePaperclipRunnerBinary: mocks.resolveBinary,
}));
vi.mock("./native-session-executor.js", async original => {
  const actual = await original<typeof import("./native-session-executor.js")>();
  return {
    ...actual,
    resolveRemoteProviderPackSource: () => ({ configuredRoot: "/selected/pack", manifest: {
      digest: `sha256:${"a".repeat(64)}`, payload: {
        nativeProviders: { pi_rpc: { version: "1.5.2", profileDigest: QUALIFIED_PI_RPC_PROFILE.commandDigest,
          path: "provider-assets/pi_rpc/linux-x64", sha256: `sha256:${"b".repeat(64)}`, closureDigest: `sha256:${"c".repeat(64)}` } },
        artifacts: { nodeCommand: { path: "node", sha256: `sha256:${"d".repeat(64)}` },
          piRpcExecutable: { path: "provider-assets/pi_rpc/linux-x64/runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", sha256: `sha256:${"e".repeat(64)}` },
          piRpcProxy: { path: "dist/cli/pi-rpc-app-server-proxy.cjs", sha256: `sha256:${"f".repeat(64)}` } },
      },
    } }),
    prepareRemoteProviderPackOnTarget: async () => ({ root: "/selected/remote-pack" }),
    createRemoteRunnerProcessLauncher: mocks.launch,
    syncRemoteRunnerDirectoryOut: mocks.syncOut.mockImplementation(async (input: Parameters<typeof actual.syncRemoteRunnerDirectoryOut>[0]) => {
      try {
        await actual.syncRemoteRunnerDirectoryOut(input);
        const archived = join(input.targetPath, "bin", "paperclip-runnerd");
        mocks.archives.push({ regular: (await lstat(archived)).isFile(), bytes: await readFile(archived, "utf8") });
      } catch (error) { mocks.cleanupErrors.push(String(error)); throw error; }
    }),
  };
});

import { QUALIFIED_PI_RPC_PROFILE } from "../../vendor/paperclip-runner/index.js";
import { probeManagedNativePiRunner } from "./pi-runner-probe.js";
import { syncRemoteRunnerDirectoryOut } from "./native-session-executor.js";

type Request = Parameters<CommandManagedRuntimeRunner["execute"]>[0];
const roots: string[] = [];
const model = "paperclip/gateway/nested/claude-opus-5-5";
const metadata = {
  schema: "paperclip-runner/runnerd-build-metadata/v1", binaryName: "paperclip-runnerd",
  packageName: "@paperclipai/paperclip-runner", binaryContractVersion: 2,
  durableSessionCapabilities: ["unlimited_runtime", "connection_lease_renewal"],
  prpTransportModes: ["dial_ws_loopback", "dial_wss", "listen_ws"],
};
const script = `#!/bin/sh\n[ "$1" = --build-metadata ] || exit 17\nprintf '%s\\n' '${JSON.stringify(metadata)}'\n`;

async function fixture(image: "matching" | "wrong-sha" | "missing", sync = true,
  fault?: "copy-exit" | "copy-timeout" | "copy-throw" | "copied-sha" | "copied-sha-error" | "copied-sha-timeout") {
  const root = await mkdtemp(join(tmpdir(), "pi-probe-artifact-"));
  roots.push(root);
  const home = join(root, "home"), bin = join(home, ".local", "bin"), cwd = join(root, "workspace");
  await mkdir(bin, { recursive: true });
  await mkdir(cwd);
  const source = join(root, "paperclip-runnerd"), installed = join(bin, "paperclip-runnerd");
  await writeFile(source, script, { mode: 0o700 });
  if (image !== "missing") await writeFile(installed, script + (image === "wrong-sha" ? "# different build\n" : ""), { mode: 0o700 });
  vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_BINARY_PATH", "");
  vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(root, "state"));
  mocks.resolveBinary.mockReset().mockResolvedValue(source);
  mocks.launch.mockReset().mockReturnValue(vi.fn());
  const requests: Request[] = [];
  const syncIn = vi.fn<NonNullable<CommandManagedRuntimeRunner["syncIn"]>>(async operations => {
    for (const operation of operations) for (const file of operation.files) {
      await mkdir(dirname(file.targetPath), { recursive: true });
      await copyFile(file.sourcePath, file.targetPath);
      await chmod(file.targetPath, file.mode ?? 0o700);
    }
    return { operations: operations.map(operation => ({ operationId: operation.operationId,
      filesTransferred: operation.files.length, bytesTransferred: Buffer.byteLength(script) * operation.files.length })) };
  });
  const runner: CommandManagedRuntimeRunner = {
    ...(sync ? { syncIn } : {}),
    async execute(request) {
      requests.push(request);
      if (request.args?.[1]?.includes("cp --preserve=mode") && fault?.startsWith("copy-")) {
        if (fault === "copy-throw") throw new Error("copy unavailable");
        return { exitCode: 1, timedOut: fault === "copy-timeout", signal: null, pid: null, startedAt: new Date().toISOString(), stdout: "", stderr: "copy failed" };
      }
      if (request.args?.[1]?.includes('sha256sum "$1"') && request.args[3]?.includes("/.paperclip-runtime/") && fault?.startsWith("copied-sha")) {
        if (fault === "copied-sha-error") throw new Error("copied checksum unavailable");
        if (fault === "copied-sha-timeout") return { exitCode: 0, timedOut: true, signal: null, pid: null, startedAt: new Date().toISOString(), stdout: "", stderr: "" };
        await writeFile(request.args[3], script + "# corrupted copy\n");
      }
      return new Promise((resolve, reject) => {
        const startedAt = new Date().toISOString();
        const child = execFile(request.command, request.args ?? [], {
          cwd: request.cwd ?? cwd, env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` }, timeout: 10_000,
        }, (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") return reject(error);
          resolve({ exitCode: typeof error?.code === "number" ? error.code : 0, signal: error?.signal ?? null,
            pid: child.pid ?? null, startedAt, timedOut: error?.killed === true, stdout, stderr });
        });
        child.stdin?.end(request.stdin);
      });
    },
  };
  const observed: { linked: boolean; link: string | null; bytes: string; mode: number }[] = [];
  mocks.probe.mockReset().mockImplementation(async options => {
    const remoteBinary = mocks.launch.mock.calls.at(-1)![0].remoteBinary as string;
    const linked = (await lstat(remoteBinary)).isSymbolicLink();
    observed.push({ linked, link: linked ? await readlink(remoteBinary) : null, bytes: await readFile(remoteBinary, "utf8"),
      mode: (await lstat(remoteBinary)).mode & 0o777 });
    const result = await runner.execute({ command: remoteBinary, args: ["--build-metadata"] });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(metadata);
    return { providerDriver: "pi_rpc", effectiveModel: model, helloProbePassed: !options.admissionOnly,
      sessionAdmissionPassed: true, piMetadata: { version: "1.5.2" } };
  });
  const context: AdapterEnvironmentTestContext = {
    companyId: "company", adapterType: "paperclip_runner",
    config: { provider: "pi_rpc", model, piRpcThinkingLevel: "xhigh" },
    executionTarget: { kind: "remote", transport: "sandbox", providerKey: "fixture", remoteCwd: cwd, runner,
      effectiveCapabilities: { reusableLeases: false, nativeSyncIn: sync, nativeSyncOut: false,
        persistentProcessSessions: false, independentControlCommands: false, incrementalSessionOutput: false,
        concurrentSyncOperations: false, duplexCommandStream: false, runnerWebSocketIngress: true } },
  };
  return { root, runner, source, installed, observed, requests, syncIn, context };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.cleanupErrors.length = 0;
  mocks.archives.length = 0;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("native Pi probe runner artifact preparation", () => {
  it.each([true, false])("copies a matching preinstalled runner without uploading and archives cleanup (syncIn=%s)", async sync => {
    const f = await fixture("matching", sync);
    const result = await probeManagedNativePiRunner(f.context);
    expect({ cleanupErrors: mocks.cleanupErrors, staged: f.observed }).toEqual({ cleanupErrors: [],
      staged: [0, 1].map(() => ({ linked: false, link: null, bytes: script, mode: 0o700 })) });
    expect(result.status).toBe("pass");
    expect(mocks.probe).toHaveBeenCalledTimes(2);
    expect(f.syncIn).not.toHaveBeenCalled();
    expect(f.requests.some(request => request.stdin !== undefined)).toBe(false);
    expect(await readFile(f.installed, "utf8")).toBe(script);
    expect(mocks.syncOut).toHaveBeenCalledTimes(2);
    expect(mocks.archives).toEqual([0, 1].map(() => ({ regular: true, bytes: script })));
    for (const [input] of mocks.syncOut.mock.calls) expect(input.excludeEntries).toBeUndefined();
  });

  it.each(["wrong-sha", "missing"] as const)("uploads and passes with a %s preinstalled runner", async image => {
    const f = await fixture(image);
    expect((await probeManagedNativePiRunner(f.context)).status).toBe("pass");
    expect(mocks.probe).toHaveBeenCalledTimes(2);
    expect(f.syncIn).toHaveBeenCalledTimes(2);
    for (const [operations] of f.syncIn.mock.calls) expect(operations).toEqual([
      expect.objectContaining({ files: [expect.objectContaining({ sourcePath: f.source,
        targetPath: expect.stringMatching(/\/bin\/paperclip-runnerd$/), mode: 0o700 })] }),
    ]);
    expect(f.observed).toEqual([0, 1].map(() => ({ linked: false, link: null, bytes: script, mode: 0o700 })));
  });

  it.each(["copy-exit", "copy-timeout", "copy-throw", "copied-sha", "copied-sha-error", "copied-sha-timeout"] as const)(
    "falls back to upload when %s fails", async fault => {
      const f = await fixture("matching", true, fault);
      expect((await probeManagedNativePiRunner(f.context)).status).toBe("pass");
      expect(f.syncIn).toHaveBeenCalledTimes(2);
      expect(f.observed.every(observation => !observation.linked && observation.bytes === script)).toBe(true);
      expect(await readFile(f.installed, "utf8")).toBe(script);
      expect(mocks.cleanupErrors).toEqual([]);
    });

  it("keeps the real strict cleanup archive rejecting symlinks", async () => {
    const f = await fixture("matching");
    const sourcePath = join(f.root, "unsafe-runtime"), targetPath = join(f.root, "checkpoint");
    await mkdir(join(sourcePath, "bin"), { recursive: true });
    await symlink(f.installed, join(sourcePath, "bin", "paperclip-runnerd"));
    await expect(syncRemoteRunnerDirectoryOut({ runner: f.runner, sourcePath, targetPath, mode: 0o700 }))
      .rejects.toThrow("runner_remote_checkpoint_archive_unsafe_entry");
  });

  it("honours an explicit remote binary even when the installed runner matches", async () => {
    const f = await fixture("matching");
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_BINARY_PATH", f.source);
    expect((await probeManagedNativePiRunner(f.context)).status).toBe("pass");
    expect(mocks.resolveBinary).toHaveBeenCalledWith(expect.objectContaining({ configuredPath: f.source }));
    expect(f.syncIn).toHaveBeenCalledTimes(2);
    expect(f.requests.some(request => request.args?.[1]?.includes("command -v paperclip-runnerd"))).toBe(false);
    expect(f.observed.every(observation => !observation.linked && observation.bytes === script)).toBe(true);
  });

  it("does not prepare or upload when the platform resolver rejects the binary", async () => {
    const f = await fixture("matching");
    mocks.resolveBinary.mockRejectedValue(new Error("runner_remote_artifact_platform_mismatch"));
    expect((await probeManagedNativePiRunner(f.context)).status).toBe("fail");
    expect(f.syncIn).not.toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
  });
});
