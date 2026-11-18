// dl-diag-redact (RFL 44a6cfdc / ee70a0b1): diagnostic log lines never carry raw
// error text, stderr or unbounded names. Every line from the two producers
// (the probe cleanup-step / cleanup-timing lines and the cleanup-pending
// warning) is captured as the real pino JSON line and checked byte for byte.
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

const mocks = vi.hoisted(() => ({ probe: vi.fn(), resolveBinary: vi.fn(), launch: vi.fn(), lines: [] as string[] }));
vi.mock("../../middleware/logger.js", async original => {
  const { default: pino } = await import("pino");
  const { Writable } = await import("node:stream");
  const sink = new Writable({ write(chunk, _encoding, done) {
    mocks.lines.push(...String(chunk).split("\n").filter(Boolean)); done();
  } });
  return { ...await original<object>(), logger: pino({ level: "debug" }, sink) };
});
vi.mock("../../vendor/paperclip-runner/index.js", async original => ({
  ...await original<object>(), probeNativeRunnerEnvironment: mocks.probe,
}));
vi.mock("./native-codex-runner.js", async original => ({
  ...await original<object>(), resolveRemotePaperclipRunnerBinary: mocks.resolveBinary,
}));
vi.mock("./native-session-executor.js", async original => ({
  ...await original<object>(),
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
}));

import { QUALIFIED_PI_RPC_PROFILE } from "../../vendor/paperclip-runner/index.js";
import { probeManagedNativePiRunner } from "./pi-runner-probe.js";
import * as aiConnectionRuntime from "../ai-connection-runtime.js";

// Planted values. Synthetic fixtures only: none is a real credential.
const PLANTED_PATH = "/private/audit-client/secret-file";
const HUGE_NAME = `${PLANTED_PATH} ${"X".repeat(10_240 - PLANTED_PATH.length - 1)}`;
const BEARER_MESSAGE = "Pi upstream rejected client bearer audit-token-XYZ";
const GHP = `ghp_${"A1b2C3d4E5".repeat(4).slice(0, 36)}`;
const SK = `sk-${"z9Y8x7W6v5".repeat(4)}`;
const STDERR = `rm: cannot remove: permission denied\nGITHUB_TOKEN=${GHP}\nOPENAI_API_KEY=${SK}\n${PLANTED_PATH}`;
const FORBIDDEN = [PLANTED_PATH, "audit-token", "ghp_", "sk-"];
const PRODUCER_EVENTS = new Set(["native_probe_cleanup_step", "native_probe_cleanup_timing", "native_probe_cleanup_pending"]);

const named = (name: string, message = "arbitrary failure") => Object.assign(new Error(message), { name });
const stepFailure = () => Object.assign(new Error(`remote command failed: ${STDERR}`), { name: "RemoteCommandError", code: "remote_exit_1", stderr: STDERR });

function producerLines() {
  return mocks.lines.filter(line => {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    return PRODUCER_EVENTS.has(String(parsed.event)) || PRODUCER_EVENTS.has(String(parsed.code));
  });
}
function expectClean(lines: string[]) {
  const leaks = lines.flatMap(line => FORBIDDEN.filter(value => line.includes(value)).map(value => ({ value, bytes: Buffer.byteLength(line), head: line.slice(0, 160) })));
  const oversized = lines.filter(line => Buffer.byteLength(line) > 512).map(line => Buffer.byteLength(line));
  console.log(JSON.stringify({ producerLines: lines.length, lineBytes: lines.map(line => Buffer.byteLength(line)) }));
  // Printed so the RED run shows what leaked (never the full line).
  if (leaks.length || oversized.length) console.log(JSON.stringify({ leaks: leaks.map(leak => ({ ...leak, head: leak.head.replace(/ghp_\w+|sk-\w+/g, "<planted>") })), oversized }));
  expect({ leaks, oversized }).toEqual({ leaks: [], oversized: [] });
}

const roots: string[] = [];
const model = "paperclip/gateway/nested/claude-opus-5-5";
const metadata = {
  schema: "paperclip-runner/runnerd-build-metadata/v1", binaryName: "paperclip-runnerd",
  packageName: "@paperclipai/paperclip-runner", binaryContractVersion: 2,
  durableSessionCapabilities: ["unlimited_runtime", "connection_lease_renewal"],
  prpTransportModes: ["dial_ws_loopback", "dial_wss", "listen_ws"],
};
const script = `#!/bin/sh\n[ "$1" = --build-metadata ] || exit 17\nprintf '%s\\n' '${JSON.stringify(metadata)}'\n`;

async function fixture(cleanupFault?: (request: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => unknown) {
  const root = await mkdtemp(join(tmpdir(), "diag-redact-"));
  roots.push(root);
  const home = join(root, "home"), bin = join(home, ".local", "bin"), cwd = join(root, "workspace");
  await mkdir(bin, { recursive: true });
  await mkdir(cwd);
  const source = join(root, "paperclip-runnerd");
  await writeFile(source, script, { mode: 0o700 });
  await writeFile(join(bin, "paperclip-runnerd"), script, { mode: 0o700 });
  vi.stubEnv("PAPERCLIP_RUNNER_REMOTE_BINARY_PATH", "");
  vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", join(root, "state"));
  mocks.resolveBinary.mockReset().mockResolvedValue(source);
  mocks.launch.mockReset().mockReturnValue(vi.fn());
  const runner: CommandManagedRuntimeRunner = {
    async syncIn(operations) {
      for (const operation of operations) for (const file of operation.files) {
        await mkdir(dirname(file.targetPath), { recursive: true });
        await copyFile(file.sourcePath, file.targetPath);
        await chmod(file.targetPath, file.mode ?? 0o700);
      }
      return { operations: operations.map(operation => ({ operationId: operation.operationId, filesTransferred: operation.files.length, bytesTransferred: 1 })) };
    },
    async execute(request) {
      const fault = cleanupFault?.(request);
      if (fault instanceof Error) throw fault;
      if (fault) return fault as Awaited<ReturnType<CommandManagedRuntimeRunner["execute"]>>;
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
  mocks.probe.mockReset().mockImplementation(async options => {
    const onDiagnostic = options.transportOptions?.onDiagnostic as ((message: string) => void) | undefined;
    // A real step line, then fixed-prefix lines carrying raw step error text and stderr.
    onDiagnostic?.("Native probe cleanup step failed: joining native Pi retirement; elapsedMs=12; pass=teardown_pass");
    onDiagnostic?.(`Native probe cleanup step failed: ${BEARER_MESSAGE}; elapsedMs=3; pass=retained_retry`);
    onDiagnostic?.(`Native probe cleanup step failed: confirming physical retirement: ${STDERR}; elapsedMs=4; pass=retained_retry`);
    onDiagnostic?.(`Native probe cleanup step failed: ${HUGE_NAME}; elapsedMs=5; pass=teardown_pass`);
    return { providerDriver: "pi_rpc", effectiveModel: model, helloProbePassed: !options.admissionOnly,
      sessionAdmissionPassed: true, piMetadata: { version: "1.5.2" } };
  });
  const context: AdapterEnvironmentTestContext = {
    companyId: "company", adapterType: "paperclip_runner",
    config: { provider: "pi_rpc", model, piRpcThinkingLevel: "xhigh" },
    executionTarget: { kind: "remote", transport: "sandbox", providerKey: "fixture", remoteCwd: cwd, runner,
      effectiveCapabilities: { reusableLeases: false, nativeSyncIn: true, nativeSyncOut: false,
        persistentProcessSessions: false, independentControlCommands: false, incrementalSessionOutput: false,
        concurrentSyncOperations: false, duplexCommandStream: false, runnerWebSocketIngress: true } },
  };
  return { context };
}
const isStaticManifest = (request: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => request.args?.[2] === "paperclip-probe-static-manifest";
const isRemoteRm = (request: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => request.command === "rm" && request.args?.[0] === "-rf";

afterEach(async () => {
  vi.unstubAllEnvs();
  mocks.lines.length = 0;
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("diagnostic log lines carry no raw error text, stderr or unbounded names", () => {
  it("probe cleanup-step and cleanup-timing lines: closed step names and numbers only, <= 512 bytes", async () => {
    const huge = named(HUGE_NAME, `stderr: ${STDERR}`);
    const { context } = await fixture(request => isStaticManifest(request) ? huge : undefined);
    await probeManagedNativePiRunner(context).catch(error => error);
    const lines = producerLines();
    expectClean(lines);
    const steps = lines.map(line => JSON.parse(line)).filter(line => line.event === "native_probe_cleanup_step");
    expect(steps.length).toBeGreaterThanOrEqual(4);
    expect(steps[0]).toMatchObject({ step: "joining native Pi retirement", pass: "teardown_pass", elapsedMs: 12 });
    for (const step of steps.slice(1)) expect(step.step).toBe("other");
    const timing = lines.map(line => JSON.parse(line)).filter(line => line.event === "native_probe_cleanup_timing");
    expect(timing.length).toBeGreaterThanOrEqual(1);
    expect(timing[0]).toMatchObject({ outcome: "failed", failedStep: "static_manifest", error: { name: "other" } });
    expect(typeof timing[0].static_manifestMs).toBe("number");
    expect(typeof timing[0].totalMs).toBe("number");
  });

  it("a cleanup step whose stderr carries tokens logs only its summarized code", async () => {
    const { context } = await fixture(request => isRemoteRm(request) ? stepFailure() : undefined);
    await probeManagedNativePiRunner(context).catch(error => error);
    const lines = producerLines();
    expectClean(lines);
    const timing = lines.map(line => JSON.parse(line)).filter(line => line.event === "native_probe_cleanup_timing");
    expect(timing[0]).toMatchObject({ outcome: "failed", failedStep: "remote_rm" });
  });

  it("cleanup-step timing logging never throws, even for a hostile error", async () => {
    const hostile = new Error("hostile");
    Object.defineProperty(hostile, "name", { get() { throw new Error(`getter ${SK}`); } });
    const { context } = await fixture(request => isStaticManifest(request) ? hostile : undefined);
    const result = await probeManagedNativePiRunner(context).catch(error => error);
    expect(result).toMatchObject({ status: "fail" });
    expectClean(producerLines());
  });

  it("the cleanup-pending warning logs summarized codes only, <= 512 bytes", () => {
    const warn = (aiConnectionRuntime as Record<string, unknown>).warnNativeProbeCleanupPending as
      ((input: { accountKeyHash: string; agentId: string; cleanupErrors: readonly unknown[]; operationError?: unknown }) => void) | undefined;
    expect(typeof warn).toBe("function");
    const cleanupErrors = [
      named(HUGE_NAME), new Error(BEARER_MESSAGE), stepFailure(),
      new Error("runner_failure token sk-audit-only-not-real"),
      new Error(`a_${"b".repeat(4_000)}`),
      new AggregateError([named(HUGE_NAME), new Error(BEARER_MESSAGE), stepFailure()], `aggregate ${PLANTED_PATH}`),
      ...Array.from({ length: 12 }, (_, index) => Object.assign(new Error("native_probe_retirement_unconfirmed"), { code: `code_${index}` })),
    ];
    warn!({ accountKeyHash: "0123456789ab", agentId: "11111111-2222-3333-4444-555555555555", cleanupErrors, operationError: new Error(BEARER_MESSAGE) });
    const lines = producerLines();
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]);
    expect(line).toMatchObject({ code: "native_probe_cleanup_pending", accountKeyHash: "0123456789ab", operationError: { name: "Error", messageCode: "none" } });
    expect(line.cleanupErrors[0]).toEqual({ name: "other", code: "none", messageCode: "none" });
    expectClean(lines);
  });
});
