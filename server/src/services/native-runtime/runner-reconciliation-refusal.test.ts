import { expect, it } from "vitest";
import { runnerLaunchProfileMismatch } from "./runner-reconciliation-refusal.js";

// Keep: authenticated Runner -> core contract, not provider prose as authority.
it("core recognizes an opaque prepare/attach refusal by its Runner code", () => {
  for (const commandType of ["run.prepare", "run.attach"]) {
    expect(runnerLaunchProfileMismatch({ runnerCommandResult: { commandType, status: "failed",
      result: { code: "command_execution_failed", refusalCode: "provider_launch_profile_mismatch", message: "opaque" } } })).toBe(true);
  }
  expect(runnerLaunchProfileMismatch(new Error("Pi runner launch profile changed across the durable run"))).toBe(false);
});
