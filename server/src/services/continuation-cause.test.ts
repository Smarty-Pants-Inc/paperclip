import { describe, expect, it } from "vitest";
import { nativeStartupNeverConnectedExhausted } from "./continuation-cause.js";

// Keep reason: the real Boat outage stranded pre-agent startup attempts. This
// failure-path boundary must never authorize replay after agent work began.
function exhausted(originalFailureCode = "runner_ingress_acquisition_failed", httpStatus: unknown = 503) {
  return {
    phase: "terminal_failure",
    failureCode: "native_session_retry_exhausted",
    failureDetail: {
      originalFailureCode,
      runnerIngressFailure: { phase: "private_preview", httpStatus },
      recoveryMode: "bootstrap_retry",
      providerSessionEstablished: false,
      providerEventsExist: false,
      checkpointExists: false,
    } as Record<string, unknown>,
  };
}

describe("exhausted ingress acquisition shares the never-connected startup continuation", () => {
  it.each([429, 500, 503, 599])("accepts structured HTTP %s after the same-run retry budget with no agent work", httpStatus => {
    expect(nativeStartupNeverConnectedExhausted(exhausted(undefined, httpStatus))).toBe(true);
  });

  it.each([400, 401, 403, 404, 408, 425, 499, 600, "503", null, undefined, 503.5, NaN])(
    "does not release the board hold for non-transient or malformed status %s", httpStatus => {
      const coordinator = exhausted(undefined, httpStatus);
      if (httpStatus === undefined) delete (coordinator.failureDetail.runnerIngressFailure as Record<string, unknown>).httpStatus;
      expect(nativeStartupNeverConnectedExhausted(coordinator)).toBe(false);
    },
  );

  it.each(["providerSessionEstablished", "providerEventsExist", "checkpointExists"])(
    "does not release an HTTP 503 hold with %s (provider thread, tool call/transcript, or checkpoint)", field => {
      const coordinator = exhausted();
      coordinator.failureDetail[field] = true;
      expect(nativeStartupNeverConnectedExhausted(coordinator)).toBe(false);
    },
  );

  it.each(["providerSessionEstablished", "providerEventsExist", "checkpointExists"])(
    "requires explicit no-work proof for %s, not missing evidence", field => {
      const coordinator = exhausted();
      delete coordinator.failureDetail[field];
      expect(nativeStartupNeverConnectedExhausted(coordinator)).toBe(false);
    },
  );

  it("does not parse a status from message text or accept missing structured ingress evidence", () => {
    const coordinator = exhausted();
    delete coordinator.failureDetail.runnerIngressFailure;
    coordinator.failureDetail.message = "Runner endpoint failed (HTTP 503).";
    expect(nativeStartupNeverConnectedExhausted(coordinator)).toBe(false);
  });

  it("keeps retry phase, exhaustion code and bootstrap recovery requirements", () => {
    expect(nativeStartupNeverConnectedExhausted({ ...exhausted(), phase: "retryable_failure" })).toBe(false);
    expect(nativeStartupNeverConnectedExhausted({ ...exhausted(), failureCode: "runner_ingress_acquisition_failed" })).toBe(false);
    const coordinator = exhausted();
    coordinator.failureDetail.recoveryMode = "ambiguous_state";
    expect(nativeStartupNeverConnectedExhausted(coordinator)).toBe(false);
    expect(nativeStartupNeverConnectedExhausted(exhausted("unrelated_failure"))).toBe(false);
    expect(nativeStartupNeverConnectedExhausted(null)).toBe(false);
  });

  it("guard: startup_failed still qualifies without any HTTP status and uses exactly the same no-work proof", () => {
    const coordinator = exhausted("runner_ingress_startup_failed");
    delete coordinator.failureDetail.runnerIngressFailure;
    expect(nativeStartupNeverConnectedExhausted(coordinator)).toBe(true);
    for (const field of ["providerSessionEstablished", "providerEventsExist", "checkpointExists"]) {
      expect(nativeStartupNeverConnectedExhausted({ ...coordinator,
        failureDetail: { ...coordinator.failureDetail, [field]: true } })).toBe(false);
    }
  });
});
