import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
const mocks = vi.hoisted(() => ({ probe: vi.fn(), adapter: vi.fn(), prepare: vi.fn(), launch: vi.fn(), driver: vi.fn() }));
vi.mock("../adapters/index.js", () => ({ requireServerAdapter: () => ({ testEnvironment: mocks.adapter }) }));
vi.mock("../vendor/paperclip-runner/index.js", async original => ({ ...await original<object>(), probeNativeRunnerEnvironment: mocks.probe }));
vi.mock("./native-runtime/native-session-executor.js", async () => ({
  resolveRemoteProviderPackSource: () => ({ configuredRoot: "/selected/pack", manifest: { digest: `sha256:${"a".repeat(64)}`, payload: { nativeProviders: { pi_rpc: { version: "1.5.2", profileDigest: QUALIFIED_PI_RPC_PROFILE.commandDigest, path: "provider-assets/pi_rpc/linux-x64", sha256: `sha256:${"b".repeat(64)}`, closureDigest: `sha256:${"c".repeat(64)}` } }, artifacts: {
    nodeCommand: { path: "node", sha256: `sha256:${"d".repeat(64)}` }, piRpcExecutable: { path: "provider-assets/pi_rpc/linux-x64/runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", sha256: `sha256:${"e".repeat(64)}` }, piRpcProxy: { path: "dist/cli/pi-rpc-app-server-proxy.cjs", sha256: `sha256:${"f".repeat(64)}` },
  } } } }), prepareRemoteProviderPackOnTarget: mocks.prepare, stageRemoteRunnerFile: vi.fn(), createRemoteRunnerProcessLauncher: mocks.launch, readRemoteRunnerState: vi.fn(),
}));
vi.mock("./native-runtime/native-codex-runner.js", () => ({ resolveRemotePaperclipRunnerBinary: () => "/selected/runnerd" }));
vi.mock("./native-runtime/native-runner-execution-driver.js", () => ({ createNativeRunnerExecutionDriver: mocks.driver, prepareNativeRemoteRunner: async (input: { prepareRemote: () => Promise<void> }) => input.prepareRemote() }));
import { QUALIFIED_PI_RPC_PROFILE } from "../vendor/paperclip-runner/index.js";
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
  it("rejects Claude max under the existing server admission rule before any metadata or prompt", async () => {
    const result = await test({ ...config, piRpcThinkingLevel: "max" });
    expect(result).toMatchObject({ status: "fail" });
    expect(result.checks[0].message).toMatch(/at most xhigh/);
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
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
  it("keeps plugin-task native Pi fail closed until that run path supports native credentials", async () => {
    const result = await test(config, { ...target, runnerTask: vi.fn() } as AdapterEnvironmentTestContext["executionTarget"]);
    expect(result).toMatchObject({ status: "fail", checks: [expect.objectContaining({ code: "pi_rpc_environment_test_unavailable" })] });
    expect(mocks.probe).not.toHaveBeenCalled();
  });
});
