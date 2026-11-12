import express from "express";
import request from "supertest";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, budgetReservations, heartbeatRuns, heartbeatRunEvents, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { PrpEvent } from "../vendor/paperclip-runner/index.js";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { FakeCodexTransport } from "../../../packages/paperclip-runner/src/drivers/codex/codex-app-server-driver.test-support.js";
import { canonicalNativeRuntimeContextDigest, PI_RPC_DISTRIBUTION, QUALIFIED_ACPX_PROFILES, QUALIFIED_PI_RPC_PROFILE } from "@paperclipai/paperclip-runner";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { resolvePaperclipRunnerNativeProviderInput, resolvePaperclipRunnerProviderProfile } from "../services/native-runtime/provider-profile.js";

type BackendOptions = NonNullable<Parameters<typeof import("../vendor/paperclip-runner/index.js").createNativeSessionBackend>[1]>;
type TransportOptions = NonNullable<Parameters<typeof import("../vendor/paperclip-runner/index.js").createRunnerdCodexTransport>[0]>;
const mocks = vi.hoisted(() => ({
  getAgent: vi.fn(), updateAgent: vi.fn(), selectConnection: vi.fn(), logActivity: vi.fn(),
  normalizeSecrets: vi.fn(async (_company: string, config: Record<string, unknown>) => config),
  createBackend: vi.fn((_input: unknown, _options: BackendOptions) => ({ kind: "test" })),
  createTransport: vi.fn((_options: TransportOptions) => ({ transport: {} })),
  runnerBinary: "",
  usageCapture: vi.fn(async (receipt: unknown) => receipt),
  producerCapture: vi.fn(async (_event: unknown) => undefined),
  events: [] as Array<{ eventType: string }>,
}));

// Same HTTP/service doubles as agent-adapter-validation-routes.test.ts. The
// route, permission normalization and isAiConnectionCompatible all stay real.
vi.mock("../services/index.js", () => ({
  agentService: () => ({ getById: mocks.getAgent, update: mocks.updateAgent }),
  agentInstructionsService: () => ({ materializeManagedBundle: async (agent: { adapterConfig: unknown }) => ({ adapterConfig: agent.adapterConfig }) }),
  accessService: () => ({ canUser: async () => true, hasPermission: async () => true,
    decide: async () => ({ allowed: true, reason: "allow_explicit_grant", explanation: "Test grant" }) }),
  approvalService: () => ({}), builtInAgentService: () => ({}), budgetService: () => ({}),
  companySkillService: () => ({ listRuntimeSkillEntries: async () => [], resolveRequestedSkillKeys: async () => [] }),
  heartbeatService: () => ({}), issueApprovalService: () => ({}), issueService: () => ({}),
  workspaceOperationService: () => ({}), logActivity: mocks.logActivity,
  secretService: () => ({ normalizeAdapterConfigForPersistence: mocks.normalizeSecrets, syncEnvBindingsForTarget: async () => undefined }),
  syncInstructionsBundleConfigFromFilePath: (_agent: unknown, config: unknown) => config,
}));
vi.mock("../services/secrets.js", () => ({ secretService: () => ({
  normalizeAdapterConfigForPersistence: mocks.normalizeSecrets, syncEnvBindingsForTarget: async () => undefined,
}) }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => ({
  get: async () => ({ defaultEnvironmentId: null }), getGeneral: async () => ({ censorUsernameInLogs: false }),
  getExperimental: async () => ({ enableNativeRunner: true }),
}) }));
vi.mock("../services/adapter-plugin-store.js", () => ({
  getDisabledAdapterTypes: () => [], isAdapterDisabled: () => false,
  listAdapterPlugins: () => [], getAdapterPluginByType: () => undefined,
}));
// As in agent-test-environment-routes.test.ts, mock account selection, not the
// shared compatibility check that formerly rejected paperclip/<id> with 422.
vi.mock("../services/ai-connections.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/ai-connections.js")>(),
  aiConnectionService: () => ({ select: mocks.selectConnection }),
}));
// Reuse the executor suite's backend/transport capture boundary: no runner,
// sandbox, credentials, AI endpoint, or provider process is actually contacted.
vi.mock("../vendor/paperclip-runner/index.js", async importOriginal => ({
  ...await importOriginal<typeof import("../vendor/paperclip-runner/index.js")>(),
  createNativeSessionBackend: mocks.createBackend, createRunnerdCodexTransport: mocks.createTransport,
}));
vi.mock("../runtime-api.js", async importOriginal => ({
  ...await importOriginal<typeof import("../runtime-api.js")>(), resolveLocalRuntimeApiUrl: () => "http://127.0.0.1:3100",
}));
vi.mock("../services/native-runtime/paperclip-runner-tool-authority.js", () => ({
  PaperclipRunnerToolAuthority: class {
    constructor(_db: unknown, readonly binding: unknown) {}
    async definitions() { return []; }
    close() {}
  },
}));
// Existing executor harness scopes transport tests away from durable recovery:
// the partial DB models a fresh run, not persisted controller proof.
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

// Persistence is an in-memory port; executor, runnerd backend, native runtime
// and facade driver remain real. As in the executor suite, no durable recovery
// or DB integration claim is made by this fake-runnerd attempt harness.
vi.mock("../services/usage-receipts.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/usage-receipts.js")>(),
  createRunUsageRecorder: async () => ({ capture: mocks.usageCapture }),
}));
vi.mock("../services/native-runtime/native-runner-file-handoff.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/native-runtime/native-runner-file-handoff.js")>(),
  stageNativeRunnerWakeAttachments: async () => ({ attachments: [], cleanup: async () => undefined }),
  renderNativeRunnerStagedAttachmentPrompt: () => "",
}));
vi.mock("../services/native-runtime/native-usage-delivery.js", () => ({
  createNativeUsageDelivery: vi.fn(async () => ({ capture: mocks.producerCapture })),
}));
vi.mock("../services/native-runtime/paperclip-control-plane-port.js", async importOriginal => {
  const original = await importOriginal<typeof import("../services/native-runtime/paperclip-control-plane-port.js")>();
  return { ...original, PaperclipControlPlanePort: class {
    cursor = 0;
    constructor(_db: unknown, _binding: unknown,
      readonly options: ConstructorParameters<typeof original.PaperclipControlPlanePort>[2] = {}) {}
    async openRun() {}
    async loadSessionCheckpoint() { return null; }
    async checkpointSession() {}
    async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; }
    normalizeReplayPayload(payload: unknown) { return payload; }
    async appendEvent(event: PrpEvent) {
      mocks.events.push(event);
      await this.options.onCommittedEvent?.(event, ++this.cursor);
      return { cursor: this.cursor, highestContiguousSourceSeq: event.sourceSeq, disposition: "committed" };
    }
    async completeRun() { await this.options.onResultCommitted?.(); }
  } };
});

import { createRunnerdBackend, executePaperclipNativeSession, sha256DirectoryTree } from "../services/native-runtime/native-session-executor.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "10000000-0000-4000-8000-000000000001";
// A fixed personal selection uses the schema's delegated connection + grant.
const binding = { provider: "anthropic", method: "api_key", mode: "delegated",
  connectionId: "22222222-2222-4222-8222-222222222222", grantId: "22222222-2222-4222-8222-222222222223" } as const;
const piConfig = { provider: "pi_rpc", model: "paperclip/claude-opus-5-5", piRpcThinkingLevel: "xhigh", lifecycleMode: "warm" };
let root: string;

// The existing executor leaseDb query shape, restricted to the launch boundary.
// No persistence/recovery claim is made by these tests.
function launchDb(): Db {
  return { select: () => ({ from: () => {
    const result = Promise.resolve([]);
    const query = { then: result.then.bind(result), where: () => query, limit: () => query, orderBy: () => query };
    return query;
  } }) } as unknown as Db;
}

async function createApp() {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", userId: "local-board", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: false };
    next();
  });
  const db = { select: () => ({ from: () => ({ where: async () => [{ id: companyId, requireBoardApprovalForNewAgents: false }] }) }) };
  app.use("/api", agentRoutes(db as unknown as Db));
  app.use(errorHandler);
  return app;
}

// Existing route harness's explicit loopback listener and deterministic close.
async function patchSavedPi() {
  const app = await createApp();
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected loopback TCP listener");
    const response = await request(`http://127.0.0.1:${address.port}`).patch(`/api/agents/${agentId}`)
      .send({ adapterType: "paperclip_runner", adapterConfig: piConfig });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const saved = await mocks.getAgent();
    expect(saved).toMatchObject({ adapterType: "paperclip_runner", adapterConfig: piConfig, runtimeConfig: { aiConnection: binding } });
    expect(saved.adapterConfig).not.toHaveProperty("codexPermissionMode");
    expect(mocks.selectConnection).toHaveBeenCalledWith(expect.objectContaining({
      companyId, agentId, adapterType: "paperclip_runner", runnerProvider: "pi_rpc", model: piConfig.model, binding,
    }));
    return saved;
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function executionFor(saved: { adapterConfig: Record<string, unknown> }) {
  const profile = resolvePaperclipRunnerProviderProfile(saved.adapterConfig, { companyId });
  const provider = resolvePaperclipRunnerNativeProviderInput({ companyId, backend: profile.backend, adapterConfig: saved.adapterConfig });
  const context = nativeRuntimeContextFixture();
  context.instructions.bundle.rootPath = root;
  context.aggregateDigest = canonicalNativeRuntimeContextDigest(context);
  return buildNativeExecutionInput({
    ...provider, companyId, agentId, runId: randomUUID(), normalizedSessionId: randomUUID(),
    issue: { id: "30000000-0000-4000-8000-000000000003", identifier: "PI-SERVER-1", title: "Native Pi server path", description: null, workMode: "standard" },
    taskPrompt: "Exercise the saved agent launch without contacting a provider.",
    workspace: { id: "40000000-0000-4000-8000-000000000004", cwd: root, repoUrl: null, repoRef: null, branchName: null },
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    completionContract: { id: "50000000-0000-4000-8000-000000000005", sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1",
      contract: { revision: "1", objective: "Preserve the selected provider", criteria: [{ id: "launch", requirement: "Launch the selected harness" }] } },
    runtimeContext: context,
  });
}

function capturedLaunch() {
  expect(mocks.createBackend).toHaveBeenCalledOnce();
  const factory = mocks.createBackend.mock.calls[0]![1].codexTransportFactory;
  expect(factory).toBeTypeOf("function");
  factory!();
  expect(mocks.createTransport).toHaveBeenCalledOnce();
  return mocks.createTransport.mock.calls[0]![0];
}

const digest = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function providerPack() {
  // Same fully digested on-disk pack fixture as native-session-executor.test.ts,
  // with nativeProviders.pi_rpc and artifacts exactly as build-provider-pack.mjs
  // emits. Synthetic executable bytes are NEVER run; the sandbox is a double.
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
    const bytes = `server-path fixture: ${key}\n`;
    await mkdir(dirname(join(packRoot, path)), { recursive: true });
    await writeFile(join(packRoot, path), bytes);
    artifacts[key as keyof typeof paths] = { path, sha256: digest(bytes) };
  }
  const payload = {
    compatibility: { opencode: 1, acpx: 1 }, contractDigest: digest("server-path-contract"),
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
  // The digest exactly as build-provider-pack.mjs writes it (code-unit key order).
  const { canonicalProviderPackDigestJson } = await import("../services/native-runtime/remote-provider-pack-verification.js");
  const manifest = { schema: "paperclip-runner/remote-provider-pack/v1", payload, digest: digest(canonicalProviderPackDigestJson(payload)) };
  await writeFile(join(packRoot, "provider-pack.json"), JSON.stringify(manifest));
  return { packRoot, manifest };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.events = [];
  mocks.createBackend.mockImplementation(() => ({ kind: "test" }));
  mocks.createTransport.mockImplementation(() => ({ transport: {} }));
  root = await mkdtemp(join(tmpdir(), "native-pi-rpc-server-path-"));
  await writeFile(join(root, "AGENTS.md"), "X");
  vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(root, "runner-state"));
  vi.stubEnv("PAPERCLIP_HOME", join(root, "paperclip-home"));
  vi.stubEnv("PAPERCLIP_ACPX_CANDIDATE_ADMISSION", undefined);
  mocks.runnerBinary = join(root, "paperclip-runnerd");
  const daemon = Buffer.alloc(64); daemon.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); daemon.writeUInt16LE(62, 18);
  await writeFile(mocks.runnerBinary, daemon);
  let agent = { id: agentId, companyId, name: "Saved Pi", urlKey: "saved-pi", role: "engineer", status: "idle",
    adapterType: "pi_local", adapterConfig: { model: piConfig.model } as Record<string, unknown>, runtimeConfig: { aiConnection: binding },
    defaultEnvironmentId: null, permissions: { canCreateAgents: false }, budgetMonthlyCents: 0, spentMonthlyCents: 0,
    reportsTo: null, metadata: null, createdAt: new Date(0), updatedAt: new Date(0) };
  mocks.getAgent.mockImplementation(async () => agent);
  mocks.updateAgent.mockImplementation(async (_id: string, patch: Partial<typeof agent>) => { agent = { ...agent, ...patch }; return agent; });
  mocks.selectConnection.mockResolvedValue({ connection: { id: binding.connectionId, config: { ai: { provider: "anthropic", method: "api_key" } } } });
  mocks.logActivity.mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

// Keep reason: recorded hq-test incidents (PATCH permission-default 422,
// broker-model fixed-connection 422, and pi_rpc silently launched as Codex).
// This is server-path integration evidence, NOT a real Pi/runnerd live proof.
describe("native Pi RPC server path: saved agent to runner launch", () => {
  it("case 1: PATCH pi_local to warm pi_rpc with a fixed Anthropic API connection returns 200 without codexPermissionMode", async () => {
    await patchSavedPi();
    expect(mocks.logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "agent.updated", entityId: agentId }));
  });

  it("case 2 local: saved native Pi RPC reaches runnerd as pi_rpc with xhigh thinking (never implicit Codex)", async () => {
    const saved = await patchSavedPi();
    const execution = executionFor(saved);
    expect(execution.provider).toMatchObject({ kind: "pi_rpc", model: piConfig.model, piRpcThinkingLevel: "xhigh" });
    expect(execution.session.driverKind).toBe("pi_rpc");
    const { packRoot, manifest } = await providerPack();
    await createRunnerdBackend({ db: launchDb(), execution, runnerInstanceId: "server-path-local", runnerExecutionTarget: { kind: "local" }, runnerRemoteProviderPackPath: packRoot });
    const launch = capturedLaunch();
    expect.soft(launch.provider, "native Pi must not default to the Codex transport").toBe("pi_rpc");
    expect.soft(launch.piRpcThinkingLevel, "exact native Pi thinking must reach runnerd").toBe("xhigh");
    expect(launch.lifecyclePolicy).toEqual({ mode: "warm", idleTimeoutMs: 60_000 });
    for (const [pathKey, digestKey, artifact] of [
      ["providerNodeCommand", "providerNodeCommandSha256", manifest.payload.artifacts.nodeCommand],
      ["piCommand", "piCommandSha256", manifest.payload.artifacts.piRpcExecutable],
      ["piProxyPath", "piProxySha256", manifest.payload.artifacts.piRpcProxy],
    ] as const) {
      expect.soft(launch[pathKey], `local ${pathKey} must use the verified provider pack`).toBe(join(packRoot, artifact.path));
      expect.soft(launch[digestKey]).toBe(artifact.sha256);
    }
    expect(launch.providerPackAuthorityDigest).toBe(manifest.digest);
    expect(launch).not.toHaveProperty("piThinkingLevel");
    expect(launch).not.toHaveProperty("acpxAgent");
  });

  it("case 2 remote sandbox: native Pi RPC launch carries the verified Node, Pi and proxy pack paths/digests and Pi agent directory", async () => {
    const execution = executionFor(await patchSavedPi());
    const { packRoot, manifest } = await providerPack();
    const execute = vi.fn(async (command: { command: string; args?: string[] }) => ({
      exitCode: 0, signal: null, timedOut: false, stderr: "",
      stdout: command.args?.[0] === "--build-metadata" ? JSON.stringify({
        schema: "paperclip-runner/runnerd-build-metadata/v1", binaryName: "paperclip-runnerd", packageName: "@paperclipai/paperclip-runner", binaryContractVersion: 2,
        durableSessionCapabilities: ["unlimited_runtime", "connection_lease_renewal"], prpTransportModes: ["listen_ws"],
      }) : command.args?.[0] === "--version" ? "1.18.34\n" : "",
    }));
    const syncIn = vi.fn(async () => undefined);
    await createRunnerdBackend({ db: launchDb(), execution, runnerInstanceId: "server-path-remote", runnerIngressAuthorized: true,
      runnerRemoteBinaryPath: mocks.runnerBinary, runnerRemoteProviderPackPath: packRoot,
      runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace", environmentId: "environment", leaseId: "lease",
        effectiveCapabilities: { runnerWebSocketIngress: true }, runner: { execute, syncIn } } as never,
    });
    const launch = capturedLaunch();
    expect.soft(launch.provider, "remote native Pi must not default to Codex").toBe("pi_rpc");
    expect.soft(launch.piRpcThinkingLevel).toBe("xhigh");
    const remotePack = "/workspace/.paperclip-runtime/paperclip-runner/provider-pack";
    const artifacts = manifest.payload.artifacts;
    for (const [pathKey, digestKey, artifact] of [
      ["providerNodeCommand", "providerNodeCommandSha256", artifacts.nodeCommand],
      ["piCommand", "piCommandSha256", artifacts.piRpcExecutable],
      ["piProxyPath", "piProxySha256", artifacts.piRpcProxy],
    ] as const) {
      expect.soft(launch[pathKey], `${pathKey} must be the verified remote pack path`).toBe(posix.join(remotePack, artifact.path));
      expect.soft(launch[digestKey], `${digestKey} must preserve the verified pack digest`).toBe(artifact.sha256);
    }
    expect.soft(launch.providerPackAuthorityDigest).toBe(manifest.digest);
    expect.soft(launch.environment?.PI_CODING_AGENT_DIR, "sandbox must receive an absolute Pi agent directory").toEqual(expect.stringMatching(/^\/(?!$)/));
    expect.soft(launch.environment?.PI_CODING_AGENT_DIR).not.toEqual(expect.stringContaining(root));
    expect.soft(execute.mock.calls.some(([command]) => command.args?.[0] === "-e" && command.args?.[2] === remotePack),
      "server must verify the selected pack on the sandbox before launch").toBe(true);
    expect(launch.externallySandboxed).toBe(true);
    expect(launch.lifecyclePolicy).toEqual({ mode: "warm", idleTimeoutMs: 60_000 });
  });

  it("case 3 ACPX Pi control: keeps ACPX Pi and its legacy thinking/permission launch options unchanged", async () => {
    const execution = executionFor({ adapterConfig: { provider: "acpx", acpxAgent: "pi", model: "anthropic/claude-opus-5-5", piThinkingLevel: "high", acpxPermissionMode: "approve-all" } });
    await createRunnerdBackend({ db: launchDb(), execution, runnerInstanceId: "server-path-acpx-pi" });
    const launch = capturedLaunch();
    expect(launch).toMatchObject({ provider: "acpx", acpxAgent: "pi", piThinkingLevel: "high", acpxPermissionMode: "approve-all" });
    expect(launch.piRpcThinkingLevel).toBeUndefined();
    expect(launch.piCommand).toBeUndefined();
    expect(launch.piProxyPath).toBeUndefined();
  });

  it("case 3 Codex control: keeps the explicit Codex launch and absence of Pi options unchanged", async () => {
    const execution = executionFor({ adapterConfig: { provider: "codex", model: "gpt-6.1-sol", codexPermissionMode: "never" } });
    await createRunnerdBackend({ db: launchDb(), execution, runnerInstanceId: "server-path-codex" });
    const launch = capturedLaunch();
    expect(launch.provider).toBe("codex");
    expect(launch.disableCodexWebSearch).toBe(false);
    expect(launch.piRpcThinkingLevel).toBeUndefined();
    expect(launch.piThinkingLevel).toBeUndefined();
    expect(launch.acpxAgent).toBeUndefined();
    expect(launch.piCommand).toBeUndefined();
    expect(launch.piProxyPath).toBeUndefined();
  });
});

// Same leaseDb shape used by native-session-executor.test.ts full attempts.
function attemptDb(execution: ReturnType<typeof executionFor>): Db {
  const rows = new Map<unknown, unknown[]>([
    [nativeRunFinalizations, [{ ...execution.binding, phase: "observed", attempt: 0, leaseOwner: null, leaseExpiresAt: null, resultId: null }]],
    [heartbeatRuns, [{ id: execution.binding.runId, companyId, agentId,
      nativeIssueId: execution.binding.issueId, nativeSessionId: execution.session.normalizedSessionId,
      runnerInstanceId: "runner", completionContractId: execution.completionContract.id,
      completionContractSha256: execution.completionContract.sha256, resultJson: {}, runnerProfileJson: {}, runtimeMode: "native", status: "running" }]],
    [issues, [{ id: execution.binding.issueId, companyId, assigneeAgentId: agentId,
      status: "todo", executionRunId: execution.binding.runId, checkoutRunId: null }]],
    [budgetReservations, [{ id: "held-reservation" }]], [activityLog, []], [heartbeatRunEvents, []],
  ]);
  const query = (values: unknown[]) => {
    const result = Promise.resolve(values);
    const q: any = { then: result.then.bind(result), from: (table: unknown) => query(rows.get(table) ?? []),
      leftJoin: () => q, where: () => q, orderBy: () => q, for: () => q, limit: () => q,
      returning: async () => values, onConflictDoUpdate: () => q, onConflictDoNothing: () => q };
    return q;
  };
  const db: any = {
    select: () => query([]), update: () => ({ set: () => query([{ runId: execution.binding.runId, nextEventSeq: 2 }]) }),
    insert: () => ({ values: (value: unknown) => query([value]) }), execute: async () => [],
    transaction: async (operation: (tx: Db) => Promise<unknown>) => operation(db),
  };
  return db;
}

// Keep reason: the recorded hq-test native attempt gate and silent accounting
// omissions. Only provider transport and persistence are doubles, not execution.
describe("native Pi RPC complete executor attempts", () => {
  it.each(["local", "remote sandbox"] as const)("%s: starts provider work and completes a real native turn with usage", async target => {
    const saved = await patchSavedPi();
    const execution = executionFor(saved);
    const actual = await vi.importActual<typeof import("../vendor/paperclip-runner/index.js")>("../vendor/paperclip-runner/index.js");
    const { rehydrateRunnerdUsageNotification } = await import("@paperclipai/paperclip-runner/live");
    const result = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Native Pi attempt completed.",
      completionClaim: { contractRevision: "1", objectiveSatisfied: true,
        criteria: [{ criterionId: "launch", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
      evidence: [], verification: [{ commandOrCheck: "fake runnerd native turn", status: "passed" }], attentionRequests: [], artifacts: [] };
    let transport: FakeCodexTransport | undefined;
    mocks.createBackend.mockImplementation((input, options) => actual.createNativeSessionBackend(input as never, options) as never);
    mocks.createTransport.mockImplementation(options => {
      class PiRunnerdTransport extends FakeCodexTransport {
        override async request(method: string, params: Record<string, unknown>) {
          const response = await super.request(method, params);
          if (method === "thread/start" || method === "thread/resume") {
            return { ...response, model: piConfig.model, cwd: options.workingDirectory,
              thread: { ...(response.thread as object), cwd: options.workingDirectory } };
          }
          if (method === "turn/start") {
            const usage = rehydrateRunnerdUsageNotification({ provider: "pi_rpc", runDeltaAvailable: true,
              runDelta: { inputTokens: 120, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, providerCostUsd: 0.25 },
              cumulative: { inputTokens: 120, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, providerCostUsd: 0.25 } }, this.threadId, "turn-1");
            queueMicrotask(() => {
              this.push("turn/started", { threadId: this.threadId, turn: { id: "turn-1", status: "inProgress" } });
              this.push("thread/tokenUsage/updated", usage);
              this.push("paperclip/runResult", { threadId: this.threadId, turnId: "turn-1", result });
              this.push("turn/completed", { threadId: this.threadId, turn: { id: "turn-1", status: "completed", items: [] } });
            });
          }
          return response;
        }
      }
      transport = new PiRunnerdTransport();
      return { transport } as never;
    });
    const remote = target === "remote sandbox" ? await providerPack() : null;
    const execute = vi.fn(async (command: { command: string; args?: string[] }) => ({ exitCode: 0, signal: null, timedOut: false, stderr: "",
      stdout: command.args?.[0] === "--build-metadata" ? JSON.stringify({
        schema: "paperclip-runner/runnerd-build-metadata/v1", binaryName: "paperclip-runnerd", packageName: "@paperclipai/paperclip-runner", binaryContractVersion: 2,
        durableSessionCapabilities: ["unlimited_runtime", "connection_lease_renewal"], prpTransportModes: ["listen_ws"],
      }) : command.args?.[0] === "--version" ? "1.18.34\n" : "" }));
    const outcome = await executePaperclipNativeSession({ db: attemptDb(execution), execution, useRunnerd: true, runnerInstanceId: "runner",
      billingIdentity: { provider: "anthropic", biller: "anthropic", billingType: "metered_api" },
      ...(remote ? { runnerIngressAuthorized: true, runnerRemoteBinaryPath: mocks.runnerBinary, runnerRemoteProviderPackPath: remote.packRoot,
        runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace", environmentId: "environment", leaseId: "lease",
          effectiveCapabilities: { runnerWebSocketIngress: true }, runner: { execute, syncIn: async () => undefined } } as never,
      } : { runnerExecutionTarget: { kind: "local" as const } }),
    });
    const providerWorkStarted = transport?.calls.some(call => call.method === "turn/start") === true
      && mocks.events.some(event => event.eventType === "turn.started");
    expect(providerWorkStarted).toBe(true);
    expect(mocks.events.some(event => event.eventType === "turn.completed")).toBe(true);
    expect(outcome).toMatchObject({ exitCode: 0, usageComplete: true, usage: { inputTokens: 120, outputTokens: 10 }, costUsdExact: "0.250000000" });
    expect(outcome.resultJson).toMatchObject({ nativeTerminal: { runTerminalState: "succeeded", turnTerminalState: "completed" } });
    expect(mocks.createTransport.mock.calls.at(-1)![0]).toMatchObject({ provider: "pi_rpc", piRpcThinkingLevel: "xhigh", lifecyclePolicy: { mode: "warm" } });
    if (remote) {
      const { createNativeUsageDelivery } = await import("../services/native-runtime/native-usage-delivery.js");
      expect(createNativeUsageDelivery).toHaveBeenCalledOnce();
      expect(mocks.createTransport.mock.calls.at(-1)![0].onAccountingEvent).toBeTypeOf("function");
    }
  });
});

describe("native attempt provider gate", () => {
  it("admits native Pi RPC at the start of a native attempt, like ACPX and Codex", async () => {
    const { isNativeAttemptProviderSupported } = await import("../services/native-runtime/native-session-executor.js");
    const schema = "paperclip.native-execution-input.v9" as never;
    for (const kind of ["pi_rpc", "acpx", "codex", "opencode"]) {
      expect(isNativeAttemptProviderSupported({ schema, provider: { kind } as never }), kind).toBe(true);
    }
    expect(isNativeAttemptProviderSupported({ schema, provider: { kind: "unknown_provider" } as never })).toBe(false);
  });
});
