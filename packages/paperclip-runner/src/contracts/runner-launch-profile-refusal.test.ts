import { describe, expect, it } from "vitest";
import { runnerRecoveryFailureClass } from "./harness-driver.js";

// Keep: release-boundary refusal is a data-safety fence, never a session reset.
const classification = "provider_launch_profile_mismatch";
const receipt = (message: string, extra = {}) => ({ commandType: "run.prepare", status: "failed",
  result: { code: "command_execution_failed", message, ...extra } });

describe("normalized Runner launch-profile refusal", () => {
  it("accepts the structured class independently of provider prose", () => {
    const error = Object.assign(new Error("opaque transport"), { runnerCommandResult: receipt("localized diagnostic", { classification }) });
    expect(runnerRecoveryFailureClass(error)).toBe(classification);
  });
  it("prioritizes the structured refusal code over the legacy state-incompatible class", () => {
    const error = Object.assign(new Error("opaque transport"), { runnerCommandResult: receipt("localized diagnostic", {
      refusalCode: classification, classification: "provider_state_incompatible",
    }) });
    expect(runnerRecoveryFailureClass(error)).toBe(classification);
  });
  it.each(["Pi", "OpenCode", "Cursor Cloud"])("normalizes old %s receipts at the Runner boundary", provider => {
    for (const message of [`${provider} runner launch profile changed across the durable run`,
      `${provider} runner launch profile changed across durable recovery`,
      `${provider} run.prepare launch does not match the runner-owned qualified profile`]) {
      const error = new Error(`native_session_recovery_failed: Error: PRP command run.prepare failed: ${JSON.stringify(receipt(message))}`);
      expect(runnerRecoveryFailureClass(new Error("wrapped", { cause: error }))).toBe(classification);
    }
  });
  it.each(["Pi runner launch profile changed across the durable run", "untrusted quoted PRP command run.prepare failed: {}"])(
    "does not treat prose as a command receipt: %s", message => {
      expect(runnerRecoveryFailureClass(new Error(message))).toBeUndefined();
    });
  it.each(["turn.start", "session.open"])("rejects the new class outside the attach/prepare boundary: %s", commandType => {
    expect(runnerRecoveryFailureClass({ runnerCommandResult: { ...receipt("opaque", { classification }), commandType } })).toBeUndefined();
  });
});
