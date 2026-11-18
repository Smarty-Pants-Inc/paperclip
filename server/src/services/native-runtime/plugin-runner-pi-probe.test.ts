import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stat } from "node:fs/promises";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import type { PluginEnvironmentTaskOperation } from "@paperclipai/plugin-sdk";
const mocks = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async original => ({ ...await original<object>(), probeNativeRunnerEnvironment: mocks.probe }));
import { NativeEnvironmentProbeCleanupError } from "../../vendor/paperclip-runner/index.js";
import { probePluginRunnerEnvironment } from "./plugin-runner-probe.js";
import { assertHarnessTestPassed } from "../agent-harness-verification.js";
import { preparePluginRunnerCredentials } from "./plugin-runner-credentials.js";

const model = "paperclip/gateway/nested/claude-opus-5-5";
const environment = { PAPERCLIP_AI_PROVIDER_KEY: "selected-key-canary", PAPERCLIP_AI_PROVIDER_URL: "https://gateway.example/v1",
  PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "bearer" };
const managed = { identity: "selected-revision", accountIdentity: "selected-account" };
const receipt = { provider: "pi_rpc", providerDriver: "pi_rpc", effectiveModel: model, helloProbePassed: true };
function fixture() {
  const operations: PluginEnvironmentTaskOperation[] = [];
  const task = vi.fn(async (input: unknown) => {
    const op = input as PluginEnvironmentTaskOperation; operations.push(op);
    switch (op.kind) {
      case "describe": return { kind: "description", taskId: "boat-task", launchPreparationVersion: 1, projectAuthCheckVersion: 1,
        runner: { version: "fixture", digest: `sha256:${"a".repeat(64)}` } };
      case "prepare": return { kind: "prepared", taskId: "boat-task", launch: { configurationId: "boat-config",
        requirementsDigest: `sha256:${"b".repeat(64)}`, provider: { kind: "pi_rpc", model } } };
      case "check_project_auth": return { kind: "project_auth", taskId: "boat-task", allowed: true,
        configurationId: op.configurationId, provider: op.provider };
      case "submit": return { kind: "accepted", taskId: "boat-task" };
      case "status": return { kind: "status", taskId: "boat-task", phase: "completed", executionStopped: true, exitCode: 0 };
      default: throw new Error(`Unexpected fixture operation: ${op.kind}`);
    }
  });
  const context: AdapterEnvironmentTestContext = { companyId: "company", adapterType: "paperclip_runner",
    config: { provider: "pi_rpc", model, piRpcThinkingLevel: "xhigh", env: { ...environment, HOME: "/controller-only", NODE_OPTIONS: "--untrusted" },
      managedAiConnection: { method: "api_key" } },
    executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: ".", leaseId: "boat-lease",
      runnerTaskProbe: { runId: "probe-run", sessionId: "probe-session" }, runnerTask: task } };
  return { operations, task, context };
}
beforeEach(() => {
  mocks.probe.mockImplementation(async input => {
    const identity = input.transportOptions.prpIdentity;
    await input.transportOptions.prepareLaunch({ schema: "paperclip.runner.launch-requirements.v1", identity,
      provider: input.provider, model: input.model, instructions: "", runtimeContext: null,
      settings: { piRpcThinkingLevel: input.transportOptions.piRpcThinkingLevel }, approvalPolicy: "never", readOnly: false,
      preparedConversation: false, includeCollaborationModeInstructions: false });
    const handle = input.transportOptions.runnerProcessLauncher({ command: "unused", args: [], cwd: "/unused", environment: {},
      nativeRunner: { identity, ticket: "synthetic-ticket", stateDirectory: "/unused", runnerVersion: "fixture",
        runnerDigest: `sha256:${"a".repeat(64)}`, maxOutboxBytes: 262144, p0ReserveBytes: 65536,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } } });
    await handle.completion;
    await input.onCleanupConfirmed();
    return receipt;
  });
});
afterEach(() => vi.resetAllMocks());

// Keep: production Boat pi_rpc hires could not cross the plugin credential boundary.
describe("native Pi plugin task verification", () => {
  it("submits only the selected Pi credential and exact model through the plugin task owner", async () => {
    const { context, operations } = fixture();
    const result = await probePluginRunnerEnvironment(context, managed);
    expect(result).toMatchObject({ status: "pass", checks: [{ code: "pi_rpc_hello_probe_passed", level: "info" }] });
    expect(() => assertHarnessTestPassed(result)).not.toThrow();
    expect(operations.find(op => op.kind === "prepare")).toMatchObject({ requirements: { provider: "pi_rpc", model,
      settings: { piRpcThinkingLevel: "xhigh" } } });
    expect(operations.find(op => op.kind === "submit")).toMatchObject({ runner: { harness: "pi_rpc", leaseId: "boat-lease", runId: "probe-run" },
      credentialIdentity: managed.identity, accountIdentity: managed.accountIdentity, credential: { type: "pi-env", environment } });
    const submitted = JSON.stringify(operations);
    expect(submitted).not.toContain("/controller-only"); expect(submitted).not.toContain("NODE_OPTIONS");
    expect(JSON.stringify(result)).not.toContain("selected-key-canary");
    expect(mocks.probe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ environment: {}, provider: "pi_rpc", model }));
  });
  it.each([
    { PAPERCLIP_AI_PROVIDER_KEY: "selected-key-canary" },
    { ...environment, PAPERCLIP_AI_PROVIDER_URL: "https://selected-key-canary@gateway.example/v1" },
    { ...environment, OPENAI_API_KEY: "other-key-canary" },
  ])("reports malformed or unrouted provider config without requesting authentication: %j", async invalid => {
    const { context, task } = fixture();
    context.config.env = invalid;
    const result = await probePluginRunnerEnvironment(context, managed);
    expect(result).toMatchObject({ status: "fail", checks: [{ code: "pi_rpc_hello_probe_config_invalid", level: "error",
      message: "The selected Pi provider configuration is malformed or missing a complete provider route. Check its credential and routing settings." }] });
    expect(() => assertHarnessTestPassed(result)).toThrow(expect.objectContaining({ code: "harness_test_failed" }));
    expect(task).toHaveBeenCalledExactlyOnceWith({ kind: "describe" });
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("selected-key-canary");
    expect(JSON.stringify(result)).not.toContain("other-key-canary");
    expect(JSON.stringify(result)).not.toContain("needs authentication");
  });
  it.each([
    ["Unauthorized 401 selected-key-canary", "pi_rpc_hello_probe_auth_required", "harness_auth_failed"],
    ["Model unavailable 404 selected-key-canary", "pi_rpc_hello_probe_model_unavailable", "harness_model_unavailable"],
    ["Pi hello probe timed out", "pi_rpc_hello_probe_timed_out", "harness_probe_timed_out"],
    ["pi_probe_empty_response selected-key-canary", "pi_rpc_hello_probe_failed", "harness_test_failed"],
  ])("fails closed on %s without reflecting credentials", async (message, code, failure) => {
    mocks.probe.mockImplementationOnce(async input => { await input.onCleanupConfirmed(); throw new Error(message); });
    const result = await probePluginRunnerEnvironment(fixture().context, managed);
    expect(result).toMatchObject({ status: "fail", checks: [{ code, level: "error" }] });
    expect(() => assertHarnessTestPassed(result)).toThrow(expect.objectContaining({ code: failure }));
    expect(JSON.stringify(result)).not.toContain("selected-key-canary");
  });
  it.each([
    { ...receipt, helloProbePassed: false }, { ...receipt, effectiveModel: "other/model" },
    { ...receipt, provider: "codex" }, { ...receipt, providerDriver: "acpx_runtime" },
  ])("rejects incomplete or mismatched native hello receipts: %j", async wrong => {
    mocks.probe.mockImplementationOnce(async input => { await input.onCleanupConfirmed(); return wrong; });
    expect((await probePluginRunnerEnvironment(fixture().context, managed)).status).toBe("fail");
  });
  it("retains the typed cleanup owner rather than claiming success or removing its root", async () => {
    let root = ""; let cleanup!: () => Promise<void>;
    const failure = new NativeEnvironmentProbeCleanupError(new Promise<void>(() => {}), new Error("still running"), []);
    mocks.probe.mockImplementationOnce(async input => { root = input.runtimeDirectory; cleanup = input.onCleanupConfirmed; throw failure; });
    try {
      await expect(probePluginRunnerEnvironment(fixture().context, managed)).rejects.toBe(failure);
      expect((await stat(root)).isDirectory()).toBe(true);
    } finally { if (cleanup) await cleanup(); }
  });
  it("refuses unmanaged credentials before invoking the native probe", async () => {
    const { context, task } = fixture();
    const result = await probePluginRunnerEnvironment(context);
    expect(result).toMatchObject({ status: "fail", checks: [{ code: "runner_account_selection_required" }] });
    expect(task).not.toHaveBeenCalled(); expect(mocks.probe).not.toHaveBeenCalled();
  });
  it("projects only Pi provider credentials, never executable or controller-home settings", async () => {
    const prepared = await preparePluginRunnerCredentials({ provider: "pi_rpc", ...managed,
      environment: { ...environment, HOME: "/controller-only", NODE_OPTIONS: "--untrusted", PAPERCLIP_PI_RPC_CREDENTIAL_MODE: "env" } });
    expect(prepared).toMatchObject({ accountIdentity: managed.accountIdentity, credential: { type: "pi-env", environment } });
  });
});
