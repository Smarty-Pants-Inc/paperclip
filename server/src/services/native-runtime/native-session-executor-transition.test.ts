// Keep: S-04 / #20974. Observation loss must not authorize a second runner;
// execute is the sandbox boundary. The monitor and deadline probe are real.
// Ported with row14 (7910a093d): only row14's own RED cases and the fork launch
// harness they use. The fork's REMOTE_RUNNER_OBSERVATION_EXHAUSTED cases are
// not part of row14 and that code is absent on this line.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import {
  createRemoteRunnerProcessLauncher, nativeSessionFailureSourceCode, nativeSessionFailureDisposition,
} from "./native-session-executor.js";
import { NativeProviderTerminalFailure } from "../../vendor/paperclip-runner/index.js";
import { RemoteRunnerSupervisionExhaustedError, REMOTE_RUNNER_SUPERVISION_EXHAUSTED } from "./remote-runner-recovery-diagnostics.js";
import { createSandboxRunnerSupervision, type SandboxRunnerSupervision } from "./sandbox-runner-retention.js";

const ok = { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: "2026-11-17T00:00:00Z" };
const transition = () => Object.assign(new Error("Boat POST /sandboxes/box/commands failed (409): http_error (state change in progress)"), { code: "boat_sandbox_state_transition" });
const rpcTransition = () => new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR, message: `boat_sandbox_state_transition: ${transition().message}` });
const fixtures: { finish(): void; supervision?: SandboxRunnerSupervision; completion: Promise<void> }[] = [];

function launch(observe: (request: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => Promise<typeof ok> | typeof ok, supervision?: SandboxRunnerSupervision) {
  let nonce = "", finishing = false, healthy = 0;
  const probeStarts: number[] = [];
  let outcome: { kind: "pending" } | { kind: "resolved" } | { kind: "rejected"; error: unknown } = { kind: "pending" };
  let launches = 0;
  const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async request => {
    const label = request.args?.[2];
    if (label === "paperclip-runner-launch") { nonce = request.args![4]!; launches++; return ok; }
    if (label === "paperclip-runner-process-identity") return { ...ok, stdout: `${nonce}\n4321\n2026-11-17T00:00:00.000Z\nrunner\n` };
    if (label === "paperclip-runner-monitor") {
      if (finishing) return { ...ok, exitCode: 45 };
      probeStarts.push(Date.now());
      const result = await observe(request);
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
  const f = { handle, execute, completion, supervision, probeStarts, finish: () => { finishing = true; },
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
  it.each(["direct", "cause", "saved", "serialized", "transport", "notification", "legacy_error_prefix"] as const)("row14 bounded supervision policy preserves the named terminal failure (%s)", form => {
    const closed = new RemoteRunnerSupervisionExhaustedError(new Error("possibly ran"));
    const transport = `runner_process_termination_unconfirmed: runnerd process supervision failed: ${closed.message}`;
    const error = form === "direct" ? closed : form === "cause" ? new Error("transport closed", { cause: closed })
      : form === "saved" ? new Error(closed.message) : form === "serialized" ? new Error(String(closed))
        : form === "transport" ? new Error(transport) : form === "legacy_error_prefix" ? new Error(`Error: ${transport}`)
        : new NativeProviderTerminalFailure("notification_transport_failed", false, `Notification transport failed closed: ${transport}`);
    const code = nativeSessionFailureSourceCode(error);
    expect(code).toBe(REMOTE_RUNNER_SUPERVISION_EXHAUSTED);
    expect(nativeSessionFailureDisposition(1, new Date(), code)).toEqual({ phase: "terminal_failure", failureCode: code, nextAttemptAt: null });
  });

  it("row14 persistent possibly-ran closes observation without confirming exit or launching another runner", async () => {
    const raw = Object.assign(new Error("possibly ran"), { code: "boat_command_possibly_ran" });
    const f = launch(() => { throw raw; });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(f.outcome).toMatchObject({ kind: "rejected", error: { failureCode: REMOTE_RUNNER_SUPERVISION_EXHAUSTED } });
    expect(f.handle.isExitConfirmed?.()).toBe(false);
    expect(f.launches).toBe(1);
    await f.completion;
  });
});
