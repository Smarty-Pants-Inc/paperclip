import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { PI_RPC_DISTRIBUTION } from "@paperclipai/paperclip-runner";
import { QUALIFIED_ACPX_PROFILES, QUALIFIED_ACPX_VERSION, QUALIFIED_PI_RPC_PROFILE } from "../../vendor/paperclip-runner/index.js";
import { prepareRemoteProviderPackOnTarget, resolveRemoteProviderPackSource, sha256DirectoryTree } from "./native-session-executor.js";
import { canonicalProviderPackJson } from "./remote-provider-pack-verification.js";
import { prepareNativePiProbeRemote } from "./pi-runner-probe.js";

const exec = promisify(execFile);
const EXECUTE_LATENCY_MS = 150;
const TRANSFER_LATENCY_MS = 300;
const TRANSFER_BYTES_PER_SECOND = 10 * 1024 * 1024;
const LARGE_ARTIFACT_BYTES = 24 * 1024 * 1024;
const sha = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function writePack(root: string, revision: string, large: Buffer, distSuffix = "") {
  const files: Record<string, string | Buffer> = {
    "node_modules/node/bin/node": `#!/bin/sh\nexec '${process.execPath}' "$@"\n`,
    "node_modules/.bin/opencode": "#!/bin/sh\necho 1.18.34\n",
    "node_modules/opencode-ai/bin/opencode.exe": large,
    "node_modules/opencode-ai/package.json": JSON.stringify({ version: "1.18.34" }),
    "node_modules/acpx/package.json": JSON.stringify({ version: QUALIFIED_ACPX_VERSION }),
    "node_modules/@agentclientprotocol/claude-agent-acp/package.json": JSON.stringify({ version: QUALIFIED_ACPX_PROFILES.claude.agentServerVersion }),
    "node_modules/@agentclientprotocol/codex-acp/package.json": JSON.stringify({ version: QUALIFIED_ACPX_PROFILES.codex.agentServerVersion }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "dist/cli/opencode-app-server-proxy.cjs": `module.exports = "proxy${distSuffix}";\n`,
    "dist/cli/acpx-runtime-sidecar.cjs": "module.exports = 'sidecar';\n",
    "dist/providers/grok/launcher.cjs": "module.exports = 'grok';\n",
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await chmod(join(root, "node_modules/node/bin/node"), 0o755);
  await chmod(join(root, "node_modules/.bin/opencode"), 0o755);
  const artifact = (path: string) => ({ path, sha256: sha(files[path]!) });
  const proxy = artifact("dist/cli/opencode-app-server-proxy.cjs"), sidecar = artifact("dist/cli/acpx-runtime-sidecar.cjs");
  const distDigest = sha256DirectoryTree(join(root, "dist"));
  const payload = {
    pins: { nodeMinimum: "24.11.0", codex: QUALIFIED_ACPX_PROFILES.codex.agentRuntimeVersion, opencode: "1.18.34", acpx: QUALIFIED_ACPX_VERSION,
      claudeAcp: QUALIFIED_ACPX_PROFILES.claude.agentServerVersion, codexAcp: QUALIFIED_ACPX_PROFILES.codex.agentServerVersion,
      grok: QUALIFIED_ACPX_PROFILES.grok.agentRuntimeVersion },
    target: { platform: process.platform, architecture: process.arch },
    runnerSourceRevision: revision.repeat(40),
    distDigest,
    bridgeDigest: `sha256:${createHash("sha256").update(proxy.sha256).update("\n").update(sidecar.sha256).update("\n").update(distDigest).digest("hex")}`,
    acpxProfileDigests: { grok: QUALIFIED_ACPX_PROFILES.grok.commandDigest, claude: QUALIFIED_ACPX_PROFILES.claude.commandDigest,
      codex: QUALIFIED_ACPX_PROFILES.codex.commandDigest },
    artifacts: {
      grokLauncher: artifact("dist/providers/grok/launcher.cjs"), nodeCommand: artifact("node_modules/node/bin/node"),
      productionLock: artifact("pnpm-lock.yaml"), opencodeCommand: artifact("node_modules/.bin/opencode"),
      opencodeExecutable: artifact("node_modules/opencode-ai/bin/opencode.exe"), opencodeProxy: proxy, acpxSidecar: sidecar,
    },
  };
  await writeFile(join(root, "provider-pack.json"), JSON.stringify({ schema: "paperclip-runner/remote-provider-pack/v1",
    digest: sha(canonicalProviderPackJson(payload)), payload }));
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name))).size;
  }
  return total;
}

function assertConfinedSandboxPath(remoteDir: string, candidate: string) {
  const root = posix.normalize(remoteDir);
  const normalized = posix.normalize(candidate);
  if (normalized !== root && !normalized.startsWith(`${root}/`)) {
    throw new Error(`sync target path escapes the workspace remote dir: ${candidate}`);
  }
}

function simulatedSandbox(home: string, workspace: string) {
  const usage = { simulatedMs: 0, executes: 0, bytesUploaded: 0 };
  const runner: CommandManagedRuntimeRunner = {
    execute: async request => {
      usage.executes += 1;
      usage.simulatedMs += EXECUTE_LATENCY_MS;
      try {
        const result = await exec(request.command, request.args ?? [], { cwd: request.cwd, env: { ...process.env, HOME: home }, maxBuffer: 1 << 24 });
        return { exitCode: 0, signal: null, pid: null, startedAt: null, timedOut: false, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const failed = error as Error & { code?: number; stdout?: string; stderr?: string };
        return { exitCode: typeof failed.code === "number" ? failed.code : 127, signal: null, pid: null, startedAt: null, timedOut: false,
          stdout: failed.stdout ?? "", stderr: failed.stderr ?? String(error) };
      }
    },
    syncIn: async operations => {
      const results = [];
      for (const operation of operations) {
        let bytes = 0;
        for (const file of operation.files) {
          if (file.kind !== "directory" || !file.sourcePath) throw new Error("unexpected transfer");
          assertConfinedSandboxPath(workspace, file.targetPath);
          bytes += await directoryBytes(file.sourcePath);
          await mkdir(dirname(file.targetPath), { recursive: true });
          await cp(file.sourcePath, file.targetPath, { recursive: true });
        }
        usage.bytesUploaded += bytes;
        usage.simulatedMs += TRANSFER_LATENCY_MS + (bytes / TRANSFER_BYTES_PER_SECOND) * 1000;
        results.push({ operationId: operation.operationId, filesTransferred: operation.files.length, bytesTransferred: bytes });
      }
      return { operations: results };
    },
  };
  return { runner, usage };
}

type Scenario = "exact" | "same_content_other_build" | "different_content" | "corrupted" | "none";

describe("provider pack selection harness", () => {
  let root: string;
  let large: Buffer;
  let server: ReturnType<typeof resolveRemoteProviderPackSource>;
  const rows: string[] = [];
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "provider-pack-harness-"));
    large = randomBytes(LARGE_ARTIFACT_BYTES);
    await writePack(join(root, "server-pack"), "b", large);
    server = resolveRemoteProviderPackSource(join(root, "server-pack"));
  });
  afterAll(async () => {
    if (rows.length) process.stdout.write(`\nprovider pack harness (execute ${EXECUTE_LATENCY_MS} ms, transfer ${TRANSFER_LATENCY_MS} ms + ${TRANSFER_BYTES_PER_SECOND / 1024 / 1024} MiB/s)\n${rows.join("\n")}\n`);
    await rm(root, { recursive: true, force: true });
  });

  const run = async (scenario: Scenario, acceptProvenanceDifferences: boolean) => {
    const sandbox = await mkdtemp(join(root, `${scenario}-`));
    const home = join(sandbox, "home"), workspace = join(sandbox, "workspace");
    await mkdir(workspace, { recursive: true });
    const image = join(home, ".local/share/paperclip-runner/provider-pack");
    if (scenario === "exact") await writePack(image, "b", large);
    if (scenario === "same_content_other_build") await writePack(image, "a", large);
    if (scenario === "different_content") await writePack(image, "a", large, "-older");
    if (scenario === "corrupted") {
      await writePack(image, "a", large);
      await writeFile(join(image, "dist/cli/acpx-runtime-sidecar.cjs"), "tampered\n");
    }
    const { runner, usage } = simulatedSandbox(home, workspace);
    const cpuBefore = process.cpuUsage();
    const startedAt = performance.now();
    const prepared = await prepareRemoteProviderPackOnTarget({
      target: { kind: "remote", transport: "sandbox", remoteCwd: workspace, runner } as never,
      runner, configuredProviderPackRoot: server.configuredRoot, manifest: server.manifest, acceptProvenanceDifferences,
    });
    const wallMs = performance.now() - startedAt;
    const cpu = process.cpuUsage(cpuBefore);
    rows.push(`${scenario.padEnd(26)} ${acceptProvenanceDifferences ? "after " : "before"} source=${prepared.source.padEnd(12)} `
      + `modelled=${((wallMs + usage.simulatedMs) / 1000).toFixed(2)}s uploaded=${(usage.bytesUploaded / 1024 / 1024).toFixed(1)}MiB `
      + `executes=${usage.executes} serverCpu=${((cpu.user + cpu.system) / 1000).toFixed(0)}ms dbStatements=0`);
    return { prepared, usage };
  };

  it("confines simulated uploads to the workspace", async () => {
    const { runner } = simulatedSandbox(root, join(root, "workspace"));
    await expect(runner.syncIn!([{ operationId: "escape", files: [{ kind: "directory", sourcePath: join(root, "server-pack"),
      targetPath: join(root, "workspace", "..", "outside"), mode: 0o700 }] }])).rejects.toThrow("escapes the workspace");
  });

  it.each<[Scenario, "preinstalled" | "uploaded", "preinstalled" | "uploaded"]>([
    ["exact", "preinstalled", "preinstalled"],
    ["same_content_other_build", "uploaded", "preinstalled"],
    ["different_content", "uploaded", "uploaded"],
    ["corrupted", "uploaded", "uploaded"],
    ["none", "uploaded", "uploaded"],
  ])("selects the pack for %s (before: %s, after: %s)", async (scenario, before, after) => {
    const previous = await run(scenario, false);
    expect(previous.prepared.source).toBe(before);
    expect(previous.prepared.manifest).toEqual(server.manifest);
    const current = await run(scenario, true);
    expect(current.prepared.source).toBe(after);
    expect(current.usage.bytesUploaded).toBe(after === "uploaded" ? previous.usage.bytesUploaded : 0);
    if (scenario === "same_content_other_build") {
      expect(current.prepared.manifest.digest).not.toBe(server.manifest.digest);
      expect(current.prepared.manifest.payload.runnerSourceRevision).toBe("a".repeat(40));
      expect({ ...current.prepared.manifest.payload, runnerSourceRevision: null })
        .toEqual({ ...server.manifest.payload, runnerSourceRevision: null });
    } else {
      expect(current.prepared.manifest).toEqual(server.manifest);
    }
  }, 120_000);
});

// Native Pi setup probe (smarty-dev#20791). A sealed image pack is admitted by
// the Runner daemon's protected-manifest inventory, as task runs do (#17749):
// no pack walk, no version command and no full-verification fallback.
// docker/daytona-runner/README.md:99-101: "It does not scan the pack".
const IMAGE_PACK_ROOT = "/opt/paperclip-runner/provider-pack";
const PI_PATHS = {
  piRpcProxy: "dist/cli/pi-rpc-app-server-proxy.cjs",
  piRpcExecutable: "provider-assets/pi_rpc/linux-x64/runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
};

/** The harness pack plus the native Pi entries the Pi probe requires. */
async function writePiPack(root: string, revision: string, large: Buffer, distSuffix = "") {
  await writePack(root, revision, large, distSuffix);
  for (const [name, path] of Object.entries(PI_PATHS)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), `pi fixture ${name}${distSuffix}\n`);
  }
  const manifest = JSON.parse(await readFile(join(root, "provider-pack.json"), "utf8"));
  const payload = manifest.payload;
  payload.distDigest = sha256DirectoryTree(join(root, "dist"));
  payload.bridgeDigest = `sha256:${createHash("sha256").update(payload.artifacts.opencodeProxy.sha256).update("\n")
    .update(payload.artifacts.acpxSidecar.sha256).update("\n").update(payload.distDigest).digest("hex")}`;
  for (const [name, path] of Object.entries(PI_PATHS)) {
    payload.artifacts[name] = { path, sha256: sha(await readFile(join(root, path))) };
  }
  payload.pins.piRpc = QUALIFIED_PI_RPC_PROFILE.runtimeVersion;
  payload.piRpcProfileDigest = QUALIFIED_PI_RPC_PROFILE.commandDigest;
  payload.nativeProviders = { pi_rpc: { version: QUALIFIED_PI_RPC_PROFILE.runtimeVersion, profileDigest: QUALIFIED_PI_RPC_PROFILE.commandDigest,
    closureDigest: PI_RPC_DISTRIBUTION.targets["linux-x64"].closureSha256, path: "provider-assets/pi_rpc/linux-x64",
    sha256: sha256DirectoryTree(join(root, "provider-assets/pi_rpc/linux-x64")) } };
  await writeFile(join(root, "provider-pack.json"), JSON.stringify({ schema: manifest.schema,
    digest: sha(canonicalProviderPackJson(payload)), payload }));
}

/** A Runner daemon double. Root ownership cannot be produced in a unit test, so
 * the double reports the publisher seal the real daemon reads from path metadata
 * (paperclip-runnerd.rs: "Check only path metadata at startup"). */
async function writeRunnerDaemon(path: string, packs: Record<string, { directory: string; immutable: boolean }>) {
  const metadata = { schema: "paperclip-runner/runnerd-build-metadata/v1", binaryName: "paperclip-runnerd",
    packageName: "@paperclipai/paperclip-runner", binaryContractVersion: 2,
    durableSessionCapabilities: ["unlimited_runtime", "connection_lease_renewal"],
    prpTransportModes: ["dial_ws_loopback", "dial_wss", "listen_ws"] };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!${process.execPath}
const fs = require("node:fs"), args = process.argv.slice(2), packs = ${JSON.stringify(packs)};
if (args[0] !== "--build-metadata") process.exit(17);
const providerPacks = [];
for (let index = 1; index < args.length; index += 2) {
  if (args[index] !== "--provider-pack-root") process.exit(2);
  // Like provider_pack_inventory: every requested root is reported; only a
  // sealed one carries its manifest.
  const root = args[index + 1], pack = packs[root];
  let manifest = null;
  try { if (pack?.immutable) manifest = JSON.parse(fs.readFileSync(pack.directory + "/provider-pack.json", "utf8")); } catch {}
  providerPacks.push(manifest ? { root, manifest, immutable: true } : { root, manifest: null, immutable: false });
}
process.stdout.write(JSON.stringify({ ...${JSON.stringify(metadata)}, ...(args.length > 1 ? { providerPacks } : {}) }));
`, { mode: 0o755 });
}

type ProbeCommand = "daemon" | "scan" | "memo_walk" | "byte_verify" | "version" | "discover" | "other";
function classifyProbeCommand(request: Parameters<CommandManagedRuntimeRunner["execute"]>[0]): ProbeCommand {
  const args = request.args ?? [];
  const text = args.join("\n");
  if (args[0] === "--build-metadata") return "daemon";
  if (text.includes("paperclip-snapshot-pack")) return "scan";
  if (text.includes("paperclip-provider-pack-immutable-v1")) return "memo_walk";
  if (args[0] === "-e" && text.includes("provider-pack.json")) return "byte_verify";
  if (args[0] === "--version") return "version";
  if (text.includes("for candidate in /opt/paperclip-runner/provider-pack")) return "discover";
  return "other";
}
const PACK_WALKS: ProbeCommand[] = ["scan", "memo_walk", "byte_verify"];

type ProbeScenario = "sealed" | "sealed_manifest_mismatch" | "unsealed_tampered" | "daemon_timeout";

describe("native Pi setup probe pack admission", () => {
  let root: string;
  let large: Buffer;
  let server: ReturnType<typeof resolveRemoteProviderPackSource>;
  const rows: string[] = [];
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-probe-pack-harness-"));
    large = randomBytes(LARGE_ARTIFACT_BYTES);
    await writePiPack(join(root, "server-pack"), "b", large);
    server = resolveRemoteProviderPackSource(join(root, "server-pack"));
  });
  afterAll(async () => {
    if (rows.length) process.stdout.write(`\nnative Pi probe pack admission (execute ${EXECUTE_LATENCY_MS} ms)\n${rows.join("\n")}\n`);
    await rm(root, { recursive: true, force: true });
  });

  const probe = async (scenario: ProbeScenario) => {
    const sandbox = await mkdtemp(join(root, `${scenario}-`));
    const home = join(sandbox, "home"), workspace = join(sandbox, "workspace");
    await mkdir(workspace, { recursive: true });
    // The image pack is also discoverable at the home candidate, so the old
    // selection path can find and fully verify the same bytes.
    const image = join(home, ".local/share/paperclip-runner/provider-pack");
    if (scenario === "sealed_manifest_mismatch") await writePiPack(image, "a", large, "-older");
    else await writePiPack(image, "b", large);
    if (scenario === "unsealed_tampered") await writeFile(join(image, "dist/cli/acpx-runtime-sidecar.cjs"), "tampered\n");
    const controllerRunnerBinary = join(sandbox, "controller-paperclip-runnerd");
    const daemonPacks = { [IMAGE_PACK_ROOT]: { directory: image, immutable: scenario !== "unsealed_tampered" } };
    await writeRunnerDaemon(controllerRunnerBinary, daemonPacks);
    await writeRunnerDaemon(join(home, ".local/bin/paperclip-runnerd"), daemonPacks);
    const { runner: fake, usage } = simulatedSandbox(home, workspace);
    const commands: ProbeCommand[] = [];
    const runner: CommandManagedRuntimeRunner = { ...fake, execute: async request => {
      commands.push(classifyProbeCommand(request));
      if (scenario === "daemon_timeout" && request.args?.includes("--provider-pack-root")) {
        usage.executes += 1;
        usage.simulatedMs += 30_000;
        return { exitCode: null, signal: null, pid: null, startedAt: null, timedOut: true, stdout: "", stderr: "" };
      }
      return fake.execute(request);
    } };
    const remoteRuntimeRoot = join(workspace, ".paperclip-runtime", "setup-harness");
    await mkdir(join(remoteRuntimeRoot, "bin"), { recursive: true });
    vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_BINARY_PATH", "");
    const startedAt = performance.now();
    let outcome: Awaited<ReturnType<typeof prepareNativePiProbeRemote>> | Error;
    try {
      outcome = await prepareNativePiProbeRemote({
        target: { kind: "remote", transport: "sandbox", remoteCwd: workspace, runner } as never, runner,
        remoteBinary: join(remoteRuntimeRoot, "bin", "paperclip-runnerd"), controllerRunnerBinary, remoteRuntimeRoot,
        source: server, requiredMode: "dial_wss",
      });
    } catch (error) {
      outcome = error as Error;
    } finally {
      vi.unstubAllEnvs();
    }
    const modelledSeconds = (performance.now() - startedAt + usage.simulatedMs) / 1000;
    const walks = commands.filter(command => PACK_WALKS.includes(command)).length;
    const fallback = commands.some(command => command === "discover" || command === "byte_verify");
    rows.push(`${scenario.padEnd(26)} ${outcome instanceof Error ? `error=${outcome.message.slice(0, 70)}` : `source=${outcome.source} root=${outcome.root}`} `
      + `commands=${usage.executes} packWalks=${walks} fallback=${fallback} modelled=${modelledSeconds.toFixed(2)}s [${commands.join(",")}]`);
    return { outcome, commands, walks, fallback, usage, modelledSeconds };
  };

  it("(a) admits a sealed image pack on a cold box through the Runner daemon with zero pack walks and no fallback", async () => {
    const result = await probe("sealed");
    if (result.outcome instanceof Error) throw result.outcome;
    expect(result.outcome).toMatchObject({ root: IMAGE_PACK_ROOT, source: "preinstalled" });
    expect(result.outcome.manifest).toEqual(server.manifest);
    expect(result.walks).toBe(0);
    expect(result.fallback).toBe(false);
    expect(result.commands).not.toContain("version");
    expect(result.commands.filter(command => command === "daemon")).toHaveLength(2);
  }, 120_000);

  it.each<[ProbeScenario, string]>([
    ["sealed_manifest_mismatch", "a sealed pack whose manifest is not the server's"],
    ["unsealed_tampered", "an unsealed pack with a tampered file"],
  ])("(b) %s: %s still gets the full byte verification", async scenario => {
    const result = await probe(scenario);
    if (result.outcome instanceof Error) throw result.outcome;
    expect(result.commands).toContain("byte_verify");
    // Neither pack may be used: the mismatch differs in content, the tamper fails its digest.
    expect(result.outcome.source).toBe("uploaded");
    expect(result.outcome.manifest).toEqual(server.manifest);
    expect(result.usage.bytesUploaded).toBeGreaterThan(LARGE_ARTIFACT_BYTES);
  }, 120_000);

  it("(c) reports an interrupted Runner daemon inventory as unavailable, never incompatible", async () => {
    const result = await probe("daemon_timeout");
    expect(result.outcome).toBeInstanceOf(Error);
    const message = (result.outcome as Error).message;
    expect(message).toMatch(/^runner_remote_provider_verification_unavailable:/);
    expect(message).not.toMatch(/incompatible/);
    expect(result.walks).toBe(0);
  }, 120_000);
});
