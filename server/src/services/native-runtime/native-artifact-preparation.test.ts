import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { createRemoteNativeArtifactPreparation, syncRemoteRunnerDirectoryOut } from "./native-session-executor.js";

type Request = Parameters<CommandManagedRuntimeRunner["execute"]>[0];
const roots: string[] = [];
const metadata = {
  schema: "paperclip-runner/runnerd-build-metadata/v1",
  binaryName: "paperclip-runnerd",
  packageName: "@paperclipai/paperclip-runner",
  binaryContractVersion: 2,
  durableSessionCapabilities: ["unlimited_runtime", "connection_lease_renewal"],
  prpTransportModes: ["dial_ws_loopback", "dial_wss", "listen_ws"],
};

async function fixture(input: {
  concurrent?: boolean;
  before?: (request: Request) => Promise<void>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "native-artifact-preparation-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(home, ".local", "bin");
  const cwd = join(root, "workspace");
  await mkdir(bin, { recursive: true });
  await mkdir(cwd);
  const runnerSource = join(bin, "paperclip-runnerd");
  const codexSource = join(bin, "codex");
  const runnerScript = `#!/bin/sh\n[ "$1" = --build-metadata ] || exit 17\nprintf '%s\\n' '${JSON.stringify(metadata)}'\n`;
  await writeFile(runnerSource, runnerScript, { mode: 0o700 });
  await writeFile(codexSource, "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.160.0'\n", { mode: 0o700 });
  let active = 0;
  let maxActive = 0;
  const requests: Request[] = [];
  const runner: CommandManagedRuntimeRunner = {
    allowConcurrentSyncOperations: input.concurrent ?? true,
    async execute(request) {
      requests.push(request);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await input.before?.(request);
        return await new Promise((resolve, reject) => {
          const startedAt = new Date().toISOString();
          const child = execFile(request.command, request.args ?? [], {
            cwd: request.cwd ?? cwd,
            env: { HOME: home, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` },
            timeout: 10_000,
          }, (error, stdout, stderr) => {
            if (error && typeof error.code !== "number") return reject(error);
            resolve({ exitCode: typeof error?.code === "number" ? error.code : 0,
              signal: error?.signal ?? null, pid: child.pid ?? null, startedAt,
              timedOut: error?.killed === true, stdout, stderr });
          });
          child.stdin?.end(request.stdin);
        });
      } finally {
        active--;
      }
    },
  };
  const runtimeRoot = join(cwd, ".paperclip-runtime");
  const runnerTarget = join(runtimeRoot, "bin", "paperclip-runnerd");
  const codexTarget = join(runtimeRoot, "bin", "codex");
  const options: Parameters<typeof createRemoteNativeArtifactPreparation>[0] = {
    target: { kind: "remote", transport: "sandbox", providerKey: "daytona", remoteCwd: cwd, runner },
    runner,
    remoteBinary: runnerTarget,
    controllerRunnerBinary: runnerSource,
    remoteRuntimeRoot: runtimeRoot,
    remoteCodexBinary: codexTarget,
    targetPlatformArtifactVerified: true,
  };
  return { options, requests, runnerSource, runnerTarget, codexSource, codexTarget,
    runnerScript, active: () => active, maxActive: () => maxActive };
}

const discovers = (request: Request, name: string) => request.command === "sh"
  && request.args?.some(value => value.includes(`for candidate in /opt/paperclip-runner/bin/${name} `));

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("remote native artifact preparation", () => {
  // catch: https://github.com/Smarty-Pants-Inc/smarty-dev/issues/21267
  // Real preparation executor and shell/hash/metadata processes. Only the
  // provider RTT is injected; the asserted bytes and inventory are real.
  it("batches retained runner hash and fresh pack inventory in one remote round trip", async () => {
    const f = await fixture({ before: async () => { await new Promise(resolve => setTimeout(resolve, 160)); } });
    const installation = { root: "/opt/paperclip-runner/provider-pack", immutable: true, manifest: { digest: "warm" } };
    const script = `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ ...metadata, providerPacks: [installation] })}'\n`;
    await writeFile(f.runnerSource, script, { mode: 0o700 });
    await mkdir(join(f.options.remoteRuntimeRoot, "bin"), { recursive: true });
    await writeFile(f.runnerTarget, script, { mode: 0o700 });
    const artifacts = createRemoteNativeArtifactPreparation({ ...f.options, remoteCodexBinary: null,
      reuseRetainedRunner: true, providerPackRoots: [installation.root] });
    const started = performance.now();
    await artifacts.prepare("listen_ws");
    const elapsedMs = performance.now() - started;
    process.stdout.write(JSON.stringify({ measurement: "retained-artifact", injectedRttMs: 160, elapsedMs, roundTrips: f.requests.length }) + "\n");
    expect(artifacts.providerPackInventory()).toEqual([installation]);
    expect(await readFile(f.runnerTarget, "utf8")).toBe(script);
    expect(f.active()).toBe(0);
    expect(f.requests).toHaveLength(1);
  });

  it.each(["binary", "capabilities", "pack-root", "old-runner"] as const)("keeps retained runner mutation fences: %s", async mutation => {
    const f = await fixture();
    const installation = { root: "/changed/pack", immutable: true, manifest: { digest: "changed" } };
    const changedMetadata = { ...metadata,
      ...(mutation === "capabilities" ? { prpTransportModes: ["dial_wss"] } : {}),
      providerPacks: [installation] };
    const script = `#!/bin/sh\n${mutation === "old-runner" ? '[ "$#" = 1 ] || exit 17\n' : ""}printf '%s\\n' '${JSON.stringify(changedMetadata)}'\n`;
    await writeFile(f.runnerSource, script, { mode: 0o700 });
    await mkdir(join(f.options.remoteRuntimeRoot, "bin"), { recursive: true });
    await writeFile(f.runnerTarget, mutation === "binary" ? "#!/bin/sh\nexit 19\n" : script, { mode: 0o700 });
    const artifacts = createRemoteNativeArtifactPreparation({ ...f.options, remoteCodexBinary: null,
      reuseRetainedRunner: true, providerPackRoots: [mutation === "pack-root" ? "/old/pack" : installation.root] });
    if (mutation === "capabilities") await expect(artifacts.prepare("listen_ws")).rejects.toThrow("runner_remote_transport_capability_missing:listen_ws");
    else {
      await artifacts.prepare("listen_ws");
      expect(await readFile(f.runnerTarget, "utf8")).toBe(script);
      expect(artifacts.providerPackInventory()).toEqual(mutation === "pack-root" ? [] : [installation]);
      if (mutation === "binary") expect(f.requests.length).toBeGreaterThan(1);
    }
    expect(f.active()).toBe(0);
  });

  it("falls back to full install after a retained artifact RPC failure", async () => {
    const f = await fixture({ before: async request => {
      if (request.args?.[2] === "paperclip-runner-retained-artifact") throw new Error("transient retained probe failure");
    } });
    await mkdir(join(f.options.remoteRuntimeRoot, "bin"), { recursive: true });
    await writeFile(f.runnerTarget, f.runnerScript, { mode: 0o700 });
    await createRemoteNativeArtifactPreparation({ ...f.options, remoteCodexBinary: null, reuseRetainedRunner: true }).prepare("listen_ws");
    expect(f.requests.length).toBeGreaterThan(1);
    expect(await readFile(f.runnerTarget, "utf8")).toBe(f.runnerScript);
    expect(f.requests.some(request => request.command === f.runnerTarget && request.args?.[0] === "--build-metadata")).toBe(true);
    expect(f.active()).toBe(0);
  });

  it("overlaps the default runner and harness while retaining both executable checks", async () => {
    const f = await fixture();
    await createRemoteNativeArtifactPreparation(f.options).prepare("listen_ws");
    expect(f.maxActive()).toBe(2);
    expect(f.active()).toBe(0);
    expect((await lstat(f.runnerTarget)).isFile()).toBe(true);
    expect(await readFile(f.runnerTarget, "utf8")).toBe(f.runnerScript);
    expect(f.requests.filter(request => request.args?.[1]?.includes('sha256sum "$1"')).map(request => request.args?.[3]))
      .toEqual([f.runnerSource, f.runnerTarget]);
    expect(await readFile(f.runnerSource, "utf8")).toBe(f.runnerScript);
    expect(f.requests.filter(request => request.command === f.runnerTarget && request.args?.[0] === "--build-metadata")).toHaveLength(1);
    expect(f.requests.filter(request => request.command === f.codexTarget && request.args?.[0] === "--version")).toHaveLength(1);
    expect(f.requests.some(request => request.command === "npm")).toBe(false);
  });

  it("atomically replaces an old link with a mode-preserving copy without changing the image", async () => {
    const f = await fixture();
    await chmod(f.runnerSource, 0o751);
    await mkdir(join(f.options.remoteRuntimeRoot, "bin"), { recursive: true });
    await symlink(f.runnerSource, f.runnerTarget);
    await createRemoteNativeArtifactPreparation(f.options).prepare("listen_ws");
    const staged = await lstat(f.runnerTarget);
    expect(staged.isFile()).toBe(true);
    expect(staged.mode & 0o777).toBe(0o751);
    expect(await readFile(f.runnerSource, "utf8")).toBe(f.runnerScript);
    expect((await readdir(join(f.options.remoteRuntimeRoot, "bin"))).sort()).toEqual(["codex", "paperclip-runnerd"]);
    const copy = f.requests.find(request => request.args?.[1]?.includes("cp --preserve=mode"));
    expect(copy).toMatchObject({ command: "sh", bypassSession: true, timeoutMs: 10_000 });
    expect(copy?.args?.[1]).toContain("mktemp");
    expect(copy?.args?.[1]).toContain("mv -f");
    // Both remaining "link" callers write a regular Codex launcher, which
    // also survives the unchanged strict archive when the whole root is seen.
    expect((await lstat(f.codexTarget)).isFile()).toBe(true);
    const checkpoint = f.options.remoteRuntimeRoot + "-checkpoint";
    await syncRemoteRunnerDirectoryOut({ runner: f.options.runner,
      sourcePath: f.options.remoteRuntimeRoot, targetPath: checkpoint, mode: 0o700 });
    expect(await readFile(join(checkpoint, "bin", "paperclip-runnerd"), "utf8")).toBe(f.runnerScript);
    expect(await readFile(join(checkpoint, "bin", "codex"), "utf8")).toBe(await readFile(f.codexTarget, "utf8"));
  });

  it("reads installed pack metadata in the existing final runner probe", async () => {
    const f = await fixture();
    const installation = { root: "/opt/paperclip-runner/provider-pack", manifest: { digest: "selected" }, immutable: true };
    await writeFile(f.runnerSource, `#!/bin/sh\n[ "$1" = --build-metadata ] || exit 17\nprintf '%s\\n' '${JSON.stringify({ ...metadata, providerPacks: [installation, { ...installation, root: "/unrequested" }] })}'\n`, { mode: 0o700 });
    const artifacts = createRemoteNativeArtifactPreparation({ ...f.options, providerPackRoots: [installation.root] });
    await artifacts.prepare("listen_ws");
    expect(artifacts.providerPackInventory()).toEqual([installation]);
    const probes = f.requests.filter(request => request.command === f.runnerTarget && request.args?.[0] === "--build-metadata");
    expect(probes).toHaveLength(1);
    expect(probes[0].args).toEqual(["--build-metadata", "--provider-pack-root", installation.root]);
    expect(f.requests.some(request => request.args?.includes("--version") && request.command.includes("provider-pack"))).toBe(false);
  });

  it("reattaches an older runner without the optional pack metadata argument", async () => {
    const f = await fixture();
    await writeFile(f.runnerSource, `#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = --build-metadata ] || exit 17\nprintf '%s\\n' '${JSON.stringify(metadata)}'\n`, { mode: 0o700 });
    const artifacts = createRemoteNativeArtifactPreparation({ ...f.options, providerPackRoots: ["/opt/paperclip-runner/provider-pack"] });
    await artifacts.verifyRemoteRunner("listen_ws", f.runnerSource, true);
    expect(artifacts.providerPackInventory()).toEqual([]);
    expect(f.requests.map(request => request.args)).toEqual([
      ["--build-metadata", "--provider-pack-root", "/opt/paperclip-runner/provider-pack"], ["--build-metadata"],
    ]);
  });

  it("keeps providers without concurrent sync support serial", async () => {
    const f = await fixture({ concurrent: false });
    await createRemoteNativeArtifactPreparation(f.options).prepare("listen_ws");
    expect(f.maxActive()).toBe(1);
  });

  it("keeps an explicit harness install after runner verification", async () => {
    const f = await fixture();
    await createRemoteNativeArtifactPreparation({ ...f.options, runnerRemoteCodexPath: f.codexSource }).prepare("listen_ws");
    expect(f.maxActive()).toBe(1);
    const verified = f.requests.findIndex(request => request.command === f.runnerTarget);
    const harness = f.requests.findIndex(request => request.command === f.codexTarget);
    expect(verified).toBeGreaterThan(-1);
    expect(harness).toBeGreaterThan(verified);
  });

  it("waits for an admitted harness operation before returning the runner failure", async () => {
    const failure = new Error("runner discovery unavailable");
    let releaseHarness!: () => void;
    const harnessGate = new Promise<void>(resolve => { releaseHarness = resolve; });
    let harnessStarted = false;
    const f = await fixture({ before: async request => {
      if (discovers(request, "paperclip-runnerd")) throw failure;
      if (discovers(request, "codex")) { harnessStarted = true; await harnessGate; }
    } });
    let rejected = false;
    const work = createRemoteNativeArtifactPreparation(f.options).prepare("listen_ws").catch(error => {
      rejected = true;
      return error;
    });
    try {
      await setImmediate();
      expect(harnessStarted).toBe(true);
      expect(rejected).toBe(false);
    } finally {
      releaseHarness();
      expect(await work).toBe(failure);
    }
    expect(f.active()).toBe(0);
    expect(f.requests.some(request => request.command === f.codexTarget)).toBe(true);
  });

  it("preserves the runner failure when both concurrent preparations fail", async () => {
    const runnerFailure = new Error("runner discovery unavailable");
    const harnessFailure = new Error("harness discovery unavailable");
    const f = await fixture({ before: async request => {
      if (discovers(request, "paperclip-runnerd")) throw runnerFailure;
      if (discovers(request, "codex")) throw harnessFailure;
    } });
    await expect(createRemoteNativeArtifactPreparation(f.options).prepare("listen_ws")).rejects.toBe(runnerFailure);
    expect(f.active()).toBe(0);
  });
});
