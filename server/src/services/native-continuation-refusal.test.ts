import { describe, expect, it } from "vitest";
import { isNativeContinuationRefusal } from "./native-continuation-refusal.js";
import { HELD_PREDECESSOR_NOTICE } from "./native-runtime/native-session-executor.js";

describe("native continuation refusal", () => {
  it.each([
    "native_controller_recovery_missing_evidence:retained_sandbox_binding",
    "native_controller_recovery_unsupported:metadata_format",
    "native_controller_recovery_unsupported:supervisor_compatibility",
    "native_controller_recovery_unsupported:admitted_input_format",
    "adapter_failed: native_controller_recovery_missing_evidence:retained_sandbox_binding",
    "native_session_cleanup_quarantined",
    "runner_process_termination_unconfirmed",
    "runner_process_termination_unconfirmed: runnerd process supervision failed",
    "runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate",
    "Error: runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate; retirement_refused=true",
  ])("refuses the conversation for %s", value => {
    expect(isNativeContinuationRefusal({ error: value })).toBe(true);
    expect(isNativeContinuationRefusal({ error: value, errorCode: "native_continuation_requires_reconciliation" })).toBe(true);
    // The code may be saved as the run's errorCode instead of its error.
    expect(isNativeContinuationRefusal({ error: "Fixture failure", errorCode: value })).toBe(true);
  });

  it.each([
    null, undefined, "", "Fixture failure",
    // Settles on its own or waits; Retry can pass later.
    "native_controller_recovery_missing_evidence:runner_not_settled",
    "native_controller_recovery_dependency_unavailable:checkpoint_authority_unreadable",
    "native_controller_recovery_waiting_for_owner",
    "native_controller_recovery_missing_evidence:retained_sandbox_binding_v2",
    "native_controller_recovery_unsupported:",
    "xnative_controller_recovery_unsupported:metadata_format",
    "native_session_cleanup_quarantined_v2",
    "xrunner_process_termination_unconfirmed",
    "runner_state_identity_mismatch: prior_owner_retired",
    "runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate_v2",
  ])("does not refuse for %s", value => {
    expect(isNativeContinuationRefusal({ error: value })).toBe(false);
    expect(isNativeContinuationRefusal({ errorCode: value })).toBe(false);
  });

  it("does not treat the no-replay hold code alone as a refusal", () => {
    // An ordinary recovered native hold carries this code and continues on the next message.
    expect(isNativeContinuationRefusal({ error: null, errorCode: "native_continuation_requires_reconciliation" })).toBe(false);
    expect(isNativeContinuationRefusal({ error: "native_continuation_requires_reconciliation", errorCode: "native_continuation_requires_reconciliation" })).toBe(false);
    expect(isNativeContinuationRefusal(null)).toBe(false);
    expect(isNativeContinuationRefusal(undefined)).toBe(false);
  });

  it("uses the durable notice's one wording: the files are kept, a new task continues, never send a message", () => {
    expect(HELD_PREDECESSOR_NOTICE)
      .toBe("Your saved work is kept, but this conversation cannot continue. Assign this agent a new task to continue.");
    expect(HELD_PREDECESSOR_NOTICE).not.toMatch(/send a message/i);
  });
});
