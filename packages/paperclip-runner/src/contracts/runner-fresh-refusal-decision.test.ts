import { expect, it } from "vitest";
import { NativeRunnerLaunchProfileMismatchError, NativeRunnerRefreshRequiredError, RUNNER_PREPARE_REFUSAL_CODES,
  runnerPrepareRefusalCode, runnerReconciliationFailureClass, runnerRefreshWaitForTurn } from "./harness-driver.js";

// Keep: the C3 trust-boundary policy opts into typed codes, not legacy prose.
it.each(RUNNER_PREPARE_REFUSAL_CODES)("C3 decides from the specific prepare code %s", refusalCode => {
  const error = { runnerCommandResult: { commandType: "run.prepare", status: "failed",
    result: { code: "command_execution_failed", refusalCode, message: "opaque", classification: "provider_state_incompatible" } } };
  expect(runnerReconciliationFailureClass(new Error("wrapped", { cause: error })))
    .toBe(refusalCode === "provider_launch_profile_mismatch" ? "provider_launch_profile_mismatch" : "provider_refresh_required");
  expect(runnerRefreshWaitForTurn(error)).toBe(refusalCode === "provider_active_turn");
});
it.each([undefined, "future_unknown"])("C3 gives old/unknown %s one generic refusal, never a prose-derived profile mismatch", refusalCode => {
  const error = { runnerCommandResult: { commandType: "run.attach", status: "failed", result: {
    code: "command_execution_failed", refusalCode, message: "Pi run.prepare launch does not match the runner-owned qualified profile" } } };
  expect(runnerPrepareRefusalCode(error)).toBe("provider_prepare_refused");
  expect(runnerReconciliationFailureClass(error)).toBe("provider_refresh_required");
});
it("preserves typed codes and wait ownership through wrapping", () => {
  const error = new Error("wrapped", { cause: new NativeRunnerRefreshRequiredError(true, "provider_active_turn") });
  expect(runnerPrepareRefusalCode(error)).toBe("provider_active_turn");
  expect(runnerRefreshWaitForTurn(error)).toBe(true);
  expect(runnerReconciliationFailureClass(error)).toBe("provider_refresh_required");
  expect(runnerReconciliationFailureClass(new Error("wrapped", { cause: new NativeRunnerLaunchProfileMismatchError("opaque") })))
    .toBe("provider_launch_profile_mismatch");
  expect(runnerReconciliationFailureClass(new Error("Pi runner launch profile changed across the durable run"))).toBeUndefined();
});
