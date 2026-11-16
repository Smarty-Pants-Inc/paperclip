import { expect, it } from "vitest";
import { FRESH_THREAD_REFUSAL_CODES, freshThreadRefusalCode, isFreshThreadRefusal, nativeReconciliationError, runnerLaunchProfileMismatch } from "./runner-reconciliation-refusal.js";
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
it.each(FRESH_THREAD_REFUSAL_CODES)("only the closed structured code authorizes fresh continuation (%s)", code => {
  expect(freshThreadRefusalCode(nativeReconciliationError(code))).toBe(code);
  expect(freshThreadRefusalCode(new Error("opaque", { cause: nativeReconciliationError(code) }))).toBe(code);
  expect(freshThreadRefusalCode(new Error(code))).toBeNull();
  expect(isFreshThreadRefusal({ errorCode: code })).toBe(true);
  expect(isFreshThreadRefusal({ errorCode: "adapter_failed", resultJson: { providerFailure: { message: code } } })).toBe(false);
});

it.each([
  "runner_harness_state_mismatch: resumed_unavailable",
  "runner_harness_state_mismatch: backup_without_reusable_lease",
  "native_controller_recovery_missing_evidence:retained_sandbox_binding",
])("D10b preserves exact controller and C1 refusal without trusting prose (%s)", code => {
  expect(freshThreadRefusalCode(nativeReconciliationError(code))).toBe(code);
  expect(runnerPrepareRefusalCode({ code, prepareRefusalCode: code })).toBe(code);
  expect(runnerPrepareRefusalCode({ prepareRefusalCode: code })).toBeUndefined();
  expect(runnerPrepareRefusalCode({ code, prepareRefusalCode: "provider_active_turn" })).toBeUndefined();
  expect(freshThreadRefusalCode(new Error(code))).toBeNull();
  expect(isFreshThreadRefusal({ errorCode: "native_session_interrupted", error: code })).toBe(true);
  expect(isFreshThreadRefusal({ error: `provider said ${code}` })).toBe(false);
  for (const commandType of ["run.prepare", "run.attach"]) {
    const receipt = { runnerCommandResult: { commandType, status: "failed",
      result: { code: "command_execution_failed", refusalCode: code, message: "opaque" } } };
    expect(runnerPrepareRefusalCode(receipt)).toBe(code);
    expect(freshThreadRefusalCode(receipt)).toBe(code);
  }
});

it("normalizes prepare/attach refresh refusals without reading provider text", () => {
  for (const commandType of ["run.prepare", "run.attach"]) expect(freshThreadRefusalCode({ runnerCommandResult: {
    commandType, status: "failed", result: { code: "command_execution_failed", refusalCode: "provider_refresh_required", message: "opaque" },
  } })).toBe("native_runner_refresh_required");
  expect(freshThreadRefusalCode({ code: "provider_refresh_required" })).toBeNull();
});

it.each([undefined, "future_unknown"])("server receives one generic code for old/unknown %s", refusalCode => {
  expect(runnerPrepareRefusalCode({ runnerCommandResult: { commandType: "run.prepare", status: "failed",
    result: { code: "command_execution_failed", refusalCode, message: "Pi run.prepare launch does not match the runner-owned qualified profile" } } })).toBe("provider_prepare_refused");
});

// J3-22 floor (RFL 08:06Z): ONE closed set. Its members are FRESH_THREAD_REFUSAL_CODES
// members whose automatic retry already takes a fresh thread; the floor only moves
// that fresh thread into the same run. Every other code stays out.
it("the same-run fresh-thread floor is a closed subset of FRESH_THREAD_REFUSAL_CODES", async () => {
  const refusal = await import("./runner-reconciliation-refusal.js") as Record<string, unknown>;
  const members = refusal.SAME_RUN_FRESH_THREAD_REFUSAL_CODES as readonly string[] | undefined;
  const codeOf = refusal.sameRunFreshThreadCode as ((value: unknown) => string | null) | undefined;
  expect(members).toContain("runner_harness_state_mismatch: backup_without_reusable_lease");
  for (const member of members ?? []) expect(FRESH_THREAD_REFUSAL_CODES).toContain(member);
  const code = "runner_harness_state_mismatch: backup_without_reusable_lease";
  expect(codeOf?.(nativeReconciliationError(code))).toBe(code);
  expect(codeOf?.(new Error("opaque", { cause: nativeReconciliationError(code) }))).toBe(code);
  expect(codeOf?.(code)).toBe(code);
  // Prose never authorizes; non-members keep today's next-run path.
  expect(codeOf?.(new Error(code))).toBeNull();
  for (const other of FRESH_THREAD_REFUSAL_CODES.filter(value => !(members ?? [code]).includes(value))) {
    expect(codeOf?.(nativeReconciliationError(other))).toBeNull();
    expect(codeOf?.(other)).toBeNull();
  }
  expect(codeOf?.("runner_harness_state_mismatch: provider_identity_changed")).toBeNull();
});
