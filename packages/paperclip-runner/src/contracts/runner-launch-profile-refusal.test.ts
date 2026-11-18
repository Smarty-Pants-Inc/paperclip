import { describe, expect, it } from "vitest";
import { RUNNER_PREPARE_REFUSAL_CODES, runnerPrepareRefusalCode, runnerRecoveryFailureClass } from "./harness-driver.js";

// Keep: trust boundary; authenticated codes cannot be inferred from provider prose.
const receipt = (message: string, extra = {}) => ({ commandType: "run.prepare", status: "failed",
  result: { code: "command_execution_failed", message, ...extra } });

describe("normalized Runner prepare refusal channel", () => {
  it.each(RUNNER_PREPARE_REFUSAL_CODES)("round-trips %s independently of diagnostics", refusalCode => {
    const error = Object.assign(new Error("opaque transport"), { runnerCommandResult: receipt("localized", { refusalCode }) });
    expect(runnerPrepareRefusalCode(new Error("wrapper", { cause: error }))).toBe(refusalCode);
  });
  it.each([undefined, "future_unknown_refusal"])("maps old/unknown code %s to the one generic code", refusalCode => {
    const error = { runnerCommandResult: receipt("Pi run.prepare launch does not match the runner-owned qualified profile", { refusalCode }) };
    expect(runnerPrepareRefusalCode(error)).toBe("provider_prepare_refused");
  });
  it.each(["Pi", "OpenCode", "Cursor Cloud"])("never promotes old %s prose", provider => {
    for (const message of [`${provider} runner launch profile changed across the durable run`,
      `${provider} runner launch profile changed across durable recovery`,
      `${provider} run.prepare launch does not match the runner-owned qualified profile`]) {
      expect(runnerPrepareRefusalCode({ runnerCommandResult: receipt(message) })).toBe("provider_prepare_refused");
      expect(runnerPrepareRefusalCode(new Error(`native_session_recovery_failed: Error: PRP command run.prepare failed: ${JSON.stringify(receipt(message))}`))).toBeUndefined();
    }
  });
  it.each(["turn.start", "session.open"])("rejects codes outside prepare/attach: %s", commandType => {
    expect(runnerPrepareRefusalCode({ runnerCommandResult: { ...receipt("opaque", { refusalCode: "provider_launch_profile_mismatch" }), commandType } })).toBeUndefined();
  });
  it("leaves the legacy recovery classifier and replacement decision unchanged", () => {
    expect(runnerRecoveryFailureClass({ runnerCommandResult: receipt("Pi run.prepare launch does not match the runner-owned qualified profile") })).toBeUndefined();
    expect(runnerRecoveryFailureClass({ runnerCommandResult: receipt("opaque", { refusalCode: "provider_launch_profile_mismatch", classification: "provider_state_incompatible" }) })).toBe("provider_state_incompatible");
  });
});
