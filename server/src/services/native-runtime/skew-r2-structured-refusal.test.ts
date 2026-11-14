import { describe, expect, it } from "vitest";
import { nativeSessionFailureDisposition, nativeSessionFailureSourceCode } from "./native-session-executor.js";

// Keep: a new Runner's authenticated refusal code, not localized/provider
// diagnostic prose, decides whether the saved conversation can be replaced.
describe("RFL F3 structured Runner refusal reaches core unchanged", () => {
  it.each([
    ["run.prepare", "object"], ["run.prepare", "serialized"],
    ["run.attach", "object"], ["run.attach", "serialized"],
  ] as const)("makes %s/%s terminal without retrying or offering history reset", (commandType, transport) => {
    const receipt = { commandType, status: "failed", result: {
      code: "command_execution_failed", refusalCode: "provider_launch_profile_mismatch",
      classification: "provider_state_incompatible", message: "opaque localized diagnostic",
    } };
    const error = transport === "serialized"
      ? new Error(`native_session_recovery_failed: Error: PRP command ${commandType} failed: ${JSON.stringify(receipt)}`)
      : Object.assign(new Error("opaque command transport"), { runnerCommandResult: receipt });
    const code = nativeSessionFailureSourceCode(error);
    expect(code).toBe("native_runner_launch_profile_mismatch");
    expect(code).not.toBe("native_provider_state_incompatible");
    expect(nativeSessionFailureDisposition(1, new Date(0), code)).toMatchObject({
      phase: "terminal_failure", nextAttemptAt: null,
    });
  });
});
