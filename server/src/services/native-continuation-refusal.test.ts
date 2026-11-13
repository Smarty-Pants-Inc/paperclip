import { describe, expect, it } from "vitest";
import { isNativeContinuationRefusal, NATIVE_CONTINUATION_REFUSED_ACTION } from "./native-continuation-refusal.js";

describe("native continuation refusal", () => {
  it.each([
    "native_controller_recovery_missing_evidence:retained_sandbox_binding",
    "native_controller_recovery_unsupported:metadata_format",
    "native_controller_recovery_unsupported:supervisor_compatibility",
    "native_controller_recovery_unsupported:admitted_input_format",
    "adapter_failed: native_controller_recovery_missing_evidence:retained_sandbox_binding",
  ])("refuses the conversation for %s", error => {
    expect(isNativeContinuationRefusal({ error })).toBe(true);
    expect(isNativeContinuationRefusal({ error, errorCode: "native_continuation_requires_reconciliation" } as never)).toBe(true);
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
  ])("does not refuse for %s", error => {
    expect(isNativeContinuationRefusal({ error })).toBe(false);
  });

  it("does not treat the no-replay hold code alone as a refusal", () => {
    // An ordinary recovered native hold carries this code and continues on the next message.
    expect(isNativeContinuationRefusal({ error: null, errorCode: "native_continuation_requires_reconciliation" } as never)).toBe(false);
    expect(isNativeContinuationRefusal(null)).toBe(false);
    expect(isNativeContinuationRefusal(undefined)).toBe(false);
  });

  it("tells the person the files are kept and to assign a new task, never to send a message", () => {
    expect(NATIVE_CONTINUATION_REFUSED_ACTION)
      .toBe("Your saved work is kept, but this conversation cannot continue. Assign this agent a new task to continue.");
    expect(NATIVE_CONTINUATION_REFUSED_ACTION).not.toMatch(/send a message/i);
  });
});
