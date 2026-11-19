import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { canonicalNativeRuntimeContextDigest, PI_RPC_DISTRIBUTION, QUALIFIED_ACPX_PROFILES, QUALIFIED_PI_RPC_PROFILE } from "@paperclipai/paperclip-runner";
import { createCapabilityRunnerdProviderEnvironment } from "../../../packages/paperclip-runner/src/live/runnerd-codex-transport.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { resolvePaperclipRunnerNativeProviderInput, resolvePaperclipRunnerProviderProfile } from "../services/native-runtime/provider-profile.js";

type BackendOptions = NonNullable<Parameters<typeof import("../vendor/paperclip-runner/index.js").createNativeSessionBackend>[1]>;
type TransportOptions = NonNullable<Parameters<typeof import("../vendor/paperclip-runner/index.js").createRunnerdCodexTransport>[0]>;
const mocks = vi.hoisted(() => ({
  createBackend: vi.fn((_input: unknown, _options: BackendOptions) => ({ kind: "test" })),
  createTransport: vi.fn((_options: TransportOptions) => ({ transport: {} })),
  runnerBinary: "",
}));
// Only external persistence, controller recovery and provider/runner processes
// are doubled. The normal task executor's env construction and the runner's
// Pi spawn-env projection both remain real; no hire probe is involved.
vi.mock("../vendor/paperclip-runner/index.js", async importOriginal => ({
  ...await importOriginal<typeof import("../vendor/paperclip-runner/index.js")>(),
  createNativeSessionBackend: mocks.createBackend,
  createRunnerdCodexTransport: mocks.createTransport,
}));
vi.mock("../runtime-api.js", async importOriginal => ({
  ...await importOriginal<typeof import("../runtime-api.js")>(),
  resolveLocalRuntimeApiUrl: () => "http://127.0.0.1:3100",
}));
vi.mock("../services/native-runtime/paperclip-runner-tool-authority.js", () => ({
  PaperclipRunnerToolAuthority: class {
    async definitions() { return []; }
    close() {}
  },
}));
vi.mock("../services/native-runtime/native-controller-recovery.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/native-runtime/native-controller-recovery.js")>(),
  resolveNativeControllerRecovery: async () => ({ kind: "no_prior_execution" as const }),
}));
vi.mock("../services/native-runtime/current-wake-comments.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/native-runtime/current-wake-comments.js")>(),
  resolveCurrentWakeCommentsBinding: async () => null,
  assertCurrentWakeCommentsRead: async () => undefined,
}));
vi.mock("../services/native-runtime/native-codex-runner.js", () => ({
  resolvePaperclipRunnerBinary: () => mocks.runnerBinary,
  resolvePaperclipRunnerBinaryAsync: async () => mocks.runnerBinary,
  resolveRemotePaperclipRunnerBinary: async () => mocks.runnerBinary,
  verifiedBundledRemoteRunnerBinary: async () => mocks.runnerBinary,
}));

import { buildNativeProviderEnvironment, createRunnerdBackend, sha256DirectoryTree } from "../services/native-runtime/native-session-executor.js";

let root: string;
const companyId = "10000000-0000-4000-8000-000000000001";
const agentId = "11111111-1111-4111-8111-111111111111";
const digest = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function launchDb(): Db {
  return { select: () => ({ from: () => {
    const result = Promise.resolve([]);
    const query = { then: result.then.bind(result), where: () => query, limit: () => query, orderBy: () => query };
    return query;
  } }) } as unknown as Db;
}

function taskExecution() {
  const adapterConfig = { provider: "pi_rpc", model: "paperclip/claude-opus-5-5", piRpcThinkingLevel: "xhigh", lifecycleMode: "warm" };
  const profile = resolvePaperclipRunnerProviderProfile(adapterConfig, { companyId });
  const provider = resolvePaperclipRunnerNativeProviderInput({ companyId, backend: profile.backend, adapterConfig });
  const context = nativeRuntimeContextFixture();
  context.instructions.bundle.rootPath = root;
  context.aggregateDigest = canonicalNativeRuntimeContextDigest(context);
  return buildNativeExecutionInput({
    ...provider, companyId, agentId, runId: randomUUID(), normalizedSessionId: randomUUID(),
    issue: { id: "30000000-0000-4000-8000-000000000003", identifier: "PI-AGENTDIR-1", title: "Normal Pi task", description: null, workMode: "standard" },
    taskPrompt: "Use the agent's Pi settings for this ordinary task.",
    workspace: { id: "40000000-0000-4000-8000-000000000004", cwd: root, repoUrl: null, repoRef: null, branchName: null },
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    completionContract: { id: "50000000-0000-4000-8000-000000000005", sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
      contract: { revision: "1", objective: "Use the intended Pi configuration", criteria: [{ id: "launch", requirement: "Preserve the Pi directory policy" }] } },
    runtimeContext: context,
  });
}

// Same digested, synthetic pack shape as native-pi-rpc-server-path.test.ts.
// These executable bytes are never run: sandbox commands are a boundary double.
async function providerPack() {
  const packRoot = join(root, "pack");
  const paths = {
    grokLauncher: "dist/providers/grok/launcher.cjs", nodeCommand: "node_modules/node/bin/node", productionLock: "pnpm-lock.yaml",
    opencodeCommand: "node_modules/.bin/opencode", opencodeExecutable: "node_modules/opencode-ai/bin/opencode.exe",
    opencodeProxy: "dist/cli/opencode-app-server-proxy.cjs", acpxSidecar: "dist/cli/acpx-runtime-sidecar.cjs",
    piRpcProxy: "dist/cli/pi-rpc-app-server-proxy.cjs",
    piRpcExecutable: "provider-assets/pi_rpc/linux-x64/runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
  };
  const artifacts = {} as Record<keyof typeof paths, { path: string; sha256: string }>;
  for (const [key, path] of Object.entries(paths)) {
    const bytes = `agentdir fixture: ${key}\n`;
    await mkdir(dirname(join(packRoot, path)), { recursive: true });
    await writeFile(join(packRoot, path), bytes);
    artifacts[key as keyof typeof paths] = { path, sha256: digest(bytes) };
  }
  const payload = {
    compatibility: { opencode: 1, acpx: 1 }, contractDigest: digest("agentdir-contract"),
    pins: { nodeMinimum: "24.11.0", codex: QUALIFIED_ACPX_PROFILES.codex.agentRuntimeVersion,
      opencode: "1.18.34", piRpc: "1.5.2", acpx: "0.22.0", grok: QUALIFIED_ACPX_PROFILES.grok.agentRuntimeVersion,
      claudeAcp: QUALIFIED_ACPX_PROFILES.claude.agentServerVersion, codexAcp: QUALIFIED_ACPX_PROFILES.codex.agentServerVersion },
    target: { platform: "linux", architecture: "x64" }, runnerSourceRevision: "1".repeat(40),
    distDigest: sha256DirectoryTree(join(packRoot, "dist")), bridgeDigest: "", artifacts,
    acpxProfileDigests: { grok: QUALIFIED_ACPX_PROFILES.grok.commandDigest,
      claude: QUALIFIED_ACPX_PROFILES.claude.commandDigest, codex: QUALIFIED_ACPX_PROFILES.codex.commandDigest },
    piRpcProfileDigest: QUALIFIED_PI_RPC_PROFILE.commandDigest,
    nativeProviders: { pi_rpc: { version: "1.5.2", profileDigest: QUALIFIED_PI_RPC_PROFILE.commandDigest,
      closureDigest: PI_RPC_DISTRIBUTION.targets["linux-x64"].closureSha256, path: "provider-assets/pi_rpc/linux-x64",
      sha256: sha256DirectoryTree(join(packRoot, "provider-assets/pi_rpc/linux-x64")) } },
  };
  payload.bridgeDigest = digest(`${artifacts.opencodeProxy.sha256}\n${artifacts.acpxSidecar.sha256}\n${payload.distDigest}`);
  const { canonicalProviderPackDigestJson } = await import("../services/native-runtime/remote-provider-pack-verification.js");
  const manifest = { schema: "paperclip-runner/remote-provider-pack/v1", payload, digest: digest(canonicalProviderPackDigestJson(payload)) };
  await writeFile(join(packRoot, "provider-pack.json"), JSON.stringify(manifest));
  return packRoot;
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), "native-pi-agentdir-task-"));
  await writeFile(join(root, "AGENTS.md"), "Task instructions\n");
  vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(root, "runner-state"));
  vi.stubEnv("PAPERCLIP_HOME", join(root, "paperclip-home"));
  vi.stubEnv("PAPERCLIP_ACPX_CANDIDATE_ADMISSION", undefined);
  // An ambient controller directory must not become a sandbox override.
  vi.stubEnv("PI_CODING_AGENT_DIR", "/controller/.pi/agent");
  mocks.runnerBinary = join(root, "paperclip-runnerd");
  const daemon = Buffer.alloc(64); daemon.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); daemon.writeUInt16LE(62, 18);
  await writeFile(mocks.runnerBinary, daemon);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

// catch: https://github.com/Smarty-Pants-Inc/paperclip/commit/c3c15054f11f969848687657805f409fa3b4c158
// Keep reason: c3c15054 forced a session Pi home for remote sandbox tasks,
// hiding the image's ~/.pi/agent settings. This is executor/transport integration
// evidence, not live provider, sandbox image, or hire-probe qualification.
describe("normal task session Pi spawn environment", () => {
  it.each([
    { row: "1 sandbox without config uses Pi's default", sandbox: true, agentDir: undefined },
    { row: "2 sandbox absolute agent config is preserved", sandbox: true, agentDir: "/home/agent/custom-pi" },
    { row: "3 sandbox relative agent config is ignored", sandbox: true, agentDir: ".pi/agent" },
    { row: "4 local target keeps its per-session Pi directory", sandbox: false, agentDir: undefined },
  ])("$row", async ({ sandbox, agentDir }) => {
    const execution = taskExecution();
    expect(execution.provider.kind).toBe("pi_rpc");
    const adapterEnv = agentDir === undefined ? {} : { PI_CODING_AGENT_DIR: agentDir };
    const runnerEnvironment = buildNativeProviderEnvironment(adapterEnv, process.env, root);
    expect(runnerEnvironment.PI_CODING_AGENT_DIR).toBe(agentDir);
    const packRoot = await providerPack();
    const execute = vi.fn(async (command: { args?: string[] }) => ({
      exitCode: 0, signal: null, timedOut: false, stderr: "",
      stdout: command.args?.[0] === "--build-metadata" ? JSON.stringify({
        schema: "paperclip-runner/runnerd-build-metadata/v1", binaryName: "paperclip-runnerd", packageName: "@paperclipai/paperclip-runner", binaryContractVersion: 2,
        durableSessionCapabilities: ["unlimited_runtime", "connection_lease_renewal"], prpTransportModes: ["listen_ws"],
      }) : command.args?.[0] === "--version" ? "1.18.34\n" : "",
    }));
    await createRunnerdBackend({ db: launchDb(), execution, runnerInstanceId: "agentdir-task", runnerEnvironment,
      runnerRemoteProviderPackPath: packRoot,
      ...(sandbox ? {
        runnerIngressAuthorized: true, runnerRemoteBinaryPath: mocks.runnerBinary,
        runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace", environmentId: "environment", leaseId: "lease",
          effectiveCapabilities: { runnerWebSocketIngress: true }, runner: { execute, syncIn: async () => undefined } } as never,
      } : { runnerExecutionTarget: { kind: "local" as const } }),
    });
    expect(mocks.createBackend).toHaveBeenCalledOnce();
    const factory = mocks.createBackend.mock.calls[0]![1].codexTransportFactory;
    expect(factory).toBeTypeOf("function");
    factory!();
    expect(mocks.createTransport).toHaveBeenCalledOnce();
    const launch = mocks.createTransport.mock.calls[0]![0];
    expect(launch.provider).toBe("pi_rpc");
    expect(launch.externallySandboxed === true).toBe(sandbox);
    // Run the actual runner transport projection, not an assertion limited to
    // the server's intermediate env or a hand-written spawn-env allowlist.
    const spawnEnv = createCapabilityRunnerdProviderEnvironment({
      provider: "pi_rpc", options: launch,
      identity: { runnerInstanceId: "agentdir-task", environmentLeaseId: "lease", runId: execution.binding.runId,
        normalizedSessionId: execution.session.normalizedSessionId, turnId: "turn", itemId: "item" },
      codexHome: join(root, "codex-home"), runtimeContextPath: join(root, "runtime-context.json"), hasRuntimeContext: false,
    });
    if (sandbox && agentDir !== "/home/agent/custom-pi") {
      expect(spawnEnv, "Pi must receive no override and use ~/.pi/agent").not.toHaveProperty("PI_CODING_AGENT_DIR");
    } else {
      const expected = sandbox ? agentDir : posix.join(launch.runnerFilesystemRoot ?? launch.stateDirectory!, "pi-agent");
      expect(spawnEnv.PI_CODING_AGENT_DIR).toBe(expected);
    }
    expect(spawnEnv.PI_CODING_AGENT_DIR).not.toBe("/controller/.pi/agent");
    expect(runnerEnvironment.PI_CODING_AGENT_DIR).toBe(agentDir);
  });
});
