import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

const mocks = vi.hoisted(() => ({ probe: vi.fn(), resolveBinary: vi.fn(), launch: vi.fn(),
  syncOut: vi.fn(), cleanupErrors: [] as string[], archives: [] as { binaryArchived: boolean; binaryBytes: string | null; source: string[]; missing: string[]; copied: string[] }[] }));
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
        // M2: a runner binary whose sha matches the staged one is not copied
        // out (its size + sha256 go in the manifest); the records are.
        const archived = join(input.targetPath, "bin", "paperclip-runnerd");
        const excluded = input.excludeEntries ?? [];
        const source = (await readdir(input.sourcePath, { recursive: true })).filter(entry =>
          !excluded.some(prefix => entry === prefix || entry.startsWith(`${prefix}/`))).sort();
        const target = new Set(await readdir(input.targetPath, { recursive: true }));
        const binaryArchived = await lstat(archived).then(stat => stat.isFile(), () => false);
        mocks.archives.push({ binaryArchived, binaryBytes: binaryArchived ? await readFile(archived, "utf8") : null,
          source, missing: source.filter(entry => !target.has(entry)), copied: [...target].sort() });
      } catch (error) { mocks.cleanupErrors.push(String(error)); throw error; }
    }),
  };
});

import { QUALIFIED_PI_RPC_PROFILE } from "../../vendor/paperclip-runner/index.js";
import { parseProbeStaticManifest, probeStaticExclusions, probeManagedNativePiRunner } from "./pi-runner-probe.js";
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

describe("native Pi probe static-file manifest", () => {
  const sha = "a".repeat(64);
  const binary = "bin/paperclip-runnerd";
  const cache = "pi/node-compile-cache";

  it("excludes a runner only when its manifest digest matches, retaining custody details", () => {
    const manifest = parseProbeStaticManifest(`12 ${sha} ${binary}\n4 ${sha} ${cache}/v8.blob\ncount 2\n`, [binary, cache]);
    const matched = probeStaticExclusions(manifest, sha);
    expect(matched.excludeEntries).toEqual([binary, cache]);
    expect(matched.record).toContain(`runnerd expected ${sha} / found ${sha} / match yes`);
    expect(matched.record).toContain("count 2");
    expect(matched.record).toContain(`${binary}`);
    const mismatch = probeStaticExclusions(manifest, "b".repeat(64));
    expect(mismatch.excludeEntries).toEqual([cache]);
    expect(mismatch.record).toContain("match no");
    const absent = probeStaticExclusions({ files: [] }, sha);
    expect(absent.excludeEntries).toEqual([cache]);
    expect(absent.record).toContain("found absent / match no");
  });

  it("runs the production manifest script with sh and busybox sh, paths with spaces, symlink omission and failing checksums", async () => {
    const source = await readFile(new URL("./pi-runner-probe.ts", import.meta.url), "utf8");
    const begin = source.indexOf("const PROBE_STATIC_MANIFEST_SCRIPT = ");
    const end = source.indexOf(";\n\nexport type ProbeStaticManifest", begin);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    const expression = source.slice(begin, end).replace(/^const PROBE_STATIC_MANIFEST_SCRIPT = /, "");
    const command = runInNewContext(expression) as string;
    const root = await mkdtemp(join(tmpdir(), "probe-manifest-script-"));
    roots.push(root);
    const tree = join(root, "tree");
    await mkdir(join(tree, "bin"), { recursive: true });
    await mkdir(join(tree, "pi", "node-compile-cache", "nested"), { recursive: true });
    await writeFile(join(tree, binary), "runner bytes");
    await writeFile(join(tree, "pi", "node-compile-cache", "nested", "file with space"), "cache bytes");
    await symlink(join(tree, binary), join(tree, "pi", "ignored-link"));
    const run = promisify(execFile);
    const invoke = (shell: string, path = "/usr/bin:/bin") => run(shell, [...(shell === "busybox" ? ["sh"] : []), "-c", command,
      "paperclip-probe-static-manifest", tree, binary, cache], { encoding: "utf8", env: { PATH: path } });
    const shells = ["sh"];
    if (await run("sh", ["-c", "command -v busybox"], { encoding: "utf8" }).then(() => true).catch(() => false)) shells.push("busybox");
    for (const shell of shells) {
      const parsed = await invoke(shell);
      expect(parsed.stdout).toContain(`${binary}`);
      expect(parsed.stdout).toContain("pi/node-compile-cache/nested/file with space");
      expect(parsed.stdout).toContain("count 2");
      expect(parsed.stdout).not.toContain("ignored-link");
    }
    const empty = await run("sh", ["-c", command, "paperclip-probe-static-manifest", tree,
      "absent-runner", "absent-cache"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    expect(empty.stdout).toBe("count 0\n");
    const failedPath = join(root, "bad-path");
    await mkdir(failedPath);
    const badSha = join(failedPath, "sha256sum");
    await writeFile(badSha, "#!/bin/sh\nexit 9\n", { mode: 0o700 });
    await expect(invoke("sh", `${failedPath}:/usr/bin:/bin`)).rejects.toMatchObject({ code: 9 });
  });

  it.each([
    `12  ${sha} ${binary}\n`,
    `12  ${binary}\ncount 1\n`,
    `12 ${sha} other/file\ncount 1\n`,
    `12 ${sha} ${binary}/../foreign\ncount 1\n`,
    `12 ${sha} ${binary}\n`,
    `12 ${sha} ${binary}\ncount 2\n`,
  ])("rejects malformed or incomplete manifests: %s", value => {
    const input = value.replaceAll("${sha}", sha).replaceAll("${binary}", binary);
    expect(() => parseProbeStaticManifest(input, [binary, cache])).toThrow("native_probe_static_manifest_invalid");
  });
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
    expect(mocks.archives.map(archive => archive.binaryArchived)).toEqual([false, false]);
    for (const [input] of mocks.syncOut.mock.calls) expect(input.excludeEntries).toEqual(["bin/paperclip-runnerd", "pi/node-compile-cache"]);
    const manifests = await retainedStaticManifests(f.root);
    expect(manifests).toHaveLength(2);
    for (const manifest of manifests) {
      expect(manifest).toMatch(/^\d+ [0-9a-f]{64} bin\/paperclip-runnerd$/m);
      expect(Number(/^count (\d+)$/m.exec(manifest)?.[1])).toBe(manifest.split("\n").filter(line => /^\d+ [0-9a-f]{64} \S/.test(line)).length);
      expect(manifest).toMatch(/^runnerd expected [0-9a-f]{64} \/ found [0-9a-f]{64} \/ match yes$/m);
    }
  });

  it("copies every record file and excludes only the two static entries", async () => {
    const f = await fixture("matching");
    // Plant a Pi session record and a compile-cache file in each box root.
    const execute = f.runner.execute.bind(f.runner);
    vi.spyOn(f.runner, "execute").mockImplementation(async request => {
      const result = await execute(request);
      const root = request.command === "mkdir" ? request.args?.[4] : undefined;
      if (root?.includes("/.paperclip-runtime/")) {
        await mkdir(join(root, "pi", "node-compile-cache"), { recursive: true });
        await writeFile(join(root, "pi", "setup-record.jsonl"), "{}\n");
        await writeFile(join(root, "pi", "node-compile-cache", "blob"), "cache");
      }
      return result;
    });
    const result = await probeManagedNativePiRunner(f.context);
    expect(mocks.cleanupErrors).toEqual([]);
    expect(result.status).toBe("pass");
    // Deny list only: every box file outside the two excluded entries is copied.
    for (const archive of mocks.archives) {
      expect({ missing: archive.missing, some: archive.source.length > 0 }).toEqual({ missing: [], some: true });
      expect(archive.copied).toContain("pi/setup-record.jsonl");
      expect(archive.copied).not.toContain("pi/node-compile-cache/blob");
    }
  });

  it("copies the box binary as evidence when its sha differs from the staged runner", async () => {
    const f = await fixture("matching");
    const execute = f.runner.execute.bind(f.runner);
    vi.spyOn(f.runner, "execute").mockImplementation(async request => {
      const result = await execute(request);
      return request.args?.[2] === "paperclip-probe-static-manifest"
        ? { ...result, stdout: result.stdout.replace(/^(\d+) [0-9a-f]{64} bin\/paperclip-runnerd$/m, `$1 ${"0".repeat(64)} bin/paperclip-runnerd`) }
        : result;
    });
    const result = await probeManagedNativePiRunner(f.context);
    expect(mocks.cleanupErrors).toEqual([]);
    expect(result.status).toBe("pass");
    expect(mocks.archives.map(archive => archive.binaryArchived)).toEqual([true, true]);
    // The old byte check, kept where the binary is still copied.
    expect(mocks.archives.map(archive => archive.binaryBytes)).toEqual([script, script]);
    for (const [input] of mocks.syncOut.mock.calls) expect(input.excludeEntries).toEqual(["pi/node-compile-cache"]);
    for (const manifest of await retainedStaticManifests(f.root)) expect(manifest).toMatch(/ \/ found 0{64} \/ match no$/m);
  });

  it("fails closed with no copy and no removal when the static manifest has no count line", async () => {
    const f = await fixture("matching");
    const execute = f.runner.execute.bind(f.runner);
    vi.spyOn(f.runner, "execute").mockImplementation(async request => {
      const result = await execute(request);
      return request.args?.[2] === "paperclip-probe-static-manifest"
        ? { ...result, stdout: result.stdout.replace(/^count \d+\n?$/m, "") }
        : result;
    });
    // This fixture's probe mock never calls onCleanupConfirmed, so cleanup runs from the probe's own
    // finally: native_probe_static_manifest_invalid is thrown there and the outer catch reports it with
    // the product's fixed safe metadata message (raw text dropped by design). Pin the failure point
    // instead: the manifest command ran, then no sync-out and no removal.
    const { logger } = await import("../../middleware/logger.js");
    const info = vi.spyOn(logger, "info");
    const result = await probeManagedNativePiRunner(f.context);
    expect(result.status).toBe("fail");
    expect(result.checks.map(check => check.code)).toContain("pi_rpc_metadata_failed");
    // Where the cause IS observable (M2b's log-only timing line): the failure is the static manifest step.
    const timings = info.mock.calls.map(([fields]) => fields as Record<string, unknown>)
      .filter(fields => fields?.event === "native_probe_cleanup_timing");
    expect(timings.length).toBeGreaterThan(0);
    for (const timing of timings) expect(timing).toMatchObject({ outcome: "failed", failedStep: "static_manifest" });
    info.mockRestore();
    expect(f.requests.some(request => request.args?.[2] === "paperclip-probe-static-manifest")).toBe(true);
    expect(mocks.syncOut).not.toHaveBeenCalled();
    expect(f.requests.some(request => request.command === "rm" && request.args?.[0] === "-rf")).toBe(false);
    expect(await retainedStaticManifests(f.root)).toEqual([]);
    expect((await readdir(join(f.root, "state"), { recursive: true })).filter(entry => entry.endsWith("remote-runtime"))).toEqual([]);
    const remoteRoot = f.requests.find(request => request.command === "mkdir")?.args?.[4];
    expect(remoteRoot && await lstat(remoteRoot).then(stat => stat.isDirectory(), () => false)).toBe(true);
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

  it("allows 15-second remote-root removal within the setup check and requests the 60-second retirement budget", async () => {
    const f = await fixture("matching");
    const execute = f.runner.execute.bind(f.runner);
    let delayedRemoval = false;
    vi.spyOn(f.runner, "execute").mockImplementation(async request => {
      if (request.command === "rm" && request.args?.[0] === "-rf") {
        f.requests.push(request);
        if (!delayedRemoval) {
          delayedRemoval = true;
          vi.useFakeTimers();
          try {
            const completion = new Promise<void>(resolve => setTimeout(resolve, 15_000));
            await vi.advanceTimersByTimeAsync(15_000);
            await completion;
          } finally {
            vi.useRealTimers();
          }
        }
        return { exitCode: 0, timedOut: false, signal: null, pid: null,
          startedAt: new Date().toISOString(), stdout: "", stderr: "" };
      }
      return execute(request);
    });
    try {
      expect((await probeManagedNativePiRunner(f.context)).status).toBe("pass");
      const removal = f.requests.find(request => request.command === "rm" && request.args?.[0] === "-rf");
      expect(removal?.timeoutMs).toBeGreaterThanOrEqual(60_000);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

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

async function retainedStaticManifests(root: string): Promise<string[]> {
  const state = join(root, "state");
  const entries = await readdir(state, { recursive: true });
  return Promise.all(entries.filter(entry => entry.endsWith(".excluded-static-files.txt")).sort()
    .map(entry => readFile(join(state, entry), "utf8")));
}
