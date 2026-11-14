import { expect, it } from "vitest";
import { runnerLaunchProfileMismatch } from "./runner-reconciliation-refusal.js";
import { runnerPrepareRefusalCode } from "../../vendor/paperclip-runner/index.js";

// Keep: authenticated Runner -> core contract, not provider prose as authority.
it("core recognizes an opaque prepare/attach refusal by its Runner code", () => {
  for (const commandType of ["run.prepare", "run.attach"]) {
    expect(runnerLaunchProfileMismatch({ runnerCommandResult: { commandType, status: "failed",
      result: { code: "command_execution_failed", refusalCode: "provider_launch_profile_mismatch", message: "opaque" } } })).toBe(true);
  }
  expect(runnerLaunchProfileMismatch(new Error("Pi runner launch profile changed across the durable run"))).toBe(false);
});

it.each(["provider_active_turn", "provider_live_descendants", "provider_active_goal", "provider_config_changed",
  "provider_contract_changed_same_run", "provider_launch_profile_mismatch", "provider_pending_tool_calls",
  "provider_reconciliation_required", "provider_session_closed"])("server receives the specific Runner code %s", refusalCode => {
  expect(runnerPrepareRefusalCode({ runnerCommandResult: { commandType: "run.prepare", status: "failed",
    result: { code: "command_execution_failed", refusalCode, message: "opaque" } } })).toBe(refusalCode);
});
it.each([undefined, "future_unknown"])("server receives one generic code for old/unknown %s", refusalCode => {
  expect(runnerPrepareRefusalCode({ runnerCommandResult: { commandType: "run.prepare", status: "failed",
    result: { code: "command_execution_failed", refusalCode, message: "Pi run.prepare launch does not match the runner-owned qualified profile" } } })).toBe("provider_prepare_refused");
});
