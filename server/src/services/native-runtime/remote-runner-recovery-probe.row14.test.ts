// Row 14: unit test explicitly requested by the task author. The live trigger is
// gate 4 / run 9125b9b2 / seq 273, not an ordinary HTTP error string.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REMOTE_RUNNER_RECOVERY_ERROR_CODE,
  REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT,
  readRemoteRunnerRecoveryError,
} from "./remote-runner-recovery-diagnostics.js";
import { readRemoteRunnerRecoveryProbe } from "./remote-runner-recovery-probe.js";

const possiblyRan = () => Object.assign(new Error(
  "Boat POST /sandboxes/{sandboxId}/commands failed (unavailable): result_unconfirmed, evidence=unknown (possibly ran)",
), { code: "boat_command_possibly_ran" });
const alive = {
  exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "",
  pid: null, startedAt: "2026-11-17T15:39:12Z",
};
const request = {
  command: "sh",
  args: ["-c", REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT, "paperclip-runner-monitor",
    "/tmp/row14/process.identity", "nonce", "runner-row14", "123", "linux:boot:123"],
  bypassSession: true,
};

afterEach(() => vi.useRealTimers());

describe("row 14: possibly-ran supervision observation", () => {
  it("re-inspects a read-only supervision probe inside the reconnect bound and returns alive, never throws", async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockRejectedValueOnce(possiblyRan()).mockResolvedValue(alive);
    const started = Date.now();
    const result = readRemoteRunnerRecoveryProbe({
      runner: { execute }, request, stage: "process_verification", readOnly: true,
      deadline: started + 2_000,
    });
    // Attach the rejection assertion before advancing timers: no unhandled rejection.
    const assertion = expect(result).resolves.toBe(alive);
    await vi.runAllTimersAsync();
    await assertion;
    expect(execute).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(execute.mock.calls[1]![0]).toMatchObject({ ...request, readOnlyProbe: true });
    expect(execute.mock.calls[1]![0].timeoutMs).toBeLessThanOrEqual(2_000);
  });

  it("exhausts the bound as a named recovery failure, not the raw possibly-ran exception", async () => {
    vi.useFakeTimers();
    const raw = possiblyRan();
    const execute = vi.fn().mockRejectedValue(raw);
    const started = Date.now();
    const result = readRemoteRunnerRecoveryProbe({
      runner: { execute }, request, stage: "process_verification", readOnly: true,
      deadline: started + 2_000,
    }).then(observation => ({ observation, error: null }), error => ({ observation: null, error }));
    await vi.runAllTimersAsync();
    const outcome = await result;
    expect(outcome.observation).toBeNull();
    expect(execute.mock.calls.length).toBeGreaterThan(1);
    expect(execute.mock.calls.length).toBeLessThanOrEqual(8);
    expect(Date.now() - started).toBeLessThanOrEqual(2_000);
    expect(readRemoteRunnerRecoveryError(outcome.error)).toEqual({
      stage: "process_verification", reason: "probe_transport_failed",
    });
    // A WeakMap annotation on the same Error is not a named failure at the
    // transport boundary: the caller still sees boat_command_possibly_ran.
    expect(outcome.error).not.toBe(raw);
    expect(outcome.error).toMatchObject({ code: REMOTE_RUNNER_RECOVERY_ERROR_CODE });
  });
});
