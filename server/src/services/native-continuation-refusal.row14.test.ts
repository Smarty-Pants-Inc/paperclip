// Necessary admission-gate regression; does not authorize reusing an unfenced
// predecessor. The executor must still fence a successor or show one Retry notice.
import { describe, expect, it } from "vitest";
import { isNativeContinuationRefusal } from "./native-continuation-refusal.js";

const supervisionFailure = "runner_process_termination_unconfirmed: runnerd process supervision failed: "
  + "Boat POST /sandboxes/{sandboxId}/commands failed (unavailable): "
  + "result_unconfirmed, evidence=unknown (possibly ran)";

describe("row 14: next person message after unprovable fail-closed", () => {
  it.each([
    { error: supervisionFailure, errorCode: "notification_transport_failed" },
    { error: `Notification transport failed closed: ${supervisionFailure}`, errorCode: "notification_transport_failed" },
    { error: "Saved supervision failure", errorCode: supervisionFailure },
  ])("does not permanently refuse the next message from saved run %j", savedRun => {
    // The next-message fallback reads this durable failed run unchanged.
    // False permits reconciliation/Retry; it does NOT prove the old PID dead.
    // This leaf check does not claim to exercise HTTP admission or render Retry.
    expect(isNativeContinuationRefusal(savedRun),
      "a possibly-ran supervision failure must enter fenced recovery or one Retry notice, not a permanent conversation refusal",
    ).toBe(false);
  });

  it("does not weaken unrelated prior-owner safety refusals", () => {
    expect(isNativeContinuationRefusal({ error: "runner_state_identity_mismatch: prior_owner_active" })).toBe(true);
    expect(isNativeContinuationRefusal({ error: "runner_state_identity_mismatch: prior_owner_scope_mismatch" })).toBe(true);
    expect(isNativeContinuationRefusal({ error: "runner_process_termination_unconfirmed" })).toBe(true);
  });
});
