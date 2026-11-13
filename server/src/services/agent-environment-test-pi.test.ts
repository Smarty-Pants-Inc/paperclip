import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
const mocks = vi.hoisted(() => ({ probe: vi.fn(), adapter: vi.fn(), prepare: vi.fn(), launch: vi.fn(), driver: vi.fn(), markAuthFailed: vi.fn(), verifyKey: vi.fn(), sync: vi.fn() }));
vi.mock("./ai-api-key-test.js", () => ({ validateAiApiKey: mocks.verifyKey }));
vi.mock("./ai-connections.js", async original => ({ ...await original<object>(), aiConnectionService: () => ({ markAuthenticationFailed: mocks.markAuthFailed }) }));
vi.mock("../adapters/index.js", () => ({ requireServerAdapter: () => ({ testEnvironment: mocks.adapter }) }));
vi.mock("../vendor/paperclip-runner/index.js", async original => ({ ...await original<object>(), probeNativeRunnerEnvironment: mocks.probe }));
vi.mock("./native-runtime/native-session-executor.js", async () => ({
  resolveLocalPiLaunchArtifacts: async () => ({ piCommand: "/selected/pi.js", piProxyPath: "/selected/proxy.cjs" }),
  resolveRemoteProviderPackSource: () => ({ configuredRoot: "/selected/pack", manifest: { digest: `sha256:${"a".repeat(64)}`, payload: { nativeProviders: { pi_rpc: { version: "1.5.2", profileDigest: QUALIFIED_PI_RPC_PROFILE.commandDigest, path: "provider-assets/pi_rpc/linux-x64", sha256: `sha256:${"b".repeat(64)}`, closureDigest: `sha256:${"c".repeat(64)}` } }, artifacts: {
    nodeCommand: { path: "node", sha256: `sha256:${"d".repeat(64)}` }, piRpcExecutable: { path: "provider-assets/pi_rpc/linux-x64/runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", sha256: `sha256:${"e".repeat(64)}` }, piRpcProxy: { path: "dist/cli/pi-rpc-app-server-proxy.cjs", sha256: `sha256:${"f".repeat(64)}` },
  } } } }), prepareRemoteProviderPackOnTarget: mocks.prepare, stageRemoteRunnerFile: vi.fn(), createRemoteRunnerProcessLauncher: mocks.launch, readRemoteRunnerState: vi.fn(), syncRemoteRunnerDirectoryOut: mocks.sync,
}));
vi.mock("./native-runtime/native-codex-runner.js", () => ({ resolveRemotePaperclipRunnerBinary: () => "/selected/runnerd", resolvePaperclipRunnerBinary: () => "/selected/runnerd" }));
vi.mock("./native-runtime/native-runner-execution-driver.js", () => ({ createNativeRunnerExecutionDriver: mocks.driver, prepareNativeRemoteRunner: async (input: { prepareRemote: () => Promise<void> }) => input.prepareRemote() }));
import { QUALIFIED_PI_RPC_PROFILE } from "../vendor/paperclip-runner/index.js";
import { testNativeRunnerAuthentication } from "./native-runtime/setup-readiness.js";
import { assertHarnessTestPassed } from "./agent-harness-verification.js";
import { agentEnvironmentTestService } from "./agent-environment-test.js";
const model = "paperclip/gateway/nested/claude-opus-5-5";
const runner = { execute: vi.fn() };
const target = { kind: "remote", transport: "sandbox", providerKey: "fixture", remoteCwd: "/selected/factory/workspace", leaseId: "selected-lease", runner } as const;
const config = { provider: "pi_rpc", model, piRpcThinkingLevel: "xhigh", env: { PAPERCLIP_AI_PROVIDER_KEY: "credential-canary", PAPERCLIP_PI_RPC_CREDENTIAL_MODE: "env" }, managedAiConnection: { method: "api_key" } };
const receipt = { provider: "pi_rpc", providerDriver: "pi_rpc", effectiveModel: model, helloProbePassed: true };
async function test(configOverride = config, executionTarget: AdapterEnvironmentTestContext["executionTarget"] = target) {
  const service = agentEnvironmentTestService({} as Db);
  return service.testManagedEnvironment("paperclip_runner", { companyId: "company", adapterType: "paperclip_runner", config: configOverride, executionTarget },
    { provider: "anthropic", mode: "responsible_user", method: "api_key" },
    { identity: "managed-binding-28", sessionIdentity: "account-28", attribution: {} } as Parameters<typeof service.testManagedEnvironment>[3]);
}
beforeEach(() => {
  mocks.probe.mockImplementation(async options => options.admissionOnly ? { ...receipt, helloProbePassed: false, admissionOnly: true, sessionAdmissionPassed: true, piMetadata: { version: "1.5.2", providers: ["paperclip"], credentialMode: "env", promptSent: false } } : receipt);
  runner.execute.mockResolvedValue({ exitCode: 0, timedOut: false, stdout: "", stderr: "" });
  mocks.prepare.mockResolvedValue({ root: "/selected/remote-pack" });
  mocks.sync.mockReset().mockResolvedValue(undefined);
  mocks.launch.mockReturnValue(vi.fn());
  mocks.driver.mockReturnValue({ controlPlaneRegistration: vi.fn() });
});
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
describe("native managed Pi Setup Test", () => {
  it("uses the selected remote factory through the run facade/proxy with the exact managed model and native effort", async () => {
    const result = await test();
    expect(result.status).toBe("pass");
    expect(result.checks.map(c => c.code)).toEqual(["pi_rpc_metadata_verified", "pi_hello_probe_passed"]);
    expect(mocks.driver).toHaveBeenCalledWith(expect.objectContaining({ target }));
    expect(mocks.launch).toHaveBeenCalledWith(expect.objectContaining({ target, runner }));
    expect(mocks.probe).toHaveBeenCalledTimes(2);
    expect(mocks.probe.mock.calls[0][0]).toMatchObject({ provider: "pi_rpc", model, admissionOnly: true, transportOptions: { piRpcThinkingLevel: "xhigh" } });
    expect(mocks.probe.mock.calls[1][0]).toMatchObject({ provider: "pi_rpc", model, environment: config.env,
      workingDirectory: target.remoteCwd, transportOptions: { piRpcThinkingLevel: "xhigh", piCommand: "/selected/remote-pack/provider-assets/pi_rpc/linux-x64/runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", piProxyPath: "/selected/remote-pack/dist/cli/pi-rpc-app-server-proxy.cjs" } });
    expect(mocks.adapter).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("credential-canary");
  });
  // Keep: remote sole-copy data safety. Assert actual retained filesystem bytes
  // exist BEFORE the remote rm is dispatched, and a failed pull forbids rm.
  it.each([false, true])("commits pulled probe bytes before remote deletion (pullFailure=%s)", async pullFailure => {
    const state = await mkdtemp(join(tmpdir(), "remote-setup-evidence-"));
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", state);
    const bytes = Buffer.from('{"type":"session","id":"opaque-remote-history"}\n');
    async function retained(root: string): Promise<boolean> {
      for (const item of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        const file = join(root, item.name);
        if (item.isDirectory() && await retained(file)) return true;
        if (item.isFile() && file.includes("/conversation-evidence/") && (await readFile(file)).equals(bytes)) return true;
      }
      return false;
    }
    mocks.sync.mockImplementation(async ({ targetPath }: { targetPath: string }) => {
      if (pullFailure) throw new Error("sync-out failed");
      await mkdir(join(targetPath, "pi"), { recursive: true, mode: 0o700 });
      await writeFile(join(targetPath, "pi", "history.jsonl"), bytes, { mode: 0o600 });
    });
    let removals = 0;
    runner.execute.mockImplementation(async (input: { command: string }) => {
      if (input.command === "rm") { removals++; expect(await retained(state)).toBe(true); }
      return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
    });
    mocks.probe.mockImplementation(async options => {
      await options.onCleanupConfirmed();
      return options.admissionOnly ? { ...receipt, helloProbePassed: false, sessionAdmissionPassed: true, piMetadata: { version: "1.5.2" } } : receipt;
    });
    const result = await test();
    expect(result.status).toBe(pullFailure ? "fail" : "pass");
    expect(removals).toBe(pullFailure ? 0 : 2);
    if (!pullFailure) expect(await retained(state)).toBe(true);
  });

  it("leaves explicit max admission to the native Pi model catalog", async () => {
    const result = await test({ ...config, piRpcThinkingLevel: "max" });
    expect(result.status).toBe("pass");
    expect(mocks.probe).toHaveBeenCalledTimes(2);
    for (const [input] of mocks.probe.mock.calls) expect(input.transportOptions.piRpcThinkingLevel).toBe("max");
  });
  it.each(["handled-but-empty", "tool-only", "stale-session", "EOF", "close-failed"])("reports %s as failure with a safe reason", async reason => {
    mocks.probe.mockResolvedValueOnce({ ...receipt, helloProbePassed: false, admissionOnly: true, sessionAdmissionPassed: true, piMetadata: { version: "1.5.2" } });
    const code = ({ "handled-but-empty": "pi_prompt_rejected", "tool-only": "pi_probe_tool_used", "stale-session": "pi_probe_session_mismatch", EOF: "pi_probe_stream_ended", "close-failed": "pi_probe_cleanup_unconfirmed" } as Record<string, string>)[reason];
    mocks.probe.mockRejectedValueOnce(Object.assign(new Error(`pi_probe_${reason}: credential-canary`), { code }));
    const result = await test();
    expect(result.status).toBe("fail");
    expect(result.checks.at(-1)).toMatchObject({ level: "error", code: "pi_hello_probe_failed" });
    expect(mocks.probe).toHaveBeenCalledTimes(2);
    expect(result.checks.at(-1)!.message.length).toBeGreaterThan(20);
    expect(JSON.stringify(result)).not.toContain("credential-canary");
    expect(mocks.adapter).not.toHaveBeenCalled();
  });
  it("cannot count a handled but empty hello receipt as success", async () => {
    mocks.probe.mockResolvedValueOnce({ ...receipt, helloProbePassed: false, admissionOnly: true, sessionAdmissionPassed: true, piMetadata: { version: "1.5.2" } });
    mocks.probe.mockResolvedValueOnce({ ...receipt, helloProbePassed: false });
    expect((await test()).status).toBe("fail");
  });
  // Keep: the production Boat hire stopped in verifying at this boundary.
  it("verifies managed native Pi through the plugin task instead of refusing the Boat target", async () => {
    const runnerTask = vi.fn(async () => ({ kind: "description", taskId: "boat-task", launchPreparationVersion: 1,
      projectAuthCheckVersion: 1, runner: { version: "fixture", digest: `sha256:${"a".repeat(64)}` } }));
    const selected = { ...config, env: { ...config.env, PAPERCLIP_AI_PROVIDER_URL: "https://selected-gateway.example/v1",
      PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "bearer" } };
    const result = await test(selected, { kind: "remote", transport: "sandbox", providerKey: "boat", leaseId: "boat-lease", remoteCwd: ".",
      runnerTaskProbe: { runId: "boat-probe", sessionId: "boat-session" }, runnerTask });
    expect(result).toMatchObject({ status: "pass", checks: [expect.objectContaining({ code: "pi_rpc_hello_probe_passed" })] });
    expect(() => assertHarnessTestPassed(result)).not.toThrow();
    expect(runnerTask).toHaveBeenCalledWith({ kind: "describe" });
    expect(mocks.probe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: "pi_rpc", model,
      environment: {}, transportOptions: expect.objectContaining({ prepareLaunch: expect.any(Function),
        runnerProcessLauncher: expect.any(Function), piRpcThinkingLevel: "xhigh" }) }));
    expect(mocks.adapter).not.toHaveBeenCalled();
    expect(mocks.verifyKey).not.toHaveBeenCalled();
  });
});

// Keep: rung-3 live hire verification rejected every locally probed managed Pi
// connection before the native probe. This is the credential trust boundary.
describe("local native Pi managed connection verification", () => {
  const managedConfig = { ...config, managedAiRouting: { kind: "gateway", protocol: "messages", auth: "bearer" },
    env: { ...config.env, PAPERCLIP_AI_PROVIDER_URL: "https://selected-gateway.example/v1",
      PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "bearer" } };
  beforeEach(() => {
    mocks.adapter.mockImplementation((context: AdapterEnvironmentTestContext) =>
      testNativeRunnerAuthentication(context, "pi_rpc", context.config.model as string));
    mocks.probe.mockImplementation(async options => {
      await options.onCleanupConfirmed();
      return receipt;
    });
  });
  it.each([null, "messages", "responses"] as const)("reaches native Pi with the selected managed key, route and model (protocol=%s)", async protocol => {
    const selected = protocol ? { ...managedConfig, env: { ...managedConfig.env, PAPERCLIP_AI_PROVIDER_PROTOCOL: protocol },
      managedAiRouting: { ...managedConfig.managedAiRouting, protocol } } : config;
    const result = await test(selected, null);
    expect(result.status).toBe("pass");
    expect(result.checks.map(check => check.code)).toEqual(["pi_rpc_hello_probe_passed"]);
    expect(() => assertHarnessTestPassed(result)).not.toThrow();
    expect(mocks.adapter).toHaveBeenCalledOnce();
    expect(mocks.probe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: "pi_rpc", model,
      environment: expect.objectContaining(selected.env),
      transportOptions: expect.objectContaining({ piCommand: "/selected/pi.js", piProxyPath: "/selected/proxy.cjs", piRpcThinkingLevel: "xhigh" }) }));
    expect(mocks.verifyKey).not.toHaveBeenCalled();
    expect(mocks.markAuthFailed).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("credential-canary");
  });
  it.each([
    [401, "Unauthorized 401: credential-canary", "pi_rpc_hello_probe_auth_required", "harness_auth_failed"],
    [404, "Model unavailable (404): credential-canary", "pi_rpc_hello_probe_model_unavailable", "harness_model_unavailable"],
  ] as const)("classifies native Pi HTTP %s without another provider probe", async (_status, message, check, failure) => {
    mocks.probe.mockImplementationOnce(async options => { await options.onCleanupConfirmed(); throw new Error(message); });
    const result = await test(managedConfig, null);
    expect(result.status).toBe("fail");
    expect(result.checks.map(item => item.code)).toEqual([check]);
    expect(() => assertHarnessTestPassed(result)).toThrow(expect.objectContaining({ code: failure }));
    expect(mocks.probe).toHaveBeenCalledOnce();
    expect(mocks.adapter).toHaveBeenCalledOnce();
    expect(mocks.verifyKey).not.toHaveBeenCalled();
    expect(mocks.markAuthFailed).toHaveBeenCalledTimes(_status === 401 ? 1 : 0);
    expect(JSON.stringify(result)).not.toContain("credential-canary");
  });
});
