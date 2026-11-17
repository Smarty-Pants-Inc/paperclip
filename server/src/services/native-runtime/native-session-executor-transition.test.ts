// Keep: S-04 / #20974. Observation loss must not authorize a second runner;
// execute is the sandbox boundary. The monitor and deadline probe are real.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import {
  createRemoteRunnerProcessLauncher, nativeSessionFailureSourceCode, nativeSessionFailureDisposition,
  REMOTE_RUNNER_OBSERVATION_EXHAUSTED, REMOTE_RUNNER_OBSERVATION_EXHAUSTED_ACTION,
} from "./native-session-executor.js";
import { NativeProviderTerminalFailure } from "../../vendor/paperclip-runner/index.js";
import { createSandboxRunnerSupervision, type SandboxRunnerSupervision } from "./sandbox-runner-retention.js";

const ok = { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: "2026-11-17T00:00:00Z" };
const transition = () => Object.assign(new Error("Boat POST /sandboxes/box/commands failed (409): http_error (state change in progress)"), { code: "boat_sandbox_state_transition" });
const rpcTransition = () => new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR, message: `boat_sandbox_state_transition: ${transition().message}` });
const fixtures: { finish(): void; supervision?: SandboxRunnerSupervision; completion: Promise<void> }[] = [];

function launch(observe: () => Promise<typeof ok> | typeof ok, supervision?: SandboxRunnerSupervision) {
  let nonce = "", finishing = false, healthy = 0;
  let outcome: { kind: "pending" } | { kind: "resolved" } | { kind: "rejected"; error: unknown } = { kind: "pending" };
  let launches = 0;
  const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async request => {
    const label = request.args?.[2];
    if (label === "paperclip-runner-launch") { nonce = request.args![4]!; launches++; return ok; }
    if (label === "paperclip-runner-process-identity") return { ...ok, stdout: `${nonce}\n4321\n2026-11-17T00:00:00.000Z\nrunner\n` };
    if (label === "paperclip-runner-monitor") {
      if (finishing) return { ...ok, exitCode: 45 };
      const result = await observe();
      if (result.exitCode === 0 && !result.timedOut) healthy++;
      return result;
    }
    if (label === "paperclip-runner-signal") return ok;
    return { ...ok, exitCode: 1 };
  });
  const handle = createRemoteRunnerProcessLauncher({
    target: { kind: "remote", transport: "sandbox", environmentId: "environment", leaseId: "lease", remoteCwd: "/workspace" },
    runner: { execute }, remoteBinary: "/runtime/runnerd", processIdentityPath: "/runtime/identity",
    stateDirectory: "/runtime", diagnosticsDirectory: "/runtime/diagnostics", runnerInstanceId: "runner",
    ...(supervision ? { sandboxRetention: { supervision, retiredBeforeClaim: () => false,
      launch: async (request: { identityNonce: string }) => { nonce = request.identityNonce; launches++; },
    } as never } : {}),
  })({ command: "/runtime/runnerd", args: [], cwd: "/controller", environment: {} });
  const completion = handle.completion.then(() => { outcome = { kind: "resolved" }; }, error => { outcome = { kind: "rejected", error }; });
  const f = { handle, execute, completion, supervision, finish: () => { finishing = true; },
    get outcome() { return outcome; }, get healthy() { return healthy; }, get launches() { return launches; },
    get probes() { return execute.mock.calls.filter(([r]) => r.args?.[2] === "paperclip-runner-monitor").length; },
  };
  fixtures.push(f);
  return f;
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-17T00:00:00Z")); });
afterEach(async () => {
  for (const f of fixtures) { f.finish(); if (f.supervision?.paused && !f.supervision.detached) f.supervision.resume(); }
  await vi.runAllTimersAsync();
  for (const f of fixtures) if (!f.supervision?.detached) await f.completion;
  fixtures.length = 0;
  vi.useRealTimers();
});

describe("sandbox transition monitor", () => {
  it.each([false, true])("preserves the one closed exhausted outcome through server failure policy (notification=%s)", notification => {
    const message = `${REMOTE_RUNNER_OBSERVATION_EXHAUSTED}: ${REMOTE_RUNNER_OBSERVATION_EXHAUSTED_ACTION}`;
    const error = notification
      ? new NativeProviderTerminalFailure("notification_transport_failed", false, `Notification transport failed closed: ${message}`)
      : Object.assign(new Error(message), { code: REMOTE_RUNNER_OBSERVATION_EXHAUSTED });
    const code = nativeSessionFailureSourceCode(error);
    expect(code).toBe("runner_process_observation_budget_exhausted");
    expect(nativeSessionFailureDisposition(1, new Date(), code)).toEqual({
      phase: "terminal_failure", failureCode: code, nextAttemptAt: null,
    });
    expect(error.message).toContain(REMOTE_RUNNER_OBSERVATION_EXHAUSTED_ACTION);
    expect(error.message).not.toContain("runner_process_termination_unconfirmed");
  });

  it.each([
    ["closed code", transition], ["real RPC form", rpcTransition],
    ["wrapped cause", () => new Error("remote execute failed", { cause: transition() })],
  ] as const)("retains the same unconfirmed process beyond 30s (%s)", async (_name, error) => {
    const started = Date.now();
    const refusal = error();
    const f = launch(() => { if (Date.now() - started < 45_000) throw refusal; return ok; });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(f.outcome.kind).toBe("pending");
    expect(f.handle.isExitConfirmed?.()).toBe(false);
    expect(f.launches).toBe(1);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(f.healthy).toBeGreaterThan(0);
    expect(f.outcome.kind).toBe("pending");
    expect(f.handle.isExitConfirmed?.()).toBe(false);
    expect(f.launches).toBe(1);
    f.finish(); await vi.advanceTimersByTimeAsync(1_000); await f.completion;
    expect(f.outcome.kind).toBe("resolved");
    expect(f.handle.isExitConfirmed?.()).toBe(true); // Only the actual exit-45 observation.
  });

  it.each([
    ["permanent refusal", () => Object.assign(new Error("access denied"), { code: "EACCES" })],
    ["ambiguous transport", () => Object.assign(new Error("request may have run"), { code: "ECONNRESET" })],
    ["free text", () => new Error("state change in progress")],
    ["lookalike code", () => Object.assign(transition(), { code: "boat_sandbox_state_transition_other" })],
    ["different RPC code", () => new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.TIMEOUT, message: transition().message })],
    ["ambiguous RPC", () => new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR, message: "connection lost after command send" })],
    ["worker readiness failure", () => new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR, message: "Daytona sandbox is still failed at its start deadline" })],
    ["worker phrase lookalike", () => new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR, message: "EACCES: not a Boat refusal; state change in progress" })],
    ["worker code lookalike", () => new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR, message: "boat_sandbox_state_transition_other: state change in progress" })],
  ] as const)("rethrows %s without an exit receipt", async (_name, error) => {
    const refusal = error(); const f = launch(() => { throw refusal; });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(f.outcome).toEqual({ kind: "rejected", error: refusal });
    expect(f.handle.isExitConfirmed?.()).toBe(false);
    expect(f.launches).toBe(1);
  });

  it.each([30_000, 31_000])("does not retain transition errors after Stop at %sms", async stopAt => {
    const refusal = transition(); const f = launch(() => { throw refusal; });
    await vi.advanceTimersByTimeAsync(stopAt);
    expect(f.outcome.kind).toBe("pending");
    f.handle.child.kill("SIGTERM");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(f.outcome).toEqual({ kind: "rejected", error: refusal });
    expect(f.handle.isExitConfirmed?.()).toBe(false);
    const probes = f.probes;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.probes).toBe(probes);
    expect(f.execute.mock.calls.filter(([r]) => r.args?.[2] === "paperclip-runner-signal")).toHaveLength(1);
  });

  it("detach during a retained transition parks observation, not remote exit", async () => {
    const supervision = createSandboxRunnerSupervision();
    const f = launch(() => { throw rpcTransition(); }, supervision);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.outcome.kind).toBe("pending");
    const probes = f.probes; supervision.detach();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.probes).toBe(probes);
    expect(f.outcome.kind).toBe("pending");
    expect(f.handle.isExitConfirmed?.()).toBe(false);
  });

  it("invalidates a retained observation on pause and resumes the existing monitor", async () => {
    const supervision = createSandboxRunnerSupervision();
    const f = launch(() => { throw transition(); }, supervision);
    await vi.advanceTimersByTimeAsync(30_000);
    const probes = f.probes; supervision.pause();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.probes).toBe(probes);
    expect(f.handle.isExitConfirmed?.()).toBe(false);
    f.finish(); supervision.resume(); await vi.advanceTimersByTimeAsync(1_000); await f.completion;
    expect(f.outcome.kind).toBe("resolved"); expect(f.launches).toBe(1);
    expect(f.handle.isExitConfirmed?.()).toBe(true);
  });

  it("exhausts the total ten-minute retained-transition budget with one actionable outcome, without confirming exit", async () => {
    const refusal = transition(); const f = launch(() => { throw refusal; });
    await vi.advanceTimersByTimeAsync(599_000);
    expect(f.outcome.kind).toBe("pending");
    await vi.advanceTimersByTimeAsync(1_001);
    expect(f.outcome).toMatchObject({ kind: "rejected", error: { code: "runner_process_observation_budget_exhausted" } });
    if (f.outcome.kind === "rejected") {
      expect((f.outcome.error as Error).message).toMatch(/Wait for.*archiv.*finish.*recovery/i);
      expect((f.outcome.error as Error).message).not.toContain("runner_process_termination_unconfirmed");
    }
    const probes = f.probes;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.probes).toBe(probes);
    expect(f.handle.isExitConfirmed?.()).toBe(false); expect(f.launches).toBe(1);
  });

  it("does not reset the total budget after healthy observations", async () => {
    const started = Date.now(), refusal = rpcTransition();
    const f = launch(() => {
      const elapsed = Date.now() - started;
      if ((elapsed >= 210_000 && elapsed < 250_000) || (elapsed >= 460_000 && elapsed < 500_000)) return ok;
      throw refusal;
    });
    await vi.advanceTimersByTimeAsync(750_000);
    expect(f.healthy).toBeGreaterThan(0);
    expect(f.outcome).toMatchObject({ kind: "rejected", error: { code: "runner_process_observation_budget_exhausted" } });
    expect(f.handle.isExitConfirmed?.()).toBe(false);
  });

  it("keeps concurrent monitors' transition budgets independent", async () => {
    const a = launch(() => { throw transition(); }), b = launch(() => { throw transition(); });
    await vi.advanceTimersByTimeAsync(420_000);
    for (const f of [a, b]) { expect(f.outcome.kind).toBe("pending"); expect(f.handle.isExitConfirmed?.()).toBe(false); expect(f.launches).toBe(1); }
  });
});
