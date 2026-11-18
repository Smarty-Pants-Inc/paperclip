import { afterEach, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { readRemoteRunnerRecoveryError, REMOTE_RUNNER_RECOVERY_ERROR_CODE, REMOTE_RUNNER_SUPERVISION_EXHAUSTED,
  REMOTE_RUNNER_SUPERVISION_EXHAUSTED_ACTION } from "./remote-runner-recovery-diagnostics.js";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { readRemoteRunnerRecoveryProbe } from "./remote-runner-recovery-probe.js";

afterEach(() => vi.useRealTimers());

const timeout = { exitCode: null, signal: null, timedOut: true, stdout: "", stderr: "", pid: null, startedAt: "2026-10-15T00:00:00Z" };

it.each([NaN, Infinity, -Infinity])("rejects a non-finite deadline (%s) before a probe", async deadline => {
  const execute = vi.fn().mockResolvedValue({ ...timeout, timedOut: false, exitCode: 0 });
  const result = await readRemoteRunnerRecoveryProbe({
    runner: { execute }, request: { command: "sh" }, stage: "process_verification",
    readOnly: true, deadline,
  }).catch(readRemoteRunnerRecoveryError);
  expect(result).toEqual({ stage: "process_verification", reason: "probe_timeout" });
  expect(execute).not.toHaveBeenCalled();
});

it("uses the read deadline when a transport outage outlasts three fast probes", async () => {
  vi.useFakeTimers();
  const unavailable = Object.assign(new Error("Request failed with status code 502"), { response: { status: 502 } });
  const healthy = { ...timeout, timedOut: false, exitCode: 0 };
  const execute = vi.fn()
    .mockRejectedValueOnce(unavailable)
    .mockRejectedValueOnce(unavailable)
    .mockRejectedValueOnce(unavailable)
    .mockResolvedValue(healthy);
  const result = readRemoteRunnerRecoveryProbe({
    runner: { execute }, request: { command: "sh" }, stage: "process_verification",
    readOnly: true, deadline: Date.now() + 30_000,
  }).catch(error => error);
  await vi.runAllTimersAsync();
  expect(await result).toBe(healthy);
  expect(execute).toHaveBeenCalledTimes(4);
});

it("bounds fast transport failures by the existing deadline and retains the cause", async () => {
  vi.useFakeTimers();
  const unavailable = new Error("sandbox unavailable");
  const execute = vi.fn().mockRejectedValue(unavailable);
  const startedAt = Date.now();
  const result = readRemoteRunnerRecoveryProbe({
    runner: { execute }, request: { command: "sh" }, stage: "process_verification",
    readOnly: true, deadline: startedAt + 2_000,
  }).catch(error => error);
  await vi.runAllTimersAsync();
  expect(await result).toBe(unavailable);
  expect(readRemoteRunnerRecoveryError(unavailable)).toEqual({ stage: "process_verification", reason: "probe_transport_failed" });
  expect(execute.mock.calls.length).toBeGreaterThan(3);
  expect(execute.mock.calls.length).toBeLessThan(9);
  expect(Date.now() - startedAt).toBeLessThanOrEqual(2_000);
  expect(execute.mock.calls.at(-1)?.[0].timeoutMs).toBeLessThanOrEqual(250);
});

it("shares the remaining deadline across timed-out reads", async () => {
  vi.useFakeTimers();
  const execute = vi.fn(async (request) => {
    await new Promise(resolve => setTimeout(resolve, request.timeoutMs));
    return timeout;
  });
  const result = readRemoteRunnerRecoveryProbe({
    runner: { execute } as CommandManagedRuntimeRunner,
    request: { command: "sh" }, stage: "identity_marker",
    readOnly: true, deadline: Date.now() + 15_000,
  }).catch(readRemoteRunnerRecoveryError);
  await vi.runAllTimersAsync();
  expect(await result).toEqual({ stage: "identity_marker", reason: "probe_timeout" });
  expect(execute.mock.calls.map(([request]) => request.timeoutMs)).toEqual([10_000, 4_750]);
  expect(execute.mock.calls.map(([request]) => request.commandTimeoutMs)).toEqual([10_000, 4_750]);
});

it.each([0, 2_000])("caps the command abort allowance at the smaller existing deadline (%s)", async commandTimeoutMs => {
  const execute = vi.fn().mockResolvedValue({ ...timeout, timedOut: false, exitCode: 0 });
  await readRemoteRunnerRecoveryProbe({ runner: { execute }, request: { command: "sh", commandTimeoutMs },
    stage: "process_verification", readOnly: true, deadline: Date.now() + 6_000 });
  expect(execute.mock.calls[0]![0].commandTimeoutMs).toBeGreaterThan(0);
  expect(execute.mock.calls[0]![0].commandTimeoutMs).toBeLessThanOrEqual(commandTimeoutMs || 6_000);
});

it("never retries a signal when its acknowledgement is lost", async () => {
  const execute = vi.fn().mockRejectedValue(new Error("connection lost"));
  const result = await readRemoteRunnerRecoveryProbe({
    runner: { execute }, request: { command: "sh" }, stage: "process_verification",
    readOnly: false, deadline: Date.now() + 30_000,
  }).catch(readRemoteRunnerRecoveryError);
  expect(result).toEqual({ stage: "process_verification", reason: "probe_transport_failed" });
  expect(execute).toHaveBeenCalledTimes(1);
});

it.each([
  ["direct code", () => Object.assign(new Error("possibly ran"), { code: "boat_command_possibly_ran" })],
  ["worker envelope", () => new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR, message: "boat_command_possibly_ran: unavailable" })],
  ["wrapped cause", () => new Error("execute failed", { cause: Object.assign(new Error("possibly ran"), { code: "boat_command_possibly_ran" }) })],
] as const)("names bounded supervision loss and retains the exact cause (%s)", async (_name, makeCause) => {
  vi.useFakeTimers();
  const cause = makeCause();
  const execute = vi.fn().mockRejectedValue(cause);
  const result = readRemoteRunnerRecoveryProbe({ runner: { execute }, request: { command: "sh" },
    stage: "process_verification", readOnly: true, deadline: Date.now() + 2_000 }).catch(error => error);
  await vi.runAllTimersAsync();
  const error = await result;
  expect(error).not.toBe(cause);
  expect(error).toMatchObject({ code: REMOTE_RUNNER_RECOVERY_ERROR_CODE, failureCode: REMOTE_RUNNER_SUPERVISION_EXHAUSTED });
  expect(error.cause).toBe(cause);
  expect(error.message).toBe(`${REMOTE_RUNNER_SUPERVISION_EXHAUSTED}: ${REMOTE_RUNNER_SUPERVISION_EXHAUSTED_ACTION}`);
  expect(readRemoteRunnerRecoveryError(error)).toEqual({ stage: "process_verification", reason: "probe_transport_failed" });
});

it("never converts an unacknowledged signal into permission to retry or replace", async () => {
  const cause = Object.assign(new Error("possibly ran"), { code: "boat_command_possibly_ran" });
  const execute = vi.fn().mockRejectedValue(cause);
  await expect(readRemoteRunnerRecoveryProbe({ runner: { execute }, request: { command: "sh" },
    stage: "process_verification", readOnly: false, deadline: Date.now() + 2_000 })).rejects.toBe(cause);
  expect(execute).toHaveBeenCalledTimes(1);
});

it("does not classify ordinary diagnostic prose as a closed possibly-ran code", async () => {
  vi.useFakeTimers();
  const cause = new Error("boat_command_possibly_ran: quoted diagnostic");
  const result = readRemoteRunnerRecoveryProbe({ runner: { execute: vi.fn().mockRejectedValue(cause) }, request: { command: "sh" },
    stage: "process_verification", readOnly: true, deadline: Date.now() + 2_000 }).catch(error => error);
  await vi.runAllTimersAsync();
  expect(await result).toBe(cause);
});

it("returns a definitive ownership conflict without retrying it", async () => {
  const conflict = { ...timeout, timedOut: false, exitCode: 47 };
  const execute = vi.fn().mockResolvedValue(conflict);
  expect(await readRemoteRunnerRecoveryProbe({
    runner: { execute }, request: { command: "sh" }, stage: "process_verification",
    readOnly: true, deadline: Date.now() + 30_000,
  })).toBe(conflict);
  expect(execute).toHaveBeenCalledTimes(1);
});
