import { expect, it } from "vitest";
import { FRESH_THREAD_REFUSAL_CODES, freshThreadRefusalCode, isFreshThreadRefusal, nativeReconciliationError, runnerLaunchProfileMismatch } from "./runner-reconciliation-refusal.js";

// Keep: authenticated Runner -> core contract, not provider prose as authority.
it("core recognizes an opaque prepare/attach refusal by its Runner code", () => {
  for (const commandType of ["run.prepare", "run.attach"]) {
    expect(runnerLaunchProfileMismatch({ runnerCommandResult: { commandType, status: "failed",
      result: { code: "command_execution_failed", refusalCode: "provider_launch_profile_mismatch", message: "opaque" } } })).toBe(true);
  }
  expect(runnerLaunchProfileMismatch(new Error("Pi runner launch profile changed across the durable run"))).toBe(false);
});

it.each(FRESH_THREAD_REFUSAL_CODES)("only the closed structured code authorizes fresh continuation (%s)", code => {
  expect(freshThreadRefusalCode(nativeReconciliationError(code))).toBe(code);
  expect(freshThreadRefusalCode(new Error("opaque", { cause: nativeReconciliationError(code) }))).toBe(code);
  expect(freshThreadRefusalCode(new Error(code))).toBeNull();
  expect(isFreshThreadRefusal({ errorCode: code })).toBe(true);
  expect(isFreshThreadRefusal({ errorCode: "adapter_failed", resultJson: { providerFailure: { message: code } } })).toBe(false);
});

it("normalizes prepare/attach refresh refusals without reading provider text", () => {
  for (const commandType of ["run.prepare", "run.attach"]) expect(freshThreadRefusalCode({ runnerCommandResult: {
    commandType, status: "failed", result: { code: "command_execution_failed", refusalCode: "provider_refresh_required", message: "opaque" },
  } })).toBe("native_runner_refresh_required");
  expect(freshThreadRefusalCode({ code: "provider_refresh_required" })).toBeNull();
});
